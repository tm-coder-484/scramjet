import { ScramjetClient } from "@client/index";

// WebRTC connects straight from the browser to the peer, so media (and the user's IP)
// bypasses the proxy. With webrtcRelay set, every connection gathers only relay
// candidates from the configured TURN servers, and the site's own ice servers are
// dropped: they would be contacted directly too.
export const enabled = (client: ScramjetClient) =>
	!!client.config.webrtcRelay?.length;

export default function (client: ScramjetClient, _self: Self) {
	const relayed = (config: RTCConfiguration | null | undefined) => ({
		...(config ?? {}),
		iceServers: client.config.webrtcRelay,
		iceTransportPolicy: "relay" as const,
	});

	// the site's config is only copied into a fresh object, then the relay servers and policy
	// are written over it, so nothing it does can change where media goes
	client.Proxy("RTCPeerConnection", {
		construct(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			ctx.args[0] = relayed(ctx.args[0]);
		},
	});

	client.Proxy("RTCPeerConnection.prototype.setConfiguration", {
		apply(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			ctx.args[0] = relayed(ctx.args[0]);
		},
	});
}
