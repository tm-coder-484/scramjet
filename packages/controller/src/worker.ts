// controller.worker.js: a headless Controller, started by a page's Controller in worker mode.
// it handles every proxied request (transport, cookies, rewriting) off that page's main thread
import "./worker-bootstrap";
import { Controller, type Frame } from "./index";

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
		for (const m of early.splice(0)) handle(m);
		controller.wait().then(
			() => self.postMessage({ $worker$ready: true }),
			(err) => self.postMessage({ $worker$error: String(err) })
		);
	} catch (err) {
		self.postMessage({ $worker$error: String(err?.stack || err) });
	}
});
