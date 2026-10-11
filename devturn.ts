// A small TURN relay (RFC 5766 over TCP, UDP relaying) for the dev server.
//
// Scramjet proxies http and websockets, but WebRTC media normally goes straight from the
// browser to the remote peer. With `webrtcRelay` set in the scramjet config, every
// RTCPeerConnection only uses this relay, so media goes browser -> relay -> peer instead.
// It speaks TCP to the browser so it works through tcp-only port forwarding (VS Code,
// ssh -L), and UDP to peers. It implements what Chrome's TURN client uses: Allocate,
// Refresh, CreatePermission, ChannelBind, Send/Data indications and ChannelData, with
// long-term credentials. IPv4 only.

import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";
import os from "node:os";

export type TurnServerOptions = {
	/** address to listen on for clients (default 127.0.0.1: only reachable through port forwarding) */
	host?: string;
	port: number;
	username: string;
	credential: string;
	realm?: string;
	/** address advertised as the relayed address (default: the first non-internal IPv4) */
	relayAddress?: string;
	/** allow relaying to private, loopback and link-local peers (off: the relay is not a way into the host's network) */
	allowPrivatePeers?: boolean;
	maxAllocations?: number;
	log?: (message: string) => void;
};

const MAGIC = 0x2112a442;

const BINDING = 0x0001;
const ALLOCATE = 0x0003;
const REFRESH = 0x0004;
const SEND = 0x0006;
const DATA = 0x0007;
const CREATE_PERMISSION = 0x0008;
const CHANNEL_BIND = 0x0009;

const INDICATION = 0x0010;
const SUCCESS = 0x0100;
const ERROR = 0x0110;

const USERNAME = 0x0006;
const MESSAGE_INTEGRITY = 0x0008;
const ERROR_CODE = 0x0009;
const CHANNEL_NUMBER = 0x000c;
const LIFETIME = 0x000d;
const XOR_PEER_ADDRESS = 0x0012;
const DATA_ATTR = 0x0013;
const REALM = 0x0014;
const NONCE = 0x0015;
const XOR_RELAYED_ADDRESS = 0x0016;
const REQUESTED_ADDRESS_FAMILY = 0x0017;
const REQUESTED_TRANSPORT = 0x0019;
const XOR_MAPPED_ADDRESS = 0x0020;
const SOFTWARE = 0x8022;

const DEFAULT_LIFETIME = 600;
const MAX_LIFETIME = 3600;
const PERMISSION_LIFETIME = 300;
const CHANNEL_LIFETIME = 600;

type Attr = { type: number; value: Buffer };
type Message = {
	type: number;
	tid: Buffer;
	attrs: Attr[];
	raw: Buffer;
	/** byte offset of MESSAGE-INTEGRITY in raw, or -1 */
	integrityOffset: number;
};
type Peer = { ip: string; port: number };
type Allocation = {
	relay: dgram.Socket;
	relayed: Peer;
	expires: number;
	permissions: Map<string, number>;
	channels: Map<number, Peer & { expires: number }>;
	peerChannels: Map<string, number>;
};

function parseMessage(raw: Buffer): Message | null {
	if (raw.length < 20 || raw.readUInt32BE(4) !== MAGIC) return null;
	const attrs: Attr[] = [];
	let integrityOffset = -1;
	let offset = 20;
	while (offset + 4 <= raw.length) {
		const type = raw.readUInt16BE(offset);
		const length = raw.readUInt16BE(offset + 2);
		if (offset + 4 + length > raw.length) return null;
		if (type === MESSAGE_INTEGRITY) integrityOffset = offset;
		attrs.push({ type, value: raw.subarray(offset + 4, offset + 4 + length) });
		offset += 4 + length + ((4 - (length % 4)) % 4);
	}
	return {
		type: raw.readUInt16BE(0),
		tid: raw.subarray(8, 20),
		attrs,
		raw,
		integrityOffset,
	};
}

function attr(message: Message, type: number) {
	return message.attrs.find((a) => a.type === type)?.value;
}

function attrBuffer(type: number, value: Buffer) {
	const header = Buffer.alloc(4);
	header.writeUInt16BE(type, 0);
	header.writeUInt16BE(value.length, 2);
	const padding = Buffer.alloc((4 - (value.length % 4)) % 4);
	return Buffer.concat([header, value, padding]);
}

function buildMessage(type: number, tid: Buffer, attrs: Attr[], key?: Buffer) {
	const body = Buffer.concat(attrs.map((a) => attrBuffer(a.type, a.value)));
	const header = Buffer.alloc(20);
	header.writeUInt16BE(type, 0);
	header.writeUInt16BE(body.length + (key ? 24 : 0), 2);
	header.writeUInt32BE(MAGIC, 4);
	tid.copy(header, 8);
	const message = Buffer.concat([header, body]);
	if (!key) return message;
	const hmac = crypto.createHmac("sha1", key).update(message).digest();
	return Buffer.concat([message, attrBuffer(MESSAGE_INTEGRITY, hmac)]);
}

function encodeXorAddress(peer: Peer) {
	const value = Buffer.alloc(8);
	value.writeUInt8(0x01, 1);
	value.writeUInt16BE(peer.port ^ (MAGIC >>> 16), 2);
	const ip = peer.ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
	value.writeUInt32BE((ip ^ MAGIC) >>> 0, 4);
	return value;
}

function decodeXorAddress(value: Buffer): Peer | null {
	// IPv6 peers are not supported (the relay socket is IPv4)
	if (value.length < 8 || value.readUInt8(1) !== 0x01) return null;
	const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
	const ip = (value.readUInt32BE(4) ^ MAGIC) >>> 0;
	return {
		ip: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join("."),
		port,
	};
}

function errorAttr(code: number, reason: string) {
	const value = Buffer.alloc(4 + Buffer.byteLength(reason));
	value.writeUInt8(Math.floor(code / 100), 2);
	value.writeUInt8(code % 100, 3);
	value.write(reason, 4);
	return { type: ERROR_CODE, value };
}

function isPrivateIPv4(ip: string) {
	const [a, b] = ip.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}

function defaultRelayAddress() {
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal)
				return address.address;
		}
	}
	return "127.0.0.1";
}

export function startTurnServer(options: TurnServerOptions) {
	const realm = options.realm ?? "scramjet";
	const relayAddress = options.relayAddress ?? defaultRelayAddress();
	const maxAllocations = options.maxAllocations ?? 64;
	const log = options.log ?? (() => {});
	const key = crypto
		.createHash("md5")
		.update(`${options.username}:${realm}:${options.credential}`)
		.digest();
	const software = { type: SOFTWARE, value: Buffer.from("scramjet-devturn") };
	const allocations = new Set<Allocation>();

	const peerAllowed = (peer: Peer) =>
		options.allowPrivatePeers || !isPrivateIPv4(peer.ip);

	const server = net.createServer((socket) => {
		const client: Peer = {
			ip: (socket.remoteAddress ?? "").replace(/^::ffff:/, ""),
			port: socket.remotePort ?? 0,
		};
		const nonce = crypto.randomBytes(16).toString("hex");
		let allocation: Allocation | null = null;
		let buffered = Buffer.alloc(0);

		const send = (data: Buffer) => {
			if (!socket.destroyed) socket.write(data);
		};
		const respond = (
			request: Message,
			cls: number,
			attrs: Attr[],
			signed = true
		) => {
			const method = request.type & 0x3eef;
			send(
				buildMessage(
					method | cls,
					request.tid,
					[software, ...attrs],
					signed ? key : undefined
				)
			);
		};
		const fail = (request: Message, code: number, reason: string) =>
			respond(request, ERROR, [errorAttr(code, reason)]);

		const freeAllocation = () => {
			if (!allocation) return;
			allocation.relay.close();
			allocations.delete(allocation);
			allocation = null;
		};

		const authenticated = (request: Message) => {
			const username = attr(request, USERNAME);
			const integrity = attr(request, MESSAGE_INTEGRITY);
			if (!username || !integrity || request.integrityOffset < 0) {
				respond(
					request,
					ERROR,
					[
						errorAttr(401, "Unauthorized"),
						{ type: REALM, value: Buffer.from(realm) },
						{ type: NONCE, value: Buffer.from(nonce) },
					],
					false
				);
				return false;
			}
			if (attr(request, NONCE)?.toString() !== nonce) {
				respond(
					request,
					ERROR,
					[
						errorAttr(438, "Stale Nonce"),
						{ type: REALM, value: Buffer.from(realm) },
						{ type: NONCE, value: Buffer.from(nonce) },
					],
					false
				);
				return false;
			}
			// the hmac covers everything before MESSAGE-INTEGRITY, with the length field
			// counting up to and including it
			const signedPart = Buffer.from(
				request.raw.subarray(0, request.integrityOffset)
			);
			signedPart.writeUInt16BE(request.integrityOffset - 20 + 24, 2);
			const expected = crypto
				.createHmac("sha1", key)
				.update(signedPart)
				.digest();
			if (
				username.toString() !== options.username ||
				!crypto.timingSafeEqual(expected, integrity)
			) {
				respond(
					request,
					ERROR,
					[
						errorAttr(401, "Unauthorized"),
						{ type: REALM, value: Buffer.from(realm) },
						{ type: NONCE, value: Buffer.from(nonce) },
					],
					false
				);
				return false;
			}
			return true;
		};

		const relayToClient = (data: Buffer, from: Peer) => {
			if (!allocation) return;
			const permission = allocation.permissions.get(from.ip);
			if (!permission || permission < Date.now()) return;
			const channel = allocation.peerChannels.get(`${from.ip}:${from.port}`);
			if (channel !== undefined) {
				const header = Buffer.alloc(4);
				header.writeUInt16BE(channel, 0);
				header.writeUInt16BE(data.length, 2);
				// over TCP, ChannelData is padded to a multiple of 4
				send(
					Buffer.concat([
						header,
						data,
						Buffer.alloc((4 - (data.length % 4)) % 4),
					])
				);
			} else {
				send(
					buildMessage(DATA | INDICATION, crypto.randomBytes(12), [
						{ type: XOR_PEER_ADDRESS, value: encodeXorAddress(from) },
						{ type: DATA_ATTR, value: data },
					])
				);
			}
		};

		const handleAllocate = (request: Message) => {
			if (allocation) return fail(request, 437, "Allocation Mismatch");
			const transport = attr(request, REQUESTED_TRANSPORT);
			if (!transport || transport.readUInt8(0) !== 17)
				return fail(request, 442, "Unsupported Transport Protocol");
			const family = attr(request, REQUESTED_ADDRESS_FAMILY);
			if (family && family.readUInt8(0) !== 0x01)
				return fail(request, 440, "Address Family not Supported");
			if (allocations.size >= maxAllocations)
				return fail(request, 486, "Allocation Quota Reached");

			const relay = dgram.createSocket("udp4");
			relay.on("error", (e) => log(`relay socket error: ${e.message}`));
			relay.bind(0, () => {
				if (socket.destroyed) {
					relay.close();
					return;
				}
				const requested =
					attr(request, LIFETIME)?.readUInt32BE(0) ?? DEFAULT_LIFETIME;
				const lifetime = Math.min(
					Math.max(requested, DEFAULT_LIFETIME),
					MAX_LIFETIME
				);
				allocation = {
					relay,
					relayed: { ip: relayAddress, port: relay.address().port },
					expires: Date.now() + lifetime * 1000,
					permissions: new Map(),
					channels: new Map(),
					peerChannels: new Map(),
				};
				allocations.add(allocation);
				relay.on("message", (data, rinfo) =>
					relayToClient(data, { ip: rinfo.address, port: rinfo.port })
				);
				log(
					`allocated ${allocation.relayed.ip}:${allocation.relayed.port} for ${client.ip}:${client.port}`
				);
				respond(request, SUCCESS, [
					{
						type: XOR_RELAYED_ADDRESS,
						value: encodeXorAddress(allocation.relayed),
					},
					{ type: XOR_MAPPED_ADDRESS, value: encodeXorAddress(client) },
					{ type: LIFETIME, value: u32(lifetime) },
				]);
			});
		};

		const handleRefresh = (request: Message) => {
			if (!allocation) return fail(request, 437, "Allocation Mismatch");
			const requested =
				attr(request, LIFETIME)?.readUInt32BE(0) ?? DEFAULT_LIFETIME;
			if (requested === 0) {
				freeAllocation();
				return respond(request, SUCCESS, [{ type: LIFETIME, value: u32(0) }]);
			}
			const lifetime = Math.min(requested, MAX_LIFETIME);
			allocation.expires = Date.now() + lifetime * 1000;
			respond(request, SUCCESS, [{ type: LIFETIME, value: u32(lifetime) }]);
		};

		const handleCreatePermission = (request: Message) => {
			if (!allocation) return fail(request, 437, "Allocation Mismatch");
			const peers = request.attrs
				.filter((a) => a.type === XOR_PEER_ADDRESS)
				.map((a) => decodeXorAddress(a.value));
			if (!peers.length || peers.some((p) => !p))
				return fail(request, 400, "Bad Request");
			if (peers.some((p) => !peerAllowed(p!)))
				return fail(request, 403, "Forbidden");
			for (const peer of peers)
				allocation.permissions.set(
					peer!.ip,
					Date.now() + PERMISSION_LIFETIME * 1000
				);
			respond(request, SUCCESS, []);
		};

		const handleChannelBind = (request: Message) => {
			if (!allocation) return fail(request, 437, "Allocation Mismatch");
			const number = attr(request, CHANNEL_NUMBER)?.readUInt16BE(0);
			const peerValue = attr(request, XOR_PEER_ADDRESS);
			const peer = peerValue && decodeXorAddress(peerValue);
			if (number === undefined || number < 0x4000 || number > 0x7fff || !peer)
				return fail(request, 400, "Bad Request");
			if (!peerAllowed(peer)) return fail(request, 403, "Forbidden");
			const peerKey = `${peer.ip}:${peer.port}`;
			const existing = allocation.channels.get(number);
			const existingChannel = allocation.peerChannels.get(peerKey);
			if (
				(existing && `${existing.ip}:${existing.port}` !== peerKey) ||
				(existingChannel !== undefined && existingChannel !== number)
			)
				return fail(request, 400, "Bad Request");
			allocation.channels.set(number, {
				...peer,
				expires: Date.now() + CHANNEL_LIFETIME * 1000,
			});
			allocation.peerChannels.set(peerKey, number);
			allocation.permissions.set(
				peer.ip,
				Date.now() + PERMISSION_LIFETIME * 1000
			);
			respond(request, SUCCESS, []);
		};

		const sendToPeer = (data: Buffer, peer: Peer) => {
			if (!allocation) return;
			const permission = allocation.permissions.get(peer.ip);
			if (!permission || permission < Date.now()) return;
			allocation.relay.send(data, peer.port, peer.ip);
		};

		const handleMessage = (raw: Buffer) => {
			const message = parseMessage(raw);
			if (!message) return;
			const method = message.type & 0x3eef;
			const cls = message.type & 0x0110;

			if (cls === INDICATION) {
				if (method !== SEND || !allocation) return;
				const peerValue = attr(message, XOR_PEER_ADDRESS);
				const peer = peerValue && decodeXorAddress(peerValue);
				const data = attr(message, DATA_ATTR);
				if (peer && data) sendToPeer(data, peer);
				return;
			}
			if (cls !== 0) return;

			if (method === BINDING) {
				return send(
					buildMessage(BINDING | SUCCESS, message.tid, [
						{ type: XOR_MAPPED_ADDRESS, value: encodeXorAddress(client) },
					])
				);
			}
			if (!authenticated(message)) return;
			switch (method) {
				case ALLOCATE:
					return handleAllocate(message);
				case REFRESH:
					return handleRefresh(message);
				case CREATE_PERMISSION:
					return handleCreatePermission(message);
				case CHANNEL_BIND:
					return handleChannelBind(message);
				default:
					return fail(message, 400, "Bad Request");
			}
		};

		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4) {
				const first = buffered.readUInt8(0);
				if (first < 0x40) {
					// STUN message: 20-byte header + attributes
					const total = 20 + buffered.readUInt16BE(2);
					if (buffered.length < total) break;
					handleMessage(buffered.subarray(0, total));
					buffered = buffered.subarray(total);
				} else if (first < 0x80) {
					// ChannelData, padded to a multiple of 4 over TCP
					const length = buffered.readUInt16BE(2);
					const total = 4 + length + ((4 - (length % 4)) % 4);
					if (buffered.length < total) break;
					const channel = allocation?.channels.get(buffered.readUInt16BE(0));
					if (channel && channel.expires > Date.now())
						sendToPeer(Buffer.from(buffered.subarray(4, 4 + length)), channel);
					buffered = buffered.subarray(total);
				} else {
					socket.destroy();
					return;
				}
			}
		});
		socket.on("error", () => {});
		socket.on("close", freeAllocation);

		const expiry = setInterval(() => {
			if (allocation && allocation.expires < Date.now()) {
				freeAllocation();
				socket.destroy();
			}
		}, 10_000);
		socket.on("close", () => clearInterval(expiry));
	});

	return new Promise<{ port: number; close: () => void }>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host ?? "127.0.0.1", () => {
			const address = server.address() as net.AddressInfo;
			log(
				`listening on ${address.address}:${address.port}, relaying from ${relayAddress}`
			);
			resolve({
				port: address.port,
				close: () => {
					server.close();
					for (const a of allocations) a.relay.close();
					allocations.clear();
				},
			});
		});
	});
}

function u32(value: number) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value, 0);
	return buffer;
}
