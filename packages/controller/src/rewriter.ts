// controller.rewriter.js: one of the controller worker's rewriter threads. Big scripts are
// rewritten here (see rewriterPool in worker.ts), so the controller worker keeps answering other
// requests meanwhile, and several bundles can be rewritten at once
import "./worker-bootstrap";
import {
	rewriteJsInner,
	setWasm,
	type ScramjetConfig,
	type ScramjetContext,
} from "@mercuryworkshop/scramjet";

type InitMessage = {
	module: WebAssembly.Module;
	digest?: string;
	config: ScramjetConfig;
	codec: { encode: string; decode: string };
};

export type RewriteRequest = {
	id: number;
	js: Uint8Array;
	url: string | null;
	prefix: string;
	origin: string;
	base: string;
	isModule: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const revive = (source: string) => new Function(`return (${source})`)();

let config: ScramjetConfig | null = null;
let codecEncode: (url: string) => string;
let codecDecode: (url: string) => string;

self.addEventListener("message", (e: MessageEvent) => {
	const data = e.data;
	if (data.$rewriter$init) {
		const init: InitMessage = data.$rewriter$init;
		setWasm(init.module, init.digest);
		config = init.config;
		codecEncode = revive(init.codec.encode);
		codecDecode = revive(init.codec.decode);
	} else if (data.$rewriter$config) {
		config = data.$rewriter$config;
	} else if (data.$rewriter$job) {
		const job: RewriteRequest = data.$rewriter$job;
		try {
			const context = {
				config: config!,
				prefix: new URL(job.prefix),
				interface: { codecEncode, codecDecode },
			} as unknown as ScramjetContext;
			const meta = { origin: new URL(job.origin), base: new URL(job.base) };
			const res = rewriteJsInner(job.js, job.url, context, meta, job.isModule);
			// copied, not transferred: the output may be a view of the rewriter's wasm memory
			self.postMessage({ id: job.id, res });
		} catch (err: any) {
			self.postMessage({ id: job.id, error: String(err?.message ?? err) });
		}
	}
});
