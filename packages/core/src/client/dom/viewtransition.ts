import { ScramjetClient } from "@client/index";

// Chromium crashes the whole renderer (a CHECK in cc::draw_property_utils::CalculateDrawProperties)
// when some same-document view transitions run inside an iframe, e.g. YouTube's channel -> watch
// navigation. Proxied sites always live in an iframe, so let the update run but skip the animation.
export const enabled = (client: ScramjetClient) =>
	!client.flagEnabled("viewTransitions");

export default function (client: ScramjetClient, _self: Self) {
	// resolve now, before the page has a chance to replace it
	client.natives.store["ViewTransition.prototype.skipTransition"];

	// Element.prototype.startViewTransition is the newer element-scoped variant
	client.Proxy(
		[
			"Document.prototype.startViewTransition",
			"Element.prototype.startViewTransition",
		],
		{
			apply(ctx) {
				const transition = ctx.call();
				client.natives.call(
					"ViewTransition.prototype.skipTransition",
					transition
				);
			},
		}
	);
}
