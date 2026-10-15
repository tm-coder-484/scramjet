export const CONTROLLERFRAME = Symbol.for("controller frame handle");

// default Config.prefix. the service worker also needs it to recognize proxied
// urls after a restart, before any controller has re-registered
export const DEFAULT_PREFIX = "/~/sj/";

// the host page publishes the compiled rewriter on its window under these keys, so documents
// can adopt it without the payload. see Controller.loadScramjetWasm and inject.ts findHostWasm
export const WASM_MODULE = Symbol.for("scramjet wasm module");
export const WASM_DIGEST = Symbol.for("scramjet wasm digest");
// and a table every document's client fills and reads (core's sharePlainNatives)
export const PLAIN_NATIVES = Symbol.for("scramjet plain natives");
