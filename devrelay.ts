// A fast transport for the dev server: the "relay". The browser hands each request to this
// server over one websocket, which makes it with Node's HTTP stack and streams the response back.
// Compared with wisp + libcurl/epoxy (TLS in wasm, inside the page), requests here get native TLS,
// HTTP/2 to the site, a DNS cache, and no per-request work on the page's thread.
//
// The trade-off: this server sees the plaintext of every request, where wisp only forwards
// encrypted bytes. That's fine for your own machine or Codespace, not for a public deployment.
//
// Protocol, on ws://<host>/relay (one socket per RelayTransport):
//   client -> server  text   {t:"req", id, url, method, headers, body:bool, prefetch?:bool, cache?:bool, whole?:bool}
//                     binary [u32 id][request body]   (follows a req with body:true)
//                     text   {t:"abort", id}
//   server -> client  text   {t:"head", id, status, statusText, headers} | {t:"err", id, error}
//                     binary [u32 id][chunk]...
//                     text   {t:"end", id}
//                     or, for a response the relay has whole (cache, prefetch) and a req with whole:true,
//                     binary [u32 id | WHOLE][u32 n][n bytes: {status, statusText, headers}][body]
//   the shared rewrite cache (RelayTransport's rewriteCache, used by the controller's rewriter threads):
//   client -> server  text   {t:"rwget", id, key, url?}   (url for big scripts: see speculate)
//                     text   {t:"rwput", id, key, header, body:true} + binary [u32 id][script]
//   server -> client  text   {t:"rwhit", id, tag, offsets, jsLength} + binary [u32 id][js][map] | {t:"rwmiss", id}
// Websockets get their own socket: ws://<host>/relay/ws?url=&protocols=&headers=
import http from "node:http";
import dns from "node:dns";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import vm from "node:vm";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Socket } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher } from "undici";
import { WebSocketServer, WebSocket } from "ws";
import { Parser } from "htmlparser2";

type RawHeaders = [string, string][];

// response headers the browser must not see: the relay already decoded the body
const DROP = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
]);
const REQUEST_DROP = new Set(["host", "connection", "content-length"]);
// RELAY_LOG=1 prints each upstream request's timing
const LOG = !!process.env.RELAY_LOG;
// the high bit of a binary frame's id: the frame is a whole response (see the protocol above)
const WHOLE = 0x80000000;

// DNS answers are kept for a minute, like Chromium's host cache, and a lookup in flight is shared
const dnsCache = new Map<string, { expires: number; addresses: dns.LookupAddress[] }>();
const dnsPending = new Map<string, Promise<dns.LookupAddress[]>>();

function resolveHost(hostname: string): Promise<dns.LookupAddress[]> {
	const hit = dnsCache.get(hostname);
	if (hit && hit.expires > Date.now()) return Promise.resolve(hit.addresses);
	let pending = dnsPending.get(hostname);
	if (!pending) {
		pending = dns.promises
			.lookup(hostname, { all: true })
			.then((addresses) => {
				dnsCache.set(hostname, { expires: Date.now() + 60_000, addresses });
				return addresses;
			})
			.finally(() => dnsPending.delete(hostname));
		dnsPending.set(hostname, pending);
	}
	return pending;
}

function cachedLookup(hostname: string, options: any, cb: any) {
	if (typeof options === "function") {
		cb = options;
		options = {};
	}
	const family = options.family === 4 || options.family === 6 ? options.family : 0;
	resolveHost(hostname).then(
		(addresses) => {
			const list = family ? addresses.filter((a) => a.family === family) : addresses;
			if (!list.length) {
				const err: any = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
				err.code = "ENOTFOUND";
				err.hostname = hostname;
				return cb(err);
			}
			if (options.all) cb(null, list);
			else cb(null, list[0].address, list[0].family);
		},
		(err) => cb(err)
	);
}

// ---- connections ahead of requests ----
// a page loaded directly has the browser connect to the hosts its <link rel=preconnect> names
// while the document still streams in, but proxied, those hints name the proxy's host. the relay
// opens such connections itself: for the hints, and for every host a site's pages used the last
// time (sites close idle connections within a minute or two, and a page's chain of banner, login
// and image requests then pays a TCP and TLS handshake at each step: ~300 ms on Wikipedia).
// one connector makes every connection, and hands out a warm one for its host if there is one
const connectSocket = buildConnector({ allowH2: true, lookup: cachedLookup as any });
// a warm connection is given to the first request for its host that comes within this long
const WARM_TTL = 10_000;
const warmSockets = new Map<string, Promise<Socket | null>>();

const connector: buildConnector.connector = (opts, cb) => {
	const key = `${opts.hostname}:${opts.port || 443}`;
	const warm = opts.protocol === "https:" && !opts.httpSocket ? warmSockets.get(key) : undefined;
	if (!warm) return connectSocket(opts, cb);
	warmSockets.delete(key);
	warm.then((socket) => {
		if (socket && !socket.destroyed && socket.readyState === "open") cb(null, socket);
		else connectSocket(opts, cb);
	});
};

// opens a connection to an https origin, unless `pool` already has one or one is warm
function preconnect(origin: string, pool: Agent) {
	let u: URL;
	try {
		u = new URL(origin);
	} catch {
		return;
	}
	if (u.protocol !== "https:") return;
	// as undici's client names it: an IPv6 address without its brackets
	const hostname = u.hostname.replace(/^\[(.*)\]$/, "$1");
	const key = `${hostname}:${u.port || 443}`;
	if (warmSockets.has(key) || Number(pool.stats[u.origin]?.connected ?? 0) > 0) return;
	const ready = new Promise<Socket | null>((resolve) =>
		connectSocket(
			{ hostname, host: u.host, protocol: "https:", port: u.port, localAddress: null },
			(err, socket) => resolve(err ? null : (socket as Socket))
		)
	);
	warmSockets.set(key, ready);
	if (LOG) console.log(`[relay] preconnect ${u.origin}`);
	setTimeout(() => {
		if (warmSockets.get(key) !== ready) return;
		warmSockets.delete(key);
		ready.then((socket) => socket?.destroy());
	}, WARM_TTL).unref();
}

// the other origins each site's pages requested (by the Referer's origin), most recent last
const LEARNED_ORIGINS = 16;
const learnedOrigins = new Map<string, string[]>();

function learnOrigin(referer: string, url: string) {
	let from: string, to: string;
	try {
		from = new URL(referer).origin;
		to = new URL(url).origin;
	} catch {
		return;
	}
	if (from === to || from === "null") return;
	let list = learnedOrigins.get(from);
	if (!list) {
		if (learnedOrigins.size >= 1000) learnedOrigins.delete(learnedOrigins.keys().next().value!);
		learnedOrigins.set(from, (list = []));
	} else if (list[list.length - 1] === to) return;
	const i = list.indexOf(to);
	if (i !== -1) list.splice(i, 1);
	list.push(to);
	if (list.length > LEARNED_ORIGINS) list.shift();
}

// ---- shared HTTP cache (opt-in per request: the transport's `cache` option) ----
// a forward-proxy cache like a CDN's or Squid's, following RFC 9111's rules for shared caches:
// only GETs without Authorization, only responses a shared cache may store (not private or
// no-store; with explicit freshness or a Last-Modified heuristic), only while fresh, keyed on
// the headers named by Vary. Set-Cookie is never replayed from it.
type CachedResponse = {
	status: number;
	statusText: string;
	headers: RawHeaders;
	body: Buffer;
	stored: number;
	lifetime: number;
	vary: Record<string, string>;
};
const CACHE_LIMIT = Number(process.env.RELAY_CACHE_MB || 512) * 1024 * 1024;
const CACHEABLE_STATUS = new Set([200, 203, 204, 300, 301, 308, 404, 410]);
const httpCache = new Map<string, CachedResponse[]>();
let httpCacheBytes = 0;

function directives(value: string) {
	const out: Record<string, string> = {};
	for (const part of value.toLowerCase().split(",")) {
		const [k, v = ""] = part.trim().split("=");
		if (k) out[k] = v.replace(/^"|"$/g, "");
	}
	return out;
}

// the freshness lifetime in ms a shared cache may give a response, or 0 if it can't store it
function freshnessLifetime(status: number, headers: RawHeaders, now: number) {
	if (!CACHEABLE_STATUS.has(status)) return 0;
	const cc = directives(header(headers, "cache-control"));
	if ("no-store" in cc || "private" in cc || "no-cache" in cc) return 0;
	if (/\*/.test(header(headers, "vary"))) return 0;
	const age = Number(header(headers, "age")) || 0;
	let lifetime: number | undefined;
	if (cc["s-maxage"] !== undefined) lifetime = Number(cc["s-maxage"]) * 1000;
	else if (cc["max-age"] !== undefined) lifetime = Number(cc["max-age"]) * 1000;
	else if (header(headers, "expires")) {
		const date = Date.parse(header(headers, "date")) || now;
		lifetime = Date.parse(header(headers, "expires")) - date;
	} else if (header(headers, "last-modified")) {
		// the usual heuristic: a tenth of the time since the last change, capped at a day
		const since = now - Date.parse(header(headers, "last-modified"));
		lifetime = Math.min(since / 10, 86_400_000);
	}
	if (!lifetime || !Number.isFinite(lifetime)) return 0;
	return lifetime - age * 1000;
}

function varyValues(responseHeaders: RawHeaders, requestHeaders: RawHeaders) {
	const vary: Record<string, string> = {};
	for (const name of header(responseHeaders, "vary").toLowerCase().split(",")) {
		const n = name.trim();
		if (n) vary[n] = header(requestHeaders, n);
	}
	return vary;
}

function cacheLookup(url: string, method: string, headers: RawHeaders) {
	if (method !== "GET" || header(headers, "authorization") || header(headers, "range")) return null;
	const cc = directives(header(headers, "cache-control"));
	if ("no-cache" in cc || "no-store" in cc || /no-cache/i.test(header(headers, "pragma"))) return null;
	const now = Date.now();
	const entries = httpCache.get(url);
	for (const entry of entries ?? []) {
		if (now - entry.stored > entry.lifetime) continue;
		if (Object.entries(entry.vary).every(([k, v]) => header(headers, k) === v)) {
			// most recently used last, for eviction
			httpCache.delete(url);
			httpCache.set(url, entries!);
			return entry;
		}
	}
	return null;
}

function cacheStore(url: string, method: string, requestHeaders: RawHeaders, r: { status: number; statusText: string; headers: RawHeaders; body: Buffer }) {
	if (method !== "GET" || header(requestHeaders, "authorization") || header(requestHeaders, "range")) return;
	const now = Date.now();
	const lifetime = freshnessLifetime(r.status, r.headers, now);
	if (lifetime <= 0 || r.body.byteLength > CACHE_LIMIT / 16) return;
	const entry: CachedResponse = {
		status: r.status,
		statusText: r.statusText,
		headers: r.headers.filter(([k]) => k.toLowerCase() !== "set-cookie"),
		body: r.body,
		stored: now,
		lifetime,
		vary: varyValues(r.headers, requestHeaders),
	};
	const list = (httpCache.get(url) ?? []).filter(
		(e) => JSON.stringify(e.vary) !== JSON.stringify(entry.vary)
	);
	list.push(entry);
	httpCache.delete(url);
	httpCache.set(url, list);
	httpCacheBytes += r.body.byteLength;
	for (const [key, entries] of httpCache) {
		if (httpCacheBytes <= CACHE_LIMIT) break;
		for (const e of entries) httpCacheBytes -= e.body.byteLength;
		httpCache.delete(key);
	}
}

// the response a cached entry gives, with its Age
function fromCache(entry: CachedResponse): PrefetchedResponse {
	const age = Math.floor((Date.now() - entry.stored) / 1000);
	return {
		status: entry.status,
		statusText: entry.statusText,
		headers: [...entry.headers.filter(([k]) => k.toLowerCase() !== "age"), ["age", String(age)]],
		body: entry.body,
	};
}

type PrefetchedResponse = {
	status: number;
	statusText: string;
	headers: RawHeaders;
	body: Buffer;
};
type PrefetchEntry = {
	origin: string;
	cookie: string;
	promise: Promise<PrefetchedResponse>;
};

const PREFETCH_TTL = 30_000;
const PREFETCH_PER_DOCUMENT = 80;
const PREFETCH_IMAGES = 12;

function header(headers: RawHeaders, name: string) {
	return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
}

// whether a response may be given to a request whose cookies differ from the prefetch's: one a
// shared HTTP cache could serve (RFC 9111). Set-Cookie doesn't prevent it, since it's this user's
// own session and the cookies get applied when the proxied request receives the response
function shareable(r: PrefetchedResponse) {
	const get = (name: string) =>
		r.headers
			.filter(([k]) => k.toLowerCase() === name)
			.map(([, v]) => v.toLowerCase())
			.join(",");
	if (/\b(private|no-store|no-cache)\b/.test(get("cache-control"))) return false;
	return !/\*|cookie/.test(get("vary"));
}

// undici's fetch sets Sec-Fetch-Mode to its own request's mode, "cors", whatever the browser's
// request was (it can't make "navigate" or "no-cors" requests), so every page load looked like a
// fetch() to the site: a bot signal to the bot checks some sites run. the browser's value comes in
// this header instead, and goes back in place just before the request is sent
const FETCH_MODE = "x-relay-sec-fetch-mode";
const keepFetchMode: Dispatcher.DispatcherComposeInterceptor =
	(dispatch) => (opts, handler) => {
		const headers = opts.headers;
		if (headers && typeof headers === "object" && !Array.isArray(headers)) {
			const record = headers as Record<string, string | string[] | undefined>;
			const mode = record[FETCH_MODE];
			if (typeof mode === "string") {
				const next: Record<string, string | string[] | undefined> = {};
				for (const [k, v] of Object.entries(record)) {
					const lower = k.toLowerCase();
					if (lower !== FETCH_MODE && lower !== "sec-fetch-mode") next[k] = v;
				}
				next["sec-fetch-mode"] = mode;
				opts = { ...opts, headers: next };
			}
		}
		return dispatch(opts, handler);
	};

const newAgent = (keepAlive?: number): Agent =>
	new Agent({
		allowH2: true,
		connect: connector,
		// undici closes idle connections after 4s by default; Chromium keeps them for minutes
		...(keepAlive
			? { keepAliveTimeout: keepAlive, keepAliveMaxTimeout: keepAlive }
			: {}),
	});

// the connections to sites are kept open for every browser that uses the relay, the way a proxy
// server's are: a page then skips the TCP and TLS handshakes for any site it, or anyone, loaded
// recently. RELAY_POOL=session gives each transport its own pool instead (closed with it), which
// is what a browser without the relay would have
const SHARED_POOL = process.env.RELAY_POOL !== "session";
let sharedAgent: Agent | null = null;

// one per websocket, i.e. per transport instance: the prefetches started for documents it loaded,
// and its connection pool if the pool isn't shared
class RelaySession {
	pool: Agent = SHARED_POOL ? (sharedAgent ??= newAgent(5 * 60_000)) : newAgent();
	agent: Dispatcher = this.pool.compose(keepFetchMode);
	prefetched = new Map<string, PrefetchEntry>();
	/** whether this transport asked for the shared cache */
	useCache = false;

	close() {
		if (!SHARED_POOL) this.pool.close().catch(() => {});
		this.prefetched.clear();
	}

	prefetch(url: string, headers: Record<string, string>) {
		if (this.prefetched.has(url) || this.prefetched.size > 400) return;
		const rawRequest: RawHeaders = Object.entries(headers);
		// a fresh cached copy needs no prefetch: the proxied request will hit the cache
		if (this.useCache && cacheLookup(url, "GET", rawRequest)) return;
		const promise = undiciFetch(url, {
			headers,
			redirect: "manual",
			dispatcher: this.agent,
		}).then(async (r) => {
			const raw: RawHeaders = [];
			for (const [k, v] of r.headers) if (!DROP.has(k)) raw.push([k, v]);
			const body = Buffer.from(await r.arrayBuffer());
			if (/text\/css/.test(r.headers.get("content-type") || ""))
				this.prefetchFromCss(url, body.toString("utf8"), headers);
			if (r.status === 200 && isScript(headers["sec-fetch-dest"] || "", r.headers.get("content-type") || ""))
				speculate(url, body, headers.referer || "");
			const res = { status: r.status, statusText: r.statusText, headers: raw, body };
			if (this.useCache) cacheStore(url, "GET", rawRequest, res);
			return res;
		});
		const entry: PrefetchEntry = {
			origin: headers.origin || "",
			cookie: headers.cookie || "",
			promise,
		};
		promise.catch(() => this.prefetched.delete(url));
		this.prefetched.set(url, entry);
		setTimeout(() => {
			if (this.prefetched.get(url) === entry) this.prefetched.delete(url);
		}, PREFETCH_TTL).unref();
	}

	// the prefetched response for a proxied request, if it was prefetched with the same Origin
	// and isn't a range or credentialed request. it is handed out once
	takePrefetch(url: string, method: string, headers: RawHeaders) {
		if (method !== "GET") return null;
		const entry = this.prefetched.get(url);
		if (!entry) return null;
		if (
			header(headers, "range") ||
			header(headers, "authorization") ||
			header(headers, "origin") !== entry.origin
		)
			return null;
		this.prefetched.delete(url);
		return { entry, sameCookies: header(headers, "cookie") === entry.cookie };
	}

	// a parser that, fed a document's HTML as it streams through, prefetches what the browser
	// will request eagerly: stylesheets, scripts, preloads and the first few non-lazy images
	htmlScanner(docUrl: string, docHeaders: RawHeaders, setCookies: string[]) {
		const doc = new URL(docUrl);
		const pool = this.pool;
		let base = doc;
		let count = 0;
		let images = 0;

		// the document request's cookies plus what its response set, for same-host requests
		const jar = new Map<string, string>();
		const addPair = (pair: string) => {
			const i = pair.indexOf("=");
			if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
		};
		for (const part of header(docHeaders, "cookie").split(/;\s*/)) addPair(part);
		for (const sc of setCookies) addPair(sc.split(";")[0]);
		const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

		const add = (raw: string | undefined, dest: string) => {
			if (!raw || count >= PREFETCH_PER_DOCUMENT) return;
			let u: URL;
			try {
				u = new URL(raw.trim(), base);
			} catch {
				return;
			}
			if (u.protocol !== "https:" && u.protocol !== "http:") return;
			u.hash = "";
			count++;
			const headers: Record<string, string> = {
				referer: docUrl,
				// the proxied requests carry Origin even in no-cors mode, and must match it
				origin: doc.origin,
				"sec-fetch-dest": dest,
				"sec-fetch-site": u.origin === doc.origin ? "same-origin" : "cross-site",
				// fonts load in cors mode; the rest, without a crossorigin attribute, in no-cors
				[FETCH_MODE]: dest === "font" ? "cors" : "no-cors",
				accept:
					dest === "style"
						? "text/css,*/*;q=0.1"
						: dest === "image"
							? "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
							: "*/*",
			};
			for (const name of ["user-agent", "accept-language"]) {
				const v = header(docHeaders, name);
				if (v) headers[name] = v;
			}
			if (u.host === doc.host && cookie) headers.cookie = cookie;
			this.prefetch(u.href, headers);
		};

		return new Parser(
			{
				onopentag(name, a) {
					if (name === "base" && a.href) {
						try {
							base = new URL(a.href, docUrl);
						} catch {}
					} else if (name === "link" && a.href) {
						const rel = (a.rel || "").toLowerCase().split(/\s+/);
						// the browser connects to these hosts (or resolves them) ahead of the requests script
						// will make to them, but it only sees the proxy's host in them (see preconnect)
						if (rel.includes("dns-prefetch") || rel.includes("preconnect")) {
							try {
								const u = new URL(a.href.trim(), base);
								if (u.protocol === "https:") preconnect(u.origin, pool);
								else if (u.protocol === "http:") resolveHost(u.hostname).catch(() => {});
							} catch {}
						}
						if (rel.includes("stylesheet") && a.disabled === undefined)
							add(a.href, "style");
						else if (rel.includes("modulepreload")) add(a.href, "script");
						else if (
							rel.includes("preload") &&
							["style", "script", "font", "image"].includes(a.as) &&
							!a.imagesrcset
						)
							add(a.href, a.as);
					} else if (name === "script" && a.src) {
						const type = (a.type || "").toLowerCase();
						if (!type || type === "module" || /javascript|ecmascript/.test(type))
							add(a.src, "script");
					} else if (
						name === "img" &&
						a.src &&
						!a.srcset &&
						(a.loading || "").toLowerCase() !== "lazy" &&
						images < PREFETCH_IMAGES
					) {
						images++;
						add(a.src, "image");
					}
				},
			},
			{ decodeEntities: true }
		);
	}

	// fonts and @imports, which the browser needs as soon as a stylesheet applies
	prefetchFromCss(cssUrl: string, css: string, parent: Record<string, string>) {
		const re =
			/@import\s+(?:url\()?\s*["']?([^"')\s;]+)|url\(\s*["']?([^"')]+?\.(?:woff2?|ttf|otf)(?:\?[^"')]*)?)["']?\s*\)/gi;
		let m: RegExpExecArray | null;
		let n = 0;
		while ((m = re.exec(css)) && n++ < 20) {
			let u: URL;
			try {
				u = new URL(m[1] || m[2], cssUrl);
			} catch {
				continue;
			}
			const font = !m[1];
			const headers: Record<string, string> = {
				referer: cssUrl,
				origin: parent.origin,
				accept: font ? "*/*" : "text/css,*/*;q=0.1",
				"sec-fetch-dest": font ? "font" : "style",
				[FETCH_MODE]: font ? "cors" : "no-cors",
			};
			for (const name of ["user-agent", "accept-language"])
				if (parent[name]) headers[name] = parent[name];
			this.prefetch(u.href, headers);
		}
	}
}

// ---- shared rewrite cache (opt-in per client: RelayTransport's rewriteCache) ----
// A controller's rewriter threads ask for a script's rewrite here before rewriting it themselves,
// and send the scripts they had to rewrite. The relay rewrites those itself, with scramjet's own
// build (packages/core/dist) in worker threads: an entry is never taken from a client, so no
// client can hand its rewrites to another. Entries are keyed the way the browser's rewrite cache
// keys them (rewriteKey: the build, the rewriter's config and the script's hash), and rewritten
// under a placeholder prefix whose offsets are kept, so any prefix of the same length fits.
const REWRITE_CACHE_LIMIT =
	Number(process.env.RELAY_REWRITE_CACHE_MB || 256) * 1024 * 1024;
const MAX_REWRITE_INPUT = 32 * 1024 * 1024;
const CORE_DIST = new URL("./packages/core/dist/", import.meta.url);

type RewriteEntry = {
	js: Uint8Array;
	map: Uint8Array | null;
	offsets: number[];
	tag: string;
};
const rewriteCache = new Map<string, { entry: RewriteEntry; size: number }>();
let rewriteCacheBytes = 0;

function rewriteCacheGet(key: string) {
	const hit = rewriteCache.get(key);
	if (!hit) return undefined;
	rewriteCache.delete(key);
	rewriteCache.set(key, hit);
	return hit.entry;
}

function rewriteCachePut(key: string, entry: RewriteEntry) {
	const size =
		entry.js.byteLength + (entry.map?.byteLength ?? 0) + entry.offsets.length * 8 + 128;
	if (size > REWRITE_CACHE_LIMIT / 4) return;
	const old = rewriteCache.get(key);
	if (old) {
		rewriteCache.delete(key);
		rewriteCacheBytes -= old.size;
	}
	rewriteCache.set(key, { entry, size });
	rewriteCacheBytes += size;
	for (const [k, v] of rewriteCache) {
		if (rewriteCacheBytes <= REWRITE_CACHE_LIMIT) break;
		rewriteCache.delete(k);
		rewriteCacheBytes -= v.size;
	}
}

// ---- speculative rewrites ----
// YouTube serves its 10 MB app bundle in a slightly different build on every visit (a few feature
// toggles and experiment names differ, and so does its url), so the rewrite cache never hits, and
// every visit waits ~1s for the rewrite. But the relay has the bundle first: it usually prefetches
// it from the page's HTML, well before the browser asks for it. So when a big script comes through
// that starts or ends like one the relay rewrote for a client recently (its twin), it rewrites it
// right away, the way that client would have it rewritten: the twin's header (build, settings,
// cache partition), with the new url. A client that asks for the script (rwget with its url)
// waits for that rewrite, and gets it if its key is the client's: same header, same bytes. Only
// within a partition: the twin is from the script's origin and, if it ran for another site's page
// (its initiator), the script came for a page of that site.
const SPECULATE_MIN_BYTES = 1024 * 1024;
// how much of a script's start and end identifies its twins
const TWIN_EDGE = 64 * 1024;
const TWINS = 8;
const SPECULATION_KEEP_MS = 60_000;

type Twin = {
	url: string;
	header: string;
	// its rewrite's key, if the twins thread keeps it (see patchRewrite)
	key?: string;
	// its cache partition: the script's origin, and the page's if that's another site's
	origin: string;
	initiator: string;
	length: number;
	edges: string[];
};
// the last few big scripts rewritten, newest last
const twins: Twin[] = [];
// rewrites started ahead of any client, by script url: their key and entry, or null if they failed
const speculated = new Map<string, Promise<{ key: string; entry: RewriteEntry } | null>>();

function edgeHashes(b: Uint8Array): string[] {
	const h = (part: Uint8Array) => crypto.createHash("sha1").update(part).digest("hex");
	return [
		"start:" + h(b.subarray(0, TWIN_EDGE)),
		"end:" + h(b.subarray(Math.max(0, b.byteLength - TWIN_EDGE))),
	];
}

function addTwin(header: string, length: number, edges: string[], key?: string) {
	let h: any;
	try {
		h = JSON.parse(header);
	} catch {
		return;
	}
	// a twin's header is reused with another url only where the script's url is all it holds
	if (typeof h.source !== "string" || h.base !== h.source || typeof h.origin !== "string") return;
	const url: string = h.source;
	const i = twins.findIndex((t) => t.url === url);
	if (i !== -1) twins.splice(i, 1);
	twins.push({ url, header, key, origin: h.origin, initiator: h.initiator || "", length, edges });
	if (twins.length > TWINS) twins.shift();
}

const isScript = (dest: string, contentType: string) =>
	dest === "script" || /javascript|ecmascript/i.test(contentType);

// starts the rewrite of a big script the relay is serving, if it has a twin (see above).
// `referer`: the page the script was fetched for
function speculate(url: string, body: Buffer, referer: string) {
	if (
		body.byteLength < SPECULATE_MIN_BYTES ||
		body.byteLength > MAX_REWRITE_INPUT ||
		speculated.has(url) ||
		!twins.length
	)
		return;
	const edges = edgeHashes(body);
	let origin = "", page = "";
	try {
		origin = new URL(url).origin;
		page = referer ? new URL(referer).origin : "";
	} catch {
		return;
	}
	let twin: Twin | undefined;
	for (let i = twins.length - 1; i >= 0 && !twin; i--) {
		const t = twins[i];
		if (
			t.url !== url &&
			t.origin === origin &&
			(!t.initiator || t.initiator === page) &&
			Math.abs(t.length - body.byteLength) <= body.byteLength / 50 &&
			t.edges.some((e) => edges.includes(e))
		)
			twin = t;
	}
	const pool = getRewritePool();
	if (!twin || !pool) return;
	const h = JSON.parse(twin.header);
	h.base = h.source = url;
	const header = JSON.stringify(h);
	if (LOG) console.log(`[relay] speculative rewrite of ${url.slice(0, 100)} (twin of ${twin.url.slice(0, 60)})`);
	const rewrite = () =>
		new Promise<{ key: string; entry: RewriteEntry } | null>((resolve) =>
			pool.submit({
				header,
				js: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
				input: body,
				hint: "speculative " + url,
				first: true,
				done: resolve,
			})
		);
	const started = performance.now();
	const patched = twin.key && twinWorker ? twinWorker.patch(twin.key, header, body) : null;
	speculated.set(
		url,
		patched
			? patched.then((r) => {
					if (!r) return rewrite();
					rewriteCachePut(r.key, r.entry);
					addTwin(header, body.byteLength, edges, r.key);
					if (LOG)
						console.log(
							`[relay] rewrite cache stored ${r.key.slice(0, 12)} (patched from its twin in ${Math.round(performance.now() - started)}ms)`
						);
					return r;
				})
			: rewrite()
	);
	setTimeout(() => speculated.delete(url), SPECULATION_KEEP_MS).unref();
}

// ---- a twin's rewrite, patched ----
// YouTube's app bundle differs from one visit to the next only in a few literals: feature-toggle
// numbers and base64 strings. Its rewrite is then the twin's, with those literals swapped in and
// every position the output records shifted to match (its scramtag comments, its sourcemap, the
// prefix's offsets): ~100 ms where a full rewrite takes ~450. That is only right where the
// rewriter would have made the same changes to the new script, so a literal may differ only where
// its value can't change them:
//  - a number: decimal or hex, both before and after
//  - a string: with the same quotes, on one line, and neither a member key (x["k"]), a property
//    key ({"k": v}, or anything before a colon), an import specifier, a directive nor an operand of
//    `in`, which the tokens around it in the twin tell
//  - neither: touched by any change the rewriter made to the twin
// anything else, and any surprise in the twin's rewrite, and the script is rewritten in full.
// The twins' literals are found with acorn, on a thread of their own (the twins thread), which
// keeps the last few big scripts with their rewrites and does the patching.

type Spans = { starts: Int32Array; ends: Int32Array; kinds: Uint8Array };
// a literal that changed: [start, end) in the twin, [start, end) in the new script
type LiteralChange = [number, number, number, number];

const STR = 1,
	NUM = 2;
// the tokens a changeable string may follow, and come before (acorn's token labels)
const STR_PREV = new Set(["=", ",", "(", "?", "+/-", "||", "&&", "??", "==/!=/===/!==", "return"]);
const STR_NEXT = new Set([",", ")", ";", "]", "}", "+/-", "||", "&&", "??", "==/!=/===/!==", ".", "?"]);
// decimal (without legacy octal), or hex
const PLAIN_NUM = /^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|0[xX][0-9a-fA-F]+)$/;
const TWIN_CACHE = 4;

// the literals of a script that may change in its twins, by byte range of their whole token
export function analyzeLiterals(acorn: any, input: Buffer, isModule = false): Spans | null {
	const src = input.toString("utf8");
	const starts: number[] = [], ends: number[] = [], kinds: number[] = [];
	// utf-16 index -> byte offset, advanced along the tokens, which come in order
	let ci = 0, bi = 0;
	const toByte = (i: number) => {
		bi += Buffer.byteLength(src.slice(ci, i));
		ci = i;
		return bi;
	};
	const push = (start: number, end: number, kind: number) => {
		starts.push(toByte(start));
		ends.push(toByte(end));
		kinds.push(kind);
	};
	// the two tokens before this one, and a string waiting for the token after it
	let prev2 = "", prev = "";
	let pending: { start: number; end: number } | null = null;
	const onToken = (tok: { type: { label: string }; start: number; end: number }) => {
		const label = tok.type.label;
		if (pending) {
			if (STR_NEXT.has(label)) push(pending.start, pending.end, STR);
			pending = null;
		}
		if (label === "num") {
			if (PLAIN_NUM.test(src.slice(tok.start, tok.end))) push(tok.start, tok.end, NUM);
		} else if (label === "string") {
			if (STR_PREV.has(prev) && !(prev === "(" && prev2 === "import"))
				pending = { start: tok.start, end: tok.end };
		}
		prev2 = prev;
		prev = label;
	};
	try {
		acorn.parse(src, {
			ecmaVersion: "latest",
			sourceType: isModule ? "module" : "script",
			allowHashBang: true,
			allowReturnOutsideFunction: true,
			onToken,
		});
	} catch {
		return null;
	}
	return { starts: Int32Array.from(starts), ends: Int32Array.from(ends), kinds: Uint8Array.from(kinds) };
}

// the first k with a[i + k] !== b[j + k], or the length of the shorter rest
function sameRun(a: Buffer, i: number, b: Buffer, j: number) {
	const n = Math.min(a.length - i, b.length - j);
	let k = 0;
	for (const w of [1 << 16, 1 << 12, 1 << 8, 1 << 4])
		while (k + w <= n && b.compare(a, i + k, i + k + w, j + k, j + k + w) === 0) k += w;
	while (k < n && a[i + k] === b[j + k]) k++;
	return k;
}

// the literal whose token holds byte p (or, a number's, ends at p: it may have grown), or -1
function literalAt(spans: Spans, p: number) {
	const { starts, ends, kinds } = spans;
	let lo = 0, hi = starts.length - 1, found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (starts[mid] <= p) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	if (found === -1) return -1;
	return p < ends[found] || (p === ends[found] && kinds[found] === NUM) ? found : -1;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const isHex = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

// the end of the string literal whose opening quote is at s, or -1 if it isn't one the rewriter
// would take as it is: one line of valid UTF-8, with only plain escapes (no octal, no \u{})
function stringEnd(buf: Buffer, s: number) {
	const q = buf[s];
	for (let i = s + 1; i < buf.length; i++) {
		const c = buf[i];
		if (c === q) {
			try {
				utf8.decode(buf.subarray(s, i + 1));
			} catch {
				return -1;
			}
			return i + 1;
		}
		if (c === 0x0a || c === 0x0d) return -1;
		if (c === 0x5c) {
			const n = buf[++i];
			if (n === 0x78) {
				if (!isHex(buf[i + 1]) || !isHex(buf[i + 2])) return -1;
				i += 2;
			} else if (n === 0x75) {
				for (let k = 1; k <= 4; k++) if (!isHex(buf[i + k])) return -1;
				i += 4;
			} else if (n === 0x30) {
				if (buf[i + 1] >= 0x30 && buf[i + 1] <= 0x39) return -1;
			} else if (!"\\\"'nrtbfv/".includes(String.fromCharCode(n))) return -1;
		}
	}
	return -1;
}

// a number token can't be followed by an identifier character, so it ends where they do
function numberEnd(buf: Buffer, s: number) {
	let i = s;
	for (; i < buf.length; i++) {
		const c = buf[i];
		if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2e || c === 0x5f || c === 0x24))
			break;
	}
	return PLAIN_NUM.test(buf.toString("latin1", s, i)) ? i : -1;
}

// the literals that changed from `old` to `next`, or null if anything else did
function diffLiterals(old: Buffer, spans: Spans, next: Buffer): LiteralChange[] | null {
	const changes: LiteralChange[] = [];
	let i = 0, j = 0;
	for (;;) {
		const k = sameRun(old, i, next, j);
		if (i + k === old.length && j + k === next.length) return changes;
		const li = literalAt(spans, i + k);
		if (li === -1) return null;
		const s0 = spans.starts[li], e0 = spans.ends[li];
		if (s0 < i) return null;
		const s1 = s0 + (j - i);
		let e1: number;
		if (spans.kinds[li] === STR) {
			if (next[s1] !== old[s0]) return null;
			e1 = stringEnd(next, s1);
		} else e1 = numberEnd(next, s1);
		if (e1 === -1 || changes.length >= 10_000) return null;
		changes.push([s0, e0, s1, e1]);
		i = e0;
		j = e1;
	}
}

// the twin's literals, moved to where they are in the new script
export function shiftSpans(spans: Spans, changes: LiteralChange[]): Spans {
	const starts = new Int32Array(spans.starts.length), ends = new Int32Array(spans.ends.length);
	let c = 0, delta = 0;
	for (let i = 0; i < spans.starts.length; i++) {
		while (c < changes.length && changes[c][1] <= spans.starts[i]) {
			delta = changes[c][3] - changes[c][1];
			c++;
		}
		const changed = c < changes.length && changes[c][0] === spans.starts[i];
		starts[i] = spans.starts[i] + delta;
		ends[i] = changed ? changes[c][3] : spans.ends[i] + delta;
	}
	return { starts, ends, kinds: spans.kinds };
}

const TAG_OPEN = Buffer.from("/*scramtag ");

/**
 * The rewrite of `next` from its twin's (`old`, its literals `spans` and rewrite `entry`, with
 * `placeholder` for the prefix), or null when it can't be had that way: see above.
 */
export function patchRewrite(
	old: Buffer,
	spans: Spans,
	entry: RewriteEntry,
	next: Buffer,
	placeholder: Buffer
): { entry: RewriteEntry; changes: LiteralChange[] } | null {
	if (!entry.map || next.indexOf(placeholder) !== -1) return null;
	const changes = diffLiterals(old, spans, next);
	if (!changes) return null;
	const js = Buffer.from(entry.js.buffer, entry.js.byteOffset, entry.js.byteLength);
	const mapBytes = Buffer.from(entry.map.buffer, entry.map.byteOffset, entry.map.byteLength);

	// the rewriter's changes, from its sourcemap: [position in the output, inserted length, op,
	// (replace) replaced length, replaced text]. positions are in the output
	const n = mapBytes.readUInt32LE(0);
	const at = new Int32Array(n), pos = new Int32Array(n), size = new Int32Array(n);
	const inStart = new Int32Array(n), inEnd = new Int32Array(n);
	let cursor = 4, offset = 0;
	for (let e = 0; e < n; e++) {
		if (cursor + 9 > mapBytes.length) return null;
		at[e] = cursor;
		pos[e] = mapBytes.readUInt32LE(cursor);
		size[e] = mapBytes.readUInt32LE(cursor + 4);
		const op = mapBytes[cursor + 8];
		cursor += 9;
		inStart[e] = pos[e] - offset;
		if (op === 0) {
			inEnd[e] = inStart[e];
			offset += size[e];
		} else if (op === 1) {
			const oldLen = mapBytes.readUInt32LE(cursor);
			cursor += 4 + oldLen;
			inEnd[e] = inStart[e] + oldLen;
			offset += size[e] - oldLen;
		} else return null;
	}
	if (cursor !== mapBytes.length) return null;

	// the literals' places in the output: where the input is copied through, untouched by changes
	const lits: { o: number; len: number; rep: Buffer }[] = [];
	let e = 0;
	offset = 0;
	for (const [s0, e0, s1, e1] of changes) {
		while (e < n && inStart[e] < s0) {
			if (inEnd[e] >= s0 && inEnd[e] !== inStart[e]) return null;
			offset = pos[e] + size[e] - inEnd[e];
			e++;
		}
		if (e < n && inStart[e] <= e0) return null;
		const o = s0 + offset;
		if (js.compare(old, s0, e0, o, o + (e0 - s0)) !== 0) return null;
		lits.push({ o, len: e0 - s0, rep: next.subarray(s1, e1) });
	}
	if (!lits.length) return { entry, changes };

	// the scramtags from the first change on: /*scramtag <its own position in the output> <tag>*/
	const tagEnd = Buffer.from(" " + entry.tag + "*/");
	const tags: { x: number; ds: number; de: number; entry: number; digits: string }[] = [];
	let m = 0;
	for (let x = js.indexOf(TAG_OPEN, lits[0].o); x !== -1; x = js.indexOf(TAG_OPEN, x + 1)) {
		const ds = x + TAG_OPEN.length;
		let de = ds;
		while (js[de] >= 0x30 && js[de] <= 0x39) de++;
		// the rewrite's random tag tells its comments from the same text in the script
		if (de === ds || js.compare(tagEnd, 0, tagEnd.length, de, de + tagEnd.length) !== 0) continue;
		if (Number(js.toString("latin1", ds, de)) !== x) return null;
		// its change: the insert of the comment at x
		const len = de + tagEnd.length - x;
		while (m < n && pos[m] < x) m++;
		let f = m;
		while (f < n && pos[f] === x && !(size[f] === len && inStart[f] === inEnd[f])) f++;
		if (f === n || pos[f] !== x) return null;
		tags.push({ x, ds, de, entry: f, digits: "" });
	}

	// the output's pieces, in order: [from, to) of the twin's output, then the bytes to put there
	const cuts: { from: number; to: number; rep: Buffer | string; moveAt: number }[] = [];
	for (let li = 0, ti = 0, delta = 0; li < lits.length || ti < tags.length; ) {
		if (ti === tags.length || (li < lits.length && lits[li].o < tags[ti].x)) {
			const { o, len, rep } = lits[li++];
			cuts.push({ from: o, to: o + len, rep, moveAt: o + len });
			delta += rep.length - len;
		} else {
			const tag = tags[ti++];
			const { x, ds, de } = tag;
			const digits = (tag.digits = String(x + delta));
			// the comment's own position doesn't move with its new length
			cuts.push({ from: ds, to: de, rep: digits, moveAt: x + 1 });
			delta += digits.length - (de - ds);
		}
	}
	let total = js.length;
	for (const c of cuts) total += c.rep.length - (c.to - c.from);
	const out = Buffer.allocUnsafe(total);
	let w = 0, r = 0;
	for (const c of cuts) {
		w += js.copy(out, w, r, c.from);
		w += typeof c.rep === "string" ? out.write(c.rep, w, "latin1") : c.rep.copy(out, w);
		r = c.to;
	}
	js.copy(out, w, r);

	// moves a sorted run of positions in the twin's output to the new output
	const mover = () => {
		let ci = 0, delta = 0;
		return (p: number) => {
			while (ci < cuts.length && cuts[ci].moveAt <= p) {
				delta += cuts[ci].rep.length - (cuts[ci].to - cuts[ci].from);
				ci++;
			}
			return p + delta;
		};
	};
	const newMap = Buffer.from(mapBytes);
	const movePos = mover();
	for (let i = 0; i < n; i++) newMap.writeUInt32LE(movePos(pos[i]), at[i]);
	for (const t of tags)
		if (t.digits.length !== t.de - t.ds)
			newMap.writeUInt32LE(size[t.entry] + t.digits.length - (t.de - t.ds), at[t.entry] + 4);
	const moveOffset = mover();
	const offsets = entry.offsets.map(moveOffset);
	for (const o of offsets)
		if (out.compare(placeholder, 0, placeholder.length, o, o + placeholder.length) !== 0) return null;
	return {
		entry: {
			js: new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
			map: new Uint8Array(newMap.buffer, newMap.byteOffset, newMap.byteLength),
			offsets,
			tag: entry.tag,
		},
		changes,
	};
}

// the twins thread, as the relay sees it
class TwinWorker {
	private worker: Worker;
	private waiting = new Map<number, (r: { key: string; entry: RewriteEntry } | null) => void>();
	private nextId = 1;

	constructor() {
		this.worker = new Worker(new URL(import.meta.url), {
			workerData: { role: "twins", dist: CORE_DIST.pathname },
		});
		this.worker.unref();
		this.worker.on("message", (m) => {
			const done = this.waiting.get(m.id);
			this.waiting.delete(m.id);
			if (LOG && m.why) console.log(`[relay] twin's rewrite not patched: ${m.why}`);
			done?.(m.key ? { key: m.key, entry: m.entry } : null);
		});
		this.worker.on("error", (e) => {
			console.warn("[relay] twins thread failed:", e);
			for (const done of this.waiting.values()) done(null);
			this.waiting.clear();
			twinWorker = null;
		});
	}

	// a big script and its rewrite, for its twins to come (`stamp`: the build that rewrote it)
	add(key: string, header: string, input: Buffer, entry: RewriteEntry, stamp: string) {
		this.worker.postMessage({ t: "add", key, header, input, entry, stamp });
	}

	// the rewrite of `input` under `header`, patched from the twin rewritten under `key`
	patch(key: string, header: string, input: Buffer) {
		const id = this.nextId++;
		return new Promise<{ key: string; entry: RewriteEntry } | null>((resolve) => {
			this.waiting.set(id, resolve);
			this.worker.postMessage({ t: "patch", id, twin: key, header, input });
		});
	}

	clear() {
		this.worker.postMessage({ t: "clear" });
	}
}

let twinWorker: TwinWorker | null = null;

// the twins thread itself: this module, run with workerData.role "twins"
async function runTwinWorker() {
	const acorn = await import("acorn");
	const jsPath = workerData.dist + "scramjet.js", wasmPath = workerData.dist + "scramjet.wasm";
	// scramjet's build, for the rewrite keys: its stamp is the one the rewriter threads report
	let stamp = "";
	const load = () => {
		const now = fs.statSync(jsPath).mtimeMs + ":" + fs.statSync(wasmPath).mtimeMs;
		if (now === stamp) return;
		(globalThis as any).self = globalThis;
		vm.runInThisContext(fs.readFileSync(jsPath, "utf8"), { filename: jsPath });
		(globalThis as any).$scramjet.setWasm(fs.readFileSync(wasmPath));
		stamp = now;
	};
	type Kept = {
		input: Buffer;
		isModule: boolean;
		entry: RewriteEntry;
		spans: Spans | null | undefined;
		stamp: string;
	};
	const kept = new Map<string, Kept>();
	const keep = (key: string, k: Kept) => {
		kept.delete(key);
		kept.set(key, k);
		if (kept.size > TWIN_CACHE) kept.delete(kept.keys().next().value!);
		// found after the page that brought it has had its turn at the CPU
		if (k.spans === undefined)
			setTimeout(() => {
				if (k.spans === undefined) k.spans = analyzeLiterals(acorn, k.input, k.isModule);
			}, 3000);
	};
	parentPort!.on("message", async (m) => {
		if (m.t === "clear") return kept.clear();
		if (m.t === "add") {
			const input = Buffer.from(m.input.buffer, m.input.byteOffset, m.input.byteLength);
			let isModule = false;
			try {
				isModule = !!JSON.parse(m.header).isModule;
			} catch {
				return;
			}
			return keep(m.key, { input, isModule, entry: m.entry, spans: undefined, stamp: m.stamp });
		}
		if (m.t !== "patch") return;
		const fail = (why: string) => parentPort!.postMessage({ id: m.id, why });
		try {
			load();
			const twin = kept.get(m.twin);
			if (!twin) return fail("twin no longer kept");
			if (twin.stamp !== stamp) return fail("scramjet was rebuilt");
			if (twin.spans === undefined) return fail("twin not analyzed yet");
			if (!twin.spans) return fail("twin doesn't parse");
			const h = JSON.parse(m.header);
			const placeholder = Buffer.from("/" + "a".repeat(h.prefixLength - 2) + "/");
			const input = Buffer.from(m.input.buffer, m.input.byteOffset, m.input.byteLength);
			const patched = patchRewrite(twin.input, twin.spans, twin.entry, input, placeholder);
			if (!patched) return fail("not only literals changed, or one that can't");
			const key: string = await (globalThis as any).$scramjet.rewriteKey(m.header, input);
			// the relay keeps the patched script as a twin too: this thread keeps its own copy
			keep(key, {
				input,
				isModule: twin.isModule,
				entry: { ...patched.entry, js: patched.entry.js.slice(), map: patched.entry.map!.slice() },
				spans: shiftSpans(twin.spans, patched.changes),
				stamp,
			});
			parentPort!.postMessage({ id: m.id, key, entry: patched.entry }, [
				patched.entry.js.buffer as ArrayBuffer,
				patched.entry.map!.buffer as ArrayBuffer,
			]);
		} catch (e) {
			fail(String((e as Error)?.message || e));
		}
	});
}


// runs in each rewriter thread: scramjet's bundle, reloaded when the build changes
const REWRITE_WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jsPath = workerData.dist + "scramjet.js";
const wasmPath = workerData.dist + "scramjet.wasm";
let stamp = "";
function load() {
	const now = fs.statSync(jsPath).mtimeMs + ":" + fs.statSync(wasmPath).mtimeMs;
	if (now === stamp) return false;
	globalThis.self = globalThis;
	vm.runInThisContext(fs.readFileSync(jsPath, "utf8"), { filename: jsPath });
	globalThis.$scramjet.setWasm(fs.readFileSync(wasmPath));
	stamp = now;
	return true;
}
// the controller's default codec (Config.codec), the only one run here; it encodes the import
// specifiers of modules. a script rewritten under another codec that needs it fails, and isn't kept
const DEFAULT_CODEC = [
	/^\(?([A-Za-z_$][\w$]*)\)?=>\1\?encodeURIComponent\(\1\):\1$/,
	/^\(?([A-Za-z_$][\w$]*)(?::string)?\)?=>\{if\(!\1\)return\1;?returnencodeURIComponent\(\1\);?\}$/,
];
const isDefaultCodec = (src) => DEFAULT_CODEC.some((re) => re.test(String(src).replace(/\s+/g, "")));
const encodeDefault = (u) => (u ? encodeURIComponent(u) : u);
const refuse = () => { throw new Error("not the default codec"); };
parentPort.on("message", async ({ id, header, js }) => {
	let reloaded = false;
	try {
		reloaded = load();
		const sj = globalThis.$scramjet;
		const h = JSON.parse(header);
		if (!Number.isInteger(h.prefixLength) || h.prefixLength < 2 || h.prefixLength > 1024)
			throw new Error("bad prefix length");
		// a placeholder no rewriter output contains but where the prefix goes
		const prefix = "/" + "a".repeat(h.prefixLength - 2) + "/";
		const context = {
			config: { globals: h.globals, flags: h.flags, siteFlags: {} },
			prefix: new URL(prefix, "http://relay.invalid"),
			interface: { codecEncode: isDefaultCodec(h.codec) ? encodeDefault : refuse, codecDecode: decodeURIComponent },
		};
		const meta = { origin: new URL(h.origin), base: new URL(h.base), initiatorOrigin: h.initiator };
		const input = new Uint8Array(js);
		const key = await sj.rewriteKey(header, input);
		const res = sj.rewriteJsInner(input, h.source, context, meta, !!h.isModule);
		if (res.errors.length) return parentPort.postMessage({ id, reloaded });
		const entry = sj.templateRewrite({ js: res.js, map: res.map, tag: res.tag }, input, new TextEncoder().encode(prefix));
		// a big script's start and end, to know its twins by (see speculate)
		let edges;
		if (entry && input.byteLength >= ${SPECULATE_MIN_BYTES}) {
			const hash = (part) => crypto.createHash("sha1").update(part).digest("hex");
			edges = ["start:" + hash(input.subarray(0, ${TWIN_EDGE})), "end:" + hash(input.subarray(Math.max(0, input.byteLength - ${TWIN_EDGE})))];
		}
		parentPort.postMessage({ id, reloaded, key, entry, edges, length: input.byteLength, stamp });
	} catch (e) {
		parentPort.postMessage({ id, reloaded, error: String((e && e.message) || e) });
	}
});
`;

type RewriteJob = {
	header: string;
	js: ArrayBuffer;
	// the script, kept on this thread: a big one's twins may be patched from it
	input?: Buffer;
	hint: string;
	// ahead of the queue: a client may wait for it
	first?: boolean;
	done?: (result: { key: string; entry: RewriteEntry } | null) => void;
};

class RewritePool {
	private idle: Worker[] = [];
	private queue: RewriteJob[] = [];
	// the hints (client keys) of jobs queued or running, so a script sent twice is rewritten once
	private hints = new Set<string>();
	private running = new Map<Worker, RewriteJob>();

	constructor(size: number) {
		for (let i = 0; i < size; i++) {
			const worker = new Worker(REWRITE_WORKER, {
				eval: true,
				workerData: { dist: CORE_DIST.pathname },
			});
			worker.unref();
			worker.on("message", (m) => this.done(worker, m));
			worker.on("error", (e) => {
				console.warn("[relay] rewrite worker failed:", e);
				const job = this.running.get(worker);
				if (job) this.hints.delete(job.hint);
				job?.done?.(null);
				this.running.delete(worker);
			});
			this.idle.push(worker);
		}
	}

	submit(job: RewriteJob) {
		if (this.hints.has(job.hint) || (!job.first && this.queue.length >= 32))
			return job.done?.(null);
		this.hints.add(job.hint);
		if (job.first) this.queue.unshift(job);
		else this.queue.push(job);
		this.pump();
	}

	private pump() {
		while (this.idle.length && this.queue.length) {
			const worker = this.idle.pop()!;
			const job = this.queue.shift()!;
			this.running.set(worker, job);
			worker.postMessage({ id: 0, header: job.header, js: job.js }, [job.js]);
		}
	}

	private done(worker: Worker, m: any) {
		const job = this.running.get(worker);
		this.running.delete(worker);
		if (job) this.hints.delete(job.hint);
		// a rebuilt scramjet makes different keys and output: what's kept was made by the old one
		if (m.reloaded) {
			rewriteCache.clear();
			rewriteCacheBytes = 0;
			twins.length = 0;
			twinWorker?.clear();
		}
		if (m.key && m.entry) {
			rewriteCachePut(m.key, m.entry);
			if (job && m.edges) {
				// the twins thread gets its own copy of the rewrite
				if (job.input && twinWorker) twinWorker.add(m.key, job.header, job.input, m.entry, m.stamp);
				addTwin(job.header, m.length, m.edges, job.input && twinWorker ? m.key : undefined);
			}
			job?.done?.({ key: m.key, entry: m.entry });
			if (LOG)
				console.log(
					`[relay] rewrite cache stored ${m.key.slice(0, 12)} (${Math.round(m.entry.js.byteLength / 1024)}KB${job?.first ? ", speculative" : m.key === job?.hint ? "" : ", client key differs"})`
				);
		} else {
			job?.done?.(null);
			if (LOG)
				console.log(`[relay] rewrite not kept: ${m.error ?? "parse errors or prefix in the script"}`);
		}
		this.idle.push(worker);
		this.pump();
	}
}

let rewritePool: RewritePool | null | undefined;
function getRewritePool() {
	if (rewritePool === undefined) {
		if (
			fs.existsSync(new URL("scramjet.js", CORE_DIST)) &&
			fs.existsSync(new URL("scramjet.wasm", CORE_DIST))
		) {
			rewritePool = new RewritePool(
				Math.max(1, Math.min(2, os.availableParallelism() - 1))
			);
			twinWorker = new TwinWorker();
		} else {
			console.warn(
				"[relay] no scramjet build in packages/core/dist: the shared rewrite cache is off"
			);
			rewritePool = null;
		}
	}
	return rewritePool;
}

function rewritePut(msg: any, body: Buffer) {
	if (
		typeof msg.header !== "string" ||
		msg.header.length > 64 * 1024 ||
		typeof msg.key !== "string" ||
		body.byteLength > MAX_REWRITE_INPUT ||
		rewriteCache.has(msg.key)
	)
		return;
	// its own copy, transferred to the thread
	const js = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	getRewritePool()?.submit({ header: msg.header, js, input: body, hint: msg.key });
}

function handleMuxSocket(ws: WebSocket) {
	const session = new RelaySession();
	const live = new Map<number, AbortController>();
	const waitingForBody = new Map<number, any>();

	const sendChunk = (id: number, chunk: Uint8Array) => {
		const buf = Buffer.allocUnsafe(4 + chunk.byteLength);
		buf.writeUInt32LE(id, 0);
		buf.set(chunk, 4);
		ws.send(buf);
	};
	const sendJson = (msg: object) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
	};
	// a response the relay already has whole: one message where head, body and end took three
	const sendResponse = (msg: any, r: PrefetchedResponse) => {
		if (!msg.whole) {
			sendJson({ t: "head", id: msg.id, status: r.status, statusText: r.statusText, headers: r.headers });
			if (r.body.byteLength) sendChunk(msg.id, r.body);
			sendJson({ t: "end", id: msg.id });
			return;
		}
		const head = Buffer.from(JSON.stringify({ status: r.status, statusText: r.statusText, headers: r.headers }));
		const frame = Buffer.allocUnsafe(8 + head.byteLength + r.body.byteLength);
		frame.writeUInt32LE((msg.id | WHOLE) >>> 0, 0);
		frame.writeUInt32LE(head.byteLength, 4);
		frame.set(head, 8);
		frame.set(r.body, 8 + head.byteLength);
		if (ws.readyState === WebSocket.OPEN) ws.send(frame);
	};

	const sendRewrite = (id: number, entry: RewriteEntry) => {
		sendJson({ t: "rwhit", id, tag: entry.tag, offsets: entry.offsets, jsLength: entry.js.byteLength });
		const frame = Buffer.allocUnsafe(4 + entry.js.byteLength + (entry.map?.byteLength ?? 0));
		frame.writeUInt32LE(id, 0);
		frame.set(entry.js, 4);
		if (entry.map) frame.set(entry.map, 4 + entry.js.byteLength);
		if (ws.readyState === WebSocket.OPEN) ws.send(frame);
	};

	async function run(msg: any, body?: Buffer) {
		const started = performance.now();
		const ac = new AbortController();
		live.set(msg.id, ac);
		try {
			const headers: RawHeaders = msg.headers;
			const dest = header(headers, "sec-fetch-dest").toLowerCase();
			if (dest === "document" || dest === "iframe") {
				try {
					for (const origin of learnedOrigins.get(new URL(msg.url).origin) ?? [])
						preconnect(origin, session.pool);
				} catch {}
			} else {
				const referer = header(headers, "referer");
				if (referer) learnOrigin(referer, msg.url);
			}
			if (msg.cache) {
				session.useCache = true;
				const hit = cacheLookup(msg.url, msg.method, headers);
				if (hit) {
					const r = fromCache(hit);
					sendResponse(msg, r);
					if (r.status === 200 && isScript(dest, header(r.headers, "content-type")))
						speculate(msg.url, r.body, header(headers, "referer"));
					return;
				}
			}
			const pre = msg.prefetch
				? session.takePrefetch(msg.url, msg.method, headers)
				: null;
			if (pre) {
				const r = await pre.entry.promise.catch(() => null);
				if (r && (pre.sameCookies || shareable(r))) {
					sendResponse(msg, r);
					return;
				}
			}

			const h = new Headers();
			for (const [k, v] of headers) {
				if (REQUEST_DROP.has(k.toLowerCase())) continue;
				try {
					h.append(k, v);
					if (k.toLowerCase() === "sec-fetch-mode") h.set(FETCH_MODE, v);
				} catch {}
			}
			const r = await undiciFetch(msg.url, {
				method: msg.method,
				headers: h,
				body: body ?? undefined,
				redirect: "manual",
				signal: ac.signal,
				dispatcher: session.agent,
			});
			const raw: RawHeaders = [];
			for (const [k, v] of r.headers) if (!DROP.has(k)) raw.push([k, v]);
			sendJson({ t: "head", id: msg.id, status: r.status, statusText: r.statusText, headers: raw });
			const headAt = performance.now();

			const scanner =
				msg.prefetch &&
				(dest === "document" || dest === "iframe") &&
				/text\/html/.test(r.headers.get("content-type") || "")
					? session.htmlScanner(msg.url, headers, r.headers.getSetCookie())
					: null;
			const decoder = scanner ? new TextDecoder() : null;
			// keep the body for the cache only if the response may be stored at all
			const keep =
				msg.cache &&
				freshnessLifetime(r.status, raw, Date.now()) > 0 &&
				msg.method === "GET";
			// a big script's body is kept too, to rewrite ahead of the client (see speculate)
			const script =
				r.status === 200 &&
				twins.length > 0 &&
				isScript(dest, r.headers.get("content-type") || "") &&
				(r.headers.has("content-encoding") ||
					Number(r.headers.get("content-length") ?? SPECULATE_MIN_BYTES) >= SPECULATE_MIN_BYTES);
			const chunks: Uint8Array[] = [];
			if (r.body) {
				for await (const chunk of r.body) {
					sendChunk(msg.id, chunk);
					if (keep || script) chunks.push(chunk);
					if (scanner) scanner.write(decoder!.decode(chunk, { stream: true }));
				}
			}
			const whole = keep || script ? Buffer.concat(chunks) : null;
			scanner?.end();
			if (LOG)
				console.log(
					`[relay] ${r.status} ${Math.round(headAt - started)}ms head, ${Math.round(performance.now() - started)}ms end ${msg.url.slice(0, 100)}`
				);
			if (keep)
				cacheStore(msg.url, msg.method, headers, {
					status: r.status,
					statusText: r.statusText,
					headers: raw,
					body: whole!,
				});
			sendJson({ t: "end", id: msg.id });
			if (script) speculate(msg.url, whole!, header(headers, "referer"));
		} catch (e: any) {
			sendJson({ t: "err", id: msg.id, error: String(e?.cause ?? e) });
		} finally {
			live.delete(msg.id);
		}
	}

	ws.on("message", (data: Buffer, isBinary) => {
		if (isBinary) {
			const id = data.readUInt32LE(0);
			const msg = waitingForBody.get(id);
			waitingForBody.delete(id);
			if (msg?.t === "rwput") rewritePut(msg, data.subarray(4));
			else if (msg) run(msg, data.subarray(4));
			return;
		}
		let msg: any;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (msg.t === "req") {
			if (msg.body) waitingForBody.set(msg.id, msg);
			else run(msg);
		} else if (msg.t === "rwget") {
			if (typeof msg.key !== "string") return sendJson({ t: "rwmiss", id: msg.id });
			const entry = rewriteCacheGet(msg.key);
			const pending = !entry && typeof msg.url === "string" ? speculated.get(msg.url) : undefined;
			if (LOG)
				console.log(
					`[relay] rewrite cache ${entry ? `hit (${Math.round(entry.js.byteLength / 1024)}KB)` : pending ? "miss, waiting for its speculative rewrite" : "miss"} ${msg.key.slice(0, 12)}`
				);
			if (entry) return sendRewrite(msg.id, entry);
			if (!pending) return sendJson({ t: "rwmiss", id: msg.id });
			const started = performance.now();
			pending.then((done) => {
				const hit = done?.key === msg.key;
				if (LOG)
					console.log(
						`[relay] speculative rewrite ${hit ? "used" : done ? "had another key" : "failed"} after ${Math.round(performance.now() - started)}ms ${msg.key.slice(0, 12)}`
					);
				if (hit) sendRewrite(msg.id, done!.entry);
				else sendJson({ t: "rwmiss", id: msg.id });
			});
		} else if (msg.t === "rwput") {
			waitingForBody.set(msg.id, msg);
		} else if (msg.t === "abort") {
			live.get(msg.id)?.abort();
		}
	});
	ws.on("close", () => {
		for (const ac of live.values()) ac.abort();
		session.close();
	});
}

// a proxied websocket: the first message to the browser is {protocol, extensions} or {error}
function handleWebSocketRelay(client: WebSocket, url: URL) {
	let upstream: WebSocket;
	try {
		const target = url.searchParams.get("url")!;
		const protocols: string[] = JSON.parse(url.searchParams.get("protocols") || "[]");
		const headers: Record<string, string> = Object.fromEntries(
			JSON.parse(url.searchParams.get("headers") || "[]")
		);
		for (const k of Object.keys(headers))
			if (REQUEST_DROP.has(k.toLowerCase())) delete headers[k];
		// throws for a url ws rejects (one with a fragment, say), which must not take the server down
		upstream = new WebSocket(target, protocols, { headers });
	} catch (e) {
		client.send(JSON.stringify({ error: String(e) }));
		client.close();
		return;
	}
	const pending: (string | Buffer)[] = [];
	upstream.on("open", () => {
		client.send(JSON.stringify({ protocol: upstream.protocol, extensions: upstream.extensions }));
		for (const m of pending) upstream.send(m);
		pending.length = 0;
	});
	upstream.on("message", (data: Buffer, isBinary) => client.send(isBinary ? data : data.toString()));
	upstream.on("close", (code, reason) => client.close(code === 1005 ? 1000 : code, reason.toString()));
	upstream.on("error", (e) => {
		try {
			client.send(JSON.stringify({ error: String(e) }));
		} catch {}
		client.close();
	});
	client.on("message", (data: Buffer, isBinary) => {
		const m = isBinary ? data : data.toString();
		if (upstream.readyState === WebSocket.OPEN) upstream.send(m);
		else pending.push(m);
	});
	client.on("close", () => upstream.close());
}

/**
 * Serves the relay on `server` at /relay and /relay/ws. Upgrades for other paths are left to
 * whatever else listens on the server (call this first, and route the rest yourself).
 * Returns a function that handles an upgrade, or returns false when it isn't the relay's.
 */
export function createRelay() {
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
	return (req: http.IncomingMessage, socket: any, head: Buffer): boolean => {
		const url = new URL(req.url || "/", "http://relay");
		if (url.pathname === "/relay" || url.pathname === "/relay/") {
			wss.handleUpgrade(req, socket, head, (ws) => handleMuxSocket(ws));
			return true;
		}
		if (url.pathname === "/relay/ws") {
			wss.handleUpgrade(req, socket, head, (ws) => handleWebSocketRelay(ws, url));
			return true;
		}
		return false;
	};
}

// this module is the twins thread too (see TwinWorker)
if (!isMainThread && workerData?.role === "twins") runTwinWorker();
