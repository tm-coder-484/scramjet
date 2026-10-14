// controller.worker.js: a headless Controller, started by a page's Controller in worker mode.
// it handles every proxied request (transport, cookies, rewriting) off that page's main thread
import "./worker-bootstrap";
import { Controller, type Frame } from "./index";
import {
	setJsRewriteOffload,
	warmUpRewriter,
	type RewriterResult,
	type ScramjetConfig,
	type ScramjetContext,
} from "@mercuryworkshop/scramjet";

// the worker's $scramjetController is the same API, so scripts loaded into the worker (plugins
// from scramjet-utils, say) can use it
export * from "./index";

declare function importScripts(...urls: string[]): void;

type WorkerInitMessage = {
	id: string;
	config: any;
	scramjetConfig: any;
	scripts: string[];
	transport: string;
	setupFrame?: string;
};

// the page serializes these with toString
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const revive = (source: string) => new Function(`return (${source})`)();

let controller: Controller | null = null;
let pool: { updateConfig(config: ScramjetConfig): void } | null = null;

// big scripts are rewritten on a few rewriter threads (controller.rewriter.js) instead of this
// one, so this thread keeps answering requests while a bundle is rewritten, and bundles that
// arrive together are rewritten in parallel. they share the compiled rewriter module
function startRewriterPool(controller: Controller) {
	const module = (self as any)[Symbol.for("scramjet wasm module")];
	if (!module) return null;
	const digest = (self as any)[Symbol.for("scramjet wasm digest")];
	const size = Math.max(
		1,
		Math.min(3, (navigator.hardwareConcurrency || 2) - 1)
	);
	const url = new URL(controller.config.rewriterPath, location.href);
	url.searchParams.set(
		"scramjet",
		new URL(location.href).searchParams.get("scramjet")!
	);
	const { encode, decode } = controller.config.codec;

	type Slot = { worker: Worker; busy: number };
	const pending = new Map<
		number,
		{ resolve: (r: RewriterResult) => void; reject: (e: Error) => void; slot: Slot }
	>();
	let nextId = 1;
	const slots: Slot[] = [];
	for (let i = 0; i < size; i++) {
		const worker = new Worker(url, { name: "scramjet rewriter" });
		worker.postMessage({
			$rewriter$init: {
				module,
				digest,
				config: controller.scramjetConfig,
				codec: { encode: encode.toString(), decode: decode.toString() },
				// a transport that comes with a shared rewrite cache (RelayTransport's rewriteCache)
				remoteRewriteCache: (controller.transport as any).rewriteCacheUrl,
			},
		});
		worker.addEventListener("message", (e) => {
			const job = pending.get(e.data.id);
			if (!job) return;
			pending.delete(e.data.id);
			job.slot.busy--;
			if (e.data.error !== undefined) job.reject(new Error(e.data.error));
			else job.resolve(e.data.res);
		});
		slots.push({ worker, busy: 0 });
	}

	setJsRewriteOffload((js, scriptUrl, context, meta, isModule, useCache) => {
		const slot = slots.reduce((a, b) => (b.busy < a.busy ? b : a));
		slot.busy++;
		const id = nextId++;
		return new Promise<RewriterResult>((resolve, reject) => {
			pending.set(id, { resolve, reject, slot });
			slot.worker.postMessage({
				$rewriter$job: {
					id,
					js,
					url: scriptUrl,
					prefix: context.prefix.href,
					origin: meta.origin.href,
					base: meta.base.href,
					initiatorOrigin: meta.initiatorOrigin,
					isModule,
					useCache,
				},
			});
		});
	});

	return {
		updateConfig(config: ScramjetConfig) {
			for (const slot of slots)
				slot.worker.postMessage({ $rewriter$config: config });
		},
	};
}
// the first document would otherwise be rewritten by cold code (see warmUpRewriter), while the
// requests for its stylesheets wait behind it. ~20-40ms, once, before the controller says it's ready
async function warmUp(controller: Controller) {
	const prefix = new URL(controller.prefix + "warmup/", location.href);
	const { encode, decode } = controller.config.codec;
	const context = {
		config: controller.scramjetConfig,
		prefix,
		cookieJar: controller.cookieJar,
		interface: {
			getInjectScripts: (_meta, _handler, _htmlcontext, script) => [
				script(controller.config.scramjetPath),
				script(controller.config.injectPath),
			],
			getWorkerInjectScripts: () => "",
			codecEncode: encode,
			codecDecode: decode,
		},
	} as ScramjetContext;
	try {
		await warmUpRewriter(context);
	} catch {
		// only a missed speedup
	}
}

let setupFrame: ((frame: Frame) => void) | null = null;
// messages that arrive before the controller exists, i.e. while scripts load
const early: any[] = [];

function handle(data: any) {
	if (!controller) return void early.push(data);
	if (data.$worker$frame) {
		const frame = controller.createFrame({} as HTMLIFrameElement, {
			id: data.$worker$frame.id,
		});
		setupFrame?.(frame);
	} else if (data.$worker$sw) {
		controller.handleServiceWorkerMessage(data.$worker$sw);
	} else if (data.$worker$config) {
		// frames read the config through the controller, so updating it in place is enough
		Object.assign(controller.scramjetConfig, data.$worker$config);
		pool?.updateConfig(controller.scramjetConfig);
	}
}

self.addEventListener("message", (e: MessageEvent) => {
	const data = e.data;
	if (!data?.$worker$init) return handle(data);
	const init: WorkerInitMessage = data.$worker$init;
	try {
		if (init.scripts.length) importScripts(...init.scripts);
		const transport = revive(init.transport)();
		setupFrame = init.setupFrame ? revive(init.setupFrame) : null;
		controller = new Controller({
			transport,
			config: {
				...init.config,
				codec: {
					encode: revive(init.config.codec.encode),
					decode: revive(init.config.codec.decode),
				},
			},
			scramjetConfig: init.scramjetConfig,
			headless: {
				id: init.id,
				postToServiceWorker: (message, transfer) =>
					self.postMessage({ $worker$toSW: message }, { transfer }),
			},
		});
		// for debugging and instrumentation from devtools
		Object.defineProperty(self, Symbol.for("scramjet controller"), {
			value: controller,
			configurable: true,
		});
		for (const m of early.splice(0)) handle(m);
		controller.wait().then(
			async () => {
				pool = startRewriterPool(controller!);
				await warmUp(controller!);
				self.postMessage({ $worker$ready: true });
			},
			(err) => self.postMessage({ $worker$error: String(err) })
		);
	} catch (err) {
		self.postMessage({ $worker$error: String(err?.stack || err) });
	}
});
