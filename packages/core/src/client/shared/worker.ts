import { ScramjetClient } from "@client/index";
import { WORKERTRANSPORT } from "@/symbols";

export default function (client: ScramjetClient, _self: GlobalThis) {
	// worker fetches go through the service worker, but websockets need a transport.
	// hand each new worker its own one as its first message (see loadWorker in the controller)
	const transportMessage = (): [any, StructuredSerializeOptions] | null => {
		const port = client.init.createWorkerTransport?.();
		if (!port) return null;

		return [{ [WORKERTRANSPORT]: port }, { transfer: [port] }];
	};

	client.Proxy("Worker", {
		construct(ctx) {
			ctx.args[0] = client.rewriteUrl(ctx.args[0], {
				destination: "worker",
				isModule: ctx.args[1]?.type === "module",
			});

			const worker = ctx.call();
			const message = transportMessage();
			if (message)
				client.natives.call("Worker.prototype.postMessage", worker, ...message);
		},
	});

	// sharedworkers can only be constructed from window
	client.Proxy("SharedWorker", {
		construct(ctx) {
			const isModule =
				typeof ctx.args[1] === "object" && ctx.args[1]?.type === "module";

			ctx.args[0] = client.rewriteUrl(ctx.args[0], {
				destination: "sharedworker",
				isModule,
			});

			if (ctx.args[1] && typeof ctx.args[1] === "string")
				ctx.args[1] = `${client.url.origin}@${ctx.args[1]}`;

			if (ctx.args[1] && typeof ctx.args[1] === "object") {
				if (ctx.args[1].name) {
					ctx.args[1].name = `${client.url.origin}@${ctx.args[1].name}`;
				}
			}

			const worker = ctx.call();
			const message = transportMessage();
			if (message)
				client.natives.call(
					"MessagePort.prototype.postMessage",
					worker.port,
					...message
				);
		},
	});

	client.Proxy("Worklet.prototype.addModule", {
		apply(ctx) {
			if (ctx.args[0]) ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});
}
