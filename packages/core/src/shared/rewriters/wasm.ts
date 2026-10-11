// i am a cat. i like to be petted. i like to be fed. i like to be
import { initSync, Rewriter } from "../../../rewriter/wasm/out/wasm.js";
import type { JsRewriterOutput } from "../../../rewriter/wasm/out/wasm.js";
import { flagEnabled, ScramjetContext } from "@/shared";

export type { JsRewriterOutput, Rewriter };

import { URLMeta } from "@rewriters/url";
import {
	Error,
	Object_getPrototypeOf,
	Object_setPrototypeOf,
	TextDecoder_decode,
} from "@/shared/snapshot";

let wasm_u8: Uint8Array | undefined;
// a compiled Module, when one was handed over (the host page compiles it once for all documents)
let wasm_module: WebAssembly.Module | undefined;
// the sha256 hex of the bytes, when it was handed over with them
let wasm_digest: string | undefined;

function isModule(x: unknown): x is WebAssembly.Module {
	// instanceof is no good here: a Module from another same-origin realm fails it
	// eslint-disable-next-line scramjet-core/no-globals -- cross-realm brand check
	return Object.prototype.toString.call(x) === "[object WebAssembly.Module]";
}

/**
 * Hands over the rewriter, as bytes or as an already compiled Module. `digest` is the sha256
 * hex of the bytes, for the rewrite cache (see getKnownWasmDigest).
 */
export function setWasm(
	src: Uint8Array | ArrayBuffer | WebAssembly.Module,
	digest?: string
) {
	if (isModule(src)) {
		wasm_module = src;
	} else {
		const u8 = src as Uint8Array | ArrayBuffer;
		wasm_u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
		wasm_module = undefined;
		wasm_digest = undefined;
	}
	if (digest !== undefined) wasm_digest = digest;
}

// the rewriter binary, for building the payload for workers and fallback documents
export function getWasmBytes(): Uint8Array {
	if (!wasm_u8)
		throw new Error("rewriter wasm not found (was setWasm called?)");
	return wasm_u8;
}

// the sha256 hex of the rewriter binary, if setWasm was given it; otherwise the caller hashes the bytes
export function getKnownWasmDigest(): string | undefined {
	return wasm_digest;
}

const MAGIC = "\0asm".split("").map((x) => x.charCodeAt(0));

let wasmInitialized = false;
function initWasm() {
	// initSync is a no-op after the first call, but new WebAssembly.Module() ran on every
	// getRewriter() call before it; skip all of it once the module is up
	if (wasmInitialized) return;

	if (wasm_module) {
		initSyncWithModule(wasm_module);
	} else {
		if (!(wasm_u8 instanceof Uint8Array))
			throw new Error("rewriter wasm not found (was setWasm called?)");

		if (![...wasm_u8.slice(0, 4)].every((x, i) => x === MAGIC[i]))
			throw new Error(
				"rewriter wasm does not have wasm magic (was it fetched correctly?)\nrewriter wasm contents: " +
					TextDecoder_decode(wasm_u8)
			);

		initSync({
			module: new WebAssembly.Module(wasm_u8 as unknown as BufferSource),
		});
	}
	wasmInitialized = true;
}

// glue's initSync checks `module instanceof WebAssembly.Module` for this realm. a Module from
// another same-origin realm instantiates fine but fails that check, so lend it this realm's
// prototype for the call and put its own back. the brand check is internal, so this is no copy
function initSyncWithModule(module: WebAssembly.Module) {
	// eslint-disable-next-line scramjet-core/no-globals -- this realm's Module constructor, for the glue's check
	const local = WebAssembly.Module.prototype;
	const own = Object_getPrototypeOf(module);
	if (own === local) {
		initSync({ module });
		return;
	}
	Object_setPrototypeOf(module, local);
	try {
		initSync({ module });
	} finally {
		Object_setPrototypeOf(module, own);
	}
}

type RewriterBox = { rewriter: Rewriter; inUse: boolean };
const rewriters: RewriterBox[] = [];
export function getRewriter(
	context: ScramjetContext,
	meta: URLMeta
): [Rewriter, () => void] {
	initWasm();

	let obj: RewriterBox;
	const index = rewriters.findIndex((x) => !x.inUse);
	const len = rewriters.length;

	if (index === -1) {
		if (flagEnabled("rewriterLogs", context, meta.base))
			dbg.log(`creating new rewriter, ${len} rewriters made already`);

		const rewriter = new Rewriter();
		obj = { rewriter, inUse: false };
		rewriters.push(obj);
	} else {
		obj = rewriters[index];
	}
	obj.inUse = true;

	return [obj.rewriter, () => (obj.inUse = false)];
}
