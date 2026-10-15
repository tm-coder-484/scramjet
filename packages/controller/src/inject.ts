import type {
	RawHeaders,
	ProxyTransport,
	TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";

import { RpcHelper } from "@mercuryworkshop/rpc";
import type { Config } from ".";
import {
	CONTROLLERFRAME,
	PLAIN_NATIVES,
	WASM_DIGEST,
	WASM_MODULE,
} from "./symbols";
import type {
	SerializedCookieSyncEntry,
	ControllerToTransport,
	TransportToController,
	WebSocketMessage,
} from "./types";
import {
	CookieJar,
	SCRAMJETCLIENT,
	ScramjetClient,
	setWasm,
	sharePlainNatives,
	Tap,
	WORKERTRANSPORT,
	type CookieSyncOptions,
	type ScramjetClientInit,
	type ScramjetConfig,
	type ScramjetContext,
	type TrackedHistoryState,
} from "@mercuryworkshop/scramjet";

const MessagePort_postMessage = MessagePort.prototype.postMessage;
// grabbed before the client hooks these, for the worker transport handoff
const EventTarget_addEventListener = EventTarget.prototype.addEventListener;
const EventTarget_removeEventListener =
	EventTarget.prototype.removeEventListener;
const postMessage = (
	port: MessagePort,
	data: any,
	transfer?: Transferable[]
) => {
	MessagePort_postMessage.call(port, data, transfer as any);
};

class RemoteTransport implements ProxyTransport {
	private readyResolve!: () => void;
	private readyPromise: Promise<void> = new Promise((resolve) => {
		this.readyResolve = resolve;
	});

	public ready = false;
	async init() {
		await this.readyPromise;
		this.ready = true;
	}

	private rpc: RpcHelper<ControllerToTransport, TransportToController>;
	public port: MessagePort | null = null;
	// calls made before a worker receives its port
	private queued: [any, Transferable[]][] = [];
	constructor(port?: MessagePort) {
		this.rpc = new RpcHelper<ControllerToTransport, TransportToController>(
			{
				ready: async () => {
					this.readyResolve();
				},
			},
			"transport",
			(data, transfer) => {
				if (this.port) postMessage(this.port, data, transfer);
				else this.queued.push([data, transfer]);
			}
		);
		if (port) this.attach(port);
	}

	attach(port: MessagePort) {
		this.port = port;
		port.onmessageerror = (ev) => {
			console.error("onmessageerror (this should never happen!)", ev);
		};
		port.onmessage = (ev) => {
			this.rpc.recieve(ev.data);
		};
		port.start();
		for (const [data, transfer] of this.queued)
			postMessage(port, data, transfer);
		this.queued = [];
	}

	/** a port for a new transport served by the same controller, to give to a worker */
	fork(): MessagePort {
		const channel = new MessageChannel();
		this.rpc.call("fork", channel.port2, [channel.port2]);
		return channel.port1;
	}
	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: Blob | ArrayBuffer | string) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [
		(data: Blob | ArrayBuffer | string) => void,
		(code: number, reason: string) => void,
	] {
		const channel = new MessageChannel();
		const port = channel.port1;
		console.warn("connecting");
		this.rpc
			.call(
				"connect",
				{
					url: url.href,
					protocols,
					requestHeaders,
					port: channel.port2,
				},
				[channel.port2]
			)
			.then((response) => {
				console.log(response);
				if (response.result === "success") {
					onopen(response.protocol, response.extensions);
				} else {
					onerror(response.error);
				}
			});
		port.onmessage = (ev) => {
			const message = ev.data as WebSocketMessage;
			if (message.type === "data") {
				onmessage(message.data);
			} else if (message.type === "close") {
				onclose(message.code, message.reason);
			}
		};
		port.onmessageerror = (ev) => {
			console.error("onmessageerror (this should never happen!)", ev);
			onerror("Message error in transport port");
		};

		return [
			(data) => {
				postMessage(
					port,
					{
						type: "data",
						data: data,
					},
					data instanceof ArrayBuffer ? [data] : []
				);
			},
			(code) => {
				postMessage(port, {
					type: "close",
					code: code,
				});
			},
		];
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		_signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		return await this.rpc.call("request", {
			remote: remote.href,
			method,
			body,
			headers,
		});
	}

	async sendSetCookie(
		cookies: Array<{ url: URL; cookie: string }>,
		options: CookieSyncOptions = {}
	): Promise<void> {
		await this.rpc.call("sendSetCookie", {
			cookies: cookies.map(({ url, cookie }) => ({
				url: url.href,
				cookie,
			})),
			options,
		});
	}
}

// workers have no navigator.serviceWorker
const sw = navigator.serviceWorker?.controller;

type Init = {
	config: Config;
	sjconfig: ScramjetConfig;
	prefix: URL;
	cookies: string;
	yieldGetInjectScripts: (
		config: Config,
		sjconfig: ScramjetConfig,
		prefix: URL,
		cookieJar: CookieJar,
		codecEncode: (input: string) => string,
		codecDecode: (input: string) => string
	) => any;
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;
	initHeaders: RawHeaders;
	history: TrackedHistoryState[];
};

export function load(init: Init) {
	if (SCRAMJETCLIENT in globalThis) {
		((globalThis as any)[SCRAMJETCLIENT] as ScramjetClient).syncDocumentInit({
			initHeaders: init.initHeaders,
			history: init.history,
			cookies: init.cookies,
		});
		return;
	}
	// the host's wasmPath, on the host origin. location is no base here: a srcdoc or about:blank
	// frame has none, while the prefix is always the absolute proxy url
	loadWasm(new URL(init.config.wasmPath, init.prefix).href);

	new ExecutionContextWrapper(globalThis, init);
}

type WorkerInit = {
	sjconfig: ScramjetConfig;
	prefix: URL;
	cookies: string;
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;
};

/**
 * The host page compiles the rewriter once and publishes the Module on its window (see
 * Controller.loadScramjetWasm). Walk the real window chain to find it: parent, top, opener,
 * and each of their chains. Runs before any hooks exist; a cross-origin read throws, so each is guarded.
 */
function findHostWasm(): [WebAssembly.Module, string, any] | undefined {
	const seen: any[] = [globalThis];
	for (let i = 0; i < seen.length && i < 32; i++) {
		const win = seen[i];
		try {
			const module = win[WASM_MODULE];
			const digest = win[WASM_DIGEST];
			// not instanceof: the Module comes from another realm
			if (
				typeof digest === "string" &&
				Object.prototype.toString.call(module) === "[object WebAssembly.Module]"
			)
				return [module, digest, win[PLAIN_NATIVES]];
		} catch {}
		for (const next of [() => win.parent, () => win.top, () => win.opener]) {
			try {
				const w = next();
				if (w && !seen.includes(w)) seen.push(w);
			} catch {}
		}
	}
	return undefined;
}

/**
 * Synchronous fetch of the wasm file itself, for a document with no host module (e.g. a noopener
 * popup). Sync XHR is not routed through the service worker in Chromium, so this cannot go
 * through the virtual payload path; it reads the static file the host fetches. The bytes come
 * back as a string with x-user-defined, one byte per char, since sync XHR has no responseType.
 */
function fetchWasmSync(url: string): Uint8Array {
	const xhr = new XMLHttpRequest();
	xhr.open("GET", url, false);
	xhr.overrideMimeType("text/plain; charset=x-user-defined");
	xhr.send();
	if (xhr.status !== 200)
		throw new Error(`rewriter wasm fetch failed: ${xhr.status}`);
	const bin = xhr.responseText;
	const wasm = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) wasm[i] = bin.charCodeAt(i);
	return wasm;
}

function loadWasm(fallbackUrl: string | undefined) {
	const host = findHostWasm();
	if (host) {
		setWasm(host[0], host[1]);
		if (host[2] && typeof host[2] === "object") sharePlainNatives(host[2]);
		return;
	}

	// workers get the payload as a script, which sets self.WASM. documents without a host fetch the file
	const b64 = (self as any).WASM as string | undefined;
	if (b64 === undefined) {
		if (fallbackUrl === undefined)
			throw new Error("WASM not found in global scope!");
		setWasm(fetchWasmSync(fallbackUrl));
		return;
	}
	delete (self as any).WASM;
	// Uint8Array.from(string, mapFn) costs ~70ms for the 1.2 MB payload on every
	// document/worker load; a plain loop over the decoded string is ~5ms.
	const bin = atob(b64);
	const wasm = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) wasm[i] = bin.charCodeAt(i);
	setWasm(wasm);
}

export function loadWorker(init: WorkerInit) {
	if (SCRAMJETCLIENT in globalThis) return;
	loadWasm(undefined);

	// the realm that created this worker sends its transport port as the first
	// message (see client/shared/worker.ts in core). until then requests just queue
	const transport = new RemoteTransport();
	const takeTransport = (target: EventTarget) => {
		const listener = (ev: Event) => {
			const port = (ev as MessageEvent).data?.[WORKERTRANSPORT];
			if (!(port instanceof MessagePort)) return;
			ev.stopImmediatePropagation();
			EventTarget_removeEventListener.call(target, "message", listener);
			// a shared worker gets one from every page that connects; it only needs one
			if (transport.port) port.close();
			else transport.attach(port);
		};
		EventTarget_addEventListener.call(target, "message", listener);
	};
	if ("SharedWorkerGlobalScope" in self) {
		EventTarget_addEventListener.call(self, "connect", (ev: Event) =>
			takeTransport((ev as MessageEvent).ports[0])
		);
	} else {
		takeTransport(self);
	}

	const cookieJar = new CookieJar();
	cookieJar.load(init.cookies);

	// workers have no document, so none of the document-only init
	const workerInit: Partial<ScramjetClientInit> = {
		context: {
			config: init.sjconfig,
			prefix: init.prefix,
			cookieJar,
			interface: {
				codecEncode: init.codecEncode,
				codecDecode: init.codecDecode,
			} as ScramjetContext["interface"],
		},
		transport,
		sendSetCookie: async (cookies, options) => {
			await transport.sendSetCookie(cookies, options);
		},
		createWorkerTransport: () => transport.fork(),
	};
	const client = new ScramjetClient(
		globalThis,
		workerInit as ScramjetClientInit
	);
	client.hook();
}

function createFrameId() {
	return `${Array(8)
		.fill(0)
		.map(() => Math.floor(Math.random() * 36).toString(36))
		.join("")}`;
}

class ExecutionContextWrapper {
	client!: ScramjetClient;
	cookieJar: CookieJar;
	transport: RemoteTransport;
	private handleServiceWorkerCookieMessage: (event: MessageEvent) => void;

	constructor(
		public global: typeof globalThis,
		public init: Init
	) {
		const channel = new MessageChannel();
		this.transport = new RemoteTransport(channel.port1);
		sw?.postMessage(
			{
				$sw$initRemoteTransport: {
					port: channel.port2,
					prefix: this.init.prefix.href,
				},
			},
			[channel.port2]
		);

		this.cookieJar = new CookieJar();
		this.cookieJar.load(this.init.cookies);

		this.handleServiceWorkerCookieMessage = (event: MessageEvent) => {
			if (
				!event.data?.$controller$setCookie ||
				typeof event.data.$controller$setCookie !== "object"
			) {
				return;
			}

			const payload = event.data.$controller$setCookie as {
				cookies?: SerializedCookieSyncEntry[];
				options?: CookieSyncOptions;
				id?: string;
			};

			if (payload.options?.clear) {
				this.cookieJar.clear();
			}

			if (Array.isArray(payload.cookies)) {
				for (const cookie of payload.cookies) {
					if (
						typeof cookie?.url !== "string" ||
						typeof cookie.cookie !== "string"
					) {
						continue;
					}

					try {
						this.cookieJar.setCookies(cookie.cookie, new URL(cookie.url));
					} catch {
						console.error("Failed to set cookie", cookie);
					}
				}
			}

			if (typeof payload.id === "string") {
				const targetSw = navigator.serviceWorker?.controller ?? sw;
				targetSw?.postMessage({
					$sw$setCookieDone: {
						id: payload.id,
					},
				});
			}
		};

		navigator.serviceWorker?.addEventListener(
			"message",
			this.handleServiceWorkerCookieMessage
		);

		this.injectScramjet();
	}

	injectScramjet() {
		const frame = this.global.frameElement as HTMLIFrameElement | null;
		if (frame && !frame.name) {
			window.name = frame.name = createFrameId();
		}
		let controllerFrame = frame?.[CONTROLLERFRAME];
		let isTopLevel = true;
		if (!controllerFrame) {
			isTopLevel = false;
			let currentwin = this.global.window;
			while (currentwin.parent !== currentwin) {
				const currentclient = currentwin[SCRAMJETCLIENT];
				if (!currentclient) {
					currentwin = currentwin.parent.window;
					continue;
				}
				const currentFrame = currentclient.descriptors.get(
					"window.frameElement",
					currentwin
				);
				if (currentFrame && currentFrame[CONTROLLERFRAME]) {
					controllerFrame = currentFrame[CONTROLLERFRAME];
					break;
				}
				currentwin = currentwin.parent.window;
			}
		}
		const context: ScramjetContext = {
			config: this.init.sjconfig,
			prefix: this.init.prefix,
			cookieJar: this.cookieJar,
			interface: {
				getInjectScripts: this.init.yieldGetInjectScripts(
					this.init.config,
					this.init.sjconfig,
					this.init.prefix,
					this.cookieJar,
					this.init.codecEncode,
					this.init.codecDecode
				),
				codecEncode: this.init.codecEncode,
				codecDecode: this.init.codecDecode,
			},
		};
		this.client = new ScramjetClient(this.global, {
			context,
			transport: this.transport,
			sendSetCookie: async (cookies, options) => {
				await this.transport.sendSetCookie(cookies, options);
			},
			shouldBlockMessageEvent: (ev) => {
				// a BroadcastChannel message has no source, and its envelope names the sender's proxied origin.
				// channel names already keep proxied sites apart, so this only refuses a mismatch that gets through.
				// about: frames take their origin from their creator, so they are not checked here
				const data: unknown = ev.data;
				if (ev.source !== null || typeof data !== "object" || data === null)
					return false;
				if (!("$scramjet$origin" in data) || !("$scramjet$messagetype" in data))
					return false;
				if (this.client.url.protocol === "about:") return false;
				return data.$scramjet$origin !== this.client.url.origin;
			},
			createWorkerTransport: () => this.transport.fork(),
			hookSubcontext: (frameself) => {
				const context = new ExecutionContextWrapper(frameself, {
					...this.init,
					cookies: this.cookieJar.dump(),
				});
				return context.client;
			},
			initHeaders: this.init.initHeaders,
			history: this.init.history,
		});
		const frameInitContext = {
			window: this.global.window,
			client: this.client,
			isTopLevel,
		};
		if (controllerFrame)
			Tap.dispatch(controllerFrame.hooks.init.pre, frameInitContext, {});
		this.client.hook();
		if (controllerFrame)
			Tap.dispatch(controllerFrame.hooks.init.post, frameInitContext, {});
	}
}
