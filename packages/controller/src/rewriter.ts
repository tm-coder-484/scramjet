// controller.rewriter.js: one of the controller worker's rewriter threads. Big scripts are
// rewritten here (see rewriterPool in worker.ts), so the controller worker keeps answering other
// requests meanwhile, and several bundles can be rewritten at once
import "./worker-bootstrap";
import { RelayRewriteCache } from "./remotecache";
import {
	rewriteJsInner,
	rewriteJsWithCache,
	setRemoteRewriteCache,
	setWasm,
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
	isModule: boolean;
	useCache: boolean;
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
		const context = {
			config: config!,
			prefix: new URL(job.prefix),
			interface: { codecEncode, codecDecode },
		} as unknown as ScramjetContext;
		const meta = { origin: new URL(job.origin), base: new URL(job.base) };
		const res = job.useCache
			? await rewriteJsWithCache(job.js, job.url, context, meta, job.isModule)
			: rewriteJsInner(job.js, job.url, context, meta, job.isModule);
		// copied, not transferred: the cache may hold on to these bytes
		self.postMessage({ id: job.id, res });
	} catch (err: any) {
		self.postMessage({ id: job.id, error: String(err?.message ?? err) });
	}
}

self.addEventListener("message", (e: MessageEvent) => {
	const data = e.data;
	if (data.$rewriter$init) {
		const init: InitMessage = data.$rewriter$init;
		setWasm(init.module, init.digest);
		if (init.remoteRewriteCache)
			setRemoteRewriteCache(new RelayRewriteCache(init.remoteRewriteCache));
		config = init.config;
		codecEncode = revive(init.codec.encode);
		codecDecode = revive(init.codec.decode);
	} else if (data.$rewriter$config) {
		config = data.$rewriter$config;
	} else if (data.$rewriter$job) {
		void runJob(data.$rewriter$job);
	}
});
