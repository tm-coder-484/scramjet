import { rewriteCss, unrewriteCss } from "@rewriters/css";
import { ScramjetClient } from "@client/index";
import { Reflect_apply, Reflect_get, Reflect_set } from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	client.Proxy("CSSStyleDeclaration.prototype.setProperty", {
		apply(ctx) {
			if (!ctx.args[1]) return;
			ctx.args[1] = rewriteCss(ctx.args[1], client.context, client.meta);
		},
	});

	client.Proxy("CSSStyleDeclaration.prototype.getPropertyValue", {
		apply(ctx) {
			const v = ctx.call();
			if (!v) return v;
			ctx.return(unrewriteCss(v, client.context));
		},
	});

	client.Trap("CSSStyleDeclaration.prototype.cssText", {
		set(ctx, value: string) {
			ctx.set(rewriteCss(value, client.context, client.meta));
		},
		get(ctx) {
			return unrewriteCss(ctx.get(), client.context);
		},
	});

	client.Proxy("CSSStyleSheet.prototype.insertRule", {
		apply(ctx) {
			ctx.args[0] = rewriteCss(ctx.args[0], client.context, client.meta);
		},
	});

	client.Proxy("CSSStyleSheet.prototype.replace", {
		apply(ctx) {
			ctx.args[0] = rewriteCss(ctx.args[0], client.context, client.meta);
		},
	});

	client.Proxy("CSSStyleSheet.prototype.replaceSync", {
		apply(ctx) {
			ctx.args[0] = rewriteCss(ctx.args[0], client.context, client.meta);
		},
	});

	client.Trap("CSSRule.prototype.cssText", {
		set(ctx, value: string) {
			ctx.set(rewriteCss(value, client.context, client.meta));
		},
		get(ctx) {
			return unrewriteCss(ctx.get(), client.context);
		},
	});

	client.Proxy("CSSStyleValue.parse", {
		apply(ctx) {
			if (!ctx.args[1]) return;
			ctx.args[1] = rewriteCss(ctx.args[1], client.context, client.meta);
		},
	});

	client.Trap("HTMLElement.prototype.style", {
		get(ctx) {
			// unfortunate and dumb hack. we have to trap every property of this
			// since the prototype chain is fucked

			const style = ctx.get() as CSSStyleDeclaration;

			return new Proxy(style, {
				get(target, prop) {
					const value = Reflect_get(target, prop);

					if (typeof value === "function") {
						return new Proxy(value, {
							apply(target, that, args) {
								return Reflect_apply(target, style, args);
							},
						});
					}

					// camelCase url properties such as backgroundImage live on the prototype too,
					// so only non-strings skip unrewriting. only url() values can hold a proxy url
					if (typeof value !== "string" || !value.includes("url("))
						return value;

					return unrewriteCss(value, client.context);
				},
				set(target, prop, value) {
					if (prop == "cssText" || value == "" || typeof value !== "string") {
						return Reflect_set(target, prop, value);
					}

					return Reflect_set(
						target,
						prop,
						rewriteCss(value, client.context, client.meta)
					);
				},
			});
		},
		set(ctx, value: string) {
			// this will actually run the trap for cssText. don't rewrite it here
			ctx.set(value);
		},
	});

	// computed values hold the proxied url() forms; only url() values need unrewriting
	const unrewriteComputed = (value: unknown) =>
		typeof value === "string" && value.includes("url(")
			? unrewriteCss(value, client.context)
			: value;

	client.Proxy("getComputedStyle", {
		apply(ctx) {
			const style = ctx.call() as CSSStyleDeclaration;

			ctx.return(
				new Proxy(style, {
					get(target, prop) {
						const value = Reflect_get(target, prop);

						if (typeof value === "function") {
							// e.g. getPropertyValue("background-image")
							return new Proxy(value, {
								apply(target, _that, args) {
									return unrewriteComputed(Reflect_apply(target, style, args));
								},
							});
						}

						return unrewriteComputed(value);
					},
				})
			);
		},
	});
}
