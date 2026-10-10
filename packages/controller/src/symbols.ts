export const CONTROLLERFRAME = Symbol.for("controller frame handle");

// default Config.prefix. the service worker also needs it to recognize proxied
// urls after a restart, before any controller has re-registered
export const DEFAULT_PREFIX = "/~/sj/";
