import { flagEnabled, ScramjetContext } from "@/shared";
import { URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import { bytesToBase64 } from "@/shared/util";
import {
	getRemoteRewriteCache,
	getRewrite,
	materialize,
	openDb,
	rewriteKey,
	storeEntry,
	storeRewrite,
} from "./jscache";
import {
	Error,
	JSON_stringify,
	Symbol_for,
	SyntaxError,
	TextDecoder_decode,
	TextEncoder_encode,
	_RegExp,
	_TextDecoder,
	_Uint8Array,
	Object_keys,
	Performance_now,
	String_startsWith,
} from "../snapshot";

export type RewriterResult = {
	js: string | Uint8Array;
	map: Uint8Array | null;
	tag: string;
	errors: string[];
	// finishRewrite already ran where the script was rewritten (a rewriter thread): js is final
	finished?: boolean;
};

function rewriterFlags(context: ScramjetContext, base: URLMeta["base"]) {
	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, base);
	}
	return flagsobj;
}

// the origin a script's static imports are fetched for: the document's. a fetched script's own
// url is its meta.origin, so the request's $io says which document it runs in
function initiatorOrigin(meta: URLMeta): string {
	return meta.initiatorOrigin ?? meta.origin.origin;
}

function rewriteJsWasm(
	input: string | Uint8Array,
	source: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): RewriterResult {
	const [rewriter, ret] = getRewriter(context, meta);
	// meta.base is a getter that re-resolves the base url (and in the client, re-parses
	// location.href), so read it once per rewrite instead of once per flag
	const base = meta.base;

	const flagsobj = rewriterFlags(context, base);

	// the rewriter encodes every static import specifier with codecEncode. blob: and
	// data: specifiers must stay raw, the way rewriteUrl emits them, because the service
	// worker reads them from the path without decoding (see handleBlobOrDataUrlFetch)
	const encodeSpecifier = (url: string) =>
		String_startsWith(url, "blob:") || String_startsWith(url, "data:")
			? url
			: context.interface.codecEncode(url);

	try {
		let out: JsRewriterOutput;
		const before = Performance_now();
		// try {
		if (typeof input === "string") {
			out = rewriter.rewrite_js(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				encodeSpecifier,
				input,
				base.href,
				source || "(unknown)",
				isModule,
				initiatorOrigin(meta)
			);
		} else {
			out = rewriter.rewrite_js_bytes(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				encodeSpecifier,
				input,
				base.href,
				source || "(unknown)",
				isModule,
				initiatorOrigin(meta)
			);
		}
		// } catch (err) {
		// 	const err1 = err as Error;
		// 	console.warn(
		// 		"failed rewriting js for",
		// 		source,
		// 		err1.message,
		// 		input instanceof Uint8Array ? textDecoder.decode(input) : input
		// 	);

		// 	return { js: input, tag: "", map: null };
		// }
		if (flagEnabled("rewriterLogs", context, base)) {
			dbg.time(meta, before, `oxc rewrite for "${source || "(unknown)"}"`);
		}

		const { js, map, scramtag, errors } = out;

		return {
			js: typeof input === "string" ? TextDecoder_decode(js) : js,
			tag: scramtag,
			map,
			errors,
		};
	} finally {
		ret();
	}
}

export function rewriteJsInner(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
) {
	return rewriteJsWasm(js, url, context, meta, isModule);
}

// "use strict" has to stay the script's first statement
const STRICT_MODE = /^\s*(['"])use strict\1;?/;
// the head of a script as text, with any byte order mark kept as U+FEFF (whitespace to the regex
// above), so the text's UTF-8 length is the head's length in bytes
const headDecoder = new _TextDecoder("utf-8", { ignoreBOM: true });
const HEAD_BYTES = 256;

// `line` in front of a script, after its "use strict" if it has one. A script in bytes stays in
// bytes: decoding YouTube's 12 MB rewritten bundle to put a line in front, and encoding it again
// for the response, held up the controller ~60 ms
function prependToScript(js: string | Uint8Array, line: string): string | Uint8Array {
	if (typeof js !== "string") {
		const head = headDecoder.decode(js.subarray(0, HEAD_BYTES));
		const lead = new _RegExp(/^\s*/).exec(head)![0].length;
		// the head holds the whole directive ('use strict'; is 13 characters), or shows there's none
		if (lead + 16 <= head.length) {
			const match = new _RegExp(STRICT_MODE).exec(head);
			const at = match ? TextEncoder_encode(match[0]).length : 0;
			const insert = TextEncoder_encode(match ? `\n${line}` : `${line}\n`);
			const out = new _Uint8Array(js.length + insert.length);
			out.set(js.subarray(0, at));
			out.set(insert, at);
			out.set(js.subarray(at), at + insert.length);
			return out;
		}
		js = TextDecoder_decode(js);
	}

	const strictMode = new _RegExp(STRICT_MODE);
	return strictMode.test(js)
		? js.replace(strictMode, `$&\n${line}`)
		: `${line}\n${js}`;
}

// whether a rewriter sourcemap records no changes: its first u32 is the number of changes
function unchanged(map: Uint8Array | null | undefined): boolean {
	return (
		!!map &&
		map.byteLength >= 4 &&
		(map[0] | (map[1] << 8) | (map[2] << 16) | (map[3] << 24)) === 0
	);
}

// the sourcemap call and the logs for a rewriter result. throws if that fails
export function finishRewrite(
	res: RewriterResult,
	context: ScramjetContext,
	meta: URLMeta
): string | Uint8Array {
	let newjs = res.js;

	// a script the rewriter left unchanged (no functions, nothing hooked: Apollo state, JSON-ish
	// config) has nothing to map back, and its output is its source
	if (flagEnabled("sourcemaps", context, meta.base) && !unchanged(res.map)) {
		const pushmap = globalThis[context.config.globals.pushsourcemapfn];
		if (pushmap) {
			pushmap(res.map, res.tag);
		} else {
			// base64 is a string literal, which parses far faster than a decimal array of the same bytes
			const sourcemapfn = `${context.config.globals.pushsourcemapfn}("${bytesToBase64(res.map)}", "${res.tag}");`;
			newjs = prependToScript(newjs, sourcemapfn);
		}
	}

	if (flagEnabled("rewriterLogs", context, meta.base)) {
		for (const error of res.errors) {
			dbg.error("oxc parse error", error);
		}
	}

	return newjs;
}

// what to do when a rewrite fails: pass the input through, or rethrow
function failRewrite(
	err: any,
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta
): string | Uint8Array {
	dbg.warn(
		"failed rewriting js for",
		url || "(unknown)",
		err.message,
		typeof js !== "string" ? TextDecoder_decode(js) : js
	);
	if (flagEnabled("allowInvalidJs", context, meta.base)) {
		return js;
	} else {
		// the rewriter only fails on code it cannot parse; report that as a SyntaxError like the engine does
		if (err.message.includes("oxc panicked in parser"))
			throw new SyntaxError(err.message);
		throw err;
	}
}

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
): string | Uint8Array {
	try {
		return finishRewrite(
			rewriteJsInner(js, url, context, meta, isModule),
			context,
			meta
		);
	} catch (err) {
		return failRewrite(err, js, url, context, meta);
	}
}

/**
 * Rewrites a script somewhere else (the controller's rewriter pool), so the thread handling
 * requests isn't blocked while a bundle is hashed, looked up in the cache, rewritten and stored.
 * Same inputs and result as rewriteJsWithCache (or rewriteJsInner, without the cache). It may
 * transfer `js` away (copying YouTube's 10 MB bundle to a thread took ~50 ms); a rejection then
 * hands it back as the error's `input`, for the fallback.
 */
export type JsRewriteOffload = (
	js: Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean,
	// false: rewrite without the cache (rewriteJsInner)
	useCache: boolean
) => Promise<RewriterResult>;

let jsRewriteOffload: JsRewriteOffload | null = null;

/** routes the rewrites of big scripts (the ones rewriteJsCached handles) through `offload` */
export function setJsRewriteOffload(offload: JsRewriteOffload | null) {
	jsRewriteOffload = offload;
}

// scripts under this size are rewritten every time. a small rewrite takes about 1ms, less than a
// lookup in the disk store, which also waits for the database to open in a fresh page
const MIN_CACHED_BYTES = 64 * 1024;
// scripts under this size are rewritten where they are, even with an offload: the round trip to a
// pool thread costs about what rewriting a few KB does. GitHub's front page loads ~150 modules,
// most of them under 16 KB: rewritten on the controller, they kept it busy for ~150 ms, while
// the requests behind them waited
const MIN_OFFLOAD_BYTES = 4 * 1024;
// from this size on, a remote cache is told which script it's asked for: it may be rewriting it
// already (see RemoteRewriteCache.get)
const MIN_SPECULATED_BYTES = 1024 * 1024;

// everything the rewriter output for a script depends on, except the prefix bytes and the script
// itself: the rewrite cache's header (see rewriteKey)
export function rewriteCacheHeader(
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): string {
	return JSON_stringify({
		globals: context.config.globals,
		flags: rewriterFlags(context, meta.base),
		prefixLength: TextEncoder_encode(context.prefix.pathname).length,
		base: meta.base.href,
		source: url || "(unknown)",
		isModule,
		// the cache is partitioned per requesting site
		origin: meta.origin.origin,
		// static import urls are tagged with it
		initiator: initiatorOrigin(meta),
		codec: `${context.interface.codecEncode}`,
	});
}

// A transport that can have its server rewrite scripts (RelayTransport with devrelay.ts) answers
// a script request with the rewritten script itself, when it has it or can make it: the browser
// then neither hashes the script, nor looks it up, nor gets its bytes twice (YouTube's 10 MB
// bundle: ~250 ms). The request carries its rewrite-cache header under REWRITE_HEADER on its raw
// headers array, and such a response the rewrite's details under REWRITTEN on its rawHeaders.
// Symbols, since a site's own headers are strings: no response header can claim a rewrite.
export const REWRITE_HEADER = Symbol_for("scramjet rewrite header");
export const REWRITTEN = Symbol_for("scramjet rewritten");
// on a script request with REWRITE_HEADER: the prefix, so the server can send the rewrite finished
// (as finishServerRewrite would make it). Its body is then the script to run, which can pass
// through untouched (see NATIVE_BODY)
export const REWRITE_FINISH = Symbol_for("scramjet rewrite finish");
// on a transport response's raw headers: a function that hands over the url its body can be
// fetched from directly, once, instead of being read (see ScramjetFetchResponse.nativeBody)
export const NATIVE_BODY = Symbol_for("scramjet native body");

/** the details of a script the transport's server rewrote: the body is js then map */
export type ServerRewrite = {
	tag: string;
	// byte offsets in js where the prefix goes (a placeholder of the same length is there)
	offsets: number[];
	jsLength: number;
	// sent finished (see REWRITE_FINISH)
	finished?: boolean;
};

/** a script the transport's server rewrote under `header`, ready to run (see REWRITTEN) */
export function finishServerRewrite(
	body: Uint8Array,
	rewrite: ServerRewrite,
	context: ScramjetContext,
	meta: URLMeta
): string | Uint8Array {
	const prefix = TextEncoder_encode(context.prefix.pathname);
	const { jsLength, offsets } = rewrite;
	if (!(jsLength >= 0 && jsLength <= body.byteLength))
		throw new Error("bad server rewrite");
	const js = body.subarray(0, jsLength);
	for (const offset of offsets) {
		if (!(offset >= 0 && offset + prefix.length <= jsLength))
			throw new Error("bad server rewrite");
		js.set(prefix, offset);
	}
	const map = body.byteLength > jsLength ? body.subarray(jsLength) : null;
	return finishRewrite({ js, map, tag: rewrite.tag, errors: [] }, context, meta);
}

/**
 * The rewriter output for a script body, from the cache (see jscache.ts) when it has it, and
 * stored there when it didn't. Throws if the rewrite fails; a failed rewrite is never cached.
 */
export async function rewriteJsWithCache(
	js: Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): Promise<RewriterResult> {
	const before = Performance_now();
	const base = meta.base;
	const source = url || "(unknown)";
	const prefix = TextEncoder_encode(context.prefix.pathname);
	const header = rewriteCacheHeader(url, context, meta, isModule);

	// a fresh page opens the database while the script is hashed, not after
	openDb();

	let key: string;
	try {
		key = await rewriteKey(header, js);
	} catch {
		// no SubtleCrypto (an insecure origin), or no wasm yet
		return rewriteJsInner(js, url, context, meta, isModule);
	}

	const hit = await getRewrite(key, prefix);
	if (hit) {
		if (flagEnabled("rewriterLogs", context, base))
			dbg.time(meta, before, `rewrite cache hit for "${source}"`);
		return { ...hit, errors: [] };
	}

	const remote = getRemoteRewriteCache();
	if (remote) {
		const entry = await remote
			.get(key, url && js.byteLength >= MIN_SPECULATED_BYTES ? url : undefined)
			.catch(() => undefined);
		if (entry) {
			storeEntry(key, entry);
			if (flagEnabled("rewriterLogs", context, base))
				dbg.time(meta, before, `remote rewrite cache hit for "${source}"`);
			return { ...materialize(entry, prefix), errors: [] };
		}
	}

	const res = rewriteJsInner(js, url, context, meta, isModule);

	// the output goes to the caller, which may transfer it: the cache stores its own copy,
	// made before returning. rewrites with parse errors are not cached
	if (res.errors.length === 0) {
		storeRewrite(
			key,
			{
				js: (res.js as Uint8Array).slice(),
				map: res.map ? res.map.slice() : null,
				tag: res.tag,
			},
			js,
			prefix
		);
		// the remote cache computes its own copy, for the next browser
		remote?.put(key, header, js);
	}
	return res;
}

/**
 * rewriteJs for an inline script on the rewriter threads, for the streaming HTML rewriter: the
 * thread rewriting the document then keeps answering the page's other requests meanwhile (an
 * inline script of tens of KB takes it several ms, and some pages have a few). Same result as
 * rewriteJs. Null when there is no offload, or the script is too small to be worth sending.
 */
export function rewriteJsOffloaded(
	js: string,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): Promise<string> | null {
	// a UTF-16 length at least this long is at least this many UTF-8 bytes
	if (!jsRewriteOffload || js.length < MIN_OFFLOAD_BYTES) return null;
	let job: Promise<RewriterResult>;
	try {
		job = jsRewriteOffload(
			TextEncoder_encode(js),
			url,
			context,
			meta,
			isModule,
			false
		);
	} catch {
		return null;
	}
	const text = (out: string | Uint8Array) =>
		typeof out === "string" ? out : TextDecoder_decode(out);
	// a rejection is the rewriter's own failure: handled as rewriteJs handles it
	return job.then(
		(res) => {
			try {
				return text(res.finished ? res.js : finishRewrite(res, context, meta));
			} catch (err) {
				return text(failRewrite(err, js, url, context, meta));
			}
		},
		(err) => text(failRewrite(err, js, url, context, meta))
	);
}

// rewriteJs for script bodies, with the rewriter output cached (see jscache.ts). the result
// is the same as rewriteJs's. a hit skips the rewriter, which costs 40-80ms per MB
export async function rewriteJsCached(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
): Promise<string | Uint8Array> {
	if (typeof js === "string") return rewriteJs(js, url, context, meta, isModule);
	const useCache =
		js.byteLength >= MIN_CACHED_BYTES &&
		flagEnabled("rewriteCache", context, meta.base);
	const offload =
		jsRewriteOffload && js.byteLength >= MIN_OFFLOAD_BYTES
			? jsRewriteOffload
			: null;
	if (!useCache && !offload)
		return rewriteJs(js, url, context, meta, isModule);

	let res: RewriterResult;
	try {
		res = offload
			? await offload(js, url, context, meta, isModule, useCache)
			: await rewriteJsWithCache(js, url, context, meta, isModule);
	} catch (err: any) {
		// a script the offload took is in the rejection, unless the thread died with it
		const input: Uint8Array = err?.input ?? js;
		if (!input.byteLength && js.byteLength) throw err;
		return failRewrite(err, input, url, context, meta);
	}

	try {
		return res.finished ? res.js : finishRewrite(res, context, meta);
	} catch (err) {
		return failRewrite(err, js, url, context, meta);
	}
}
