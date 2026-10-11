import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { getOwnPropertyDescriptorHandler } from "@client/helpers";
import {
	Object_defineProperty,
	Reflect_apply,
	Reflect_get,
	Reflect_ownKeys,
	Symbol_for,
	_WeakMap,
} from "@/shared/snapshot";

type Listener = (...args: any) => any;

const realOnEvent = Symbol_for("scramjet original onevent function");

// true for a window outside the proxy, e.g. the host page posting into the frame. such a window
// must not reach the page, since its eval and other members are the real ones
function isForeignWindow(source: any): boolean {
	try {
		if (source.window !== source) return false;

		return !(SCRAMJETCLIENT in source);
	} catch {
		// a cross-origin window throws on the symbol check, and it is still foreign
		return true;
	}
}

export default function (client: ScramjetClient, self: Self) {
	// the page gets one handle per foreign window, so repeated events from the same window compare equal
	const foreignSources = new _WeakMap<object, object>();
	function foreignSourceHandle(source: any): object {
		let handle = foreignSources.get(source);
		if (!handle) {
			handle = {
				// replies still reach the real window
				postMessage(...args: any[]) {
					return source.postMessage(...args);
				},
				// the page's own view of eval: the indirect eval rewrites its code, as `parent.eval` does
				eval: client.indirectEval,
			};
			foreignSources.set(source, handle);
		}

		return handle;
	}

	const handlers = {
		message: {
			_init() {
				if (client.init.shouldBlockMessageEvent?.(this)) {
					return false;
				}

				return true;
			},
			ports() {
				// don't know why i have to do this?
				return this.ports;
			},
			source() {
				if (this.source === null) return null;

				// messages between proxied windows keep the real window, as before
				if (isForeignWindow(this.source))
					return foreignSourceHandle(this.source);

				return this.source;
			},
			origin() {
				if (!iswindow) return "";
				if (typeof this.data === "object" && "$scramjet$origin" in this.data)
					return this.data.$scramjet$origin;

				return client.url.origin;
			},
			data() {
				if (typeof this.data === "object" && "$scramjet$data" in this.data)
					return this.data.$scramjet$data;

				return this.data;
			},
		},
		hashchange: {
			oldURL() {
				return client.unrewriteUrl(this.oldURL);
			},
			newURL() {
				return client.unrewriteUrl(this.newURL);
			},
		},
		storage: {
			_init() {
				return this.key.startsWith(client.url.host + "@");
			},
			key() {
				return this.key.substring(this.key.indexOf("@") + 1);
			},
			url() {
				return client.unrewriteUrl(this.url);
			},
		},
	};

	// one wrapper per original listener: the same function always maps to the same
	// proxy, so native addEventListener dedupes it and native removeEventListener
	// matches (type, proxy, capture) exactly like the browser would
	const proxiedListeners = new _WeakMap() as WeakMap<Listener, Listener>;
	// the event currently being dispatched to a wrapped listener (backs window.event)
	let currentEvent: Event | undefined;
	let windowEventDefined = false;

	function wraplistener(listener: Listener): Listener {
		const existing = proxiedListeners.get(listener);
		if (existing) return existing;

		const proxied = new Proxy(listener, {
			apply(target, that, args) {
				const realEvent: Event = args[0];

				// we only need to handle events dispatched from the browser
				if (realEvent.isTrusted) {
					const type = realEvent.type;

					if (type in handlers) {
						const handler = handlers[type];

						if (handler._init) {
							// if _init returns false, we skip the event, and it never dispatches to listeners
							if (handler._init.call(realEvent) === false) return;
						}

						args[0] = new Proxy(realEvent, {
							get(target, prop, reciever) {
								const value = Reflect_get(target, prop);
								if (prop in handler) {
									return handler[prop].call(target);
								}

								if (typeof value === "function") {
									return new Proxy(value, {
										apply(target, that, args) {
											if (that === reciever) {
												return Reflect_apply(target, realEvent, args);
											}

											return Reflect_apply(target, that, args);
										},
									});
								}

								return value;
							},
							getOwnPropertyDescriptor: getOwnPropertyDescriptorHandler,
						});
					}
				}

				// only where the browser doesn't provide it (e.g. workers), and only once:
				// our getter reads undefined between dispatches, so checking self.event
				// alone would redefine it on every call (e.g. every pointer move)
				if (!windowEventDefined && !self.event) {
					windowEventDefined = true;
					Object_defineProperty(self, "event", {
						get() {
							return currentEvent;
						},
						configurable: true,
					});
				}

				const prevEvent = currentEvent;
				currentEvent = args[0];
				try {
					return Reflect_apply(target, that, args);
				} finally {
					currentEvent = prevEvent;
				}
			},
			getOwnPropertyDescriptor: getOwnPropertyDescriptorHandler,
		});

		proxiedListeners.set(listener, proxied);
		return proxied;
	}

	client.Proxy("EventTarget.prototype.addEventListener", {
		apply(ctx) {
			if (typeof ctx.args[1] !== "function") return;

			ctx.args[1] = wraplistener(ctx.args[1]);
		},
	});

	client.Proxy("EventTarget.prototype.removeEventListener", {
		apply(ctx) {
			if (typeof ctx.args[1] !== "function") return;

			// keep capture/options in args[2] untouched: the native call matches on them
			ctx.args[1] = proxiedListeners.get(ctx.args[1]) ?? ctx.args[1];
		},
	});

	const targets = [
		self.self,
		self.MessagePort.prototype,
		self.BroadcastChannel.prototype,
	] as Array<any>;
	if (iswindow) targets.push(self.HTMLElement.prototype);
	if (self.Worker) targets.push(self.Worker.prototype);

	for (const target of targets) {
		const keys = Reflect_ownKeys(target);

		for (const key of keys) {
			if (
				typeof key === "string" &&
				key.startsWith("on") &&
				handlers[key.slice(2)]
			) {
				const descriptor = client.natives.call(
					"Object.getOwnPropertyDescriptor",
					null,
					target,
					key
				);
				if (!descriptor.get || !descriptor.set || !descriptor.configurable)
					continue;

				// these are the `onmessage`, `onclick`, etc. properties
				client.RawTrap(target, key, {
					get(ctx) {
						if (this[realOnEvent]) return this[realOnEvent];

						return ctx.get();
					},
					set(ctx, value: any) {
						this[realOnEvent] = value;

						if (typeof value !== "function") return ctx.set(value);

						ctx.set(wraplistener(value));
					},
				});
			}
		}
	}
}
