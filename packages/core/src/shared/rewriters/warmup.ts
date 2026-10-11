import type { ScramjetContext } from "@/shared";
import type { URLMeta } from "@rewriters/url";
import { rewriteHtmlStream } from "@rewriters/htmlStream";
import { rewriteJs } from "@rewriters/js";
import { rewriteCss } from "@rewriters/css";
import { Performance_now, TextEncoder_encode } from "@/shared/snapshot";

// A page's first document is rewritten by cold code: the HTML tokenizer and the attribute, URL,
// CSS and JS rewriters still run in V8's interpreter, and the rewriter's wasm functions are only
// compiled when first called. Wikipedia's 400KB article took ~130ms that way, against ~30ms once
// warm, and the thread doing it is the one answering the page's other requests. warmUpRewriter
// runs that code on a made-up document first, when a controller starts.

const script = `
(function () {
	var items = document.querySelectorAll(".item a[href]");
	var config = { endpoint: "/api/v1/items?limit=20&offset=" + items.length, retries: 3 };
	function load(page) {
		return fetch(config.endpoint + "&page=" + page, { credentials: "include" })
			.then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
			.then(function (data) {
				for (var i = 0; i < data.length; i++) {
					var el = document.createElement("a");
					el.href = data[i].url;
					el.textContent = data[i]["title"] || location.hostname;
					document.body.appendChild(el);
				}
				window.parent.postMessage({ loaded: data.length }, "*");
			});
	}
	const { origin, pathname } = location;
	let state = window["__state"] || {};
	state[pathname] = origin + pathname;
	if (top !== self) state.framed = true;
	setTimeout(() => load(1), 0);
	class Widget extends HTMLElement { connectedCallback() { this.innerHTML = "<b>" + this.dataset.label + "</b>"; } }
	customElements.get("x-widget") || customElements.define("x-widget", Widget);
})();
`;

const style = `
@import url("/css/base.css");
@font-face { font-family: Brand; src: url(/fonts/brand.woff2) format("woff2"), url('/fonts/brand.woff') format("woff"); }
body { margin: 0; background: #fff url("/img/bg.png") repeat-x; font: 16px/1.5 Brand, sans-serif; }
.hero { background-image: image-set(url(/img/hero.avif) type("image/avif"), url(/img/hero.jpg) 1x); }
.icon::before { content: ""; mask: url(data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>) no-repeat; }
@media (max-width: 600px) { .hero { background: url(/img/hero-small.jpg) center / cover; } }
`;

function warmupDocument(): string {
	let body = "";
	for (let i = 0; i < 40; i++) {
		body += `<div class="item" data-id="${i}" style="background:url(/img/${i}.png)"><a href="/wiki/Article_${i}?ref=list&amp;n=${i}#top" title="Article ${i}">Article &amp; ${i} &mdash; text</a>
<img src="https://cdn.example.test/thumb/${i}.jpg" srcset="/thumb/${i}.jpg 1x, /thumb/${i}@2x.jpg 2x" alt="" loading="lazy" width="120" height="80">
<span onclick="toggle(${i}); return false">more</span></div>\n`;
	}
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>warmup</title>
<meta http-equiv="refresh" content="3600; url=/next">
<base href="https://warmup.example.test/dir/">
<link rel="stylesheet" href="/static/site.css"><link rel="preload" as="script" href="/static/app.js">
<link rel="icon" href="/favicon.ico"><link rel="modulepreload" href="./mod.js">
<script>${script}</script>
<script type="module">import { x } from "./mod.js"; export const y = x;</script>
<script type="importmap">{"imports":{"lib":"/js/lib.js"}}</script>
<script src="/static/app.js" async></script>
<style>${style}</style>
</head><body class="page">
<header><nav><a href="/">Home</a> <a href="https://other.example.test/x">Other</a></nav></header>
<main>${body}</main>
<form action="/search" method="get"><input name="q" formaction="/s"><button>Go</button></form>
<iframe src="/embed/1" srcdoc="<p>a &amp; b</p>"></iframe>
<picture><source srcset="/a.webp" type="image/webp"><img src="/a.jpg"></picture>
<video poster="/v.jpg"><source src="/v.mp4"></video>
<svg viewBox="0 0 10 10"><use href="#i"></use><image href="/i.png"/><a href="/svg-link"><text>t</text></a></svg>
<script>document.write("<p>" + location.href + "</p>");</script>
</body></html>`;
}

async function drain(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	for (;;) {
		// eslint-disable-next-line no-await-in-loop
		const { done } = await reader.read();
		if (done) return;
	}
}

/**
 * Runs the document rewriters on a made-up page, `rounds` times, so the code they run is compiled
 * before the first real document. Returns the time it took, in ms.
 */
export async function warmUpRewriter(
	context: ScramjetContext,
	rounds = 3
): Promise<number> {
	const started = Performance_now();
	const meta: URLMeta = {
		origin: new URL("https://warmup.example.test/dir/page.html"),
		base: new URL("https://warmup.example.test/dir/page.html"),
	};
	const bytes = TextEncoder_encode(warmupDocument());
	for (let round = 0; round < rounds; round++) {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// in pieces, the way a response body arrives
				for (let i = 0; i < bytes.length; i += 16384)
					controller.enqueue(bytes.subarray(i, i + 16384));
				controller.close();
			},
		});
		try {
			// eslint-disable-next-line no-await-in-loop
			await drain(
				rewriteHtmlStream(body, "text/html; charset=utf-8", context, meta, {
					loadScripts: true,
					inline: false,
					source: meta.origin.href,
					headers: [],
					history: [],
				})
			);
			rewriteJs(script, meta.origin.href + "#warmup.js", context, meta);
			rewriteCss(style, context, meta);
		} catch {
			// a warmup that fails costs nothing but the time
		}
	}
	return Performance_now() - started;
}
