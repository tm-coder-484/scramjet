/* eslint-disable scramjet-core/no-globals -- host page only (the controller), never a proxied realm */
// cache of rewriter output for script bodies. memory is an LRU of 64MB; disk is IndexedDB
// (database scramjet-rewrite-cache, this origin) an LRU of 256MB. without indexedDB only memory is used.
// an entry is only ever stored with the prefix it was rewritten under at `offsets`, and a hit
// writes the current prefix over those bytes, so the prefix length must match (it is in the key)

import { TextEncoder_encode } from "../snapshot";
import { getWasmBytes } from "./wasm";

declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;

const MEMORY_LIMIT = 64 * 1024 * 1024;
const DISK_LIMIT = 256 * 1024 * 1024;
const DISK_TARGET = (DISK_LIMIT * 3) / 4;

export type CachedRewrite = {
	js: Uint8Array;
	// byte offsets in js where the prefix was written
	offsets: number[];
	map: Uint8Array | null;
	tag: string;
};

export type RewriteOutput = {
	js: Uint8Array;
	map: Uint8Array | null;
	tag: string;
};

function sizeOf(entry: CachedRewrite) {
	return (
		entry.js.byteLength +
		(entry.map?.byteLength ?? 0) +
		entry.offsets.length * 8 +
		128
	);
}

// every occurrence of needle in haystack, as byte offsets
export function findBytes(haystack: Uint8Array, needle: Uint8Array): number[] {
	const found: number[] = [];
	const first = needle[0];
	let i = haystack.indexOf(first);
	while (i !== -1 && i + needle.length <= haystack.length) {
		let j = 1;
		while (j < needle.length && haystack[i + j] === needle[j]) j++;
		if (j === needle.length) {
			found.push(i);
			i += needle.length;
		} else {
			i++;
		}
		i = haystack.indexOf(first, i);
	}
	return found;
}

function toHex(digest: ArrayBuffer): string {
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0")
	).join("");
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", data));
}

// VERSION, COMMITHASH, BUILDDATE and the rewriter wasm, hashed once
let buildTag: Promise<string> | undefined;
function getBuildTag(): Promise<string> {
	if (!buildTag) {
		buildTag = sha256(getWasmBytes() as Uint8Array<ArrayBuffer>).then((wasm) =>
			[VERSION, COMMITHASH, BUILDDATE, wasm].join(" ")
		);
	}
	return buildTag;
}

// header: everything but the script bytes that the rewriter output depends on, as a string
// the script is hashed on its own, so no copy of it is made; the key is the hash of the version,
// the header and that hash
export async function rewriteKey(
	header: string,
	input: Uint8Array
): Promise<string> {
	const inputHash = toHex(
		await crypto.subtle.digest("SHA-256", input as Uint8Array<ArrayBuffer>)
	);
	return sha256(
		TextEncoder_encode((await getBuildTag()) + "\n" + header + "\n" + inputHash)
	);
}

// memory

const memory = new Map<string, { entry: CachedRewrite; size: number }>();
let memoryBytes = 0;

function memoryDelete(key: string) {
	const old = memory.get(key);
	if (old) {
		memory.delete(key);
		memoryBytes -= old.size;
	}
}

function memoryGet(key: string): CachedRewrite | undefined {
	const hit = memory.get(key);
	if (!hit) return undefined;
	// re-insert so the map's order is least to most recently used
	memory.delete(key);
	memory.set(key, hit);
	return hit.entry;
}

function memoryPut(key: string, entry: CachedRewrite) {
	const size = sizeOf(entry);
	if (size > MEMORY_LIMIT) return;
	memoryDelete(key);
	memory.set(key, { entry, size });
	memoryBytes += size;
	for (const oldKey of memory.keys()) {
		if (memoryBytes <= MEMORY_LIMIT) break;
		memoryDelete(oldKey);
	}
}

// disk

const DB_NAME = "scramjet-rewrite-cache";
const DATA = "data";
const INDEX = "index";

// a database that doesn't open in time (blocked by another tab, or a stuck backend) leaves this
// page on the memory cache, so lookups never wait on it for long
const OPEN_TIMEOUT = 2000;

let dbPromise: Promise<IDBDatabase | undefined> | undefined;
export function openDb(): Promise<IDBDatabase | undefined> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve) => {
			const timer = setTimeout(() => resolve(undefined), OPEN_TIMEOUT);
			const done = (db: IDBDatabase | undefined) => {
				clearTimeout(timer);
				resolve(db);
			};
			try {
				const req = indexedDB.open(DB_NAME, 1);
				req.onupgradeneeded = () => {
					req.result.createObjectStore(DATA);
					req.result.createObjectStore(INDEX);
				};
				req.onsuccess = () => {
					// let a later version of the cache upgrade the database instead of blocking on this page
					req.result.onversionchange = () => req.result.close();
					done(req.result);
				};
				req.onerror = () => done(undefined);
				req.onblocked = () => done(undefined);
			} catch {
				done(undefined);
			}
		});
	}
	return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function transactionDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

// writes and evictions run one at a time, off the request path
let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>) {
	queue = queue.then(task).catch(() => {});
}

// bytes in the disk store, as of the last full scan (undefined until the first one)
let diskBytes: number | undefined;

type IndexRow = { used: number; size: number };

async function diskEvict(db: IDBDatabase) {
	const tx = db.transaction([DATA, INDEX], "readwrite");
	const index = tx.objectStore(INDEX);
	const keys = await request(index.getAllKeys());
	const rows = (await request(index.getAll())) as IndexRow[];

	let total = 0;
	for (const row of rows) total += row.size;

	if (total > DISK_LIMIT) {
		const oldest = keys
			.map((key, i) => ({ key: key as string, ...rows[i] }))
			.sort((a, b) => a.used - b.used);
		for (const row of oldest) {
			if (total <= DISK_TARGET) break;
			total -= row.size;
			index.delete(row.key);
			tx.objectStore(DATA).delete(row.key);
		}
	}
	diskBytes = total;
	await transactionDone(tx);
}

// disk writes are batched. a readwrite transaction blocks the reads queued behind it, and a
// page that is loading writes many entries (hits waited ~200ms behind them on a YouTube load).
// so entries wait in `pending` for FLUSH_DELAY after the first of them, and go to disk in
// transactions of at most FLUSH_BATCH bytes, with a turn for reads in between
const FLUSH_DELAY = 1500;
const FLUSH_BATCH = 8 * 1024 * 1024;
const FLUSH_NOW = 32 * 1024 * 1024;

const pending = new Map<string, { entry: CachedRewrite; size: number }>();
let pendingBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush() {
	if (pendingBytes > FLUSH_NOW) {
		enqueue(flushPending);
	} else if (flushTimer === undefined) {
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			enqueue(flushPending);
		}, FLUSH_DELAY);
	}
}

async function flushPending() {
	const db = await openDb();
	if (!db) return;
	// the first flush of a page measures the store, and evicts if it is over the limit
	if (diskBytes === undefined) await diskEvict(db);

	// batches go to disk one at a time on purpose, so reads get a turn between them
	/* eslint-disable no-await-in-loop */
	while (pending.size) {
		const batch: [string, { entry: CachedRewrite; size: number }][] = [];
		let bytes = 0;
		for (const [key, item] of pending) {
			if (batch.length && bytes + item.size > FLUSH_BATCH) break;
			batch.push([key, item]);
			bytes += item.size;
		}
		for (const [key] of batch) pending.delete(key);
		pendingBytes -= bytes;

		const tx = db.transaction([DATA, INDEX], "readwrite");
		const used = Date.now();
		for (const [key, { entry, size }] of batch) {
			tx.objectStore(DATA).put(entry, key);
			const row: IndexRow = { used, size };
			tx.objectStore(INDEX).put(row, key);
		}
		await transactionDone(tx);

		// an overcount (a key stored twice) only makes the next eviction run earlier
		diskBytes = (diskBytes ?? 0) + bytes;
		if (diskBytes > DISK_LIMIT) await diskEvict(db);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	/* eslint-enable no-await-in-loop */
}

async function diskTouch(key: string) {
	const db = await openDb();
	if (!db) return;
	const tx = db.transaction(INDEX, "readwrite");
	const index = tx.objectStore(INDEX);
	const row = (await request(index.get(key))) as IndexRow | undefined;
	if (row) index.put({ ...row, used: Date.now() }, key);
	await transactionDone(tx);
}

// the output for a stored entry under a prefix: a fresh copy with the prefix written at its offsets
export function materialize(
	entry: CachedRewrite,
	prefix: Uint8Array
): RewriteOutput {
	const js = entry.js.slice();
	for (const offset of entry.offsets) js.set(prefix, offset);
	return {
		js,
		map: entry.map ? entry.map.slice() : null,
		tag: entry.tag,
	};
}

// lookups

// a fresh copy of the cached output for this prefix, or undefined on a miss. the cache keeps
// its own bytes, since the caller may transfer what it gets back
export async function getRewrite(
	key: string,
	prefix: Uint8Array
): Promise<RewriteOutput | undefined> {
	let entry = memoryGet(key);
	if (entry) {
		enqueue(() => diskTouch(key).catch(() => {}));
	} else {
		try {
			const db = await openDb();
			if (db) {
				entry = await request(db.transaction(DATA).objectStore(DATA).get(key));
			}
		} catch {
			entry = undefined;
		}
		if (!entry) return undefined;
		memoryPut(key, entry);
		enqueue(() => diskTouch(key).catch(() => {}));
	}

	return materialize(entry, prefix);
}

// stores a rewrite after the response has been returned. the caller passes a copy of the
// rewriter output, since the response body may be transferred. input is the script that was rewritten
export function storeRewrite(
	key: string,
	rewrite: RewriteOutput,
	input: Uint8Array,
	prefix: Uint8Array
) {
	setTimeout(() =>
		enqueue(async () => {
			// the script contains the prefix itself, so its occurrences would not all be the
			// rewriter's; leave it uncached
			if (findBytes(input, prefix).length) return;

			const entry: CachedRewrite = {
				js: rewrite.js,
				offsets: findBytes(rewrite.js, prefix),
				map: rewrite.map,
				tag: rewrite.tag,
			};
			memoryPut(key, entry);

			// without indexedDB the entry stays in memory only
			if (!(await openDb())) return;
			const size = sizeOf(entry);
			const old = pending.get(key);
			if (old) pendingBytes -= old.size;
			pending.set(key, { entry, size });
			pendingBytes += size;
			scheduleFlush();
		})
	);
}
