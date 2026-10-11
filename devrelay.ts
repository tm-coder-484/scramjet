// A fast transport for the dev server: the "relay". The browser hands each request to this
// server over one websocket, which makes it with Node's HTTP stack and streams the response back.
// Compared with wisp + libcurl/epoxy (TLS in wasm, inside the page), requests here get native TLS,
// HTTP/2 to the site, a DNS cache, and no per-request work on the page's thread.
//
// The trade-off: this server sees the plaintext of every request, where wisp only forwards
// encrypted bytes. That's fine for your own machine or Codespace, not for a public deployment.
//
// Protocol, on ws://<host>/relay (one socket per RelayTransport):
//   client -> server  text   {t:"req", id, url, method, headers, body:bool, prefetch?:bool}
//                     binary [u32 id][request body]   (follows a req with body:true)
//                     text   {t:"abort", id}
//   server -> client  text   {t:"head", id, status, statusText, headers} | {t:"err", id, error}
//                     binary [u32 id][chunk]...
//                     text   {t:"end", id}
// Websockets get their own socket: ws://<host>/relay/ws?url=&protocols=&headers=
import http from "node:http";
import dns from "node:dns";
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

// one per websocket, i.e. per transport instance: its own connection pool, and the prefetches
// started for documents it loaded
class RelaySession {
	agent: Dispatcher = new Agent({
		allowH2: true,
		connect: { lookup: cachedLookup as any },
	});
	prefetched = new Map<string, PrefetchEntry>();

	close() {
		this.agent.close().catch(() => {});
		this.prefetched.clear();
	}

	prefetch(url: string, headers: Record<string, string>) {
		if (this.prefetched.has(url) || this.prefetched.size > 400) return;
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
			return { status: r.status, statusText: r.statusText, headers: raw, body };
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
		const ac = new AbortController();
		live.set(msg.id, ac);
		try {
			const headers: RawHeaders = msg.headers;
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

			const dest = header(headers, "sec-fetch-dest").toLowerCase();
			const scanner =
				msg.prefetch &&
				(dest === "document" || dest === "iframe") &&
				/text\/html/.test(r.headers.get("content-type") || "")
					? session.htmlScanner(msg.url, headers, r.headers.getSetCookie())
					: null;
			const decoder = scanner ? new TextDecoder() : null;
			if (r.body) {
				for await (const chunk of r.body) {
					sendChunk(msg.id, chunk);
					if (scanner) scanner.write(decoder!.decode(chunk, { stream: true }));
				}
			}
			scanner?.end();
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
			if (msg) run(msg, data.subarray(4));
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
	const target = url.searchParams.get("url")!;
	const protocols: string[] = JSON.parse(url.searchParams.get("protocols") || "[]");
	const headers: Record<string, string> = Object.fromEntries(
		JSON.parse(url.searchParams.get("headers") || "[]")
	);
	for (const k of Object.keys(headers))
		if (REQUEST_DROP.has(k.toLowerCase())) delete headers[k];

	const upstream = new WebSocket(target, protocols, { headers });
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
