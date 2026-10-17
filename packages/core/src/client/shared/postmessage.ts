import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { Object_defineProperty, String, _WeakMap } from "@/shared/snapshot";
import { POLLUTANT } from "./realm";

// the helpers below only depend on the caller's realm, so they are built once per realm (keyed by
// that realm's Function). every Function() call goes through the Function hook (a rewrite and two
// compiles), which made each postMessage several hundred microseconds slower than the native call
const realmHelpers = new _WeakMap() as WeakMap<
	object,
	{ callerGlobalThisProxied: Self; wrappedPostMessage: any }
>;

export default function (client: ScramjetClient, self: Self) {
	if (iswindow)
		client.Proxy("window.postMessage", {
			apply(ctx) {
				// so we need to send the real origin here, since the recieving window can't possibly know.
				// except, remember that this code is being ran in a different realm than the invoker, so if we ask our `client` it may give us the wrong origin
				// if we were given any object that came from the real realm we can use that to get the real origin
				// and this works in every case EXCEPT for the fact that all three arguments can be strings which are copied instead of cloned
				// so we have to use `$setrealm` which will pollute this with an object from the real realm

				let pollutant;

				if (typeof ctx.args[0] === "object" && ctx.args[0] !== null) {
					pollutant = ctx.args[0]; // try to use the first object we can find because it's more reliable
				} else if (typeof ctx.args[2] === "object" && ctx.args[2] !== null) {
					pollutant = ctx.args[2]; // next try to use transfer
				} else if (
					ctx.this &&
					POLLUTANT in ctx.this &&
					typeof ctx.this[POLLUTANT] === "object" &&
					ctx.this[POLLUTANT] !== null
				) {
					pollutant = ctx.this[POLLUTANT]; // lastly try to use the object from $setrealm
				} else {
					pollutant = {}; // give up
				}

				// and now we can steal Function from the caller's realm
				const {
					constructor: { constructor: Function },
				} = pollutant;

				let helpers = realmHelpers.get(Function);
				if (!helpers) {
					helpers = {
						// invoking stolen function will give us the caller's globalThis, remember scramjet has already proxied it!!!
						callerGlobalThisProxied: Function("return globalThis")(),
						// this WOULD be enough but the source argument of MessageEvent has to return the caller's window
						// and if we just call it normally it would be coming from here, which WILL NOT BE THE CALLER'S because the accessor is from the parent
						// so with the stolen function we wrap postmessage so the source will truly be the caller's window (remember that function is scramjet's!!!)
						wrappedPostMessage: Function("...args", "this(...args)"),
					};
					realmHelpers.set(Function, helpers);
				}
				const { callerGlobalThisProxied, wrappedPostMessage } = helpers;
				const callerClient = callerGlobalThisProxied[SCRAMJETCLIENT];

				// console.log(
				// 	callerClient,
				// 	client,
				// 	callerGlobalThisProxied.document,
				// 	self.document,
				// 	callerClient === client
				// );
				const inherit =
					callerClient.url.href === "about:srcdoc" ||
					callerClient.url.href === "about:blank";
				ctx.args[0] = {
					$scramjet$messagetype: "window",
					$scramjet$origin: inherit
						? callerClient.global.parent[SCRAMJETCLIENT].url.origin
						: callerClient.url.origin,
					$scramjet$data: ctx.args[0],
				};
				// console.error("?", ctx.args);
				// eval("debugger");

				// * origin because obviously
				if (typeof ctx.args[1] === "string") ctx.args[1] = "*";
				if (typeof ctx.args[1] === "object") ctx.args[1].targetOrigin = "*";

				ctx.return(wrappedPostMessage.call(ctx.fn, ...ctx.args));
			},
		});

	// every proxied site shares one real origin, so channel names are namespaced per proxied origin.
	// an about: frame (e.g. an iframe without src) has no origin of its own, so it uses its creator's
	const channelOrigin = () => {
		if (client.url.protocol === "about:" && self.parent !== self) {
			try {
				const parent = (self.parent as Self)[SCRAMJETCLIENT];
				if (parent) return parent.url.origin;
			} catch {
				// a real cross-origin parent: keep this frame's own origin
			}
		}
		return client.url.origin;
	};

	client.Proxy("BroadcastChannel", {
		construct(ctx) {
			if (ctx.args.length === 0) return;
			ctx.args[0] = `${channelOrigin()}@${String(ctx.args[0])}`;
		},
	});

	client.Trap("BroadcastChannel.prototype.name", {
		get(ctx) {
			const name = String(ctx.get());
			return name.substring(name.indexOf("@") + 1);
		},
	});

	client.Proxy("BroadcastChannel.prototype.postMessage", {
		apply(ctx) {
			ctx.args[0] = {
				$scramjet$messagetype: "window",
				// TODO: need to actually look up the broadcastchannel itself in box i think
				$scramjet$origin: channelOrigin(),
				$scramjet$data: ctx.args[0],
			};
		},
	});

	const toproxy = ["MessagePort.prototype.postMessage"];

	if (self.Worker) toproxy.push("Worker.prototype.postMessage");
	if (!iswindow) toproxy.push("self.postMessage"); // only do the generic version if we're in a worker

	client.Proxy(toproxy, {
		apply(ctx) {
			// origin/source doesn't need to be preserved - it's null in the message event

			ctx.args[0] = {
				$scramjet$messagetype: "worker",
				$scramjet$data: ctx.args[0],
			};
		},
	});
	Object_defineProperty(self, client.config.globals.wrappostmessagefn, {
		value: function (obj: any) {
			if (!obj || typeof obj.postMessage !== "function") return obj;
			return {
				postMessage: obj.postMessage.bind(obj),
			};
		},
		configurable: false,
		writable: false,
		enumerable: false,
	});
}
