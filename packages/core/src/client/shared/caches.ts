import { ScramjetClient } from "@client/index";
import { Array_isArray, String } from "@/shared/snapshot";

export default function (client: ScramjetClient, _self: Self) {
	client.Proxy("CacheStorage.prototype.open", {
		apply(ctx) {
			ctx.args[0] = `${client.url.origin}@${ctx.args[0]}`;
		},
	});

	client.Proxy("CacheStorage.prototype.has", {
		apply(ctx) {
			ctx.args[0] = `${client.url.origin}@${ctx.args[0]}`;
		},
	});

	client.Proxy("CacheStorage.prototype.match", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
		},
	});

	client.Proxy("CacheStorage.prototype.delete", {
		apply(ctx) {
			ctx.args[0] = `${client.url.origin}@${ctx.args[0]}`;
		},
	});

	// a string request is a url, and cache entries are keyed by the proxied url
	const rewriteRequest = (request: unknown) =>
		typeof request === "string" ? client.rewriteUrl(request) : request;

	client.Proxy(
		[
			"Cache.prototype.add",
			"Cache.prototype.delete",
			"Cache.prototype.match",
			"Cache.prototype.matchAll",
			"Cache.prototype.put",
		],
		{
			apply(ctx) {
				ctx.args[0] = rewriteRequest(ctx.args[0]);
			},
		}
	);

	client.Proxy("Cache.prototype.addAll", {
		apply(ctx) {
			if (Array_isArray(ctx.args[0])) {
				ctx.args[0] = ctx.args[0].map(rewriteRequest);
			}
		},
	});

	// names are stored as "<origin>@<name>": list only this site's caches, under their own names
	client.Proxy("CacheStorage.prototype.keys", {
		apply(ctx) {
			const prefix = `${client.url.origin}@`;

			ctx.return(
				(ctx.call() as Promise<string[]>).then((names) =>
					names
						.filter((name) => name.startsWith(prefix))
						.map((name) => name.substring(prefix.length))
				)
			);
		},
	});

	// TODO - check if this might leak things if Response from fetch is passed in and the url isn't properly being unrewritten
}
