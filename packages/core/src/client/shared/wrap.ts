import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
// import { argdbg } from "@client/shared/err";
import {
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
	Object_getPrototypeOf,
	Reflect_apply,
	Reflect_ownKeys,
	Reflect_set,
} from "@/shared/snapshot";

// window.location and document.location are [LegacyUnforgeable] accessors, so they can't be redefined.
// a write through Reflect.set or Object.assign runs the native setter, which would navigate to a
// javascript: url without rewriting its code. those two entry points route the value through
// client.url, the same path `location = x` takes after rewriting
function hookLocationWrites(client: ScramjetClient, self: GlobalThis) {
	const realWindow = self;
	const realDocument = self.document;
	const nativeAssign = self.Object.assign;
	const nativeSet = self.Reflect.set;

	// these are plain methods rather than client.Proxy or a Proxy trap. client.Proxy allocates a context
	// object and closures per call, and a Proxy trap allocates an argument array per call; together that
	// was about +70% on Object.assign and +87% on Reflect.set in the benchmark. a method has no
	// prototype and is not constructible, like the natives. the common case is one identity check
	// against the two cached objects, then a direct native call with no argument array
	const { assign, set } = {
		assign(target: any, source: any) {
			if (target === realWindow || target === realDocument)
				return assignIntoLocationTarget(client, nativeAssign, arguments);

			switch (arguments.length) {
				case 2:
					return nativeAssign(target, source);
				case 1:
					return nativeAssign(target);
				default:
					return Reflect_apply(nativeAssign, undefined, arguments);
			}
		},
		set(target: any, key: any, value: any) {
			if (
				(target === realWindow || target === realDocument) &&
				key === "location" &&
				(arguments.length < 4 || arguments[3] === target)
			) {
				client.url = value;

				return true;
			}

			if (arguments.length < 4) return nativeSet(target, key, value);

			return nativeSet(target, key, value, arguments[3]);
		},
	};

	// the hooks report the native source text to Function.prototype.toString
	client.box.unproxy.set(assign, nativeAssign);
	client.box.unproxy.set(set, nativeSet);
	Object_defineProperty(self.Object, "assign", {
		value: assign,
		writable: true,
		enumerable: false,
		configurable: true,
	});
	Object_defineProperty(self.Reflect, "set", {
		value: set,
		writable: true,
		enumerable: false,
		configurable: true,
	});
}

// Object.assign(window, src) with a source that has an own enumerable `location` must not reach the
// native location setter, so those sources are copied key by key like [[Set]] does
function assignIntoLocationTarget(
	client: ScramjetClient,
	nativeAssign: (...args: any[]) => any,
	args: ArrayLike<any>
) {
	let hasLocation = false;
	for (let i = 1; i < args.length; i++) {
		const source = args[i];
		if (source === null || source === undefined) continue;
		if (Object_getOwnPropertyDescriptor(source, "location")?.enumerable) {
			hasLocation = true;
			break;
		}
	}
	if (!hasLocation) return Reflect_apply(nativeAssign, undefined, args);

	const target = args[0];
	for (let i = 1; i < args.length; i++) {
		const source = args[i];
		if (source === null || source === undefined) continue;
		const from: any = Object(source);
		for (const key of Reflect_ownKeys(from)) {
			if (!Object_getOwnPropertyDescriptor(from, key)?.enumerable) continue;
			const value = from[key];
			if (key === "location") {
				client.url = value;
			} else if (!Reflect_set(target, key, value)) {
				throw new TypeError(
					`Cannot assign to read only property '${String(key)}' of object`
				);
			}
		}
	}

	return target;
}

export function createWrapFn(client: ScramjetClient, self: GlobalThis) {
	// the native eval as it was when scramjet loaded. page code may replace window.eval, and such a
	// replacement must be honoured, so the check cannot compare against the current self.eval
	const nativeEval = self.eval;
	let wrappedParent: GlobalThis | null = null;
	let wrappedTop: GlobalThis | null = null;
	if (iswindow) {
		try {
			if (SCRAMJETCLIENT in self.parent) {
				// ... then we're in a subframe, and the parent frame is also in a proxy context, so we should return its proxy
				wrappedParent = self.parent;
			} else {
				// ... then we should pretend we aren't nested and return the current window
				wrappedParent = self;
			}
		} catch {
			// accessing self.parent can throw if it's cross-origin, in which case we should also pretend we aren't nested
			wrappedParent = self;
		}
		// instead of returning top, we need to return the uppermost parent that's inside a scramjet context
		let current = self;
		for (;;) {
			const test = current.parent.self;
			if (test === current) break; // there is no parent, actual or emulated.

			try {
				// ... then `test` represents a window outside of the proxy context, and therefore `current` is the topmost window in the proxy context
				if (!(SCRAMJETCLIENT in test)) break;
			} catch {
				// accessing test can throw if it's cross-origin, in which case we should also break
				break;
			}
			// test is also insde a proxy, so we should continue up the chain
			current = test;
		}
		wrappedTop = current;
	}

	return function (identifier: any) {
		if (identifier === self.location) return client.locationProxy;
		if (identifier === nativeEval) {
			return client.indirectEval;
		}
		if (iswindow) {
			if (identifier === self.parent) {
				return wrappedParent;
			} else if (identifier === self.top) {
				return wrappedTop;
			}
		}
		return identifier;
	};
}

// decides whether `receiver[key]` can safely use the raw key instead of the `$scramjet__` alias.
// only a null-prototype object is treated as a plain dictionary: Window, Location and Document
// always have a prototype. cross-origin windows and locations report a null prototype, so they
// are excluded by the `self` check, which is readable cross-origin and returns the window itself.
// anything that throws (including proxies that throw) falls back to the alias.
function isNullProtoDictionary(receiver: any, alias: string): boolean {
	try {
		if (receiver === null) return false;
		const t = typeof receiver;
		if (t !== "object" && t !== "function") return false;
		if (Object_getPrototypeOf(receiver) !== null) return false;
		if (alias in receiver) return false;

		const selfRef = receiver.self;
		if (selfRef !== null && selfRef !== undefined && selfRef.self === selfRef)
			return false;

		return true;
	} catch {
		return false;
	}
}

export const order = 4;
export default function (client: ScramjetClient, self: GlobalThis) {
	Object_defineProperty(self, client.config.globals.wrapfn, {
		value: client.wrapfn,
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.wrappropertyfn, {
		// receiver is only passed for `receiver[key]`, where it is a plain identifier or `this`
		value: function (str: any, receiver?: any) {
			if (
				str === "location" ||
				str === "parent" ||
				str === "top" ||
				str === "eval"
			) {
				const alias = client.config.globals.wrappropertybase + str;
				if (isNullProtoDictionary(receiver, alias)) return str;

				return alias;
			}

			return str;
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.cleanrestfn, {
		value: function (obj) {
			// TODO
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});

	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "location",
		{
			get: function () {
				// if (this.location.constructor.toString().includes("Location")) {

				if (this === self || this === self.document) {
					return client.locationProxy;
				}

				return this.location;
			},
			set(value: any) {
				if (this === self || this === self.document) {
					client.url = value;

					return;
				}
				this.location = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "parent",
		{
			get: function () {
				return client.wrapfn(this.parent);
			},
			set(value: any) {
				// i guess??
				this.parent = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "top",
		{
			get: function () {
				return client.wrapfn(this.top);
			},
			set(value: any) {
				this.top = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "eval",
		{
			get: function () {
				return client.wrapfn(this.eval);
			},
			set(value: any) {
				this.eval = value;
			},
			configurable: false,
			enumerable: false,
		}
	);

	self.$scramitize = function (v) {
		const t = typeof v;
		if (t === "object" && v !== null) {
			if (v === location) debugger;
			if (iswindow) {
				// if (v === self.parent) debugger;
				if (v === self.top) debugger;
			}
		} else if (t === "string") {
			if (v.includes("scramjet")) debugger;
			if (v.includes("~/sj")) debugger;
			if (v.includes(location.origin)) debugger;
		}

		return v;
	};

	// location = "..." can't be rewritten as wrapfn(location) = ..., so instead it will actually be rewritten as
	// ((t)=>$scramjet$tryset(location,"+=",t)||location+=t)(...);
	// it has to be a discrete function because there's always the possibility that "location" is a local variable
	// we have to use an IIFE to avoid duplicating side-effects in the getter
	Object_defineProperty(self, client.config.globals.trysetfn, {
		value: function (lhs: any, op: string, rhs: any) {
			if (client.box.locations.has(lhs)) {
				lhs.href = rhs;
				return true;
			}

			return false;
		},
		writable: false,
		configurable: false,
	});

	if (iswindow) hookLocationWrites(client, self);
}
