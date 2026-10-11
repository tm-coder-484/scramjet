import { rewriteJs } from "@rewriters/js";
import { ScramjetClient, ProxyCtx, Proxy } from "@client/index";
import { Object_defineProperty } from "@/shared/snapshot";

function rewriteFunction<T extends string, U extends "construct" | "apply">(
	ctx: ProxyCtx<T, U>,
	client: ScramjetClient,
	RawFunction: FunctionConstructor
) {
	const stringifiedFunction = ctx.call().toString();

	// TODO: also check if the function comes from a weird realm. if so we need to completely block it or do something else weird
	// not much point rewriting the javascript if it's executing in the top level

	const content = rewriteJs(
		`return ${stringifiedFunction}`,
		"(function proxy)",
		client.context,
		client.meta
	);
	// the wrapper must be a plain function. ctx.fn may be an async or generator constructor,
	// and calling those without `new` would return a Promise or generator around the real function
	ctx.return(RawFunction(content)());
}

export default function (client: ScramjetClient, self: Self) {
	const handler: Proxy = {
		apply(ctx: ProxyCtx) {
			rewriteFunction(ctx, client, RawFunction);
		},
		construct(ctx) {
			rewriteFunction(ctx, client, RawFunction);
		},
	};

	client.Proxy("Function", handler);

	const RawFunction = client.natives.call(
		"eval",
		null,
		"(function () {})"
	).constructor;
	const RawAsyncFunction = client.natives.call(
		"eval",
		null,
		"(async function () {})"
	).constructor;
	const RawGeneratorFunction = client.natives.call(
		"eval",
		null,
		"(function* () {})"
	).constructor;
	const RawAsyncGeneratorFunction = client.natives.call(
		"eval",
		null,
		"(async function* () {})"
	).constructor;

	// Function.prototype.constructor must be the same object as the global Function. client.Proxy
	// above already replaced the global, so reuse that proxy instead of creating a second one
	Object_defineProperty(RawFunction.prototype, "constructor", {
		value: self.Function,
		writable: true,
		enumerable: false,
		configurable: true,
	});
	client.RawProxy(RawAsyncFunction.prototype, "constructor", handler);
	client.RawProxy(RawGeneratorFunction.prototype, "constructor", handler);
	client.RawProxy(RawAsyncGeneratorFunction.prototype, "constructor", handler);
}
