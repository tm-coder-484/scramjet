// The first site a controller loads runs everything cold: the HTML, CSS and JS rewriters still run
// in V8's interpreter (in the controller and in each rewriter thread), and so does the client that
// boots in every document. A 400 KB Wikipedia article loaded ~60% slower than the same article
// loaded after any other site. So before a controller says it's ready, it loads a made-up site in
// a hidden frame, through the whole pipeline (service worker, controller, rewriters, client), with
// every response made up here: the warm-up never touches the network.
import { Plugin } from "@mercuryworkshop/scramjet";
import type { Frame } from "./index";

/** The made-up site's origin. ".invalid" never resolves, so nothing real can live here. */
export const WARMUP_ORIGIN = "https://warmup.scramjet.invalid";

// the frame's load event (or this long) ends the warm-up
export const WARMUP_TIMEOUT = 4000;
// V8 compiles the code that got hot on background threads and only switches to it later, so the
// warm-up then waits this long: a page loaded right after the frame's load event got little of
// the speedup (Wikipedia 1.42x direct, against 1.16x after 300ms and 1.08x after 700ms)
export const WARMUP_SETTLE = 500;

const words =
	"lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(
		" "
	);
const text = (i: number, n: number) => {
	let s = "";
	for (let k = 0; k < n; k++) s += (k ? " " : "") + words[(i * 7 + k * 3) % words.length];
	return s;
};

// ~200 KB of the markup real pages are made of: every attribute the rewriter handles, entities,
// inline handlers and styles, scripts and styles of each kind, an iframe, svg and forms
function html(): string {
	let main = "";
	for (let i = 0; i < 260; i++) {
		main += `<article class="card c${i % 7}" id="a${i}" data-index="${i}" style="--w:${i % 9}px">
<h2><a href="/wiki/Article_${i}?ref=list&amp;n=${i}#s${i % 4}" title="${text(i, 3)}">${text(i, 4)} &amp; more</a></h2>
<p>${text(i, 18)} <a href="https://other.warmup.scramjet.invalid/p/${i}" rel="noopener">${text(i + 1, 2)}</a>, <b>${text(i + 2, 2)}</b> &mdash; <i>&lt;${i}&gt;</i> ${text(i + 3, 12)}.</p>
<img src="/img/${i % 4}.png" srcset="/img/${i % 4}.png 1x, /img/${i % 4}@2x.png 2x" loading="lazy" width="120" height="80" alt="${text(i, 2)}">
<ul><li><a href="./rel/${i}">${text(i, 2)}</a></li><li><span onclick="toggle(${i}); return false">${text(i + 5, 2)}</span></li></ul>
</article>
`;
	}
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>warm-up</title>
<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="preconnect" href="https://cdn.warmup.scramjet.invalid">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/print.css" media="print">
<link rel="icon" href="/img/icon.svg">
<link rel="preload" as="script" href="/app.js">
<script>window.__config = { lang: "en", page: location.pathname, items: ${JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: i, href: "/wiki/" + i })))} }; document.documentElement.className += " js";</script>
<script type="importmap">{"imports":{"dep":"/dep.js"}}</script>
<script src="/app.js" defer></script>
<script src="/vendor.js" defer></script>
<script type="module" src="/module.js"></script>
<style>.card{margin:0 0 8px;background:url(/img/0.png) no-repeat}.js .card h2{font-size:18px}</style>
</head><body class="page">
<header><nav>${Array.from({ length: 24 }, (_, i) => `<a href="/section/${i}">${text(i, 1)}</a>`).join(" ")}</nav>
<form action="/search" method="get"><input name="q" placeholder="search"><button formaction="/s">go</button></form></header>
<main>${main}</main>
<iframe src="/frame.html" width="300" height="150" title="embed"></iframe>
<picture><source srcset="/img/1.png" type="image/png"><img src="/img/1.png" alt=""></picture>
<svg viewBox="0 0 10 10" width="10" height="10"><use href="/img/icon.svg#i"></use><image href="/img/2.png" width="1" height="1"/><a href="/svg-link"><text>t</text></a></svg>
<table><tr><td><a href="/t/1">1</a></td><td style="background-image:url('/img/3.png')">2</td></tr></table>
<footer><a href="mailto:a@warmup.scramjet.invalid">mail</a> <a href="javascript:void 0">js</a></footer>
<script>function toggle(i) { var el = document.getElementById("a" + i); if (el) el.hidden = !el.hidden; }</script>
</body></html>`;
}

function css(): string {
	let s = `@import url("/base.css");\n@font-face{font-family:W;src:url(/font.woff2) format("woff2"),url('/font.woff') format("woff");font-display:optional}\n`;
	for (let i = 0; i < 400; i++)
		s += `.c${i} .x${i % 13}:hover>a[href^="/wiki/"]{background:#${(0x100000 + i * 997).toString(16).slice(-6)} url("/img/${i % 4}.png") no-repeat ${i % 50}px 0;mask:url(#m${i})}\n${i % 40 === 0 ? `@media (max-width:${600 + i}px){.c${i}{background-image:image-set(url(/img/${i % 4}.png) 1x,url(/img/${i % 4}@2x.png) 2x)}}\n` : ""}`;
	return s;
}

// classic scripts of 20-40 KB: big enough to go to the rewriter threads (16 KB and up), small
// enough to stay out of the rewrite caches (64 KB and up). each does a little DOM work when run
function script(name: string, n: number): string {
	let s = `(function () {\n"use strict";\nvar registry = Object.create(null);\n`;
	for (let i = 0; i < n; i++) {
		s += `function ${name}${i}(a, b) {
	const el = document.createElement(${i % 2 ? '"div"' : '"a"'});
	el.className = "c${i} " + (b || "");
	el.setAttribute("data-k", "${name}${i}");
	if (a && a.href) el.title = a.href + location.search;
	const o = { x: a, y: b, ["k${i}"]: ${i}, ...registry };
	let t = \`\${location.pathname}#${i}\`;
	for (const [k, v] of Object.entries(o)) if (v === ${i}) t += k;
	return [el, t, window.top === self, typeof globalThis.parent?.postMessage];
}
registry["${name}${i}"] = ${name}${i};
`;
	}
	s += `class ${name}Widget extends (window.HTMLElement || Object) {
	connectedCallback() { this.innerHTML = '<a href="/w/' + this.dataset.id + '">w</a><img src="/img/1.png">'; }
}
if (window.customElements && !customElements.get("x-${name}")) customElements.define("x-${name}", ${name}Widget);
var host = document.body || document.documentElement;
for (var i = 0; i < 20; i++) {
	var r = registry["${name}" + (i * 7 % ${n})](document.links[i % (document.links.length || 1)], "q" + i);
	r[0].href = "/dyn/${name}/" + i + "?q=" + encodeURIComponent(r[1]);
	host.appendChild(r[0]).remove();
}
var u = new URL("./x?y=1", location.href);
history.replaceState({ n: u.search }, "", location.href);
void document.title, void document.referrer, void location.origin, void navigator.userAgent;
fetch("/data.json").then(function (r) { return r.json(); }).catch(function () {});
})();
`;
	return s;
}

const module = `import { dep, n } from "./dep.js";
const { pathname } = location;
export const ready = dep(pathname) + n;
const lazy = () => import("./dep.js").then((m) => m.n);
lazy();
document.documentElement.dataset.ready = String(ready);
`;

// a 1x1 transparent png
const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
	),
	(c) => c.charCodeAt(0)
);

function respond(path: string): Response {
	const typed = (body: BodyInit, type: string) =>
		new Response(body, {
			status: 200,
			headers: { "content-type": type, "cache-control": "no-store" },
		});
	if (path === "/") return typed(html(), "text/html; charset=utf-8");
	if (path === "/frame.html")
		return typed(
			`<!doctype html><html><head><title>embed</title><link rel="stylesheet" href="/base.css"></head><body><p><a href="/x">${text(1, 8)}</a></p><script>document.body.dataset.n = String(history.length + document.links.length);</script></body></html>`,
			"text/html; charset=utf-8"
		);
	if (path === "/style.css") return typed(css(), "text/css");
	if (path === "/print.css" || path === "/base.css")
		return typed(`body{margin:0;font:14px/1.4 sans-serif}a{color:#06c}`, "text/css");
	if (path === "/app.js") return typed(script("app", 90), "text/javascript");
	if (path === "/vendor.js") return typed(script("vnd", 70), "text/javascript");
	if (path === "/module.js") return typed(module, "text/javascript");
	if (path === "/dep.js")
		return typed(
			`export const n = 1;\nexport function dep(p) { return p.length; }\n`,
			"text/javascript"
		);
	if (path === "/data.json")
		return typed(JSON.stringify({ items: [1, 2, 3] }), "application/json");
	if (path.endsWith(".png")) return typed(PNG, "image/png");
	if (path.endsWith(".svg"))
		return typed(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><symbol id="i"><rect width="1" height="1"/></symbol></svg>`,
			"image/svg+xml"
		);
	return new Response(null, { status: 404 });
}

/**
 * Answers every request of the warm-up frame with the made-up site, so none of them reaches the
 * transport. Installed on the frame that runs the fetch handler (in the worker, in worker mode).
 */
export function installWarmupResponder(frame: Frame) {
	const plugin = new Plugin("scramjet-warmup");
	plugin.tap(frame.hooks.fetch.request, (ctx, props) => {
		const url = ctx.parsed.url;
		props.earlyResponse = (
			url.origin === WARMUP_ORIGIN
				? respond(url.pathname)
				: new Response(null, { status: 404 })
		) as any;
	});
}
