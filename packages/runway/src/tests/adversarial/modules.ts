import { serverTest } from "../../testcommon.ts";

// ES module loading: specifier resolution, import.meta.url, import maps, and
// dynamic <script> injection. import.meta.url in particular is how modern code
// finds its own sibling assets - `new URL("./worker.js", import.meta.url)` is
// the pattern every bundler emits for workers, wasm binaries and locale files.

const FILES: Record<string, string> = {
	"/p.js": `window.__preloaded = true;`,
	"/mod.js": `export const v = "modvalue"; export const metaUrl = import.meta.url;`,
	"/modchain.js": `import { v } from "/mod.js"; export const chained = "chain:" + v;`,
	"/modrel.js": `import { v } from "./mod.js"; export const rel = "rel:" + v;`,
	"/modsibling.js": `export const sibling = new URL("./mod.js", import.meta.url).href;`,
	"/classic.js": `
		window.__classicRan = (window.__classicRan || 0) + 1;
		window.__currentScriptSrc = document.currentScript && document.currentScript.src;
	`,
};

const modTest = (name: string, js: string) =>
	serverTest({
		name,
		autoPass: true,
		js,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/" || path === "/script.js") return;
				if (FILES[path]) {
					res.writeHead(200, { "Content-Type": "application/javascript" });
					res.end(FILES[path]);
					return;
				}
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("nf");
			});
		},
	});

// rewrite cache (packages/core/src/shared/rewriters/jscache.ts): the first load of each script
// is stored and every later load in the test is served from the cache. scripts under 64KB bypass
// the cache, so each one is padded past that. frames inside one proxied page share its prefix;
// a hit under a different prefix (another controller) is covered by the cache's own
// prefix-splicing check, not here. /nocache/ paths turn the cache off for the site (siteFlags in
// the harness), so the same checks cover the uncached path too
const CACHE_PAD = `\n/*${"x".repeat(70 * 1024)}*/\n`;
const cacheFiles = (dir: string): Record<string, [string, string]> => ({
	[dir + "/frame.html"]: [
		"text/html",
		`<!doctype html><script type="module" src="${dir}/main.mjs"></script>`,
	],
	[dir + "/main.mjs"]: [
		"application/javascript",
		`import { value as depValue, url as depUrl } from "./dep.mjs";
		const dyn = (await import("./dep.mjs")).value;
		export const value = depValue;
		window.__cacheModule = { value: depValue, depUrl, dyn, url: import.meta.url };` +
			CACHE_PAD,
	],
	[dir + "/dep.mjs"]: [
		"application/javascript",
		`export const value = 41 + 1; export const url = import.meta.url;` +
			CACHE_PAD,
	],
	[dir + "/classic.html"]: [
		"text/html",
		`<!doctype html><script src="${dir}/classic.js"></script>`,
	],
	[dir + "/classic.js"]: [
		"application/javascript",
		`(window.__cacheRuns = window.__cacheRuns || []).push({
			src: document.currentScript.src,
			ev: eval("typeof location"),
			fn: (function () { return typeof this; })(),
			arr: [1, 2, 3].map((n) => n * 2).join(","),
			nested: { a: { b: 1 } }.a.b,
			href: location.href,
		});` + CACHE_PAD,
	],
});

const cacheTest = (name: string, dir: string) => {
	const files = cacheFiles(dir);
	return serverTest({
		name,
		autoPass: true,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/" || path === "/script.js") return;
				const file = files[path];
				if (file) {
					res.writeHead(200, { "Content-Type": file[0] });
					res.end(file[1]);
					return;
				}
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("nf");
			});
		},
		js: `
			const dir = ${JSON.stringify(dir)};
			const frame = (src) =>
				new Promise((resolve, reject) => {
					const f = document.createElement("iframe");
					f.src = src;
					f.onload = () => resolve(f);
					f.onerror = () => reject(new Error("iframe failed: " + src));
					document.body.appendChild(f);
				});
			const settle = async (f, key) => {
				for (let i = 0; i < 100 && !f.contentWindow[key]; i++)
					await new Promise((r) => setTimeout(r, 20));
				return f.contentWindow[key];
			};
			const classicFields = (r) => ({ src: r.src, ev: r.ev, fn: r.fn, arr: r.arr, nested: r.nested });

			// static and dynamic imports, then the frame that loaded them is removed and the same module
			// is loaded again by a new frame, this time from the cache
			const a = await frame(dir + "/frame.html?run=a");
			const ma = await settle(a, "__cacheModule");
			assertEqual(ma && ma.value, 42, "static import in the first frame");
			a.remove();

			const b = await frame(dir + "/frame.html?run=b");
			const mb = await settle(b, "__cacheModule");
			assertEqual(mb && mb.value, 42, "static import in a second frame, after the first was removed");
			assertEqual(mb.dyn, 42, "dynamic import from the module in the second frame");
			assertEqual(mb.depUrl, new URL(dir + "/dep.mjs", location.href).href, "import.meta.url of the imported module");
			assertEqual(mb.url, new URL(dir + "/main.mjs", location.href).href, "import.meta.url of the module in the second frame");
			assertEqual(ma.url, mb.url, "import.meta.url is the same in both frames");

			// the same classic script twice in one frame, then in another frame: all runs must agree
			const runTop = () =>
				new Promise((resolve, reject) => {
					const s = document.createElement("script");
					s.src = dir + "/classic.js";
					s.onload = () => { s.remove(); resolve(); };
					s.onerror = () => reject(new Error("classic script failed"));
					document.head.appendChild(s);
				});
			await runTop();
			await runTop();
			const top = window.__cacheRuns;
			assertEqual(top.length, 2, "the classic script ran twice");
			assertEqual(JSON.stringify(classicFields(top[1])), JSON.stringify(classicFields(top[0])), "second run of a classic script matches the first");
			assertEqual(top[1].href, location.href, "location.href in the classic script");

			const c = await frame(dir + "/classic.html");
			const runsInFrame = await settle(c, "__cacheRuns");
			assertEqual(runsInFrame && runsInFrame.length, 1, "the classic script ran in a frame");
			assertEqual(JSON.stringify(classicFields(runsInFrame[0])), JSON.stringify(classicFields(top[0])), "a classic script from another frame matches");
			assertEqual(runsInFrame[0].href, new URL(dir + "/classic.html", location.href).href, "location.href inside the frame");
		`,
	});
};

export default [
	modTest(
		"modules-dynamic-import",
		`
			const m = await import("/mod.js");
			assertEqual(m.v, "modvalue", "named export");
			assertEqual(await import("/mod.js"), m, "module identity is cached across imports");
			assertEqual(typeof m.metaUrl, "string", "import.meta.url is a string");
		`
	),
	modTest(
		"modules-specifier-resolution",
		`
			assertEqual((await import("/modchain.js")).chained, "chain:modvalue",
				"a module importing another module by absolute path");
			assertEqual((await import("/modrel.js")).rel, "rel:modvalue",
				"a relative specifier resolves against the importing module");
		`
	),
	modTest(
		"modules-inline-module-script",
		`
			window.__inlineResult = null;
			const s = document.createElement("script");
			s.type = "module";
			s.textContent = 'import { v } from "/mod.js"; window.__inlineResult = v;';
			document.head.appendChild(s);
			for (let i = 0; i < 60 && window.__inlineResult === null; i++) {
				await new Promise((r) => setTimeout(r, 50));
			}
			assertEqual(window.__inlineResult, "modvalue", "an inline module script with a static import");
		`
	),
	modTest(
		"modules-script-injection",
		`
			const s = document.createElement("script");
			s.src = "/classic.js";
			await new Promise((res, rej) => {
				s.onload = res;
				s.onerror = () => rej(new Error("onerror fired for a script that exists"));
				document.head.appendChild(s);
			});
			assertEqual(window.__classicRan, 1, "the injected script ran once");
			assertEqual(window.__currentScriptSrc, location.origin + "/classic.js",
				"document.currentScript.src inside it: " + window.__currentScriptSrc);
			assertEqual(s.src, location.origin + "/classic.js", "script.src property");
			assertEqual(s.getAttribute("src"), "/classic.js", "script src attribute");
		`
	),
	modTest(
		"modules-script-order",
		`
			window.__order = [];
			const mk = (n) => {
				const s = document.createElement("script");
				s.async = false;
				s.src = "/classic.js";
				s.onload = () => window.__order.push(n);
				return s;
			};
			document.head.appendChild(mk("a"));
			document.head.appendChild(mk("b"));
			await new Promise((r) => setTimeout(r, 800));
			assertDeepEqual(window.__order, ["a", "b"], "async=false injected scripts keep document order");
			assertEqual(window.__classicRan, 2, "both ran");
		`
	),

	// ------------------------------------------------------------------
	modTest(
		// KNOWN FAILURE: inside a fetched module, import.meta.url is the whole
		// proxy URL (including the $module and $io query parameters) rather than
		// the module's own URL. Anything that resolves a sibling asset from it -
		// workers, wasm, locale JSON - builds its URL from the proxy path, and any
		// code that parses or logs it sees proxy internals. An *inline* module
		// script gets this right; only fetched modules are affected.
		"modules-import-meta-url",
		`
			const m = await import("/mod.js");
			assert(!m.metaUrl.includes("/~/sj/"), "import.meta.url must not expose the proxy URL: " + m.metaUrl);
			assertEqual(m.metaUrl, location.origin + "/mod.js", "import.meta.url");
			const s = await import("/modsibling.js");
			assertEqual(s.sibling, location.origin + "/mod.js", "a sibling URL built from import.meta.url");
		`
	),
	modTest(
		// KNOWN FAILURE: <script type="importmap"> is not rewritten, so a bare
		// specifier resolves against the proxy origin root
		// (http://localhost:4500/mod.js) and the import fails outright. Import maps
		// are how buildless setups and an increasing number of shipped apps
		// resolve their dependencies.
		"modules-importmap",
		`
			const im = document.createElement("script");
			im.type = "importmap";
			im.textContent = JSON.stringify({ imports: { "bare-spec": "/mod.js" } });
			document.head.appendChild(im);
			let err, m;
			try { m = await import("bare-spec"); } catch (e) { err = e; }
			assert(!err, "a bare specifier from an import map must resolve: " + (err && err.message));
			assertEqual(m && m.v, "modvalue", "import map resolution");
		`
	),
	modTest(
		"modules-preload-link",
		`
			const l = document.createElement("link");
			l.rel = "preload";
			l.as = "script";
			l.href = "/p.js";
			const loaded = await new Promise((res) => {
				l.onload = () => res(true);
				l.onerror = () => res(false);
				document.head.appendChild(l);
				setTimeout(() => res(null), 3000);
			});
			assertEqual(loaded, true, "the preload link loaded");
			assertEqual(l.href, location.origin + "/p.js", "preload href property");
			assertEqual(l.getAttribute("href"), "/p.js", "preload href attribute");
			const s = document.createElement("script");
			s.src = "/p.js";
			await new Promise((res, rej) => { s.onload = res; s.onerror = rej; document.head.appendChild(s); });
			assertEqual(window.__preloaded, true, "the preloaded script then ran");
		`
	),
	modTest(
		"modules-modulepreload-link",
		`
			const l = document.createElement("link");
			l.rel = "modulepreload";
			l.href = "/p.js";
			const loaded = await new Promise((res) => {
				l.onload = () => res(true);
				l.onerror = () => res(false);
				document.head.appendChild(l);
				setTimeout(() => res(null), 3000);
			});
			assert(loaded !== false, "modulepreload did not error: " + loaded);
			assertEqual(l.href, location.origin + "/p.js", "modulepreload href");
		`
	),
	cacheTest("rewrite-cache-module-and-classic", "/cache"),
	// /nocache/ is excluded from the rewrite cache by the harness siteFlags
	cacheTest("rewrite-cache-off-module-and-classic", "/nocache"),
	// a module from another origin that imports a module statically and then dynamically gets one
	// instance of it, as in a browser. scramjet tags module urls with the origin they are fetched
	// for; the static import was tagged with the importing module's origin and the dynamic one
	// with the document's, so the browser saw two urls and made two instances (CrazyGames'
	// gameframe: "[GameConfig] is not set"). localhost and 127.0.0.1 are two origins on one server
	serverTest({
		name: "modules-cross-origin-static-and-dynamic-import-share-instance",
		autoPass: true,
		js: `
			window.__xo = null;
			const s = document.createElement("script");
			s.type = "module";
			s.src = "http://127.0.0.1:" + location.port + "/xo/entry.mjs";
			await new Promise((res, rej) => { s.onload = res; s.onerror = () => rej(new Error("entry module failed to load")); document.head.appendChild(s); });
			for (let i = 0; i < 50 && !window.__xo; i++) await new Promise((r) => setTimeout(r, 50));
			assert(window.__xo, "the entry module ran");
			assertEqual(window.__xo.same, true, "import() returned the instance the static import made");
			assertEqual(window.__xo.value, 42, "state set through the static import is seen through import()");
		`,
		start: async (server) => {
			const files: Record<string, string> = {
				"/xo/entry.mjs": `
					import { setValue } from "./state.mjs";
					setValue(42);
					const again = await import("./state.mjs");
					window.__xo = { value: again.getValue(), same: again.setValue === setValue };
				`,
				"/xo/state.mjs": `
					let value = 0;
					export const setValue = (v) => { value = v; };
					export const getValue = () => value;
				`,
			};
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (!files[path]) return;
				res.writeHead(200, {
					"Content-Type": "application/javascript",
					"Access-Control-Allow-Origin": "*",
				});
				res.end(files[path]);
			});
		},
	}),
];
