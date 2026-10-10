import { basicTest } from "../testcommon.ts";

// module workers from blob: and data: urls must be loaded as modules, not as
// classic scripts (which would call importScripts and die immediately).
// the worker must also see its native url, not the proxy's download/module marker.
export default [
	basicTest({
		name: "module-workers-blob-and-data",
		js: `
			const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
			const run = (url, options) =>
				new Promise((resolve, reject) => {
					const w = options ? new Worker(url, options) : new Worker(url);
					const timer = setTimeout(() => reject(new Error("worker timed out")), 5000);
					w.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
					w.onerror = (e) => { clearTimeout(timer); reject(new Error("worker error: " + e.message)); };
				});
			const moduleOptions = { type: "module" };

			assertEqual(await run(blobUrl('postMessage("hi")'), moduleOptions), "hi", "module blob worker");

			const dataUrl = "data:text/javascript," + encodeURIComponent('postMessage("data-ok")');
			assertEqual(await run(dataUrl, moduleOptions), "data-ok", "module data worker");

			const self = blobUrl("postMessage({ loc: location.href, meta: import.meta.url });");
			const seen = await run(self, moduleOptions);
			assertEqual(seen.loc, self, "location.href inside a module worker");
			assertEqual(seen.meta, self, "import.meta.url inside a module worker");

			assertEqual(await run(blobUrl('postMessage("classic-ok")')), "classic-ok", "classic blob worker");
		`,
	}),
];
