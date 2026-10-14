// A fast transport for the dev server: the "relay". The browser hands each request to this
// server over one websocket, which makes it with Node's HTTP stack and streams the response back.
// Compared with wisp + libcurl/epoxy (TLS in wasm, inside the page), requests here get native TLS,
// HTTP/2 to the site, a DNS cache, and no per-request work on the page's thread.
//
// The trade-off: this server sees the plaintext of every request, where wisp only forwards
// encrypted bytes. That's fine for your own machine or Codespace, not for a public deployment.
//
// Protocol, on ws://<host>/relay (one socket per RelayTransport):
//   client -> server  text   {t:"req", id, url, method, headers, body:bool, prefetch?:bool, cache?:bool}
//                     binary [u32 id][request body]   (follows a req with body:true)
//                     text   {t:"abort", id}
//   server -> client  text   {t:"head", id, status, statusText, headers} | {t:"err", id, error}
//                     binary [u32 id][chunk]...
//                     text   {t:"end", id}
//   the shared rewrite cache (RelayTransport's rewriteCache, used by the controller's rewriter threads):
//   client -> server  text   {t:"rwget", id, key}
//                     text   {t:"rwput", id, key, header, body:true} + binary [u32 id][script]
//   server -> client  text   {t:"rwhit", id, tag, offsets, jsLength} + binary [u32 id][js][map] | {t:"rwmiss", id}
// Websockets get their own socket: ws://<host>/relay/ws?url=&protocols=&headers=
import http from "node:http";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { WebSocketServer, WebSocket } from "ws";
import { Parser } from "htmlparser2";

type RawHeaders = [string, string][];

// response headers the browser must not see: the relay already decoded the body
const DROP = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
]);
const REQUEST_DROP = new Set(["host", "connection", "content-length"]);
// RELAY_LOG=1 prints each upstream request's timing
const LOG = !!process.env.RELAY_LOG;

// DNS answers are kept for a minute, like Chromium's host cache
const dnsCache = new Map<string, { expires: number; result: any[] }>();
function cachedLookup(hostname: string, options: any, cb: any) {
	if (typeof options === "function") {
		cb = options;
		options = {};
	}
	const key = `${hostname}|${options.family || 0}|${!!options.all}`;
	const hit = dnsCache.get(key);
	if (hit && hit.expires > Date.now()) {
		process.nextTick(() => cb(null, ...hit.result));
		return;
	}
	dns.lookup(hostname, options, (err: any, address: any, family: any) => {
		if (!err)
			dnsCache.set(key, {
				expires: Date.now() + 60_000,
				result: options.all ? [address] : [address, family],
			});
		cb(err, address, family);
	});
}

// ---- shared HTTP cache (opt-in per request: the transport's `cache` option) ----
// a forward-proxy cache like a CDN's or Squid's, following RFC 9111's rules for shared caches:
// only GETs without Authorization, only responses a shared cache may store (not private or
// no-store; with explicit freshness or a Last-Modified heuristic), only while fresh, keyed on
// the headers named by Vary. Set-Cookie is never replayed from it.
type CachedResponse = {
	status: number;
	statusText: string;
	headers: RawHeaders;
	body: Buffer;
	stored: number;
	lifetime: number;
	vary: Record<string, string>;
};
const CACHE_LIMIT = Number(process.env.RELAY_CACHE_MB || 512) * 1024 * 1024;
const CACHEABLE_STATUS = new Set([200, 203, 204, 300, 301, 308, 404, 410]);
const httpCache = new Map<string, CachedResponse[]>();
let httpCacheBytes = 0;

function directives(value: string) {
	const out: Record<string, string> = {};
	for (const part of value.toLowerCase().split(",")) {
		const [k, v = ""] = part.trim().split("=");
		if (k) out[k] = v.replace(/^"|"$/g, "");
	}
	return out;
}

// the freshness lifetime in ms a shared cache may give a response, or 0 if it can't store it
function freshnessLifetime(status: number, headers: RawHeaders, now: number) {
	if (!CACHEABLE_STATUS.has(status)) return 0;
	const cc = directives(header(headers, "cache-control"));
	if ("no-store" in cc || "private" in cc || "no-cache" in cc) return 0;
	if (/\*/.test(header(headers, "vary"))) return 0;
	const age = Number(header(headers, "age")) || 0;
	let lifetime: number | undefined;
	if (cc["s-maxage"] !== undefined) lifetime = Number(cc["s-maxage"]) * 1000;
	else if (cc["max-age"] !== undefined) lifetime = Number(cc["max-age"]) * 1000;
	else if (header(headers, "expires")) {
		const date = Date.parse(header(headers, "date")) || now;
		lifetime = Date.parse(header(headers, "expires")) - date;
	} else if (header(headers, "last-modified")) {
		// the usual heuristic: a tenth of the time since the last change, capped at a day
		const since = now - Date.parse(header(headers, "last-modified"));
		lifetime = Math.min(since / 10, 86_400_000);
	}
	if (!lifetime || !Number.isFinite(lifetime)) return 0;
	return lifetime - age * 1000;
}

function varyValues(responseHeaders: RawHeaders, requestHeaders: RawHeaders) {
	const vary: Record<string, string> = {};
	for (const name of header(responseHeaders, "vary").toLowerCase().split(",")) {
		const n = name.trim();
		if (n) vary[n] = header(requestHeaders, n);
	}
	return vary;
}

function cacheLookup(url: string, method: string, headers: RawHeaders) {
	if (method !== "GET" || header(headers, "authorization") || header(headers, "range")) return null;
	const cc = directives(header(headers, "cache-control"));
	if ("no-cache" in cc || "no-store" in cc || /no-cache/i.test(header(headers, "pragma"))) return null;
	const now = Date.now();
	const entries = httpCache.get(url);
	for (const entry of entries ?? []) {
		if (now - entry.stored > entry.lifetime) continue;
		if (Object.entries(entry.vary).every(([k, v]) => header(headers, k) === v)) {
			// most recently used last, for eviction
			httpCache.delete(url);
			httpCache.set(url, entries!);
			return entry;
		}
	}
	return null;
}

function cacheStore(url: string, method: string, requestHeaders: RawHeaders, r: { status: number; statusText: string; headers: RawHeaders; body: Buffer }) {
	if (method !== "GET" || header(requestHeaders, "authorization") || header(requestHeaders, "range")) return;
	const now = Date.now();
	const lifetime = freshnessLifetime(r.status, r.headers, now);
	if (lifetime <= 0 || r.body.byteLength > CACHE_LIMIT / 16) return;
	const entry: CachedResponse = {
		status: r.status,
		statusText: r.statusText,
		headers: r.headers.filter(([k]) => k.toLowerCase() !== "set-cookie"),
		body: r.body,
		stored: now,
		lifetime,
		vary: varyValues(r.headers, requestHeaders),
	};
	const list = (httpCache.get(url) ?? []).filter(
		(e) => JSON.stringify(e.vary) !== JSON.stringify(entry.vary)
	);
	list.push(entry);
	httpCache.delete(url);
	httpCache.set(url, list);
	httpCacheBytes += r.body.byteLength;
	for (const [key, entries] of httpCache) {
		if (httpCacheBytes <= CACHE_LIMIT) break;
		for (const e of entries) httpCacheBytes -= e.body.byteLength;
		httpCache.delete(key);
	}
}

// the response a cached entry gives, with its Age
function fromCache(entry: CachedResponse): PrefetchedResponse {
	const age = Math.floor((Date.now() - entry.stored) / 1000);
	return {
		status: entry.status,
		statusText: entry.statusText,
		headers: [...entry.headers.filter(([k]) => k.toLowerCase() !== "age"), ["age", String(age)]],
		body: entry.body,
	};
}

type PrefetchedResponse = {
	status: number;
	statusText: string;
	headers: RawHeaders;
	body: Buffer;
};
type PrefetchEntry = {
	origin: string;
	cookie: string;
	promise: Promise<PrefetchedResponse>;
};

const PREFETCH_TTL = 30_000;
const PREFETCH_PER_DOCUMENT = 80;
const PREFETCH_IMAGES = 12;

function header(headers: RawHeaders, name: string) {
	return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
}

// whether a response may be given to a request whose cookies differ from the prefetch's: one a
// shared HTTP cache could serve (RFC 9111). Set-Cookie doesn't prevent it, since it's this user's
// own session and the cookies get applied when the proxied request receives the response
function shareable(r: PrefetchedResponse) {
	const get = (name: string) =>
		r.headers
			.filter(([k]) => k.toLowerCase() === name)
			.map(([, v]) => v.toLowerCase())
			.join(",");
	if (/\b(private|no-store|no-cache)\b/.test(get("cache-control"))) return false;
	return !/\*|cookie/.test(get("vary"));
}

const newAgent = (keepAlive?: number): Dispatcher =>
	new Agent({
		allowH2: true,
		connect: { lookup: cachedLookup as any },
		// undici closes idle connections after 4s by default; Chromium keeps them for minutes
		...(keepAlive
			? { keepAliveTimeout: keepAlive, keepAliveMaxTimeout: keepAlive }
			: {}),
	});

// the connections to sites are kept open for every browser that uses the relay, the way a proxy
// server's are: a page then skips the TCP and TLS handshakes for any site it, or anyone, loaded
// recently. RELAY_POOL=session gives each transport its own pool instead (closed with it), which
// is what a browser without the relay would have
const SHARED_POOL = process.env.RELAY_POOL !== "session";
let sharedAgent: Dispatcher | null = null;

// one per websocket, i.e. per transport instance: the prefetches started for documents it loaded,
// and its connection pool if the pool isn't shared
class RelaySession {
	agent: Dispatcher = SHARED_POOL
		? (sharedAgent ??= newAgent(5 * 60_000))
		: newAgent();
	prefetched = new Map<string, PrefetchEntry>();
	/** whether this transport asked for the shared cache */
	useCache = false;

	close() {
		if (!SHARED_POOL) this.agent.close().catch(() => {});
		this.prefetched.clear();
	}

	prefetch(url: string, headers: Record<string, string>) {
		if (this.prefetched.has(url) || this.prefetched.size > 400) return;
		const rawRequest: RawHeaders = Object.entries(headers);
		// a fresh cached copy needs no prefetch: the proxied request will hit the cache
		if (this.useCache && cacheLookup(url, "GET", rawRequest)) return;
		const promise = undiciFetch(url, {
			headers,
			redirect: "manual",
			dispatcher: this.agent,
		}).then(async (r) => {
			const raw: RawHeaders = [];
			for (const [k, v] of r.headers) if (!DROP.has(k)) raw.push([k, v]);
			const body = Buffer.from(await r.arrayBuffer());
			if (/text\/css/.test(r.headers.get("content-type") || ""))
				this.prefetchFromCss(url, body.toString("utf8"), headers);
			const res = { status: r.status, statusText: r.statusText, headers: raw, body };
			if (this.useCache) cacheStore(url, "GET", rawRequest, res);
			return res;
		});
		const entry: PrefetchEntry = {
			origin: headers.origin || "",
			cookie: headers.cookie || "",
			promise,
		};
		promise.catch(() => this.prefetched.delete(url));
		this.prefetched.set(url, entry);
		setTimeout(() => {
			if (this.prefetched.get(url) === entry) this.prefetched.delete(url);
		}, PREFETCH_TTL).unref();
	}

	// the prefetched response for a proxied request, if it was prefetched with the same Origin
	// and isn't a range or credentialed request. it is handed out once
	takePrefetch(url: string, method: string, headers: RawHeaders) {
		if (method !== "GET") return null;
		const entry = this.prefetched.get(url);
		if (!entry) return null;
		if (
			header(headers, "range") ||
			header(headers, "authorization") ||
			header(headers, "origin") !== entry.origin
		)
			return null;
		this.prefetched.delete(url);
		return { entry, sameCookies: header(headers, "cookie") === entry.cookie };
	}

	// a parser that, fed a document's HTML as it streams through, prefetches what the browser
	// will request eagerly: stylesheets, scripts, preloads and the first few non-lazy images
	htmlScanner(docUrl: string, docHeaders: RawHeaders, setCookies: string[]) {
		const doc = new URL(docUrl);
		let base = doc;
		let count = 0;
		let images = 0;

		// the document request's cookies plus what its response set, for same-host requests
		const jar = new Map<string, string>();
		const addPair = (pair: string) => {
			const i = pair.indexOf("=");
			if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
		};
		for (const part of header(docHeaders, "cookie").split(/;\s*/)) addPair(part);
		for (const sc of setCookies) addPair(sc.split(";")[0]);
		const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

		const add = (raw: string | undefined, dest: string) => {
			if (!raw || count >= PREFETCH_PER_DOCUMENT) return;
			let u: URL;
			try {
				u = new URL(raw.trim(), base);
			} catch {
				return;
			}
			if (u.protocol !== "https:" && u.protocol !== "http:") return;
			u.hash = "";
			count++;
			const headers: Record<string, string> = {
				referer: docUrl,
				// the proxied requests carry Origin even in no-cors mode, and must match it
				origin: doc.origin,
				"sec-fetch-dest": dest,
				"sec-fetch-site": u.origin === doc.origin ? "same-origin" : "cross-site",
				accept:
					dest === "style"
						? "text/css,*/*;q=0.1"
						: dest === "image"
							? "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
							: "*/*",
			};
			for (const name of ["user-agent", "accept-language"]) {
				const v = header(docHeaders, name);
				if (v) headers[name] = v;
			}
			if (u.host === doc.host && cookie) headers.cookie = cookie;
			this.prefetch(u.href, headers);
		};

		return new Parser(
			{
				onopentag(name, a) {
					if (name === "base" && a.href) {
						try {
							base = new URL(a.href, docUrl);
						} catch {}
					} else if (name === "link" && a.href) {
						const rel = (a.rel || "").toLowerCase().split(/\s+/);
						if (rel.includes("stylesheet") && a.disabled === undefined)
							add(a.href, "style");
						else if (rel.includes("modulepreload")) add(a.href, "script");
						else if (
							rel.includes("preload") &&
							["style", "script", "font", "image"].includes(a.as) &&
							!a.imagesrcset
						)
							add(a.href, a.as);
					} else if (name === "script" && a.src) {
						const type = (a.type || "").toLowerCase();
						if (!type || type === "module" || /javascript|ecmascript/.test(type))
							add(a.src, "script");
					} else if (
						name === "img" &&
						a.src &&
						!a.srcset &&
						(a.loading || "").toLowerCase() !== "lazy" &&
						images < PREFETCH_IMAGES
					) {
						images++;
						add(a.src, "image");
					}
				},
			},
			{ decodeEntities: true }
		);
	}

	// fonts and @imports, which the browser needs as soon as a stylesheet applies
	prefetchFromCss(cssUrl: string, css: string, parent: Record<string, string>) {
		const re =
			/@import\s+(?:url\()?\s*["']?([^"')\s;]+)|url\(\s*["']?([^"')]+?\.(?:woff2?|ttf|otf)(?:\?[^"')]*)?)["']?\s*\)/gi;
		let m: RegExpExecArray | null;
		let n = 0;
		while ((m = re.exec(css)) && n++ < 20) {
			let u: URL;
			try {
				u = new URL(m[1] || m[2], cssUrl);
			} catch {
				continue;
			}
			const font = !m[1];
			const headers: Record<string, string> = {
				referer: cssUrl,
				origin: parent.origin,
				accept: font ? "*/*" : "text/css,*/*;q=0.1",
				"sec-fetch-dest": font ? "font" : "style",
			};
			for (const name of ["user-agent", "accept-language"])
				if (parent[name]) headers[name] = parent[name];
			this.prefetch(u.href, headers);
		}
	}
}

// ---- shared rewrite cache (opt-in per client: RelayTransport's rewriteCache) ----
// A controller's rewriter threads ask for a script's rewrite here before rewriting it themselves,
// and send the scripts they had to rewrite. The relay rewrites those itself, with scramjet's own
// build (packages/core/dist) in worker threads: an entry is never taken from a client, so no
// client can hand its rewrites to another. Entries are keyed the way the browser's rewrite cache
// keys them (rewriteKey: the build, the rewriter's config and the script's hash), and rewritten
// under a placeholder prefix whose offsets are kept, so any prefix of the same length fits.
const REWRITE_CACHE_LIMIT =
	Number(process.env.RELAY_REWRITE_CACHE_MB || 256) * 1024 * 1024;
const MAX_REWRITE_INPUT = 32 * 1024 * 1024;
const CORE_DIST = new URL("./packages/core/dist/", import.meta.url);

type RewriteEntry = {
	js: Uint8Array;
	map: Uint8Array | null;
	offsets: number[];
	tag: string;
};
const rewriteCache = new Map<string, { entry: RewriteEntry; size: number }>();
let rewriteCacheBytes = 0;

function rewriteCacheGet(key: string) {
	const hit = rewriteCache.get(key);
	if (!hit) return undefined;
	rewriteCache.delete(key);
	rewriteCache.set(key, hit);
	return hit.entry;
}

function rewriteCachePut(key: string, entry: RewriteEntry) {
	const size =
		entry.js.byteLength + (entry.map?.byteLength ?? 0) + entry.offsets.length * 8 + 128;
	if (size > REWRITE_CACHE_LIMIT / 4) return;
	const old = rewriteCache.get(key);
	if (old) {
		rewriteCache.delete(key);
		rewriteCacheBytes -= old.size;
	}
	rewriteCache.set(key, { entry, size });
	rewriteCacheBytes += size;
	for (const [k, v] of rewriteCache) {
		if (rewriteCacheBytes <= REWRITE_CACHE_LIMIT) break;
		rewriteCache.delete(k);
		rewriteCacheBytes -= v.size;
	}
}

// runs in each rewriter thread: scramjet's bundle, reloaded when the build changes
const REWRITE_WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const vm = require("node:vm");
const jsPath = workerData.dist + "scramjet.js";
const wasmPath = workerData.dist + "scramjet.wasm";
let stamp = "";
function load() {
	const now = fs.statSync(jsPath).mtimeMs + ":" + fs.statSync(wasmPath).mtimeMs;
	if (now === stamp) return false;
	globalThis.self = globalThis;
	vm.runInThisContext(fs.readFileSync(jsPath, "utf8"), { filename: jsPath });
	globalThis.$scramjet.setWasm(fs.readFileSync(wasmPath));
	stamp = now;
	return true;
}
// the controller's default codec (Config.codec), the only one run here; it encodes the import
// specifiers of modules. a script rewritten under another codec that needs it fails, and isn't kept
const DEFAULT_CODEC = [
	/^\(?([A-Za-z_$][\w$]*)\)?=>\1\?encodeURIComponent\(\1\):\1$/,
	/^\(?([A-Za-z_$][\w$]*)(?::string)?\)?=>\{if\(!\1\)return\1;?returnencodeURIComponent\(\1\);?\}$/,
];
const isDefaultCodec = (src) => DEFAULT_CODEC.some((re) => re.test(String(src).replace(/\s+/g, "")));
const encodeDefault = (u) => (u ? encodeURIComponent(u) : u);
const refuse = () => { throw new Error("not the default codec"); };
parentPort.on("message", async ({ id, header, js }) => {
	let reloaded = false;
	try {
		reloaded = load();
		const sj = globalThis.$scramjet;
		const h = JSON.parse(header);
		if (!Number.isInteger(h.prefixLength) || h.prefixLength < 2 || h.prefixLength > 1024)
			throw new Error("bad prefix length");
		// a placeholder no rewriter output contains but where the prefix goes
		const prefix = "/" + "a".repeat(h.prefixLength - 2) + "/";
		const context = {
			config: { globals: h.globals, flags: h.flags, siteFlags: {} },
			prefix: new URL(prefix, "http://relay.invalid"),
			interface: { codecEncode: isDefaultCodec(h.codec) ? encodeDefault : refuse, codecDecode: decodeURIComponent },
		};
		const meta = { origin: new URL(h.origin), base: new URL(h.base), initiatorOrigin: h.initiator };
		const input = new Uint8Array(js);
		const key = await sj.rewriteKey(header, input);
		const res = sj.rewriteJsInner(input, h.source, context, meta, !!h.isModule);
		if (res.errors.length) return parentPort.postMessage({ id, reloaded });
		const entry = sj.templateRewrite({ js: res.js, map: res.map, tag: res.tag }, input, new TextEncoder().encode(prefix));
		parentPort.postMessage({ id, reloaded, key, entry });
	} catch (e) {
		parentPort.postMessage({ id, reloaded, error: String((e && e.message) || e) });
	}
});
`;

type RewriteJob = { header: string; js: ArrayBuffer; hint: string };

class RewritePool {
	private idle: Worker[] = [];
	private queue: RewriteJob[] = [];
	// the hints (client keys) of jobs queued or running, so a script sent twice is rewritten once
	private hints = new Set<string>();
	private running = new Map<Worker, RewriteJob>();

	constructor(size: number) {
		for (let i = 0; i < size; i++) {
			const worker = new Worker(REWRITE_WORKER, {
				eval: true,
				workerData: { dist: CORE_DIST.pathname },
			});
			worker.unref();
			worker.on("message", (m) => this.done(worker, m));
			worker.on("error", (e) => {
				console.warn("[relay] rewrite worker failed:", e);
				const job = this.running.get(worker);
				if (job) this.hints.delete(job.hint);
				this.running.delete(worker);
			});
			this.idle.push(worker);
		}
	}

	submit(job: RewriteJob) {
		if (this.hints.has(job.hint) || this.queue.length >= 32) return;
		this.hints.add(job.hint);
		this.queue.push(job);
		this.pump();
	}

	private pump() {
		while (this.idle.length && this.queue.length) {
			const worker = this.idle.pop()!;
			const job = this.queue.shift()!;
			this.running.set(worker, job);
			worker.postMessage({ id: 0, header: job.header, js: job.js }, [job.js]);
		}
	}

	private done(worker: Worker, m: any) {
		const job = this.running.get(worker);
		this.running.delete(worker);
		if (job) this.hints.delete(job.hint);
		// a rebuilt scramjet makes different keys and output: what's kept was made by the old one
		if (m.reloaded) {
			rewriteCache.clear();
			rewriteCacheBytes = 0;
		}
		if (m.key && m.entry) {
			rewriteCachePut(m.key, m.entry);
			if (LOG)
				console.log(
					`[relay] rewrite cache stored ${m.key.slice(0, 12)} (${Math.round(m.entry.js.byteLength / 1024)}KB${m.key === job?.hint ? "" : ", client key differs"})`
				);
		} else if (LOG)
			console.log(`[relay] rewrite not kept: ${m.error ?? "parse errors or prefix in the script"}`);
		this.idle.push(worker);
		this.pump();
	}
}

let rewritePool: RewritePool | null | undefined;
function getRewritePool() {
	if (rewritePool === undefined) {
		if (
			fs.existsSync(new URL("scramjet.js", CORE_DIST)) &&
			fs.existsSync(new URL("scramjet.wasm", CORE_DIST))
		) {
			rewritePool = new RewritePool(
				Math.max(1, Math.min(2, os.availableParallelism() - 1))
			);
		} else {
			console.warn(
				"[relay] no scramjet build in packages/core/dist: the shared rewrite cache is off"
			);
			rewritePool = null;
		}
	}
	return rewritePool;
}

function rewritePut(msg: any, body: Buffer) {
	if (
		typeof msg.header !== "string" ||
		msg.header.length > 64 * 1024 ||
		typeof msg.key !== "string" ||
		body.byteLength > MAX_REWRITE_INPUT ||
		rewriteCache.has(msg.key)
	)
		return;
	// its own copy, transferred to the thread
	const js = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	getRewritePool()?.submit({ header: msg.header, js, hint: msg.key });
}

function handleMuxSocket(ws: WebSocket) {
	const session = new RelaySession();
	const live = new Map<number, AbortController>();
	const waitingForBody = new Map<number, any>();

	const sendChunk = (id: number, chunk: Uint8Array) => {
		const buf = Buffer.allocUnsafe(4 + chunk.byteLength);
		buf.writeUInt32LE(id, 0);
		buf.set(chunk, 4);
		ws.send(buf);
	};
	const sendJson = (msg: object) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
	};

	async function run(msg: any, body?: Buffer) {
		const started = performance.now();
		const ac = new AbortController();
		live.set(msg.id, ac);
		try {
			const headers: RawHeaders = msg.headers;
			if (msg.cache) {
				session.useCache = true;
				const hit = cacheLookup(msg.url, msg.method, headers);
				if (hit) {
					const r = fromCache(hit);
					sendJson({ t: "head", id: msg.id, status: r.status, statusText: r.statusText, headers: r.headers });
					if (r.body.byteLength) sendChunk(msg.id, r.body);
					sendJson({ t: "end", id: msg.id });
					return;
				}
			}
			const pre = msg.prefetch
				? session.takePrefetch(msg.url, msg.method, headers)
				: null;
			if (pre) {
				const r = await pre.entry.promise.catch(() => null);
				if (r && (pre.sameCookies || shareable(r))) {
					sendJson({ t: "head", id: msg.id, status: r.status, statusText: r.statusText, headers: r.headers });
					if (r.body.byteLength) sendChunk(msg.id, r.body);
					sendJson({ t: "end", id: msg.id });
					return;
				}
			}

			const h = new Headers();
			for (const [k, v] of headers) {
				if (REQUEST_DROP.has(k.toLowerCase())) continue;
				try {
					h.append(k, v);
				} catch {}
			}
			const r = await undiciFetch(msg.url, {
				method: msg.method,
				headers: h,
				body: body ?? undefined,
				redirect: "manual",
				signal: ac.signal,
				dispatcher: session.agent,
			});
			const raw: RawHeaders = [];
			for (const [k, v] of r.headers) if (!DROP.has(k)) raw.push([k, v]);
			sendJson({ t: "head", id: msg.id, status: r.status, statusText: r.statusText, headers: raw });
			const headAt = performance.now();

			const dest = header(headers, "sec-fetch-dest").toLowerCase();
			const scanner =
				msg.prefetch &&
				(dest === "document" || dest === "iframe") &&
				/text\/html/.test(r.headers.get("content-type") || "")
					? session.htmlScanner(msg.url, headers, r.headers.getSetCookie())
					: null;
			const decoder = scanner ? new TextDecoder() : null;
			// keep the body for the cache only if the response may be stored at all
			const keep =
				msg.cache &&
				freshnessLifetime(r.status, raw, Date.now()) > 0 &&
				msg.method === "GET";
			const chunks: Uint8Array[] = [];
			if (r.body) {
				for await (const chunk of r.body) {
					sendChunk(msg.id, chunk);
					if (keep) chunks.push(chunk);
					if (scanner) scanner.write(decoder!.decode(chunk, { stream: true }));
				}
			}
			scanner?.end();
			if (LOG)
				console.log(
					`[relay] ${r.status} ${Math.round(headAt - started)}ms head, ${Math.round(performance.now() - started)}ms end ${msg.url.slice(0, 100)}`
				);
			if (keep)
				cacheStore(msg.url, msg.method, headers, {
					status: r.status,
					statusText: r.statusText,
					headers: raw,
					body: Buffer.concat(chunks),
				});
			sendJson({ t: "end", id: msg.id });
		} catch (e: any) {
			sendJson({ t: "err", id: msg.id, error: String(e?.cause ?? e) });
		} finally {
			live.delete(msg.id);
		}
	}

	ws.on("message", (data: Buffer, isBinary) => {
		if (isBinary) {
			const id = data.readUInt32LE(0);
			const msg = waitingForBody.get(id);
			waitingForBody.delete(id);
			if (msg?.t === "rwput") rewritePut(msg, data.subarray(4));
			else if (msg) run(msg, data.subarray(4));
			return;
		}
		let msg: any;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (msg.t === "req") {
			if (msg.body) waitingForBody.set(msg.id, msg);
			else run(msg);
		} else if (msg.t === "rwget") {
			const entry = typeof msg.key === "string" ? rewriteCacheGet(msg.key) : undefined;
			if (LOG)
				console.log(
					`[relay] rewrite cache ${entry ? `hit (${Math.round(entry.js.byteLength / 1024)}KB)` : "miss"} ${String(msg.key).slice(0, 12)}`
				);
			if (!entry) return sendJson({ t: "rwmiss", id: msg.id });
			sendJson({
				t: "rwhit",
				id: msg.id,
				tag: entry.tag,
				offsets: entry.offsets,
				jsLength: entry.js.byteLength,
			});
			const frame = Buffer.allocUnsafe(4 + entry.js.byteLength + (entry.map?.byteLength ?? 0));
			frame.writeUInt32LE(msg.id, 0);
			frame.set(entry.js, 4);
			if (entry.map) frame.set(entry.map, 4 + entry.js.byteLength);
			ws.send(frame);
		} else if (msg.t === "rwput") {
			waitingForBody.set(msg.id, msg);
		} else if (msg.t === "abort") {
			live.get(msg.id)?.abort();
		}
	});
	ws.on("close", () => {
		for (const ac of live.values()) ac.abort();
		session.close();
	});
}

// a proxied websocket: the first message to the browser is {protocol, extensions} or {error}
function handleWebSocketRelay(client: WebSocket, url: URL) {
	let upstream: WebSocket;
	try {
		const target = url.searchParams.get("url")!;
		const protocols: string[] = JSON.parse(url.searchParams.get("protocols") || "[]");
		const headers: Record<string, string> = Object.fromEntries(
			JSON.parse(url.searchParams.get("headers") || "[]")
		);
		for (const k of Object.keys(headers))
			if (REQUEST_DROP.has(k.toLowerCase())) delete headers[k];
		// throws for a url ws rejects (one with a fragment, say), which must not take the server down
		upstream = new WebSocket(target, protocols, { headers });
	} catch (e) {
		client.send(JSON.stringify({ error: String(e) }));
		client.close();
		return;
	}
	const pending: (string | Buffer)[] = [];
	upstream.on("open", () => {
		client.send(JSON.stringify({ protocol: upstream.protocol, extensions: upstream.extensions }));
		for (const m of pending) upstream.send(m);
		pending.length = 0;
	});
	upstream.on("message", (data: Buffer, isBinary) => client.send(isBinary ? data : data.toString()));
	upstream.on("close", (code, reason) => client.close(code === 1005 ? 1000 : code, reason.toString()));
	upstream.on("error", (e) => {
		try {
			client.send(JSON.stringify({ error: String(e) }));
		} catch {}
		client.close();
	});
	client.on("message", (data: Buffer, isBinary) => {
		const m = isBinary ? data : data.toString();
		if (upstream.readyState === WebSocket.OPEN) upstream.send(m);
		else pending.push(m);
	});
	client.on("close", () => upstream.close());
}

/**
 * Serves the relay on `server` at /relay and /relay/ws. Upgrades for other paths are left to
 * whatever else listens on the server (call this first, and route the rest yourself).
 * Returns a function that handles an upgrade, or returns false when it isn't the relay's.
 */
export function createRelay() {
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
	return (req: http.IncomingMessage, socket: any, head: Buffer): boolean => {
		const url = new URL(req.url || "/", "http://relay");
		if (url.pathname === "/relay" || url.pathname === "/relay/") {
			wss.handleUpgrade(req, socket, head, (ws) => handleMuxSocket(ws));
			return true;
		}
		if (url.pathname === "/relay/ws") {
			wss.handleUpgrade(req, socket, head, (ws) => handleWebSocketRelay(ws, url));
			return true;
		}
		return false;
	};
}
