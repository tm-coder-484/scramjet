import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from "@mercuryworkshop/proxy-transports";

export type RelayTransportOptions = {
	/** the relay endpoint, e.g. ws://localhost:4142/relay (see devrelay.ts) */
	url: string;
	/**
	 * let the relay prefetch a document's stylesheets, scripts and first images while its HTML
	 * streams through, so they're ready when the page asks for them. Costs some extra bandwidth
	 * when a prefetched resource ends up unused.
	 */
	prefetch?: boolean;
	/**
	 * let the relay answer from its shared HTTP cache (a forward-proxy cache that follows the
	 * RFC 9111 rules for shared caches), so a site's static files come from the relay instead of
	 * the network on later visits, from any browser
	 */
	cache?: boolean;
	/**
	 * use the relay's shared rewrite cache: in controller worker mode, the rewriter threads look
	 * scripts up there before rewriting them, and send the ones they had to rewrite, which the
	 * relay rewrites itself and keeps. A browser with an empty cache then skips the rewrites of
	 * scripts anyone loaded through the relay before (YouTube's 10MB bundle: ~600ms).
	 */
	rewriteCache?: boolean;
};

// the high bit of a binary frame's id: the frame holds a whole response, head and body (see
// devrelay.ts)
const WHOLE = 0x80000000;
const headDecoder = new TextDecoder();
// scramjet's REWRITE_HEADER and REWRITTEN: a script request's rewrite-cache header, which the relay
// may answer with the script rewritten under it, and the details of that rewrite on the response
const REWRITE_HEADER = Symbol.for("scramjet rewrite header");
const REWRITTEN = Symbol.for("scramjet rewritten");

// the response's headers, marked with the relay's rewrite if it sent one (a field of its own
// message, never a header, so a site can't fake it)
function markRewrite(headers: any, rewritten: unknown) {
	if (rewritten && typeof rewritten === "object" && headers && typeof headers === "object")
		headers[REWRITTEN] = rewritten;
	return headers;
}

type Pending = {
	resolve: (r: TransferrableResponse) => void;
	reject: (e: unknown) => void;
	controller: ReadableStreamDefaultController<Uint8Array> | null;
};

/**
 * A transport for a relay server (devrelay.ts), which makes requests itself with native TLS and
 * HTTP/2 and multiplexes them over one websocket. Much faster than TLS in wasm over wisp, but the
 * relay sees plaintext, so only use it with a server you run yourself. Works in a worker, so it
 * can be used with the controller's worker mode.
 */
export class RelayTransport implements ProxyTransport {
	ready = true;
	private ws: WebSocket | null = null;
	private queue: (string | Uint8Array)[] = [];
	private nextId = 1;
	private streams = new Map<number, Pending>();

	/** the relay's shared rewrite cache, read by the controller's rewriter threads */
	rewriteCacheUrl?: string;

	constructor(private options: RelayTransportOptions) {
		if (options.rewriteCache) this.rewriteCacheUrl = options.url;
	}

	async init() {
		this.ready = true;
	}

	private open(): WebSocket {
		if (this.ws && this.ws.readyState <= WebSocket.OPEN) return this.ws;

		const ws = new WebSocket(this.options.url);
		ws.binaryType = "arraybuffer";
		ws.onopen = () => {
			for (const m of this.queue) ws.send(m);
			this.queue = [];
		};
		ws.onmessage = (e) => {
			if (typeof e.data !== "string") {
				const view = new DataView(e.data);
				const word = view.getUint32(0, true);
				if (word & WHOLE) return this.whole(word & ~WHOLE, view);
				this.streams.get(word)?.controller?.enqueue(new Uint8Array(e.data, 4));
				return;
			}
			const msg = JSON.parse(e.data);
			const s = this.streams.get(msg.id);
			if (!s) return;
			if (msg.t === "head") {
				const body = new ReadableStream<Uint8Array>({
					start: (c) => {
						s.controller = c;
					},
					cancel: () => {
						this.streams.delete(msg.id);
						this.send(JSON.stringify({ t: "abort", id: msg.id }));
					},
				});
				s.resolve({
					body,
					headers: markRewrite(msg.headers, msg.rewritten),
					status: msg.status,
					statusText: msg.statusText,
				});
			} else if (msg.t === "end") {
				this.streams.delete(msg.id);
				s.controller?.close();
			} else if (msg.t === "err") {
				this.streams.delete(msg.id);
				const err = new Error("relay: " + msg.error);
				if (s.controller) s.controller.error(err);
				else s.reject(err);
			}
		};
		ws.onclose = () => {
			const err = new Error("relay connection closed");
			for (const s of this.streams.values()) {
				if (s.controller) s.controller.error(err);
				else s.reject(err);
			}
			this.streams.clear();
			this.queue = [];
		};
		this.ws = ws;

		return ws;
	}

	// a response the relay had whole (from its cache or a prefetch), in one frame
	private whole(id: number, view: DataView) {
		const s = this.streams.get(id);
		if (!s) return;
		this.streams.delete(id);
		const headLength = view.getUint32(4, true);
		const head = JSON.parse(
			headDecoder.decode(new Uint8Array(view.buffer, 8, headLength))
		);
		const bytes = new Uint8Array(view.buffer, 8 + headLength);
		s.resolve({
			body: new ReadableStream<Uint8Array>({
				start: (c) => {
					if (bytes.byteLength) c.enqueue(bytes);
					c.close();
				},
			}),
			headers: markRewrite(head.headers, head.rewritten),
			status: head.status,
			statusText: head.statusText,
		});
	}

	private send(m: string | Uint8Array) {
		const ws = this.open();
		if (ws.readyState === WebSocket.OPEN) ws.send(m);
		else this.queue.push(m);
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		let bytes: Uint8Array | null = null;
		if (body != null) bytes = new Uint8Array(await new Response(body).arrayBuffer());

		const id = this.nextId++;
		const response = new Promise<TransferrableResponse>((resolve, reject) =>
			this.streams.set(id, { resolve, reject, controller: null })
		);
		this.send(
			JSON.stringify({
				t: "req",
				id,
				url: remote.href,
				method,
				headers,
				body: bytes !== null,
				prefetch: !!this.options.prefetch,
				cache: !!this.options.cache,
				whole: true,
				// with the shared rewrite cache, the relay may send a script rewritten
				rewrite:
					this.options.rewriteCache && typeof (headers as any)[REWRITE_HEADER] === "string"
						? (headers as any)[REWRITE_HEADER]
						: undefined,
			})
		);
		if (bytes) {
			const frame = new Uint8Array(4 + bytes.byteLength);
			new DataView(frame.buffer).setUint32(0, id, true);
			frame.set(bytes, 4);
			this.send(frame);
		}
		signal?.addEventListener("abort", () => {
			const s = this.streams.get(id);
			if (!s) return;
			this.streams.delete(id);
			this.send(JSON.stringify({ t: "abort", id }));
			const err = new DOMException("The request was aborted", "AbortError");
			if (s.controller) s.controller.error(err);
			else s.reject(err);
		});

		return response;
	}

	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [(data: WebSocketDataType) => void, (code: number, reason: string) => void] {
		const endpoint = new URL(this.options.url);
		endpoint.pathname = endpoint.pathname.replace(/\/?$/, "/ws");
		endpoint.searchParams.set("url", url.href);
		endpoint.searchParams.set("protocols", JSON.stringify(protocols));
		endpoint.searchParams.set("headers", JSON.stringify(requestHeaders));

		const ws = new WebSocket(endpoint);
		ws.binaryType = "arraybuffer";
		let opened = false;
		ws.onmessage = (e) => {
			if (opened) return onmessage(e.data);
			const meta = JSON.parse(e.data);
			if (meta.error) return onerror(meta.error);
			opened = true;
			onopen(meta.protocol || "", meta.extensions || "");
		};
		ws.onclose = (e) => onclose(e.code, e.reason);
		ws.onerror = () => onerror("relay websocket error");

		return [
			(data) => ws.send(data as any),
			(code, reason) => ws.close(code ?? 1000, reason),
		];
	}
}
