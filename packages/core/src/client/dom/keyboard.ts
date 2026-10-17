import { ScramjetClient } from "@client/index";
import { SCRAMJETCLIENT } from "@/symbols";
import { Promise_resolve } from "@/shared/snapshot";

// navigator.keyboard.lock() only works in a top-level document, and proxied sites always live in
// an iframe, so it always rejected. Sites like GeForce NOW lock the keyboard in fullscreen so keys
// like Ctrl+G and Esc reach the page instead of the browser. In the site's top frame, lock the
// real top-level document instead: it's same-origin, and the lock applies to the whole tab.
export default function (client: ScramjetClient, self: Self) {
	const topKeyboard = (): Keyboard | null => {
		try {
			const parent = self.parent;
			// a subframe of the site rejects, like it would natively
			if (parent === self || SCRAMJETCLIENT in parent) return null;

			return self.top.navigator.keyboard ?? null;
		} catch {
			// the real top is cross-origin
			return null;
		}
	};

	// natively the lock goes away with the document, so release it when the site leaves
	let locked: Keyboard | null = null;
	const unlock = () => {
		locked?.unlock();
		locked = null;
	};

	client.Proxy("Keyboard.prototype.lock", {
		apply(ctx) {
			const keyboard = topKeyboard();
			if (!keyboard) return;
			locked = keyboard;
			ctx.this = keyboard;
			// the promise belongs to the top document's realm, re-wrap it as one of this realm
			ctx.return(Promise_resolve(ctx.call()));
		},
	});

	client.Proxy("Keyboard.prototype.unlock", {
		apply(ctx) {
			if (!topKeyboard()) return;
			unlock();
			ctx.return(undefined);
		},
	});

	client.natives.call(
		"EventTarget.prototype.addEventListener",
		self,
		"pagehide",
		unlock
	);
}
