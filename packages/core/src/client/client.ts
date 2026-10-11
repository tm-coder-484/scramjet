import {
	BareCompatibleClient,
	ProxyTransport,
	RawHeaders,
} from "@mercuryworkshop/proxy-transports";
import { SCRAMJETCLIENT } from "@/symbols";
import { getOwnPropertyDescriptorHandler } from "@client/helpers";
import { createLocationProxy } from "@client/location";
import { createWrapFn } from "@client/shared/wrap";
import { LifecycleHooks } from "@client/events";
import {
	rewriteUrl,
	RewriteUrlOptions,
	unrewriteUrl,
	type URLMeta,
} from "@rewriters/url";
import {
	flagEnabled,
	HtmlRewriterHooks,
	ScramjetContext,
	ScramjetHeaders,
} from "@/shared";
import { iswindow } from "./entry";
import { SingletonBox } from "./singletonbox";
import { ScramjetConfig } from "@/types";
import { Tap } from "@/Tap";
import {
	type CookieSyncEntry,
	type CookieSyncOptions,
	TrackedHistoryState,
} from "@/fetch";
import { AnyFunction } from "@/types";
import {
	_URL,
	Error,
	String,
	Reflect_get,
	Array_isArray,
	Reflect_has,
	Reflect_apply,
	Reflect_construct,
	Object_getOwnPropertyDescriptor,
	Object_defineProperty,
	Object_defineProperties,
	_Map,
} from "@/shared/snapshot";
import { createIndirectEval } from "./shared/eval";

// https://github.com/Microsoft/TypeScript/issues/27024#issuecomment-421529650
type IfEquals<T, U, Y = unknown, N = never> =
	(<G>() => G extends T ? 1 : 2) extends <G>() => G extends U ? 1 : 2 ? Y : N;
// thank you psm (https://github.com/psmpm) <3
type Traverse<
	O extends Record<any, any>,
	P extends string,
> = P extends `${infer K}.${infer R}` ? Traverse<O[K], R> : O[P];
type GlobalTraverse<P extends string> = Traverse<
	GlobalThis & Record<string, any>,
	P
>;
type ProxyApplyThis<T extends string> =
	unknown extends ThisParameterType<Extract<GlobalTraverse<T>, AnyFunction>>
		? T extends `${infer ClassName}.prototype.${string}`
			? GlobalTraverse<ClassName> extends { prototype: infer Proto }
				? Proto
				: unknown
			: unknown
		: ThisParameterType<Extract<GlobalTraverse<T>, AnyFunction>>;

export type ScramjetClientInit = {
	context: ScramjetContext;
	transport: ProxyTransport;
	sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions
	) => Promise<void>;
	shouldBlockMessageEvent?: (ev: MessageEvent) => boolean;
	/** returns a transport port for a worker this realm creates, so the worker can open websockets */
	createWorkerTransport?: () => MessagePort;
	hookSubcontext: (self: Self, frame?: HTMLIFrameElement) => ScramjetClient;
	initHeaders: RawHeaders;
	history: TrackedHistoryState[];
};
type NativeStore = {
	store: Record<string, any>;
	construct: <T extends string>(
		target: T,
		...args: ConstructorParameters<GlobalTraverse<T>>
	) => InstanceType<GlobalTraverse<T>>;
	call: <T extends string>(
		target: T,
		that: ProxyApplyThis<T>,
		...args: Parameters<GlobalTraverse<T>>
	) => ReturnType<GlobalTraverse<T>>;
};
type DescriptorStore = {
	store: Record<string, PropertyDescriptor>;
	get: <T extends string>(target: T, that: any) => GlobalTraverse<T>;
	set: <T extends string>(
		target: T,
		that: any,
		value: GlobalTraverse<T>
	) => void;
};

export type ProxyCtx<
	T extends string = string,
	U extends "construct" | "apply" = "apply",
> = {
	fn: GlobalTraverse<T>;
	this: IfEquals<U, "construct", null, ProxyApplyThis<T>>;
	args: IfEquals<
		U,
		"construct",
		ConstructorParameters<GlobalTraverse<T>>,
		Parameters<GlobalTraverse<T>>
	>;
	newTarget: IfEquals<U, "construct", GlobalTraverse<T>, null>;
	return: (
		r: IfEquals<
			U,
			"construct",
			InstanceType<GlobalTraverse<T>>,
			ReturnType<GlobalTraverse<T>>
		>
	) => void;
	call: () => IfEquals<
		U,
		"construct",
		InstanceType<GlobalTraverse<T>>,
		ReturnType<GlobalTraverse<T>>
	>;
};
export type Proxy<T extends string = string> = {
	construct?(ctx: ProxyCtx<T, "construct">): any;
	apply?(ctx: ProxyCtx<T, "apply">): any;
};

export type TrapCtx<T extends string> = {
	this: any;
	get: () => GlobalTraverse<T>;
	set: (v: GlobalTraverse<T>) => void;
};
export type Trap<T extends string> = {
	writable?: boolean;
	value?: any;
	enumerable?: boolean;
	configurable?: boolean;
	get?: (ctx: TrapCtx<T>) => GlobalTraverse<T>;
	set?: (ctx: TrapCtx<T>, v: GlobalTraverse<T>) => void;
};

export type ScramjetModule = {
	enabled: (client: ScramjetClient) => boolean | undefined;
	disabled: (client: ScramjetClient, self: GlobalThis) => void | undefined;
	order: number | undefined;
	default: (client: ScramjetClient, self: GlobalThis) => void;
};

// the ctx a hook handler gets for an apply. return and call are on the prototype, so a hooked
// call allocates this one object instead of two closures. no handler uses return/call detached
class ApplyHookCtx {
	fn: any;
	"this": any;
	args: any[];
	newTarget: null = null;
	earlyreturn = false;
	returnValue: any = undefined;
	invoke: (fn: any, that: any, args: any[]) => any;
	constructor(
		fn: any,
		that: any,
		args: any[],
		invoke: (fn: any, that: any, args: any[]) => any
	) {
		this.fn = fn;
		this["this"] = that;
		this.args = args;
		this.invoke = invoke;
	}
	return(r: any) {
		this.earlyreturn = true;
		this.returnValue = r;
	}
	call() {
		this.earlyreturn = true;
		return (this.returnValue = this.invoke(this.fn, this["this"], this.args));
	}
}

// same as ApplyHookCtx, for a construct
class ConstructHookCtx {
	fn: any;
	args: any[];
	newTarget: any;
	"this": null = null;
	earlyreturn = false;
	returnValue: any = undefined;
	invoke: (fn: any, args: any[], newTarget: any) => any;
	constructor(
		fn: any,
		args: any[],
		newTarget: any,
		invoke: (fn: any, args: any[], newTarget: any) => any
	) {
		this.fn = fn;
		this.args = args;
		this.newTarget = newTarget;
		this.invoke = invoke;
	}
	return(r: any) {
		this.earlyreturn = true;
		this.returnValue = r;
	}
	call() {
		this.earlyreturn = true;
		return (this.returnValue = this.invoke(this.fn, this.args, this.newTarget));
	}
}

const emptyFunction = function () {};

// true for a method that lives on a prototype object and is not constructible, the kind of
// function a plain wrapper can stand in for. constructors and static functions stay on Proxy
function isPlainPrototypeMethod(target: any, value: any): boolean {
	if (typeof value !== "function") return false;
	const ctor = Object_getOwnPropertyDescriptor(target, "constructor")?.value;
	if (typeof ctor !== "function" || ctor.prototype !== target) return false;
	if (Reflect_has(value, "prototype")) return false;
	// the real test: Reflect.construct throws when newTarget is not a constructor, and reads nothing
	// from it since value has no prototype property
	try {
		Reflect_construct(emptyFunction, [], value);
	} catch {
		return true;
	}
	return false;
}

// a method-shorthand function has no [[Construct]] and no prototype, like the native it wraps.
// name and length are copied from the native
function createMethodWrapper(
	name: string,
	value: AnyFunction,
	applyHook: (fn: any, that: any, args: any[]) => any
): AnyFunction {
	const wrapper = {
		[name](this: any, ...args: any[]) {
			return applyHook(value, this, args);
		},
	}[name];
	Object_defineProperty(wrapper, "length", {
		value: value.length,
		writable: false,
		enumerable: false,
		configurable: true,
	});
	Object_defineProperty(wrapper, "name", {
		value: value.name,
		writable: false,
		enumerable: false,
		configurable: true,
	});
	return wrapper;
}

function findBox(global: Window, seen: Window[]): SingletonBox | null {
	if (seen.includes(global)) return null;
	seen.push(global);

	try {
		if ((SCRAMJETCLIENT in global) as any) {
			return global[SCRAMJETCLIENT].box;
		}
	} catch {}

	try {
		const b = findBox(global.parent, seen);
		if (b) return b;
	} catch {}

	try {
		const b = findBox(global.top, seen);
		if (b) return b;
	} catch {}

	try {
		if (global.opener) {
			const b = findBox(global.opener, seen);
			if (b) return b;
		}
	} catch {}

	for (let i = 0; i < global.length; i++) {
		try {
			const b = findBox(global[i], seen);
			if (b) return b;
		} catch {}
	}

	return null;
}

export class ScramjetClient {
	locationProxy: any;
	indirectEval: any;
	serviceWorker: ServiceWorkerContainer;
	bare: BareCompatibleClient;

	natives: NativeStore;
	descriptors: DescriptorStore;
	wrapfn: (i: any, ...args: any) => any;

	eventcallbacks: Map<
		any,
		[
			{
				event: string;
				originalCallback: AnyFunction;
				proxiedCallback: AnyFunction;
			},
		]
	> = new _Map();

	meta: URLMeta;

	box: SingletonBox;

	context: ScramjetContext;

	initHeaders: ScramjetHeaders;

	history: TrackedHistoryState[];

	private flagCache = new _Map<keyof ScramjetConfig["flags"], boolean>();

	hooks = {
		rewriter: {
			html: Tap.create<HtmlRewriterHooks>(),
		},
		lifecycle: Tap.create<LifecycleHooks>(),
	};

	constructor(
		public global: GlobalThis,
		public init: ScramjetClientInit
	) {
		if (SCRAMJETCLIENT in global) {
			dbg.error(
				"attempted to initialize a scramjet client, but one is already loaded - this is very bad"
			);
			throw new Error();
		}

		if (iswindow) {
			const b = findBox(global as unknown as Window, []);
			if (b) {
				this.box = b;
			}
		}

		if (!this.box) {
			this.box = new SingletonBox(this);
		}

		this.box.registerClient(this, global as Self);

		this.context = init.context;
		if (init.initHeaders)
			this.initHeaders = ScramjetHeaders.fromRawHeaders(init.initHeaders);
		this.history = init.history;
		this.context.hooks = {
			rewriter: this.hooks.rewriter,
		};

		this.bare = new BareCompatibleClient(init.transport);

		this.serviceWorker = this.global.navigator.serviceWorker;

		if (iswindow) {
			global.document[SCRAMJETCLIENT] = this;
		}

		this.indirectEval = createIndirectEval(this);
		this.wrapfn = createWrapFn(this, global);
		this.natives = {
			store: new Proxy(
				{},
				{
					get: (target, prop: string) => {
						if (prop in target) {
							return target[prop];
						}

						const split = prop.split(".");
						const realProp = split.pop();
						const realTarget = split.reduce((a, b) => a?.[b], this.global);

						if (!realTarget) return;

						const original = Reflect_get(realTarget, realProp);
						target[prop] = original;

						return target[prop];
					},
				}
			),
			construct(target, ...args) {
				const original = this.store[target];
				if (!original) return null;

				return new original(...args);
			},
			call(target, that, ...args) {
				const original = this.store[target];
				if (!original) return null;

				return original.call(that, ...args);
			},
		};
		this.descriptors = {
			store: new Proxy(
				{},
				{
					get: (target, prop: string) => {
						if (prop in target) {
							return target[prop];
						}

						const split = prop.split(".");
						const realProp = split.pop();
						const realTarget = split.reduce((a, b) => a?.[b], this.global);

						if (!realTarget) return;

						const original = client.natives.call(
							"Object.getOwnPropertyDescriptor",
							null,
							realTarget,
							realProp
						);
						target[prop] = original;

						return target[prop];
					},
				}
			),
			get(target, that) {
				const original = this.store[target];
				if (!original) return null;

				return original.get!.call(that);
			},
			set(target, that, value) {
				const original = this.store[target];
				if (!original) return null;

				original.set!.call(that, value);
			},
		};
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const client = this;
		// the url of the first <base href>, resolved when it was last processed
		let frozenBase: {
			element: HTMLBaseElement;
			href: string;
			count: number;
			url: string;
		} | null = null;
		this.meta = {
			get origin() {
				return client.url;
			},
			get base() {
				if (!iswindow) return client.url;

				const bases = client.natives.call(
					"Document.prototype.getElementsByTagName",
					client.global.document,
					"base"
				);
				let base: HTMLBaseElement | null = null;
				for (let i = 0; i < bases.length; i++) {
					if (bases[i].hasAttribute("href")) {
						base = bases[i] as HTMLBaseElement;
						break;
					}
				}
				if (!base) {
					frozenBase = null;
					return client.url;
				}

				// like the browser, resolve the base href against the document url only when the
				// base is processed (inserted, href changed, bases added or removed), so a later
				// pushState/replaceState doesn't move it (GeForce NOW's lazy chunks rely on this)
				const href = base.getAttribute("href");
				if (
					frozenBase?.element !== base ||
					frozenBase.href !== href ||
					frozenBase.count !== bases.length
				) {
					let url = client.url;
					try {
						const parsed = new _URL(href, url);
						if (
							parsed.protocol !== "data:" &&
							parsed.protocol !== "javascript:"
						)
							url = parsed;
					} catch {
						// an invalid href falls back to the document url
					}
					frozenBase = {
						element: base,
						href,
						count: bases.length,
						url: url.href,
					};
				}

				return new _URL(frozenBase.url);
			},
			// TODO: very bad assumptions made here, window.parent never throws
			get topFrameName() {
				if (!iswindow)
					throw new Error("topFrameName was called from a worker?");

				let currentWin = client.global;

				try {
					if (currentWin.parent.window == currentWin.window) {
						// we're top level & we don't have a frame name
						return null;
					}
				} catch {
					// accessing parent was blocked by CORS, we're in a frame but the parent is cross origin
				}

				try {
					// find the topmost frame that's controlled by scramjet, stopping before the real top frame
					while (currentWin.parent.window !== currentWin.window) {
						if (!currentWin.parent.window[SCRAMJETCLIENT]) break;
						currentWin = currentWin.parent.window;
					}
				} catch {
					// doesn't matter if it throws here just means we found the topmost one
				}

				const curclient = currentWin[SCRAMJETCLIENT];
				const frame = curclient.descriptors.get(
					"window.frameElement",
					currentWin
				);
				if (!frame) {
					// we're inside an iframe, but the top frame is scramjet-controlled and top level, so we can't get a top frame name
					// or we're cross-origin and frameElement doesn't exist. that's a TODO because this won't work
					return null;
				}
				if (!frame.name) {
					// the top frame is scramjet-controlled, but it has no name. this is user error
					dbg.error(
						"YOU NEED TO USE `new ScramjetFrame()`! DIRECT IFRAMES WILL NOT WORK"
					);

					return null;
				}

				return frame.name;
			},
			get parentFrameName() {
				if (!iswindow)
					throw new Error("parentFrameName was called from a worker?");

				try {
					try {
						if (client.global.parent.window == client.global.window) {
							// we're top level & we don't have a frame name
							return null;
						}
					} catch {
						// accessing parent was blocked by CORS, we're in a frame but the parent is cross origin
						return null;
					}

					const parentWin = client.global.parent.window;
					if (parentWin[SCRAMJETCLIENT]) {
						// we're inside an iframe, and the parent is scramjet-controlled
						const parentClient = parentWin[SCRAMJETCLIENT];
						const frame = parentClient.descriptors.get(
							"window.frameElement",
							parentWin
						);

						if (!frame) {
							// parent is scramjet controlled and top-level. there is no parent frame name
							return null;
						}

						if (!frame.name) {
							// the parent frame is scramjet-controlled, but it has no name. this is user error
							dbg.error(
								"YOU NEED TO USE `new ScramjetFrame()`! DIRECT IFRAMES WILL NOT WORK"
							);

							return null;
						}

						return frame.name;
					} else {
						// we're inside an iframe, and the parent is not scramjet-controlled
						// return our own frame name
						const frame = client.descriptors.get(
							"window.frameElement",
							client.global
						);
						if (!frame.name) {
							// the parent frame is not scramjet-controlled, so we can't get a parent frame name
							dbg.error(
								"YOU NEED TO USE `new ScramjetFrame()`! DIRECT IFRAMES WILL NOT WORK"
							);

							return null;
						}

						return frame.name;
					}
				} catch {
					return null;
				}
			},
			get referrerPolicy(): string | undefined {
				if (client.initHeaders && client.initHeaders.has("referrer-policy")) {
					return client.initHeaders.get("referrer-policy");
				}
				if (!iswindow) return "";

				// TODO: need to nullify the actual meta tag so it still sends unsafe-url
				// one walk for the <meta> tags (the engine caches a live tag collection until the DOM
				// changes), then the three checks run on that short list. the last match wins, in the
				// order: name=referrer, name=referrer-policy, http-equiv=referrer-policy (ASCII case-insensitive)
				// a querySelectorAll with a selector list costs as much as three separate walks, so it is not used
				const metas = client.natives.call(
					"Document.prototype.getElementsByTagName",
					client.global.document,
					"meta"
				);
				const attr = (el: Element, name: string) =>
					client.natives.call("Element.prototype.getAttribute", el, name);
				const matchers: ((el: Element) => boolean)[] = [
					(el) => attr(el, "name") === "referrer",
					(el) => attr(el, "name") === "referrer-policy",
					(el) =>
						(attr(el, "http-equiv") ?? "").toLowerCase() === "referrer-policy",
				];
				let last: Element | undefined;
				for (const matches of matchers) {
					for (let i = 0; i < metas.length; i++) {
						if (matches(metas[i])) last = metas[i];
					}
				}
				if (last) {
					return last.getAttribute("content");
				}

				return "";
			},
		};
		this.locationProxy = createLocationProxy(this, global);

		global[SCRAMJETCLIENT] = this;
	}

	/** Apply document injection init when a client was already installed (e.g. early contentWindow). */
	syncDocumentInit(init: {
		initHeaders: RawHeaders;
		history: TrackedHistoryState[];
		cookies?: string;
	}) {
		this.initHeaders = ScramjetHeaders.fromRawHeaders(init.initHeaders);
		this.history = init.history;
		if (init.cookies !== undefined) {
			this.context.cookieJar.load(init.cookies);
		}
	}

	hook() {
		const context = import.meta.webpackContext(".", {
			recursive: true,
		});

		const modules: ScramjetModule[] = [];

		for (const key of context.keys()) {
			const module = context(key) as ScramjetModule;
			if (!key.endsWith(".ts")) continue;
			if (
				(key.startsWith("./dom/") && "window" in this.global) ||
				(key.startsWith("./worker/") && "WorkerGlobalScope" in this.global) ||
				key.startsWith("./shared/")
			) {
				modules.push(module);
			}
		}

		modules.sort((a, b) => {
			const aorder = a.order || 0;
			const border = b.order || 0;

			return aorder - border;
		});

		for (const module of modules) {
			if (!module.enabled || module.enabled(this))
				module.default(this, this.global);
			else if (module.disabled) module.disabled(this, this.global);
		}
	}

	// location.href is unrewritten (two URL parses) on every read of client.url, and client.url
	// is read several times per URL rewrite (meta.origin, meta.base), so keep the last result
	private lastRawHref: string | undefined;
	private lastUnrewrittenHref: string | undefined;
	// the parsed form of lastUnrewrittenHref, built lazily. it stays inside the client: it is only read
	// by peekUrl(), and url hands out a fresh object each time since callers may mutate it
	private cachedUrl: _URL | undefined;

	private syncUrl(): string {
		const raw = this.global.location.href;
		if (raw !== this.lastRawHref || this.lastUnrewrittenHref === undefined) {
			this.lastUnrewrittenHref = this.unrewriteUrl(raw);
			this.lastRawHref = raw;
			this.cachedUrl = undefined;
		}
		return this.lastUnrewrittenHref;
	}

	get url(): _URL {
		return new _URL(this.syncUrl());
	}

	// read-only view of the current url, for reading its string properties (href, origin, ...).
	// never pass it to code that might mutate it, use url for that
	peekUrl(): _URL {
		const href = this.syncUrl();
		return this.cachedUrl ?? (this.cachedUrl = new _URL(href));
	}

	set url(url: _URL | string) {
		url = String(url);

		Tap.dispatch(
			this.hooks.lifecycle.navigate,
			{
				type: "location",
			},
			{
				url,
			}
		);

		this.global.location.href = this.rewriteUrl(url, {
			navigateType: "location",
		});
	}

	// below are the utilities for proxying and trapping dom APIs
	// you don't have to understand this it just makes the rest easier
	// i'll document it eventually
	Proxy<T extends string>(name: T, handler: Proxy<T>): void;
	Proxy<const T extends readonly string[]>(
		name: T,
		handler: Proxy<T[number]>
	): void;
	Proxy(name: string | string[], handler: Proxy<any>): void {
		if (Array_isArray(name)) {
			for (const n of name) {
				this.Proxy(n, handler);
			}

			return;
		}

		const split = name.split(".");
		const prop = split.pop();
		const target = split.reduce((a, b) => a?.[b], this.global);
		if (!target) return;
		if (!prop) return;

		if (!(name in this.natives.store)) {
			const original = Reflect_get(target, prop);
			this.natives.store[name] = original;
		}

		this.RawProxy(target, prop, handler, name);
	}
	RawProxy(target: any, prop: string, handler: Proxy<any>, debugname?: string) {
		if (!target) return;
		if (!prop) return;
		if (!Reflect_has(target, prop)) return;

		const value = Reflect_get(target, prop);
		const originalDescriptor = Object_getOwnPropertyDescriptor(target, prop);
		delete target[prop];

		const h: ProxyHandler<any> = {};

		let applyFn: typeof Reflect_apply;
		let constructFn: typeof Reflect_construct;
		const debugTrampolines = this.flagEnabled("debugTrampolines");
		if (debugTrampolines) {
			let fnName: string;
			if (debugname) {
				fnName = debugname;
			} else if (typeof value === "function" && value.name) {
				fnName = `Function ${value.name} -> ${prop}`;
			} else if (typeof value === "object" && value.constructor) {
				fnName = `Object ${value.constructor.name} -> ${prop}`;
			} else {
				fnName = `${typeof value} -> ${prop}`;
			}
			let windowName = this.descriptors.get("window.name", this.global);
			if (!windowName) windowName = "<unnamed window>";
			let location = this.url.href;

			// sanitize newlines just in case somehow
			location = location.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
			windowName = windowName.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
			fnName = fnName.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
			const sourceURL = debugname ? `${debugname}.sj` : "rawproxy.sj";

			const { construct, apply } = this.natives.call(
				"Function",
				null,
				`"use strict";

// SCRAMJET FUNCTION INTERCEPT
// target: ${fnName}
// frame: ${windowName}
// location: ${location}

function apply(fn, that, args) {
	return Reflect.apply(fn, that, args);
}

function construct(fn, args, newTarget) {
	return Reflect.construct(fn, args, newTarget);
}

return { apply, construct };

//# sourceURL=${sourceURL}`
			)();

			applyFn = apply;
			constructFn = construct;
		} else {
			applyFn = Reflect_apply;
			constructFn = Reflect_construct;
		}

		if (handler.construct) {
			h.construct = function (
				constructor: any,
				args: any[],
				newTarget: AnyFunction
			) {
				const ctx = new ConstructHookCtx(
					constructor,
					args,
					newTarget,
					constructFn
				);

				handler.construct!(ctx as any as ProxyCtx<any, "construct">);

				if (ctx.earlyreturn) {
					return ctx.returnValue;
				}

				return constructFn(ctx.fn, ctx.args, ctx.newTarget);
			};
		}

		// the apply logic, shared by the Proxy apply trap and the plain wrapper below
		// allowFailedIntercepts is read on the first call, exactly when the old per-call check first read it
		// (flagEnabled caches per client, so every later read returns the same value)
		let allowFailed: boolean | undefined;
		// hoisted: one function per hook, not one per call
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const client = this;
		const prepareStackTrace = function (err: any, s: any[]) {
			if (
				s[0].getFileName() &&
				!s[0].getFileName().startsWith(client.context.prefix.href)
			) {
				return { stack: err.stack };
			}
		};
		const applyHook = (fn: any, that: any, args: any[]) => {
			const ctx = new ApplyHookCtx(fn, that, args, applyFn);
			allowFailed ??= this.flagEnabled("allowFailedIntercepts");

			if (!debugTrampolines && allowFailed) {
				// fast path, no error detection
				handler.apply!(ctx as any as ProxyCtx<any, "apply">);

				if (ctx.earlyreturn) {
					return ctx.returnValue;
				}
				return applyFn(ctx.fn, ctx.this, ctx.args);
			}

			const pst = Error.prepareStackTrace;

			Error.prepareStackTrace = prepareStackTrace;

			try {
				handler.apply!(ctx as any as ProxyCtx<any, "apply">);
			} catch (err) {
				if (this.box.instanceof(err, "Error")) {
					if (this.box.instanceof(err.stack, "Object")) {
						//i'm not going to explain this
						err.stack = err.stack.stack;
						// eslint-disable-next-line scramjet-core/no-globals
						console.error("ERROR FROM SCRAMJET INTERNALS", err);
						if (!allowFailed) {
							Error.prepareStackTrace = pst;
							throw err;
						}
					} else {
						Error.prepareStackTrace = pst;
						throw err;
					}
				} else {
					Error.prepareStackTrace = pst;
					throw err;
				}
			}

			Error.prepareStackTrace = pst;

			if (ctx.earlyreturn) {
				return ctx.returnValue;
			}

			return applyFn(ctx.fn, ctx.this, ctx.args);
		};

		let proxy: any;
		if (
			handler.apply &&
			!handler.construct &&
			isPlainPrototypeMethod(target, value)
		) {
			// a plain method on a prototype: a real function is much cheaper than a Proxy apply trap
			proxy = createMethodWrapper(prop, value, applyHook);
		} else {
			if (handler.apply) h.apply = applyHook;
			h.getOwnPropertyDescriptor = getOwnPropertyDescriptorHandler;
			proxy = new Proxy(value, h);
		}
		this.box.unproxy.set(proxy, value);
		// Preserve original property descriptor (enumerable, configurable, etc.)
		Object_defineProperty(target, prop, {
			value: proxy,
			writable: originalDescriptor?.writable ?? true,
			enumerable: originalDescriptor?.enumerable ?? false,
			configurable: originalDescriptor?.configurable ?? true,
		});
	}
	Trap<T extends string>(name: T, handler: Trap<T>): void;
	Trap<const T extends readonly string[]>(
		name: T,
		handler: Trap<T[number]>
	): void;
	Trap(name: string | string[], descriptor: Trap<any>): void {
		if (Array_isArray(name)) {
			for (const n of name) {
				this.Trap(n, descriptor);
			}

			return;
		}

		const split = name.split(".");
		const prop = split.pop();
		const target = split.reduce((a, b) => a?.[b], this.global);
		if (!target) return;
		if (!prop) return;

		const original = this.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			target,
			prop
		);
		this.descriptors.store[name] = original;

		this.RawTrap(target, prop, descriptor);
	}
	RawTrap(target: any, prop: string, descriptor: Trap<any>) {
		if (!target) return;
		if (!prop) return;
		if (!Reflect_has(target, prop)) return;

		const oldDescriptor = this.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			target,
			prop
		);

		const ctx: TrapCtx<any> = {
			this: null,
			get: function () {
				return oldDescriptor && oldDescriptor.get.call(this.this);
			},
			set: function (v: any) {
				// eslint-disable-next-line @typescript-eslint/no-unused-expressions
				oldDescriptor && oldDescriptor.set.call(this.this, v);
			},
		};

		delete target[prop];

		const desc: PropertyDescriptor = {};

		if (descriptor.get) {
			desc.get = function () {
				ctx.this = this;

				return descriptor.get(ctx);
			};
		} else if (oldDescriptor?.get) {
			desc.get = oldDescriptor.get;
		}

		if (descriptor.set) {
			desc.set = function (v: any) {
				ctx.this = this;

				descriptor.set(ctx, v);
			};
		} else if (oldDescriptor?.set) {
			desc.set = oldDescriptor.set;
		}

		if (descriptor.enumerable) desc.enumerable = descriptor.enumerable;
		else if (oldDescriptor?.enumerable)
			desc.enumerable = oldDescriptor.enumerable;
		if (descriptor.configurable) desc.configurable = descriptor.configurable;
		else if (oldDescriptor?.configurable)
			desc.configurable = oldDescriptor.configurable;

		Object_defineProperty(target, prop, desc);
	}

	rewriteUrl(url: string | URL, options?: RewriteUrlOptions): string {
		return rewriteUrl(url, this.context, this.meta, options);
	}

	unrewriteUrl(url: string | URL): string {
		return unrewriteUrl(url, this.context);
	}

	flagEnabled(flag: keyof ScramjetConfig["flags"]): boolean {
		const cached = this.flagCache.get(flag);
		if (cached !== undefined) return cached;

		const result = flagEnabled(flag, this.context, this.url);
		this.flagCache.set(flag, result);
		return result;
	}

	get config(): ScramjetConfig {
		return this.context.config;
	}
}
