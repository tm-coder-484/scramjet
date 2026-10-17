import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { stdout } from "node:process";
import { execSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import chalk from "chalk";
import { createServer } from "vite";
//@ts-expect-error no typedefs
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import {
	normalizeWebsocketUrl,
	warnOnUrlEscape,
	runRspack,
	black,
	printBanner,
} from "./devlib.ts";
import rspackConfig from "./rspack.config.ts";
import { startTurnServer } from "./devturn.ts";
import { createRelay } from "./devrelay.ts";

const image = await fs.readFile("./assets/scramjet-mini-noalpha.png");

const commit = execSync("git rev-parse --short HEAD", {
	encoding: "utf-8",
}).replace(/\r?\n|\r/g, "");
const branch = execSync("git rev-parse --abbrev-ref HEAD", {
	encoding: "utf-8",
}).replace(/\r?\n|\r/g, "");
const packagejson = JSON.parse(await fs.readFile("./package.json", "utf-8"));
const version = packagejson.version;

const DEMO_PORT = process.env.DEMO_PORT || 4141;
const WISP_PORT = process.env.WISP_PORT || 4142;
const TURN_PORT = process.env.TURN_PORT || 4143;

if (process.env.VITE_WISP_URL) {
	process.env.VITE_WISP_URL = normalizeWebsocketUrl(process.env.VITE_WISP_URL);
} else {
	process.env.VITE_WISP_URL = `ws://localhost:${WISP_PORT}/`;
}

// the relay transport (devrelay.ts) shares the wisp port, at /relay
const relay = createRelay();
const wispserver = http.createServer((req, res) => {
	if (relay.request(req, res)) return;
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("wisp server js rewrite");
});
wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = true;
wispserver.on("upgrade", (req, socket, head) => {
	if (relay(req, socket, head)) return;
	wisp.routeRequest(req, socket, head);
});

wispserver.listen(Number(WISP_PORT));

// WebRTC media doesn't go through wisp, so the demo makes every RTCPeerConnection relay
// through this TURN server instead (see devturn.ts). It only listens on loopback, so it's
// reachable from this machine or through port forwarding, with a fresh password per run.
const turnCredential = crypto.randomBytes(16).toString("hex");
try {
	await startTurnServer({
		port: Number(TURN_PORT),
		username: "scramjet",
		credential: turnCredential,
		relayAddress: process.env.TURN_RELAY_IP,
		log: process.env.DEBUG ? (m) => console.log(`[turn] ${m}`) : undefined,
	});
	// 127.0.0.1 rather than localhost: VS Code forwards ports on IPv4 loopback
	process.env.VITE_TURN_URL ??= `turn:127.0.0.1:${TURN_PORT}?transport=tcp`;
	process.env.VITE_TURN_USERNAME = "scramjet";
	process.env.VITE_TURN_CREDENTIAL = turnCredential;
} catch (e) {
	console.warn(
		`WebRTC relay not started (${e instanceof Error ? e.message : e}); WebRTC will connect directly`
	);
}

const server = await createServer({
	configFile: "./packages/demo/vite.config.ts",
	root: "./packages/demo",
	server: {
		port: Number(DEMO_PORT),
		strictPort: true,
	},
});

warnOnUrlEscape(server);

await server.listen();

const accent = (text: string) => chalk.hex("#f1855bff").bold(text);
const highlight = (text: string) => chalk.hex("#fdd76cff").bold(text);
const urlColor = (text: string) => chalk.hex("#64DFDF").underline(text);
const note = (text: string) => chalk.hex("#CDB4DB")(text);
const connector = chalk.hex("#8D99AE").dim("@");

const lines = [
	black()(`${highlight("SCRAMJET DEV SERVER")}`),
	black()(
		`${accent("demo")} ${connector} ${urlColor(
			`http://localhost:${DEMO_PORT}/`
		)}`
	),
	black()(
		`${accent("wisp")} ${connector} ${urlColor(
			process.env.VITE_WISP_URL ?? ""
		)}`
	),
	black()(
		`${accent("relay")} ${connector} ${urlColor(
			new URL("relay", process.env.VITE_WISP_URL).href
		)}`
	),
	...(process.env.VITE_TURN_URL
		? [
				black()(
					`${accent("webrtc relay")} ${connector} ${urlColor(
						process.env.VITE_TURN_URL
					)}`
				),
			]
		: []),
	black()(chalk.dim(`[${branch}] ${commit} scramjet/${version}`)),
];

runRspack(rspackConfig);

printBanner(image, lines);
