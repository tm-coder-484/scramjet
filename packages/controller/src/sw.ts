/// <reference lib="WebWorker" />
/// <reference types="@types/serviceworker" />
import { RpcHelper } from "@mercuryworkshop/rpc";
import type { Controllerbound, SWbound } from "./types";
import type { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { DEFAULT_PREFIX } from "./symbols";
import { receiveBody } from "./bodystream";

function makeId(): string {
	return Math.random().toString(36).substring(2, 10);
}

const cookieResolvers: Record<string, (value: void) => void> = {};
addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (e.data.$sw$setCookieDone && typeof e.data.$sw$setCookieDone == "object") {
		const done = e.data.$sw$setCookieDone;

		const resolver = cookieResolvers[done.id];
		if (resolver) {
			resolver();
			delete cookieResolvers[done.id];
		}
	}

	if (
		e.data.$sw$initRemoteTransport &&
		typeof e.data.$sw$initRemoteTransport == "object"
	) {
		const { port, prefix } = e.data.$sw$initRemoteTransport;

		const relevantcontroller = tabs.find((tab) =>
			new URL(prefix).pathname.startsWith(tab.prefix)
		);
		if (!relevantcontroller) {
			console.error("No relevant controller found for transport init");
			return;
		}
		relevantcontroller.rpc.call("initRemoteTransport", port, [port]);
	}
});

class ControllerReference {
	rpc: RpcHelper<SWbound, Controllerbound>;

	constructor(
		public prefix: string,
		public id: string,
		port: MessagePort
	) {
		this.rpc = new RpcHelper(
			{
				sendSetCookie: async ({ cookies, options }) => {
					const clients = await self.clients.matchAll();
					const ids: string[] = [];
					const promises: Promise<string>[] = [];

					// Navigation fetches (document/iframe) deliver cookies via the inject
					// script's embedded cookieJar dump — the destination page doesn't have
					// inject.ts loaded yet to ack, so awaiting would deadlock. Broadcast
					// so any already-loaded clients can update their jars, but don't wait.
					const isNavigation =
						options?.destination === "document" ||
						options?.destination === "iframe";

					for (const client of clients) {
						const id = makeId();
						ids.push(id);
						client.postMessage({
							$controller$setCookie: {
								cookies,
								options,
								id,
							},
						});
						if (!isNavigation) {
							promises.push(
								new Promise<string>((resolve) => {
									// Resolve with the id so we know which client replied.
									cookieResolvers[id] = () => resolve(id);
								})
							);
						}
					}
					// Wait for the first client to acknowledge the cookie sync.
					// Using Promise.any (not Promise.all) so that extra SW clients created by
					// window.open (e.g. test popup windows) don't cause timeouts — only the
					// main controller client needs to respond.
					if (promises.length > 0) {
						let timeoutId: ReturnType<typeof setTimeout> | undefined;
						let responded = false;
						const timeoutPromise = new Promise<void>((resolve) => {
							timeoutId = setTimeout(() => {
								if (!responded) {
									const pending = ids.filter(
										(id) => cookieResolvers[id] !== undefined
									);
									console.error(
										"timed out waiting for set cookie response (deadlock?): " +
											`cookies=${cookies.length} clients=${clients.length} ` +
											`pending=${pending.length}/${ids.length} ` +
											`clientUrls=${clients.map((c) => c.url).join(",")}`
									);
								}
								resolve();
							}, 1000);
						});

						try {
							await Promise.race([
								timeoutPromise,
								Promise.any(promises)
									.then(() => {
										responded = true;
									})
									.catch(() => {}),
							]);
						} finally {
							// Clear the timeout so it doesn't fire spuriously after the
							// race has already been won by Promise.any.
							if (timeoutId !== undefined) clearTimeout(timeoutId);
							// Clean up any pending resolvers so clients that never
							// responded don't leak entries in cookieResolvers.
							for (const id of ids) {
								delete cookieResolvers[id];
							}
						}
					}
				},
			},
			"tabchannel-" + id,
			(data, transfer) => {
				port.postMessage(data, transfer);
			}
		);
		port.onmessage = (e: MessageEvent) => {
			this.rpc.recieve(e.data);
		};
		port.onmessageerror = console.error;

		this.rpc.call("ready", undefined);
	}
}

const tabs: ControllerReference[] = [];

// When the browser restarts an idle service worker, `tabs` is empty until each
// controller answers the revive message at the bottom of this file. Requests
// that arrive in that window (often the one that woke the worker up) must
// wait for their controller instead of falling through to the network and 404ing.
const knownPrefixes = new Set<string>([DEFAULT_PREFIX]);
const tabWaiters: (() => void)[] = [];
const TAB_WAIT_TIMEOUT = 5000;

function findTab(url: URL): ControllerReference | undefined {
	return tabs.find((tab) => url.pathname.startsWith(tab.prefix));
}

async function waitForTab(url: URL): Promise<ControllerReference | undefined> {
	const deadline = Date.now() + TAB_WAIT_TIMEOUT;
	let tab = findTab(url);
	while (!tab && Date.now() < deadline) {
		await new Promise<void>((resolve) => {
			tabWaiters.push(resolve);
			setTimeout(resolve, deadline - Date.now());
		});
		tab = findTab(url);
	}
	return tab;
}

// ---- scramjet's client scripts, from CacheStorage ----
// Every proxied document loads the same client scripts (scramjet.js, controller.inject.js), and
// in a fresh profile each document compiled them again: ~20-30ms per document. Chromium keeps the
// compiled code of scripts a service worker caches while it installs, so they are cached here and
// answered from the cache. A controller reports its client paths when it connects; the cached
// copies are then checked against the server (and replaced if they changed, e.g. after a rebuild)
// before any document gets them, so a page's frames run the client its controller loaded with.
const CLIENT_CACHE = "scramjet-client";
const DEFAULT_CLIENT_PATHS = [
	"/scramjet/scramjet.js",
	"/controller/controller.inject.js",
];
// path -> the check that must finish before the cached copy is used
const clientChecks = new Map<string, Promise<boolean>>();

function sameBytes(a: ArrayBuffer, b: ArrayBuffer) {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a),
		y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

// the cached copy of a client script, refreshed if the server's differs. resolves whether the
// cache now holds the server's current version
async function checkClientScript(path: string): Promise<boolean> {
	try {
		const cache = await caches.open(CLIENT_CACHE);
		const fresh = await fetch(path, { cache: "no-cache" });
		if (!fresh.ok) {
			await cache.delete(path);
			return false;
		}
		const cached = await cache.match(path);
		if (
			cached &&
			sameBytes(await cached.arrayBuffer(), await fresh.clone().arrayBuffer())
		)
			return true;
		await cache.put(path, fresh);
		return true;
	} catch {
		return false;
	}
}

function watchClientScripts(paths: string[]) {
	for (const path of paths) {
		if (new URL(path, location.href).origin !== location.origin) continue;
		const pathname = new URL(path, location.href).pathname;
		clientChecks.set(pathname, checkClientScript(pathname));
	}
}

addEventListener("install", (e: ExtendableEvent) => {
	// failures only cost the speedup; they must not fail the install
	e.waitUntil(
		caches
			.open(CLIENT_CACHE)
			.then((cache) => cache.addAll(DEFAULT_CLIENT_PATHS))
			.catch(() => {})
	);
});

function isClientScript(url: URL) {
	return url.origin === location.origin && clientChecks.has(url.pathname);
}

async function routeClientScript(event: FetchEvent): Promise<Response> {
	const path = new URL(event.request.url).pathname;
	if (await clientChecks.get(path)) {
		const cached = await (await caches.open(CLIENT_CACHE)).match(path);
		if (cached) return cached;
	}
	return fetch(event.request);
}

addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (!e.data.$controller$init) return;
	if (typeof e.data.$controller$init != "object") return;
	const init = e.data.$controller$init;
	if (Array.isArray(init.client)) watchClientScripts(init.client);

	const existing = tabs.findIndex((t) => t.id === init.id);
	if (existing !== -1) {
		tabs.splice(existing, 1);
	}
	tabs.push(new ControllerReference(init.prefix, init.id, e.ports[0]));

	// the controller prefix is Config.prefix + id + "/"
	const prefix: string = init.prefix;
	knownPrefixes.add(
		prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1)
	);
	for (const resolve of tabWaiters.splice(0)) resolve();
});

export function shouldRoute(event: FetchEvent): boolean {
	const url = new URL(event.request.url);
	if (event.request.method === "GET" && isClientScript(url)) return true;
	if (findTab(url)) return true;
	for (const prefix of knownPrefixes) {
		if (url.pathname.startsWith(prefix)) return true;
	}
	return false;
}

export async function route(event: FetchEvent): Promise<Response> {
	try {
		const url = new URL(event.request.url);
		if (event.request.method === "GET" && isClientScript(url))
			return await routeClientScript(event);
		const tab = await waitForTab(url);
		// no controller owns this url (e.g. it belonged to a page that's gone); behave as if unrouted
		if (!tab) return await fetch(event.request);
		const client = await clients.get(event.clientId);

		const rawheaders: RawHeaders = [...event.request.headers];

		const response = await tab.rpc.call(
			"request",
			{
				rawUrl: event.request.url,
				rawReferrer: event.request.referrer,
				destination: event.request.destination,
				mode: event.request.mode,
				referrer: event.request.referrer,
				method: event.request.method,
				body: event.request.body,
				cache: event.request.cache,
				forceCrossOriginIsolated: false,
				initialHeaders: rawheaders,
				rawClientUrl: client ? client.url : undefined,
				clientId: event.clientId || event.resultingClientId,
				acceptsBodyPort: true,
			},
			event.request.body instanceof ReadableStream ||
				// @ts-expect-error the types for fetchevent are messed up
				event.request.body instanceof ArrayBuffer
				? [event.request.body]
				: undefined
		);

		return new Response(
			response.bodyPort ? receiveBody(response.bodyPort) : response.body,
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			}
		);
	} catch (e) {
		console.error("Service Worker error:", e);
		return new Response(
			"Internal Service Worker Error: " + (e as Error).message,
			{
				status: 500,
			}
		);
	}
}

addEventListener("install", () => {
	self.skipWaiting();
});

addEventListener("activate", (event: ExtendableEvent) => {
	event.waitUntil(clients.claim());
});

// the only way to know if a service worker has suddenly died is if this code runs again
// notify all clients to send over their messageports again
setTimeout(async () => {
	console.log("service worker activated, notifying clients to revive");
	// includeUncontrolled: a hard reload (Ctrl+Shift+R) leaves the page without a
	// controller, but its Controller still owns a tab channel that must be revived
	for (const client of await clients.matchAll({ includeUncontrolled: true })) {
		client.postMessage({
			$controller$swrevive: {
				// controllers that already registered with this instance don't need to again
				known: tabs.map((tab) => tab.id),
			},
		});
	}
	// short delay is apparently needed
}, 100);
