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
	// a module statically importing blob: modules (a 3-level chain) must load them as modules,
	// and each module must see its own native blob url as import.meta.url
	basicTest({
		name: "module-workers-static-blob-imports",
		js: `
			const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
			const C = blobUrl("export const x = 3; export const url = import.meta.url;");
			const B = blobUrl('import { x as c, url as cu } from "' + C + '"; export const x = 2 + c; export const url = import.meta.url; export const cUrl = cu;');
			const A = blobUrl('import { x as b, url as bu, cUrl as cu2 } from "' + B + '"; export const x = 1 + b; export const url = import.meta.url; export const bUrl = bu; export const cUrl = cu2;');
			const D = "data:text/javascript," + encodeURIComponent("export const x = 7;");
			const run = (url, options) =>
				new Promise((resolve, reject) => {
					const w = new Worker(url, options);
					const timer = setTimeout(() => reject(new Error("worker timed out")), 5000);
					w.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
					w.onerror = (e) => { clearTimeout(timer); reject(new Error("worker error: " + (e.message || "(no message)"))); };
				});

			const self = blobUrl('import { x, url, bUrl, cUrl } from "' + A + '"; import { x as dx } from "' + D + '"; postMessage({ x, url, bUrl, cUrl, dx, self: import.meta.url });');
			const seen = await run(self, { type: "module" });
			assertEqual(seen.x, 6, "static blob import chain in a module worker");
			assertEqual(seen.dx, 7, "static data: import in a module worker");
			assertEqual(seen.url, A, "import.meta.url of a statically imported blob module");
			assertEqual(seen.bUrl, B, "import.meta.url of a blob module imported by a blob module");
			assertEqual(seen.cUrl, C, "import.meta.url of the innermost blob module");
			assertEqual(seen.self, self, "import.meta.url of the worker module itself");

			const m = await import(A);
			assertEqual(m.x, 6, "dynamic import() of a blob module chain");
			assertEqual(m.url, A, "import.meta.url of a dynamically imported blob module");
		`,
	}),
	// code inside `export` declarations is rewritten like any other code: before, the
	// rewriter skipped them, so an exported function saw the real (proxy) location
	basicTest({
		name: "modules-export-declarations-rewritten",
		js: `
			const src = "export function where() { return location.href; } export const here = location.href; export class K { static at() { return location.href; } }";
			const m = await import(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
			assertEqual(m.here, location.href, "export const initializer");
			assertEqual(m.where(), location.href, "exported function body");
			assertEqual(m.K.at(), location.href, "exported class body");
		`,
	}),
];
