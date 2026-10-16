import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	client.Proxy("EventSource", {
		construct(ctx) {
			const url = String(ctx.args[0]);
			// marked, so the service worker can tell the browser's own headers on it (Cache-Control,
			// Last-Event-ID) from ones a page set (see fetch/cors.ts)
			ctx.args[0] = client.rewriteUrl(url, { eventSource: true });
		},
	});

	client.Trap("EventSource.prototype.url", {
		get(ctx) {
			return client.unrewriteUrl(ctx.get());
		},
	});
}
