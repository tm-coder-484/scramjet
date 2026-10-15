import { type MethodsDefinition, RpcHelper } from "@mercuryworkshop/rpc";
import {
	BareResponse,
	type ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
import { deepmerge } from "@fastify/deepmerge";
import {
	CookieJar,
	defaultConfig as scramjetDefaultConfig,
	rewriteUrl,
	bytesToBase64,
	getWasmBytes,
	ScramjetFetchHandler,
	ScramjetHeaders,
	setWasm,
	Tap,
	type CookieSyncOptions,
	type FetchHooks,
	type ScramjetConfig,
	type ScramjetContext,
	type ScramjetInterface,
	type TrackedHistoryState,
	Plugin,
} from "@mercuryworkshop/scramjet";
import {
	CONTROLLERFRAME,
	DEFAULT_PREFIX,
	WASM_DIGEST,
	WASM_MODULE,
} from "./symbols";
import type {
	FrameInitHooks,
	SerializedCookieSyncEntry,
	TransportToController,
	Controllerbound,
	ControllerToTransport,
	SWbound,
	WebSocketMessage,
	FrameErrorHooks,
	BodyType,
} from "./types";
import { assertRuntimeScramjetVersion } from "./version";
import { endAfter, sendBody, takePort } from "./bodystream";
import {
	WARMUP_ORIGIN,
	WARMUP_SETTLE,
	WARMUP_TIMEOUT,
	warmUpRewriters,
	installWarmupResponder,
} from "./warmup";

export { VERSION } from "./version";
export { assertRuntimeScramjetVersion } from "./version";

export type Config = {
	prefix: string;
	scramjetPath: string;
	injectPath: string;
	workerPath: string;
	rewriterPath: string;
	wasmPath: string;
	virtualWasmPath: string;
	codec: Record<"encode" | "decode", (input: string) => string>;
};

export const config: Config = {
	prefix: DEFAULT_PREFIX,
	scramjetPath: "/scramjet/scramjet.js",
	injectPath: "/controller/controller.inject.js",
	workerPath: "/controller/controller.worker.js",
	rewriterPath: "/controller/controller.rewriter.js",
	wasmPath: "/scramjet/scramjet.wasm",
	virtualWasmPath: "scramjet.wasm.js",
	codec: {
		encode: (url: string) => {
			if (!url) return url;

			return encodeURIComponent(url);
		},
		decode: (url: string) => {
			if (!url) return url;

			return decodeURIComponent(url);
		},
	},
};

const scramjetConfig: Partial<ScramjetConfig> = {
	flags: {
		...scramjetDefaultConfig.flags,
		allowFailedIntercepts: true,
	},
	// scramjet.wasm: the document fallback fetches the wasm file directly (inject.ts fetchWasmSync)
	maskedfiles: ["inject.js", "scramjet.wasm.js", "scramjet.wasm"],
};

type PersistedCookieState = {
	updatedAt: number;
	cookies: string;
};

export class ManagedPlugin extends Plugin {
	frame: Frame = null!;
	dependencies: string[] = [];
	constructor(name: string, dependencies: string[]) {
		super(name);
		this.dependencies = dependencies;
	}

	install(frame: Frame): void {
		this.frame = frame;
	}
}

const COOKIE_DB_NAME = "__scramjet_controller";
const COOKIE_STORE_NAME = "state";
const COOKIE_STATE_KEY = "cookies";
const BROADCASTCHANNEL_NAME = "__scramjet_controller_channel";

let cookieDbPromise: Promise<IDBDatabase> | null = null;

function parsePersistedCookieState(
	value: unknown
): PersistedCookieState | null {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as PersistedCookieState).updatedAt !== "number" ||
		!Number.isFinite((value as PersistedCookieState).updatedAt) ||
		typeof (value as PersistedCookieState).cookies !== "string"
	) {
		return null;
	}

	return value as PersistedCookieState;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});
}

function openCookieDatabase(): Promise<IDBDatabase> {
	if (cookieDbPromise) {
		return cookieDbPromise;
	}

	cookieDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(COOKIE_DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(COOKIE_STORE_NAME)) {
				db.createObjectStore(COOKIE_STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Failed to open cookie database"));
	});

	return cookieDbPromise;
}

async function readCookieState(): Promise<PersistedCookieState | null> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readonly");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const value = await requestToPromise(store.get(COOKIE_STATE_KEY));
		await transactionToPromise(transaction);
		return parsePersistedCookieState(value);
	} catch (error) {
		console.error("Failed to read persisted controller cookies:", error);
		return null;
	}
}

async function writeCookieState(
	cookies: string,
	currentUpdatedAt: number
): Promise<number> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readwrite");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const existing = parsePersistedCookieState(
			await requestToPromise(store.get(COOKIE_STATE_KEY))
		);
		const updatedAt = Math.max(
			Date.now(),
			currentUpdatedAt + 1,
			(existing?.updatedAt ?? 0) + 1
		);
		const state: PersistedCookieState = {
			updatedAt,
			cookies,
		};
		store.put(state, COOKIE_STATE_KEY);
		await transactionToPromise(transaction);
		return updatedAt;
	} catch (error) {
		console.error("Failed to persist controller cookies:", error);
		return currentUpdatedAt;
	}
}

function makeId(): string {
	return Math.random().toString(36).substring(2, 10);
}

const deepMerge = deepmerge();

/**
 * Run request handling (the transport, cookies and all rewriting) in a dedicated worker
 * instead of on this page's main thread. Proxied frames are same-origin with this page, so
 * they share its main thread: without a worker, every request waits whenever the proxied
 * site runs script or lays out. Fetch hooks tapped on this page's frames are not called in
 * this mode; install them in the worker with `setupFrame`.
 */
export type ControllerWorkerInit = {
	/** classic scripts the worker loads first, e.g. the transport implementation */
	scripts?: string[];
	/** creates the transport inside the worker; serialized with toString, so it can't close over anything */
	transport: (() => ProxyTransport) | string;
	/** runs in the worker for each frame, e.g. to install plugins on its fetch hooks; serialized like `transport` */
	setupFrame?: ((frame: Frame) => void) | string;
	/** the worker script, defaults to config.workerPath */
	path?: string;
};

type ControllerInit = {
	serviceworker?: ServiceWorker;
	transport?: ProxyTransport;
	config?: Partial<Config>;
	scramjetConfig?: Partial<ScramjetConfig>;
	worker?: ControllerWorkerInit;
	/**
	 * Before `wait()` resolves, load a made-up site in a hidden frame (served without the
	 * network, see warmup.ts), so the first real page isn't rewritten and booted by cold code.
	 * Adds ~1s to startup, once. Default true; skipped without `document.body`.
	 */
	warmup?: boolean;
	/** @internal set by the worker: the facade's id, and how to reach the service worker */
	headless?: {
		id: string;
		postToServiceWorker: (message: any, transfer: Transferable[]) => void;
	};
};

type FrameOptions = {
	plugins?: ManagedPlugin[];
	/** @internal the worker reuses the facade's frame ids */
	id?: string;
	/** @internal the hidden frame of the warm-up, whose requests never reach the transport */
	warmup?: boolean;
};

export class Controller {
	id: string;
	config: Config;
	scramjetConfig: ScramjetConfig;
	prefix: string;
	cookieJar = new CookieJar();
	frames: Frame[] = [];
	serviceWorkerController: ServiceWorker;
	guardServiceWorkerRevive = true;

	private ready: Promise<void>;
	private readyResolve!: () => void;
	public isReady: boolean = false;
	rpc: RpcHelper<Controllerbound, SWbound>;
	private port: MessagePort | null = null;

	transport: ProxyTransport;
	private cookieUpdatedAt = 0;
	private cookieSyncPromise: Promise<void> | null = null;
	private cookieSyncDirty = true;
	private cookieSyncChannel = new BroadcastChannel(BROADCASTCHANNEL_NAME);

	private wasmAlreadyFetched = false;
	private wasmPayload: string | null = null;
	private onTabChannelMessage: (e: MessageEvent) => void = (e) => {
		this.rpc.recieve(e.data);
	};
	private onCookieSyncMessage = (event: MessageEvent) => {
		const updatedAt =
			typeof event.data === "object" && event.data !== null
				? (event.data as { updatedAt?: unknown }).updatedAt
				: undefined;
		if (typeof updatedAt !== "number" || updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieSyncDirty = true;
		void this.loadSavedCookies();
	};

	private async loadScramjetWasm() {
		if (this.wasmAlreadyFetched) {
			return;
		}

		const resp = await fetch(this.config.wasmPath);
		const bytes = await resp.arrayBuffer();
		setWasm(bytes);
		// compiled once here, off the main thread. documents adopt the Module from this window
		// (inject.ts findHostWasm), so they neither get the payload nor compile it themselves
		const [module, digest] = await Promise.all([
			WebAssembly.compile(bytes),
			sha256Hex(bytes),
		]);
		setWasm(module, digest);
		Object.defineProperty(globalThis, WASM_MODULE, {
			value: module,
			enumerable: false,
			configurable: true,
		});
		Object.defineProperty(globalThis, WASM_DIGEST, {
			value: digest,
			enumerable: false,
			configurable: true,
		});
		this.wasmAlreadyFetched = true;
	}

	private methods: MethodsDefinition<Controllerbound> = {
		ready: async () => {
			this.readyResolve();
			setTimeout(() => {
				this.guardServiceWorkerRevive = false;
			}, 5000);
		},
		request: async (data) => {
			const path = new URL(data.rawUrl).pathname;
			const frame = await this.findFrame(path);
			if (!frame) throw new Error("No frame found for request");
			try {
				// doesn't actually *load* every request, but hold up requests until the promise finishes
				await this.loadSavedCookies();

				if (path === frame.prefix + this.config.virtualWasmPath) {
					// built on first request only, by workers and documents without a host module
					if (!this.wasmPayload) {
						this.wasmPayload = `self.WASM = '${bytesToBase64(getWasmBytes())}';`;
					}

					return [
						{
							body: this.wasmPayload,
							status: 200,
							statusText: "OK",
							headers: [["Content-Type", "application/javascript"]],
						},
						[],
					];
				}

				const sjheaders = ScramjetHeaders.fromRawHeaders(data.initialHeaders);

				const fetchresponse = await frame.fetchHandler.handleFetch({
					initialHeaders: sjheaders,
					rawClientUrl: data.rawClientUrl
						? new URL(data.rawClientUrl)
						: undefined,
					rawUrl: new URL(data.rawUrl),
					rawReferrer: data.rawReferrer,
					rawDestination: data.destination,
					method: data.method,
					mode: data.mode,
					referrer: data.referrer,
					body: data.body,
					cache: data.cache,
					clientId: data.clientId,
				});

				// the response's cookies are still on their way to the page: its bytes go now, its end
				// once they're there (see cookieSync)
				if (fetchresponse.cookieSync)
					fetchresponse.body = endAfter(
						fetchresponse.body,
						fetchresponse.cookieSync
					);

				// a streamed body goes over a port, pushed chunk by chunk, when the service worker
				// knows how to take it: a transferred stream costs a round trip per chunk
				if (
					data.acceptsBodyPort &&
					fetchresponse.body instanceof ReadableStream
				) {
					// a document rewritten on a rewriter thread comes from there directly
					const bodyPort =
						takePort(fetchresponse.body) ?? sendBody(fetchresponse.body);
					return [
						{
							body: null as unknown as BodyType,
							bodyPort,
							status: fetchresponse.status,
							statusText: fetchresponse.statusText,
							headers: fetchresponse.headers.toRawHeaders(),
						},
						[bodyPort],
					];
				}

				return [
					{
						body: fetchresponse.body,
						status: fetchresponse.status,
						statusText: fetchresponse.statusText,
						headers: fetchresponse.headers.toRawHeaders(),
					},
					fetchresponse.body instanceof ReadableStream ||
					fetchresponse.body instanceof ArrayBuffer
						? [fetchresponse.body]
						: [],
				];
			} catch (e) {
				const reqcontext: typeof frame.hooks.error.request.context = {
					rawrequest: data,
					error: e,
				};
				const reqprops: typeof frame.hooks.error.request.props = {
					setResponse: undefined,
					suppressError: false,
				};
				await Tap.dispatch(frame.hooks.error.request, reqcontext, reqprops);
				if (!reqprops.suppressError) {
					console.error("Error in controller request handler:", e);
				}
				if (reqprops.setResponse) {
					return [reqprops.setResponse, []];
				}
				throw e;
			}
		},
		initRemoteTransport: async (port) => {
			const rpc = new RpcHelper<TransportToController, ControllerToTransport>(
				{
					request: async ({ remote, method, body, headers }) => {
						const response = await this.transport.request(
							new URL(remote),
							method,
							body,
							headers,
							undefined
						);
						return [response, [response.body]];
					},
					sendSetCookie: async ({ cookies, options }) => {
						await this.loadSavedCookies(true);
						if (options?.clear) {
							this.cookieJar.clear();
						}
						this.applyCookieSyncEntries(cookies);
						await this.persistCookies();
						await this.propagateCookieSync(cookies, options);
					},
					connect: async ({ url, protocols, requestHeaders, port }) => {
						let resolve: (arg: TransportToController["connect"][1]) => void;
						const promise = new Promise<TransportToController["connect"][1]>(
							(res) => (resolve = res)
						);
						const [send, close] = this.transport.connect(
							new URL(url),
							protocols,
							requestHeaders,
							(protocol, extensions) => {
								resolve({
									result: "success",
									protocol: protocol,
									extensions: extensions,
								});
							},
							(data) => {
								port.postMessage(
									{
										type: "data",
										data: data,
									} as WebSocketMessage,
									data instanceof ArrayBuffer ? [data] : []
								);
							},
							(close, reason) => {
								port.postMessage({
									type: "close",
									code: close,
									reason: reason,
								} as WebSocketMessage);
							},
							(error) => {
								resolve({
									result: "failure",
									error: error,
								});
							}
						);
						port.onmessageerror = (ev) => {
							console.error(
								"Transport port messageerror (this should never happen!)",
								ev
							);
						};
						port.onmessage = ({ data }: { data: WebSocketMessage }) => {
							if (data.type === "data") {
								send(data.data);
							} else if (data.type === "close") {
								close(data.code, data.reason);
							}
						};

						return [await promise, []];
					},
					fork: async (port) => {
						await this.methods.initRemoteTransport(port);
					},
				},
				"transport",
				(data, transfer) => port.postMessage(data, transfer)
			);
			port.onmessageerror = (ev) => {
				console.error(
					"Transport port messageerror (this should never happen!)",
					ev
				);
			};
			port.onmessage = (e) => {
				rpc.recieve(e.data);
			};
			rpc.call("ready", undefined, []);
		},
	};

	constructor(public init: ControllerInit) {
		assertRuntimeScramjetVersion();
		this.id = init.headless?.id ?? makeId();
		this.config = deepMerge(config, init.config || {}) as Config;
		this.scramjetConfig = deepMerge(scramjetConfig, scramjetDefaultConfig);
		this.scramjetConfig = deepMerge(
			this.scramjetConfig,
			init.scramjetConfig || {}
		) as ScramjetConfig;
		this.prefix = this.config.prefix + this.id + "/";
		this.serviceWorkerController = init.serviceworker!;
		this.transport = init.transport!;

		if (init.worker) {
			// this page still compiles the rewriter: its frames take the compiled module from it
			this.ready = Promise.all([
				this.startWorker(init.worker),
				this.loadScramjetWasm(),
			]).then(() => this.warmUp());
			this.rpc = null!;
			return;
		}

		this.ready = Promise.all([
			new Promise<void>((resolve) => {
				this.readyResolve = resolve;
			}),
			this.loadScramjetWasm(),
			this.loadSavedCookies(true),
		]).then(() => this.warmUp());

		this.rpc = new RpcHelper<Controllerbound, SWbound>(
			this.methods,
			"tabchannel-" + this.id,
			(data, transfer) => {
				if (!this.port) {
					throw new Error("Port not found");
				}
				this.port.postMessage(data, transfer);
			}
		);

		this.cookieSyncChannel.addEventListener(
			"message",
			this.onCookieSyncMessage
		);
		this.setupMessagePort();

		// a headless controller (in the worker) gets these forwarded by its page
		if (!init.headless) {
			navigator.serviceWorker.addEventListener("message", (e) => {
				this.handleServiceWorkerMessage(e.data);
			});
		}
	}

	private postToServiceWorker(message: any, transfer: Transferable[] = []) {
		if (this.init.headless) {
			this.init.headless.postToServiceWorker(message, transfer);
		} else {
			this.serviceWorkerController.postMessage(message, transfer);
		}
	}

	/** @internal handles a message the service worker posted to this page */
	handleServiceWorkerMessage(data: any) {
		if (
			data?.$controller$setCookie &&
			typeof data.$controller$setCookie === "object"
		) {
			const payload = data.$controller$setCookie as {
				cookies?: SerializedCookieSyncEntry[];
				options?: CookieSyncOptions;
				id?: string;
			};

			if (payload.options?.clear) {
				this.cookieJar.clear();
			}
			this.applyCookieSyncEntries(payload.cookies);

			if (typeof payload.id === "string") {
				this.postToServiceWorker({
					$sw$setCookieDone: {
						id: payload.id,
					},
				});
			}

			return;
		}

		if (data?.$controller$swrevive) {
			const known = data.$controller$swrevive.known;
			if (Array.isArray(known)) {
				if (known.includes(this.id)) return;
			} else if (this.guardServiceWorkerRevive) {
				// older service workers don't say who they know. if we just spawned it,
				// it will send this even though it's not actually dead
				return;
			}
			this.setupMessagePort();
		}
	}

	private worker: Worker | null = null;

	// worker mode: this page keeps the frames and the API, a headless Controller in a worker
	// does the rest. it talks to the service worker through this page, except for the request
	// port, which goes straight from the service worker to the worker
	private startWorker(workerInit: ControllerWorkerInit): Promise<void> {
		const abs = (path: string) => new URL(path, location.href).href;
		const url = new URL(abs(workerInit.path ?? this.config.workerPath));
		url.searchParams.set("scramjet", abs(this.config.scramjetPath));
		const worker = new Worker(url, { name: "scramjet controller" });
		this.worker = worker;

		const ready = new Promise<void>((resolve, reject) => {
			worker.addEventListener("message", (e) => {
				const data = e.data;
				if (data?.$worker$ready) {
					this.isReady = true;
					resolve();
				} else if (data?.$worker$error) {
					reject(new Error(data.$worker$error));
				} else if (data?.$worker$toSW) {
					this.serviceWorkerController.postMessage(
						data.$worker$toSW,
						e.ports as unknown as Transferable[]
					);
				}
			});
			worker.addEventListener("error", (e) =>
				reject(new Error("controller worker failed to start: " + e.message))
			);
		});

		navigator.serviceWorker.addEventListener("message", (e) => {
			if (e.data?.$controller$setCookie || e.data?.$controller$swrevive) {
				worker.postMessage({ $worker$sw: e.data });
			}
		});

		const { encode, decode } = this.config.codec;
		worker.postMessage({
			$worker$init: {
				id: this.id,
				config: {
					...this.config,
					codec: { encode: encode.toString(), decode: decode.toString() },
				},
				scramjetConfig: this.scramjetConfig,
				scripts: (workerInit.scripts ?? []).map(abs),
				// the page's warm-up frame covers the worker's own (see warmUp)
				frameWarmup: this.willWarmUp(),
				transport: workerInit.transport.toString(),
				setupFrame: workerInit.setupFrame?.toString(),
			},
		});

		return ready;
	}

	private setupMessagePort() {
		if (this.port) {
			this.port.removeEventListener("message", this.onTabChannelMessage);
			try {
				this.port.close();
			} catch {
				// ignore
			}
			this.port = null;
		}

		const channel = new MessageChannel();
		this.port = channel.port1;
		this.port.addEventListener("message", this.onTabChannelMessage);
		this.port.start();

		this.postToServiceWorker(
			{
				$controller$init: {
					prefix: this.prefix,
					id: this.id,
					// the scripts every document loads, which the service worker serves from its cache
					client: [this.config.scramjetPath, this.config.injectPath].map(
						(path) => new URL(path, location.href).href
					),
				},
			},
			[channel.port2]
		);
	}

	// TODO: should this be a method on the cookie jar?
	private applyCookieSyncEntries(
		cookies: SerializedCookieSyncEntry[] | undefined
	) {
		if (!Array.isArray(cookies)) {
			return;
		}

		for (const entry of cookies) {
			if (typeof entry?.url !== "string" || typeof entry.cookie !== "string") {
				continue;
			}

			this.cookieJar.setCookies(entry.cookie, new URL(entry.url));
		}
	}

	async propagateCookieSync(
		cookies: SerializedCookieSyncEntry[],
		options: CookieSyncOptions = {}
	): Promise<void> {
		if (!this.port) {
			return;
		}

		await this.rpc.call("sendSetCookie", {
			cookies,
			options,
		});
	}

	private async loadSavedCookies(force = false): Promise<void> {
		if (!force && !this.cookieSyncDirty) {
			return;
		}

		if (this.cookieSyncPromise) {
			return this.cookieSyncPromise;
		}

		this.cookieSyncPromise = (async () => {
			const persisted = await readCookieState();
			if (persisted && persisted.updatedAt > this.cookieUpdatedAt) {
				this.cookieJar.load(persisted.cookies);
				this.cookieUpdatedAt = persisted.updatedAt;
			}
			this.cookieSyncDirty = false;
		})().finally(() => {
			this.cookieSyncPromise = null;
		});

		return this.cookieSyncPromise;
	}

	async persistCookies(): Promise<void> {
		const updatedAt = await writeCookieState(
			this.cookieJar.dump(),
			this.cookieUpdatedAt
		);
		if (updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieUpdatedAt = updatedAt;
		this.cookieSyncDirty = false;
		this.cookieSyncChannel.postMessage({
			updatedAt,
		});
	}

	/**
	 * In worker mode, sends `scramjetConfig` to the worker again after it was changed in place
	 * (flags, webrtcRelay...). Pages loaded after this use the new config. A no-op otherwise.
	 */
	pushConfig() {
		this.worker?.postMessage({ $worker$config: this.scramjetConfig });
	}

	private frameWaiters: (() => void)[] = [];

	/** @internal the frame a proxied url belongs to. in a worker, the page may not have told us about it yet */
	async findFrame(path: string): Promise<Frame | undefined> {
		const deadline = Date.now() + 5000;
		let frame = this.frames.find((f) => path.startsWith(f.prefix));
		while (!frame && this.init.headless && Date.now() < deadline) {
			await new Promise<void>((resolve) => {
				this.frameWaiters.push(resolve);
				setTimeout(resolve, deadline - Date.now());
			});
			frame = this.frames.find((f) => path.startsWith(f.prefix));
		}
		return frame;
	}

	setTransport(transport: ProxyTransport) {
		if (this.worker) {
			throw new Error(
				"setTransport isn't supported for a controller running in a worker"
			);
		}
		this.transport = transport;
		for (const frame of this.frames) {
			frame.controller.transport = transport;
			frame.fetchHandler.client.transport = transport;
		}
	}

	createFrame(element?: HTMLIFrameElement, options: FrameOptions = {}): Frame {
		if (!this.ready) {
			throw new Error(
				"Controller is not ready! Try awaiting controller.wait()"
			);
		}
		element ??= document.createElement("iframe");
		const frame = new Frame(this, element, options);
		this.frames.push(frame);
		this.worker?.postMessage({
			$worker$frame: { id: frame.id, warmup: options.warmup },
		});
		if (options.warmup && !this.worker) installWarmupResponder(frame);
		for (const resolve of this.frameWaiters.splice(0)) resolve();
		return frame;
	}

	/** @internal forgets a frame (the warm-up's) */
	removeFrame(frame: Frame) {
		const i = this.frames.indexOf(frame);
		if (i !== -1) this.frames.splice(i, 1);
		this.worker?.postMessage({ $worker$frameGone: { id: frame.id } });
	}

	private willWarmUp(): boolean {
		return (
			!this.init.headless &&
			this.init.warmup !== false &&
			typeof document !== "undefined" &&
			!!document.body
		);
	}

	// the made-up site in a hidden frame (see warmup.ts), once, before wait() resolves. a failure
	// or a timeout only loses the speedup
	private async warmUp(): Promise<void> {
		if (!this.willWarmUp()) return;
		const element = document.createElement("iframe");
		element.setAttribute("aria-hidden", "true");
		element.tabIndex = -1;
		// laid out at a desktop size, out of sight
		element.style.cssText =
			"position:fixed;left:-20000px;top:0;width:1280px;height:800px;border:0;visibility:hidden;pointer-events:none";
		let frame: Frame | undefined;
		try {
			frame = this.createFrame(element, { warmup: true });
			frame.go(WARMUP_ORIGIN + "/");
			await new Promise<void>((resolve) => {
				element.addEventListener("load", () => resolve(), { once: true });
				setTimeout(resolve, WARMUP_TIMEOUT);
				document.body.appendChild(element);
			});
			const settled = new Promise((resolve) =>
				setTimeout(resolve, WARMUP_SETTLE)
			);
			// meanwhile, the thread that rewrites documents runs them some more
			if (this.worker) this.worker.postMessage({ $worker$warmup: true });
			else await warmUpRewriters(this);
			await settled;
		} catch {
			// only a missed speedup
		} finally {
			element.remove();
			if (frame) this.removeFrame(frame);
		}
	}

	async wait(): Promise<void> {
		await this.ready;
	}
}

// sha256 hex of the rewriter, the same digest the core's rewrite cache keys on
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0")
	).join("");
}

function base64Encode(text: string) {
	return btoa(
		new TextEncoder()
			.encode(text)
			.reduce(
				(data, byte) => (data.push(String.fromCharCode(byte)), data),
				[] as any
			)
			.join("")
	);
}

function yieldGetInjectScripts(
	config: Config,
	sjconfig: ScramjetConfig,
	prefix: URL,
	cookieJar: CookieJar,
	codecEncode: (input: string) => string,
	codecDecode: (input: string) => string
) {
	const getInjectScripts: ScramjetInterface["getInjectScripts"] = (
		meta,
		handler,
		htmlcontext,
		script
	) => {
		function base64Encode(text: string) {
			return btoa(
				new TextEncoder()
					.encode(text)
					.reduce(
						(data, byte) => (data.push(String.fromCharCode(byte)), data),
						[] as any
					)
					.join("")
			);
		}
		// no wasm payload here: documents take the host's compiled module, or fetch the wasm
		// file synchronously when there is no host (inject.ts loadWasm)
		return [
			script(config.scramjetPath),
			script(config.injectPath),
			script(
				"data:text/javascript;charset=utf-8;base64," +
					base64Encode(`
					document.querySelectorAll("script[scramjet-injected]").forEach(script => script.remove());
					$scramjetController.load({
						config: ${JSON.stringify(config)},
						sjconfig: ${JSON.stringify(sjconfig)},
						prefix: new URL("${prefix.href}"),
						cookies: ${JSON.stringify(cookieJar.dump())},
						yieldGetInjectScripts: ${yieldGetInjectScripts.toString()},
						codecEncode: ${codecEncode.toString()},
						codecDecode: ${codecDecode.toString()},
						initHeaders: ${JSON.stringify(htmlcontext.headers ?? [])},
						history: ${JSON.stringify(htmlcontext.history ?? [])},
					})
				`)
			),
		];
	};
	return getInjectScripts;
}

export class Frame {
	id: string;
	prefix: string;
	fetchHandler: ScramjetFetchHandler;
	hooks: {
		fetch: FetchHooks;
		init: FrameInitHooks;
		error: FrameErrorHooks;
	};

	get context(): ScramjetContext {
		return {
			config: this.controller.scramjetConfig,
			prefix: new URL(this.prefix, location.href),
			cookieJar: this.controller.cookieJar,
			interface: {
				getInjectScripts: yieldGetInjectScripts(
					this.controller.config,
					this.controller.scramjetConfig,
					new URL(this.prefix, location.href),
					this.controller.cookieJar,
					this.controller.config.codec.encode,
					this.controller.config.codec.decode
				),
				getWorkerInjectScripts: (meta, type, script) => {
					let str = "";

					str += script(this.controller.config.scramjetPath);
					str += script(this.prefix + this.controller.config.virtualWasmPath);
					str += script(this.controller.config.injectPath);
					str += script(
						"data:text/javascript;charset=utf-8;base64," +
							base64Encode(`
					$scramjetController.loadWorker({
						sjconfig: ${JSON.stringify(this.controller.scramjetConfig)},
						prefix: new URL("${this.prefix}", location.href),
						cookies: ${JSON.stringify(this.controller.cookieJar.dump())},
						codecEncode: ${this.controller.config.codec.encode.toString()},
						codecDecode: ${this.controller.config.codec.decode.toString()},
					});
					`)
					);

					return str;
				},
				codecEncode: this.controller.config.codec.encode,
				codecDecode: this.controller.config.codec.decode,
			},
		};
	}

	public plugins: ManagedPlugin[] = [];
	constructor(
		public controller: Controller,
		public element: HTMLIFrameElement,
		public options: FrameOptions = {}
	) {
		this.id = options.id ?? makeId();
		this.prefix = this.controller.prefix + this.id + "/";

		this.fetchHandler = new ScramjetFetchHandler({
			crossOriginIsolated: self.crossOriginIsolated,
			context: this.context,
			transport: controller.transport,
			async sendSetCookie(cookies, options) {
				await controller.persistCookies();
				await controller.propagateCookieSync(
					cookies.map(({ url, cookie }) => ({
						url: url.href,
						cookie,
					})),
					options
				);
			},
			async fetchBlobUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
			async fetchDataUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
		});

		this.hooks = {
			fetch: this.fetchHandler.hooks.fetch,
			init: Tap.create<FrameInitHooks>(),
			error: Tap.create<FrameErrorHooks>(),
		};

		element[CONTROLLERFRAME] = this;

		this.plugins = options.plugins ?? [];
		for (const plugin of this.plugins) {
			for (const dependency of plugin.dependencies) {
				const dependencyPlugin = this.plugins.find(
					(p) => p.name === dependency
				);
				if (!dependencyPlugin) {
					throw new Error(
						`Dependency ${dependency} not found for plugin ${plugin.name}`
					);
				}
			}
			plugin.install(this);
		}
	}

	getPlugin<T extends ManagedPlugin>(name: string): T {
		const plugin = this.plugins.find((p) => p.name === name) as T;
		if (!plugin) {
			throw new Error(`Plugin ${name} not found`);
		}
		return plugin;
	}

	back() {
		this.element.contentWindow?.history.back();
	}

	forward() {
		this.element.contentWindow?.history.forward();
	}

	reload() {
		this.element.contentWindow?.location.reload();
	}

	go(url: string) {
		const encoded = rewriteUrl(url, this.context, {
			//@ts-expect-error
			origin: new URL(location.href),
			//@ts-expect-error
			base: new URL(location.href),
		});
		this.element.src = encoded;
	}
}
