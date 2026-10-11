import { flagEnabled, ScramjetContext } from "@/shared";
import { URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import { bytesToBase64 } from "@/shared/util";
import { getRewrite, openDb, rewriteKey, storeRewrite } from "./jscache";
import {
	JSON_stringify,
	SyntaxError,
	TextDecoder_decode,
	TextEncoder_encode,
	_RegExp,
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
};

function rewriterFlags(context: ScramjetContext, base: URLMeta["base"]) {
	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, base);
	}
	return flagsobj;
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
				isModule
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
				isModule
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

// the sourcemap call and the logs for a rewriter result. throws if that fails
function finishRewrite(
	res: RewriterResult,
	context: ScramjetContext,
	meta: URLMeta
): string | Uint8Array {
	let newjs = res.js;

	if (flagEnabled("sourcemaps", context, meta.base)) {
		const pushmap = globalThis[context.config.globals.pushsourcemapfn];
		if (pushmap) {
			pushmap(res.map, res.tag);
		} else {
			// TODO: how do we check instanceof here?
			let text: string =
				typeof newjs === "string" ? newjs : TextDecoder_decode(newjs);
			// base64 is a string literal, which parses far faster than a decimal array of the same bytes
			const sourcemapfn = `${context.config.globals.pushsourcemapfn}("${bytesToBase64(res.map)}", "${res.tag}");`;

			// don't put the sourcemap call before "use strict"
			const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
			if (strictMode.test(text)) {
				text = text.replace(strictMode, `$&\n${sourcemapfn}`);
			} else {
				text = `${sourcemapfn}\n${text}`;
			}
			newjs = text;
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
 * Same inputs and result as rewriteJsWithCache (or rewriteJsInner, without the cache).
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
// scripts under this size are rewritten where they are, even with an offload: a pool thread can be
// busy with a big bundle for 100ms
const MIN_OFFLOAD_BYTES = 16 * 1024;

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

	// everything the rewriter output depends on, except the prefix bytes and the script
	const header = JSON_stringify({
		globals: context.config.globals,
		flags: rewriterFlags(context, base),
		prefixLength: prefix.length,
		base: base.href,
		source,
		isModule,
		// the cache is partitioned per requesting site
		origin: meta.origin.origin,
		codec: `${context.interface.codecEncode}`,
	});

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
	}
	return res;
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
	} catch (err) {
		return failRewrite(err, js, url, context, meta);
	}

	try {
		return finishRewrite(res, context, meta);
	} catch (err) {
		return failRewrite(err, js, url, context, meta);
	}
}
