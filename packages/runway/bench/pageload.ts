// Page-load benchmark: real sites loaded directly in Chromium and through scramjet, cold (a fresh
// browser context for every load, so no HTTP, code or rewrite cache in the browser), in rotating
// order, reporting the median load time of each and the ratio. It serves scramjet itself: the
// built packages (pnpm build), a host page running the controller in worker mode with the relay
// transport (devrelay.ts, with its prefetch, HTTP cache and rewrite cache), and the relay.
//
//   pnpm --filter runway bench [--sites wikipedia,crazygames] [--reps 3] [--out results.jsonl]
//
// load: the site document's navigation timing loadEventEnd, read inside the document in both
// cases. A load whose document came back with an error status (a site's rate-limit page, say) is
// reported but left out of the medians, since an error page is no measure of the site. Sites
// with a game (crazygames) also report "game": the time from starting the navigation until the
// game has drawn a screen, which is what a player waits for.
//
// The relay's caches persist across loads, like a proxy server's would, so the first rep of a
// site is the cold-cache one; with --reps 3 the medians are of warm-relay, cold-browser loads.
// The host and the relay run in a child process, as a server of their own: in this one, they
// would wait on Playwright's protocol traffic. CHROMIUM_PATH picks the browser binary,
// CHROMIUM_ARGS adds launch arguments.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Site = {
	url: string;
	// the game's canvas, in the page or frame that shows the site
	game?: (root: Page | Frame | ReturnType<Page["frameLocator"]>) => Locator;
};

const crazygamesCanvas: Site["game"] = (root) =>
	root.frameLocator("#game-iframe").frameLocator("#game-iframe").locator("canvas").first();

export const SITES: Record<string, Site> = {
	example: { url: "https://example.com/" },
	wikipedia: { url: "https://en.wikipedia.org/wiki/Web_browser" },
	hn: { url: "https://news.ycombinator.com/" },
	mdn: { url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript" },
	google: { url: "https://www.google.com/" },
	youtube: { url: "https://www.youtube.com/" },
	ddg: { url: "https://duckduckgo.com/" },
	pydocs: { url: "https://docs.python.org/3/" },
	cloudflare: { url: "https://www.cloudflare.com/" },
	apple: { url: "https://www.apple.com/" },
	microsoft: { url: "https://www.microsoft.com/en-us" },
	bing: { url: "https://www.bing.com/" },
	twitch: { url: "https://www.twitch.tv/" },
	discord: { url: "https://discord.com/" },
	react: { url: "https://react.dev/" },
	vue: { url: "https://vuejs.org/" },
	cnnlite: { url: "https://lite.cnn.com/" },
	typescript: { url: "https://www.typescriptlang.org/" },
	github: { url: "https://github.com/" },
	npr: { url: "https://www.npr.org/" },
	nasa: { url: "https://www.nasa.gov/" },
	stripe: { url: "https://stripe.com/" },
	poki: { url: "https://poki.com/" },
	aljazeera: { url: "https://www.aljazeera.com/" },
	crazygames: { url: "https://www.crazygames.com/game/moto-x3m", game: crazygamesCanvas },
};

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
	const i = args.indexOf("--" + name);
	return i === -1 ? def : args[i + 1];
};
const siteNames = opt("sites", Object.keys(SITES).join(",")).split(",");
const reps = Number(opt("reps", "3"));
const out = opt("out", "");
const port = Number(opt("port", "4950"));
const TIMEOUT = 60_000;
// an empty or one-color canvas compresses to a few KB; a game's drawn screen is far bigger
const DRAWN_PNG_BYTES = 50_000;

for (const name of siteNames)
	if (!SITES[name]) throw new Error(`unknown site ${name} (sites: ${Object.keys(SITES).join(", ")})`);
for (const dir of ["core", "controller", "utils"])
	if (!fs.existsSync(path.join(ROOT, "packages", dir, "dist")))
		throw new Error(`packages/${dir}/dist is missing: run pnpm build first`);

// ---- the scramjet host ----

const HOST = `<!doctype html>
<html><head><title>scramjet bench</title>
<script src="/scramjet/scramjet.js"></script>
<script src="/controller/controller.api.js"></script>
</head><body style="margin:0">
<div id="status">loading</div>
<iframe id="f" style="width:1280px;height:760px;border:0"></iframe>
<script>
(async () => {
	await navigator.serviceWorker.register("/sw.js");
	await navigator.serviceWorker.ready;
	if (!navigator.serviceWorker.controller)
		await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
	const controller = new $scramjetController.Controller({
		serviceworker: navigator.serviceWorker.controller,
		worker: {
			scripts: ["/utils/scramjet-utils.js"],
			transport: \`() => new $scramjetUtils.RelayTransport({ url: "ws://\${location.host}/relay", prefetch: true, cache: true, rewriteCache: true })\`,
		},
	});
	await controller.wait();
	const frame = controller.createFrame(document.getElementById("f"));
	window.bench = { go: (url) => frame.go(url) };
	document.getElementById("status").textContent = "ready";
})().catch((e) => (document.getElementById("status").textContent = "error: " + e));
</script></body></html>`;

const SW = `importScripts("/controller/controller.sw.js");
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
addEventListener("fetch", (e) => {
	if ($scramjetController.shouldRoute(e)) e.respondWith($scramjetController.route(e));
});`;

const DIST: Record<string, string> = {
	"/scramjet/": path.join(ROOT, "packages/core/dist/"),
	"/controller/": path.join(ROOT, "packages/controller/dist/"),
	"/utils/": path.join(ROOT, "packages/utils/dist/"),
};
const TYPES: Record<string, string> = {
	".js": "text/javascript",
	".wasm": "application/wasm",
	".map": "application/json",
};

async function startHost(): Promise<http.Server> {
	const { createRelay } = await import(path.join(ROOT, "devrelay.ts"));
	const relay = createRelay();
	const server = http.createServer((req, res) => {
		const url = new URL(req.url || "/", "http://host");
		if (url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html" });
			return res.end(HOST);
		}
		if (url.pathname === "/sw.js") {
			res.writeHead(200, { "content-type": "text/javascript" });
			return res.end(SW);
		}
		for (const [prefix, dir] of Object.entries(DIST)) {
			if (!url.pathname.startsWith(prefix)) continue;
			const file = path.join(dir, url.pathname.slice(prefix.length));
			if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) break;
			res.writeHead(200, {
				"content-type": TYPES[path.extname(file)] || "application/octet-stream",
				"last-modified": fs.statSync(file).mtime.toUTCString(),
			});
			return res.end(fs.readFileSync(file));
		}
		res.writeHead(404);
		res.end();
	});
	server.on("upgrade", (req, socket, head) => {
		if (!relay(req, socket, head)) socket.destroy();
	});
	return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// ---- measuring ----

type Result = {
	site: string;
	kind: "direct" | "scramjet";
	rep: number;
	load?: number;
	// the document's HTTP status
	status?: number;
	game?: number;
	error?: string;
};

const navTiming = () => {
	const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
	return n && n.loadEventEnd > 0 ? { load: n.loadEventEnd, status: n.responseStatus } : null;
};

async function waitFor<T>(fn: () => Promise<T | null>, what: string): Promise<T> {
	const deadline = Date.now() + TIMEOUT;
	while (Date.now() < deadline) {
		const v = await fn().catch(() => null);
		if (v !== null && v !== undefined) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function gameDrawn(canvas: Locator) {
	return waitFor(async () => {
		const shot = await canvas.screenshot({ timeout: 2000 });
		return shot.length > DRAWN_PNG_BYTES ? true : null;
	}, "the game to draw");
}

async function measure(browser: Browser, site: string, kind: Result["kind"], rep: number): Promise<Result> {
	const { url, game } = SITES[site];
	const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	try {
		const page = await ctx.newPage();
		if (kind === "direct") {
			const t0 = Date.now();
			await page.goto(url, { waitUntil: "commit", timeout: TIMEOUT });
			const result: Result = { site, kind, rep, ...(await waitFor(() => page.evaluate(navTiming), "the load event")) };
			if (game) {
				await gameDrawn(game(page));
				result.game = Date.now() - t0;
			}
			return result;
		}
		await page.goto(`http://127.0.0.1:${port}/`);
		await page.waitForFunction(() => document.getElementById("status")?.textContent === "ready", null, { timeout: TIMEOUT });
		const t0 = Date.now();
		await page.evaluate((u) => (window as any).bench.go(u), url);
		const frame = await waitFor(async () => page.frames().find((f) => f.parentFrame() === page.mainFrame() && f.url() !== "about:blank") ?? null, "the site's frame");
		const result: Result = { site, kind, rep, ...(await waitFor(() => frame.evaluate(navTiming), "the load event")) };
		if (game) {
			await gameDrawn(game(page.frameLocator("#f")));
			result.game = Date.now() - t0;
		}
		return result;
	} catch (e: any) {
		return { site, kind, rep, error: String(e?.message || e).split("\n")[0].slice(0, 120) };
	} finally {
		await ctx.close();
	}
}

// an error page in place of the site (0 is a response the browser didn't get a status for)
const failed = (r: Result) => (r.status ?? 0) >= 400;

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

// --serve: the child, which serves until its parent goes away
if (args.includes("--serve")) {
	await startHost();
	console.log("serving");
	process.stdin.resume();
	process.stdin.on("end", () => process.exit(0));
} else {
	await runBenchmark();
}

async function runBenchmark() {
	const server = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--serve", "--port", String(port)], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	await new Promise<void>((resolve, reject) => {
		server.stdout!.on("data", (d: Buffer) => d.toString().includes("serving") && resolve());
		server.on("exit", (code) => reject(new Error(`the host exited (${code})`)));
	});
	const browser = await chromium.launch({
		headless: true,
		executablePath: process.env.CHROMIUM_PATH || undefined,
		args: (process.env.CHROMIUM_ARGS || "").split(" ").filter(Boolean),
	});
	const results: Result[] = [];
	for (let rep = 0; rep < reps; rep++) {
		for (const site of siteNames) {
			// alternate which goes first, so drift over the run spreads over both
			const kinds: Result["kind"][] = rep % 2 ? ["scramjet", "direct"] : ["direct", "scramjet"];
			for (const kind of kinds) {
				const r = await measure(browser, site, kind, rep);
				results.push(r);
				if (out) fs.appendFileSync(out, JSON.stringify(r) + "\n");
				console.log(`${site.padEnd(11)} ${kind.padEnd(8)} rep${rep} ${r.error ? "ERROR " + r.error : `load=${Math.round(r.load!)}${r.game ? ` game=${r.game}` : ""}${failed(r) ? ` status=${r.status} (left out)` : ""}`}`);
			}
		}
	}
	await browser.close();
	server.stdin!.end();
	server.kill();

	const med = (site: string, kind: string, key: "load" | "game") =>
		median(results.filter((r) => r.site === site && r.kind === kind && r[key] !== undefined && !failed(r)).map((r) => r[key]!));
	console.log(`\nmedian ms over ${reps} cold loads (ratio = scramjet / direct)`);
	console.log("site          direct  scramjet  ratio");
	const ratios: number[] = [];
	for (const site of siteNames) {
		for (const key of ["load", "game"] as const) {
			if (key === "game" && !SITES[site].game) continue;
			const d = med(site, "direct", key), s = med(site, "scramjet", key), ratio = s / d;
			if (key === "load" && Number.isFinite(ratio)) ratios.push(ratio);
			console.log(`${(key === "game" ? site + " game" : site).padEnd(13)} ${String(Math.round(d)).padStart(6)}  ${String(Math.round(s)).padStart(8)}  ${ratio.toFixed(2)}${ratio > 1.1 ? "*" : ""}`);
		}
	}
	const geo = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length);
	console.log(`load: geomean ratio ${geo.toFixed(3)}; sites over 1.10: ${ratios.filter((r) => r > 1.1).length}/${ratios.length}`);
	process.exit(0);
}
