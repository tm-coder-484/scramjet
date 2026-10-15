// controller.worker.js: a headless Controller, started by a page's Controller in worker mode.
// it handles every proxied request (transport, cookies, rewriting) off that page's main thread
import "./worker-bootstrap";
import { Controller, type Frame } from "./index";
import {
	html as warmupHtml,
	installWarmupResponder,
	warmUpRewriters,
} from "./warmup";
import {
	setHtmlRewriteOffload,
	setJsRewriteOffload,
	type RewriterResult,
	type ScramjetConfig,
} from "@mercuryworkshop/scramjet";
import type { HtmlRewriteRequest } from "./rewriter";
import { receiveForwardable, sendBody } from "./bodystream";

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
	/** the page warms everything up with a hidden frame once this worker is ready */
	frameWarmup?: boolean;
};

// the page serializes these with toString
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const revive = (source: string) => new Function(`return (${source})`)();

let controller: Controller | null = null;
let pool: {
	updateConfig(config: ScramjetConfig): void;
	warmUp(): void;
} | null = null;

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

	// busy: scripts in flight; docs: documents streaming through
	type Slot = { worker: Worker; busy: number; docs: number };
	const pending = new Map<
		number,
		{ resolve: (r: RewriterResult) => void; reject: (e: Error) => void; slot: Slot }
	>();
	let nextId = 1;
	const slots: Slot[] = [];
	for (let i = 0; i < size; i++) {
		const worker = new Worker(url, { name: "scramjet rewriter" });
		const slot: Slot = { worker, busy: 0, docs: 0 };
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
			if (e.data.docDone) {
				slot.docs--;
				return;
			}
			const job = pending.get(e.data.id);
			if (!job) return;
			pending.delete(e.data.id);
			job.slot.busy--;
			if (e.data.error !== undefined) job.reject(new Error(e.data.error));
			else job.resolve(e.data.res);
		});
		slots.push(slot);
	}
	// a document holds its thread until its last byte, so it counts for more than a script
	const leastBusy = () =>
		slots.reduce((a, b) =>
			b.busy + 4 * b.docs < a.busy + 4 * a.docs ? b : a
		);

	setJsRewriteOffload((js, scriptUrl, context, meta, isModule, useCache) => {
		const slot = leastBusy();
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

	// documents too. the body goes to the rewriter thread and the rewritten document comes back,
	// each pushed over a port (see bodystream.ts): a transferred stream would wait for a round
	// trip between the threads for every chunk
	setHtmlRewriteOffload(
		(body, contentType, context, meta, htmlcontext, injectScripts) => {
			const slot = leastBusy();
			const { port1, port2 } = new MessageChannel();
			const job: HtmlRewriteRequest = {
				body: sendBody(body),
				out: port2,
				contentType,
				prefix: context.prefix.href,
				origin: meta.origin.href,
				base: meta.base.href,
				topFrameName: meta.topFrameName,
				parentFrameName: meta.parentFrameName,
				referrerPolicy: meta.referrerPolicy,
				loadScripts: htmlcontext.loadScripts,
				inline: htmlcontext.inline,
				source: htmlcontext.source,
				injectScripts,
			};
			slot.docs++;
			slot.worker.postMessage({ $rewriter$html: job }, [job.body, job.out]);
			// the controller sends it on to the service worker as is (takePort)
			return receiveForwardable(port1);
		}
	);

	return {
		updateConfig(config: ScramjetConfig) {
			for (const slot of slots)
				slot.worker.postMessage({ $rewriter$config: config });
		},
		warmUp() {
			// over the warm-up frame's page, as warmUpRewriters does
			const page = warmupHtml();
			for (const slot of slots)
				slot.worker.postMessage({ $rewriter$warmup: { html: page } });
		},
	};
}

// the first document would otherwise be rewritten by cold code (see warmUpRewriter), while the
// requests for its stylesheets wait behind it. ~20-40ms, once, before the controller says it's
// ready, when the page doesn't load its warm-up frame. with the frame, the page asks for the same
// once the frame has loaded ($worker$warmup), as it waits for the optimized code to land
const warmUp = (controller: Controller) =>
	warmUpRewriters(controller, { budget: 40, small: true });

let setupFrame: ((frame: Frame) => void) | null = null;
// messages that arrive before the controller exists, i.e. while scripts load
const early: any[] = [];

function handle(data: any) {
	if (!controller) return void early.push(data);
	if (data.$worker$frame) {
		const frame = controller.createFrame({} as HTMLIFrameElement, {
			id: data.$worker$frame.id,
		});
		if (data.$worker$frame.warmup) installWarmupResponder(frame);
		else setupFrame?.(frame);
	} else if (data.$worker$frameGone) {
		const frame = controller.frames.find(
			(f) => f.id === data.$worker$frameGone.id
		);
		if (frame) controller.removeFrame(frame);
	} else if (data.$worker$warmup) {
		// documents are rewritten on the pool's threads too, so they warm up as well
		pool?.warmUp();
		void warmUpRewriters(controller);
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
				if (!init.frameWarmup) {
					pool?.warmUp();
					await warmUp(controller!);
				}
				self.postMessage({ $worker$ready: true });
			},
			(err) => self.postMessage({ $worker$error: String(err) })
		);
	} catch (err) {
		self.postMessage({ $worker$error: String(err?.stack || err) });
	}
});
