import { basicTest } from "../testcommon.ts";

// connects two peers in the page and returns what each side used. under scramjet the
// harness sets webrtcRelay, so this goes through its TURN relay; bare, it's direct.
const connectPeers = `
	async function connectPeers(config) {
		const a = new RTCPeerConnection(config);
		const b = new RTCPeerConnection(config);
		const candidates = [];
		a.onicecandidate = (e) => { if (e.candidate) { candidates.push(e.candidate.type); b.addIceCandidate(e.candidate); } };
		b.onicecandidate = (e) => { if (e.candidate) { candidates.push(e.candidate.type); a.addIceCandidate(e.candidate); } };

		const canvas = document.createElement("canvas");
		canvas.width = 64;
		canvas.height = 48;
		const g = canvas.getContext("2d");
		const paint = setInterval(() => { g.fillStyle = "hsl(" + Math.random() * 360 + " 80% 50%)"; g.fillRect(0, 0, 64, 48); }, 40);
		const stream = canvas.captureStream(25);
		a.addTrack(stream.getVideoTracks()[0], stream);

		const channel = a.createDataChannel("test");
		const reply = new Promise((resolve) => {
			b.ondatachannel = (e) => (e.channel.onmessage = (m) => e.channel.send("pong:" + m.data));
			channel.onopen = () => channel.send("ping");
			channel.onmessage = (m) => resolve(m.data);
		});

		await a.setLocalDescription(await a.createOffer());
		await b.setRemoteDescription(a.localDescription);
		await b.setLocalDescription(await b.createAnswer());
		await a.setRemoteDescription(b.localDescription);

		const message = await Promise.race([reply, new Promise((r) => setTimeout(() => r("timeout"), 10000))]);
		let frames = 0;
		for (let i = 0; i < 50 && frames < 5; i++) {
			await new Promise((r) => setTimeout(r, 100));
			(await b.getStats()).forEach((s) => { if (s.type === "inbound-rtp" && s.kind === "video") frames = s.framesDecoded; });
		}
		clearInterval(paint);
		const policy = a.getConfiguration().iceTransportPolicy;
		const iceServers = a.getConfiguration().iceServers.map((s) => [].concat(s.urls).join(","));
		a.close();
		b.close();
		return { message, frames, candidates, policy, iceServers };
	}
`;

export default [
	basicTest({
		name: "webrtc-loopback-datachannel-and-video",
		js: `
			${connectPeers}
			const r = await connectPeers();
			assertEqual(r.message, "pong:ping", "data channel round trip");
			assert(r.frames >= 5, "video frames decoded: " + r.frames);
		`,
	}),
	basicTest({
		// with webrtcRelay set, media must not leave the browser except through the relay:
		// only relay candidates, and the site's own ice servers are dropped
		name: "webrtc-relay-only",
		scramjetOnly: true,
		js: `
			${connectPeers}
			const r = await connectPeers({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
			assertEqual(r.message, "pong:ping", "data channel round trip through the relay");
			assert(r.frames >= 5, "video frames decoded through the relay: " + r.frames);
			assertEqual(r.policy, "relay", "ice transport policy");
			assert(r.candidates.length > 0, "gathered candidates");
			assert(r.candidates.every((c) => c === "relay"), "only relay candidates: " + r.candidates.join(","));
			assert(!r.iceServers.some((u) => u.includes("stun.l.google.com")), "the site's stun server was dropped: " + r.iceServers);
		`,
	}),
];
