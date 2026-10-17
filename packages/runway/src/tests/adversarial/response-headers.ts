import { serverTest } from "../../testcommon.ts";

// Response headers the proxy has to actively handle rather than pass through:
// multiple Set-Cookie headers (folding them into one is a classic proxy bug),
// conditional revalidation, and the framing headers that would otherwise stop a
// proxied page from rendering inside a frame at all.
//
// Nothing here diverges - this is regression cover for behaviour whole sites
// depend on.

export default [
	serverTest({
		name: "respheaders-multiple-set-cookie",
		autoPass: true,
		js: `
			await fetch("/multicookie");
			await new Promise((r) => setTimeout(r, 400));
			const jar = document.cookie;
			assert(jar.includes("c1=v1"), "the first Set-Cookie was stored: " + jar);
			assert(jar.includes("c2=v2"), "the second Set-Cookie was stored: " + jar);
			assert(jar.includes("c3=v3"), "the third Set-Cookie was stored: " + jar);
		`,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/" || path === "/script.js") return;
				if (path === "/multicookie") {
					res.writeHead(200, {
						"Content-Type": "text/plain",
						"Set-Cookie": ["c1=v1; Path=/", "c2=v2; Path=/", "c3=v3; Path=/"],
					});
					res.end("ok");
					return;
				}
				res.writeHead(404);
				res.end();
			});
		},
	}),
	serverTest({
		name: "respheaders-etag-revalidation",
		autoPass: true,
		js: `
			const first = await fetch("/etag");
			assertEqual(first.status, 200, "first response");
			assertEqual(await first.text(), "etagbody", "first body");
			assertEqual(first.headers.get("etag"), '"abc"', "the ETag is exposed to the page");
			const second = await fetch("/etag");
			assertEqual(second.status, 200, "a revalidated response is presented as 200");
			assertEqual(await second.text(), "etagbody", "the cached body is served");
		`,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/" || path === "/script.js") return;
				if (path === "/etag") {
					if (req.headers["if-none-match"] === '"abc"') {
						res.writeHead(304, { ETag: '"abc"' });
						res.end();
						return;
					}
					res.writeHead(200, {
						"Content-Type": "text/plain",
						ETag: '"abc"',
						"Cache-Control": "no-cache",
					});
					res.end("etagbody");
					return;
				}
				res.writeHead(404);
				res.end();
			});
		},
	}),
	serverTest({
		name: "respheaders-response-type",
		autoPass: true,
		js: `
			const r = await fetch("/echo");
			assertEqual(r.type, "basic", "a same-origin response is basic");
			const nc = await fetch("/echo", { mode: "no-cors" });
			assertEqual(nc.type, "basic", "no-cors to the same origin is still basic");
			assertEqual(nc.status, 200, "and remains readable");
		`,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/" || path === "/script.js") return;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("{}");
			});
		},
	}),
	serverTest({
		// A site that refuses to be framed still has to render inside the proxy's
		// frame, so these headers must be neutralised; if that regresses, every
		// site setting them goes blank. Applied to a subframe because serverTest
		// owns the "/" response. scramjetOnly: unproxied, the frame is genuinely
		// blocked, which is the point.
		name: "respheaders-framing-headers-neutralised",
		autoPass: true,
		scramjetOnly: true,
		js: `
			const f = document.createElement("iframe");
			f.src = "/framed.html";
			document.body.appendChild(f);
			await new Promise((r) => { f.onload = r; setTimeout(r, 4000); });
			const doc = f.contentDocument;
			assert(doc, "the frame document is reachable");
			const h1 = doc.querySelector("h1");
			assert(h1, "the frame rendered despite X-Frame-Options: DENY and frame-ancestors 'none'");
			assertEqual(h1.textContent, "framed", "frame content");
		`,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path !== "/framed.html") return;
				res.writeHead(200, {
					"Content-Type": "text/html",
					"X-Frame-Options": "DENY",
					"Content-Security-Policy": "frame-ancestors 'none'",
				});
				res.end("<!DOCTYPE html><html><body><h1>framed</h1></body></html>");
			});
		},
	}),
	serverTest({
		// A strict CSP must not stop the proxy's rewritten code from running, and
		// the site's own subresources must still load under it.
		name: "respheaders-strict-csp",
		autoPass: true,
		scramjetOnly: true,
		js: `
			const f = document.createElement("iframe");
			f.src = "/csp.html";
			document.body.appendChild(f);
			await new Promise((r) => { f.onload = r; setTimeout(r, 4000); });
			await new Promise((r) => setTimeout(r, 500));
			const doc = f.contentDocument;
			assert(doc, "the frame document is reachable");
			assertEqual(doc.querySelector("h1").textContent, "csp", "the frame rendered under a strict CSP");
			assertEqual(f.contentWindow.__cspScriptRan, true,
				"an external script still ran under default-src 'self'");
		`,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/csp.html") {
					res.writeHead(200, {
						"Content-Type": "text/html",
						"Content-Security-Policy": "default-src 'self'; script-src 'self'",
					});
					res.end(
						'<!DOCTYPE html><html><body><h1>csp</h1><script src="/cspscript.js"></' +
							"script></body></html>"
					);
					return;
				}
				if (path === "/cspscript.js") {
					res.writeHead(200, { "Content-Type": "application/javascript" });
					res.end("window.__cspScriptRan = true;");
				}
			});
		},
	}),
	serverTest({
		// A stylesheet preloaded by the document's Link header with an integrity hash (Discord's
		// front page does this through its CDN). The proxy rewrites the stylesheet's urls, so the
		// hash no longer matches: the integrity in the header has to go, or the browser blocks the
		// preload and the stylesheet with it, and the page renders unstyled.
		name: "respheaders-link-preload-integrity",
		autoPass: true,
		js: `
			const f = document.createElement("iframe");
			f.src = "/sri/page.html";
			document.body.appendChild(f);
			await new Promise((r) => { f.onload = r; setTimeout(r, 4000); });
			const doc = f.contentDocument;
			assert(doc, "the frame document is reachable");
			const box = doc.getElementById("box");
			assert(box, "the frame rendered");
			assertEqual(f.contentWindow.getComputedStyle(box).width, "123px", "the preloaded stylesheet applied");
		`,
		start: async (server) => {
			const css = "#box { width: 123px; height: 10px; background: url(/sri/bg.png) no-repeat; }";
			const { createHash } = await import("node:crypto");
			const hash = "sha256-" + createHash("sha256").update(css).digest("base64");
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/sri/page.html") {
					res.writeHead(200, {
						"Content-Type": "text/html",
						Link: `</sri/style.css>; rel=preload; as=style; integrity="${hash}"`,
					});
					res.end(`<!DOCTYPE html><html><head><link rel="stylesheet" href="/sri/style.css" integrity="${hash}"></head><body><div id="box"></div></body></html>`);
				} else if (path === "/sri/style.css") {
					res.writeHead(200, { "Content-Type": "text/css" });
					res.end(css);
				} else if (path === "/sri/bg.png") {
					res.writeHead(404);
					res.end();
				}
			});
		},
	}),
];
