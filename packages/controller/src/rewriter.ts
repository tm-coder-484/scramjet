// controller.rewriter.js: one of the controller worker's rewriter threads. Big scripts and
// documents are rewritten here (see startRewriterPool in worker.ts), so the controller worker
// keeps answering other requests meanwhile, and several can be rewritten at once
import "./worker-bootstrap";
import { RelayRewriteCache } from "./remotecache";
import { receiveBody, sendBodyTo } from "./bodystream";
import { REWRITER_WARMUP_MS } from "./warmup";
import {
	openRewriteCache,
	rewriteHtmlStream,
	rewriteJsInner,
	rewriteJsWithCache,
	finishRewrite,
	setRemoteRewriteCache,
	setWasm,
	warmUpRewriter,
	type ScramjetConfig,
	type ScramjetContext,
} from "@mercuryworkshop/scramjet";

type InitMessage = {
	module: WebAssembly.Module;
	digest?: string;
	config: ScramjetConfig;
	codec: { encode: string; decode: string };
	// the relay's shared rewrite cache (see remotecache.ts), when the transport has one
	remoteRewriteCache?: string;
};

export type RewriteRequest = {
	id: number;
	js: Uint8Array;
	url: string | null;
	prefix: string;
	origin: string;
	base: string;
	initiatorOrigin?: string;
	isModule: boolean;
	useCache: boolean;
};

/** a streamed document: rewriteHtmlStream's arguments, and where its output goes */
export type HtmlRewriteRequest = {
	// the body comes in on one port (from sendBody) and the rewritten document goes out on the other
	body: MessagePort;
	out: MessagePort;
	contentType: string | null;
	prefix: string;
	origin: string;
	base: string;
	topFrameName?: string;
	parentFrameName?: string;
	referrerPolicy?: string;
	loadScripts: boolean;
	inline: boolean;
	source: string;
	// made by the controller, which has the cookie jar
	injectScripts: string[];
};

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const revive = (source: string) => new Function(`return (${source})`)();

let config: ScramjetConfig | null = null;
let codecEncode: (url: string) => string;
let codecDecode: (url: string) => string;

// hashes the script, looks it up in the rewrite cache, and rewrites and stores it on a miss (or
// just rewrites it, for the scripts too small to cache): all of it here, off the controller's thread
async function runJob(job: RewriteRequest) {
	try {
		const context = contextFor(job.prefix, []);
		const meta = {
			origin: new URL(job.origin),
			base: new URL(job.base),
			initiatorOrigin: job.initiatorOrigin,
		};
		const rewritten = job.useCache
			? await rewriteJsWithCache(job.js, job.url, context, meta, job.isModule)
			: rewriteJsInner(job.js, job.url, context, meta, job.isModule);
		// the sourcemap call goes in here too, so the controller only passes the script on
		const res = {
			js: finishRewrite(rewritten, context, meta),
			map: null,
			tag: rewritten.tag,
			errors: rewritten.errors,
			finished: true,
		};
		// transferred: the output is always its own copy (the cache keeps its own), and copying a
		// big bundle's took several ms
		self.postMessage({ id: job.id, res }, ownBuffers(res.js));
	} catch (err: any) {
		// the script back, for the controller's fallback (it was transferred here)
		self.postMessage(
			{ id: job.id, error: String(err?.message ?? err), input: job.js },
			ownBuffers(job.js)
		);
	}
}

// the buffers of these arrays that hold nothing else, to transfer
function ownBuffers(...arrays: unknown[]): ArrayBuffer[] {
	const buffers: ArrayBuffer[] = [];
	for (const a of arrays)
		if (
			a instanceof Uint8Array &&
			a.byteOffset === 0 &&
			a.byteLength === a.buffer.byteLength &&
			a.buffer instanceof ArrayBuffer &&
			!buffers.includes(a.buffer)
		)
			buffers.push(a.buffer);
	return buffers;
}

function contextFor(prefix: string, injectScripts: string[]): ScramjetContext {
	return {
		config: config!,
		prefix: new URL(prefix),
		interface: {
			codecEncode,
			codecDecode,
			getInjectScripts: (_meta, _handler, _htmlcontext, script) =>
				injectScripts.map(script),
		},
	} as unknown as ScramjetContext;
}

function runHtmlJob(job: HtmlRewriteRequest) {
	const meta = {
		origin: new URL(job.origin),
		base: new URL(job.base),
		topFrameName: job.topFrameName,
		parentFrameName: job.parentFrameName,
		referrerPolicy: job.referrerPolicy,
	};
	const body = receiveBody(job.body);
	let out: ReadableStream<Uint8Array>;
	try {
		out = rewriteHtmlStream(
			body,
			job.contentType,
			contextFor(job.prefix, job.injectScripts),
			meta,
			{ loadScripts: job.loadScripts, inline: job.inline, source: job.source }
		);
	} catch (err) {
		body.cancel(err).catch(() => {});
		out = new ReadableStream({ start: (c) => c.error(err) });
	}
	// a document the page cancels cancels its rewrite, and its body, through the ports
	void sendBodyTo(out, job.out).finally(() =>
		self.postMessage({ docDone: true })
	);
}

// the warm-up frame's document reaches one of these threads at most. while the page waits for
// the optimized code to land, each runs the rewriters over that page (`html`) twice, as the
// controller's thread does (see warmUpRewriters)
async function warmUp(html: string) {
	const context = contextFor(
		new URL("/scramjet/warmup/", location.href).href,
		["/scramjet.js", "/inject.js"]
	);
	const end = performance.now() + REWRITER_WARMUP_MS;
	try {
		for (let i = 0; i < 2 && performance.now() < end; i++)
			// eslint-disable-next-line no-await-in-loop
			await warmUpRewriter(context, 1, html);
	} catch {
		// only a missed speedup
	}
}

self.addEventListener("message", (e: MessageEvent) => {
	const data = e.data;
	if (data.$rewriter$init) {
		const init: InitMessage = data.$rewriter$init;
		setWasm(init.module, init.digest);
		// the cache's database and connection are opened now, not by the first big script, which
		// would wait ~10-20ms for each
		void openRewriteCache();
		if (init.remoteRewriteCache) {
			const remote = new RelayRewriteCache(init.remoteRewriteCache);
			remote.connect();
			setRemoteRewriteCache(remote);
		}
		config = init.config;
		codecEncode = revive(init.codec.encode);
		codecDecode = revive(init.codec.decode);
	} else if (data.$rewriter$config) {
		config = data.$rewriter$config;
	} else if (data.$rewriter$job) {
		void runJob(data.$rewriter$job);
	} else if (data.$rewriter$html) {
		runHtmlJob(data.$rewriter$html);
	} else if (data.$rewriter$warmup) {
		void warmUp(data.$rewriter$warmup.html);
	}
});
