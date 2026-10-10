import { basicTest } from "../testcommon.ts";

// keyboard.lock() only works in a top-level document, so scramjet forwards it from the
// site's top frame to the real top. the bare harness runs tests in an iframe, where it rejects.
export default [
	basicTest({
		name: "keyboard-lock-top-frame",
		scramjetOnly: true,
		js: `
			if (!navigator.keyboard) return;
			const locked = navigator.keyboard.lock(["KeyG", "Escape"]);
			assert(locked instanceof Promise, "lock returns a Promise from this realm");
			await locked;
			assertEqual(navigator.keyboard.unlock(), undefined, "unlock");

			const sub = document.createElement("iframe");
			document.body.append(sub);
			let error;
			try {
				await sub.contentWindow.navigator.keyboard.lock(["KeyG"]);
			} catch (e) {
				error = e.name;
			}
			assertEqual(error, "InvalidStateError", "a subframe still can't lock");
		`,
	}),
];
