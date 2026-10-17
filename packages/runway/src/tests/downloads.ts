import { basicTest } from "../testcommon.ts";

// <a download> requests skip the service worker, so scramjet hides the real
// attribute and marks the href instead. the page must not be able to tell.
export default [
	basicTest({
		name: "download-attribute-reflection",
		js: `
			const a = document.createElement("a");
			a.href = "/file.txt?q=1#frag";
			a.download = "t.txt";
			assertEqual(a.download, "t.txt", "download property");
			assertEqual(a.getAttribute("download"), "t.txt", "getAttribute");
			assert(a.hasAttribute("download"), "hasAttribute");
			assert(a.getAttributeNames().includes("download"), "getAttributeNames");
			assertEqual(a.search, "?q=1", "search has no download marker");
			assertEqual(a.hash, "#frag", "hash");
			assertEqual(new URL(a.href).pathname, "/file.txt", "href pathname");
			assertEqual(new URL(a.href).search, "?q=1", "href search");
			assert(a.outerHTML.includes('download="t.txt"'), "outerHTML: " + a.outerHTML);
			assert(a.cloneNode().hasAttribute("download"), "clone keeps download");

			assertEqual(a.toggleAttribute("download"), false, "toggle off");
			assert(!a.hasAttribute("download"), "toggled off");
			assertEqual(a.download, "", "property after toggle off");
			assertEqual(a.toggleAttribute("download"), true, "toggle on");
			assertEqual(a.getAttribute("download"), "", "toggled on value");
			assertEqual(a.toggleAttribute("download", true), true, "force on");

			a.removeAttribute("download");
			assert(!a.hasAttribute("download"), "removed");
			assertEqual(a.getAttribute("download"), null, "removed getAttribute");
			assertEqual(new URL(a.href).search, "?q=1", "href after remove");

			const b = document.createElement("a");
			b.download = "b.txt";
			b.href = URL.createObjectURL(new Blob(["x"]));
			assert(b.href.startsWith("blob:" + location.origin + "/"), "blob href: " + b.href);
			assert(!b.href.includes("?"), "blob href has no marker: " + b.href);

			const d = document.createElement("a");
			d.setAttribute("download", "d.txt");
			d.setAttribute("href", "data:text/plain,abc");
			assertEqual(d.href, "data:text/plain,abc", "data href");

			const div = document.createElement("div");
			div.innerHTML = '<a href="/x" download="x.txt">x</a>';
			const parsed = div.firstChild;
			assertEqual(parsed.download, "x.txt", "parsed download property");
			assertEqual(new URL(parsed.href).pathname, "/x", "parsed href");
			assertEqual(div.innerHTML, '<a href="/x" download="x.txt">x</a>', "innerHTML round trip");
		`,
	}),

	// chromium can crash the renderer running view transitions inside an iframe,
	// so scramjet skips them. the update callback must still run.
	basicTest({
		name: "view-transition-update-runs",
		js: `
			if (!document.startViewTransition) return;
			let ran = false;
			const transition = document.startViewTransition(() => {
				ran = true;
			});
			await transition.updateCallbackDone;
			assert(ran, "update callback ran");
			await transition.finished;
		`,
	}),
];
