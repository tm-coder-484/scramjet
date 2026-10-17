// The relay's shared rewrite cache (devrelay.ts), as the core's RemoteRewriteCache: a rewriter
// pool thread asks it for an entry before rewriting a script, and hands it the scripts it had to
// rewrite, which the relay rewrites itself and keeps for the next browser.
//   -> {t:"rwget", id, key, url?}               <- {t:"rwhit", id, tag, offsets, jsLength} + binary [u32 id][js][map]
//                                               <- {t:"rwmiss", id}
//   -> {t:"rwput", id, key, header, body:true} + binary [u32 id][script]
import type { CachedRewrite, RemoteRewriteCache } from "@mercuryworkshop/scramjet";

// a lookup that takes longer than this is treated as a miss: rewriting locally is the fallback
const GET_TIMEOUT = 3000;
// scripts bigger than this aren't sent for the relay to rewrite
const MAX_PUT_BYTES = 32 * 1024 * 1024;

type Waiting = {
	resolve: (entry: CachedRewrite | undefined) => void;
	head?: { tag: string; offsets: number[]; jsLength: number };
};

export class RelayRewriteCache implements RemoteRewriteCache {
	private ws: WebSocket | null = null;
	private queue: (string | Uint8Array)[] = [];
	private nextId = 1;
	private waiting = new Map<number, Waiting>();

	constructor(private url: string) {}

	/** opens the connection now, so the first lookup doesn't wait for it */
	connect() {
		this.open();
	}

	private open(): WebSocket {
		if (this.ws && this.ws.readyState <= WebSocket.OPEN) return this.ws;
		const ws = new WebSocket(this.url);
		ws.binaryType = "arraybuffer";
		ws.onopen = () => {
			for (const m of this.queue) ws.send(m);
			this.queue = [];
		};
		ws.onmessage = (e) => {
			if (typeof e.data !== "string") {
				const id = new DataView(e.data).getUint32(0, true);
				const w = this.waiting.get(id);
				if (!w?.head) return;
				this.waiting.delete(id);
				const bytes = new Uint8Array(e.data, 4);
				w.resolve({
					js: bytes.slice(0, w.head.jsLength),
					map:
						bytes.byteLength > w.head.jsLength
							? bytes.slice(w.head.jsLength)
							: null,
					offsets: w.head.offsets,
					tag: w.head.tag,
				});
				return;
			}
			const msg = JSON.parse(e.data);
			const w = this.waiting.get(msg.id);
			if (!w) return;
			if (msg.t === "rwhit") {
				w.head = { tag: msg.tag, offsets: msg.offsets, jsLength: msg.jsLength };
			} else {
				this.waiting.delete(msg.id);
				w.resolve(undefined);
			}
		};
		ws.onclose = () => {
			for (const w of this.waiting.values()) w.resolve(undefined);
			this.waiting.clear();
			this.queue = [];
		};
		this.ws = ws;
		return ws;
	}

	private send(m: string | Uint8Array) {
		const ws = this.open();
		if (ws.readyState === WebSocket.OPEN) ws.send(m);
		else this.queue.push(m);
	}

	get(key: string, url?: string): Promise<CachedRewrite | undefined> {
		const id = this.nextId++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				resolve(undefined);
			}, GET_TIMEOUT);
			this.waiting.set(id, {
				resolve: (entry) => {
					clearTimeout(timer);
					resolve(entry);
				},
			});
			this.send(JSON.stringify({ t: "rwget", id, key, url }));
		});
	}

	put(key: string, header: string, input: Uint8Array) {
		if (input.byteLength > MAX_PUT_BYTES) return;
		const id = this.nextId++;
		this.send(JSON.stringify({ t: "rwput", id, key, header, body: true }));
		const frame = new Uint8Array(4 + input.byteLength);
		new DataView(frame.buffer).setUint32(0, id, true);
		frame.set(input, 4);
		this.send(frame);
	}
}
