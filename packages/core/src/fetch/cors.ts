import { ScramjetHeaders } from "@/shared";
import {
	Error,
	Math_min,
	Number_parseInt,
	Performance_now,
	_Map,
} from "@/shared/snapshot";
import type {
	ScramjetFetchHandler,
	ScramjetFetchParsed,
	ScramjetFetchRequest,
} from ".";
import { computeFetchMode } from "./headers";

// CORS preflights (Fetch's "CORS-preflight fetch"). A page's cross-origin fetch or XHR in cors
// mode whose method or headers a plain HTML form couldn't send is asked about first, with an
// OPTIONS request, and only goes if the server's answer allows it. The browser can't do that for
// the page here (to the browser, every request the page makes is to the proxy's own origin), so
// scramjet does: servers see the requests a browser would make, at the same pace (sites' bot
// checks can tell), and a request the server doesn't allow fails as it would in a browser.

// request headers a page can't set, or that the browser sets itself and a service worker may see:
// never a reason to ask (Fetch's forbidden request-header names, and user-agent, which Chromium
// doesn't let a page set either)
const FORBIDDEN = [
	"accept-charset",
	"accept-encoding",
	"access-control-request-headers",
	"access-control-request-method",
	"connection",
	"content-length",
	"cookie",
	"cookie2",
	"date",
	"dnt",
	"expect",
	"host",
	"keep-alive",
	"origin",
	"referer",
	"set-cookie",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"via",
	"user-agent",
];
const SAFELISTED_METHODS = ["GET", "HEAD", "POST"];
const SAFELISTED_CONTENT_TYPES = [
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"text/plain",
];
// whether a header value has a CORS-unsafe request-header byte: a control character other than
// tab, DEL, or one of "():<>?@[\]{}
function hasUnsafeByte(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (
			(c < 0x20 && c !== 0x09) ||
			c === 0x7f ||
			"\"():<>?@[\\]{}".includes(value[i])
		)
			return true;
	}
	return false;
}
const LANGUAGE = /^[0-9A-Za-z *,\-.;=]*$/;
const SIMPLE_RANGE = /^bytes=(\d+-\d*|\d*-\d+)$/;
// Chromium's cap on Access-Control-Max-Age, in seconds; 5 when there's none
const MAX_AGE_CAP = 7200;
const DEFAULT_MAX_AGE = 5;
const CACHE_LIMIT = 256;

// whether a request header is CORS-safelisted (Fetch's "CORS-safelisted request-header")
function safelisted(name: string, value: string): boolean {
	if (value.length > 128) return false;
	switch (name) {
		case "accept":
			return !hasUnsafeByte(value);
		case "accept-language":
		case "content-language":
			return LANGUAGE.test(value);
		case "content-type": {
			if (hasUnsafeByte(value)) return false;
			const essence = value.split(";")[0].trim().toLowerCase();
			return SAFELISTED_CONTENT_TYPES.includes(essence);
		}
		case "range":
			return SIMPLE_RANGE.test(value);
		default:
			return false;
	}
}

// the names of the page's own headers that need the server's permission, sorted and lowercase
// (Fetch's "CORS-unsafe request-header names")
function unsafeHeaderNames(headers: ScramjetHeaders): string[] {
	const unsafe: string[] = [];
	const potentiallyUnsafe: string[] = [];
	let safelistSize = 0;
	for (const [name, value] of headers.toRawHeaders()) {
		const lower = name.toLowerCase();
		if (
			FORBIDDEN.includes(lower) ||
			lower.startsWith("sec-") ||
			lower.startsWith("proxy-")
		)
			continue;
		if (safelisted(lower, value)) {
			potentiallyUnsafe.push(lower);
			safelistSize += value.length;
		} else unsafe.push(lower);
	}
	if (safelistSize > 1024) unsafe.push(...potentiallyUnsafe);

	return unsafe.filter((name, i) => unsafe.indexOf(name) === i).sort();
}

type PreflightEntry = {
	expires: number;
	// null: any method (a `*` the request's credentials mode allows)
	methods: string[] | null;
	headers: string[];
	anyHeader: boolean;
};
// by credentials mode, origin and url, as a browser keys its preflight cache
const preflightCache = new _Map<string, PreflightEntry>();

function allows(
	entry: PreflightEntry,
	method: string,
	names: string[]
): boolean {
	if (
		!SAFELISTED_METHODS.includes(method) &&
		entry.methods !== null &&
		!entry.methods.includes(method)
	)
		return false;
	for (const name of names) {
		if (entry.headers.includes(name)) continue;
		// Fetch says a `*` doesn't cover Authorization, but Chromium lets it (it only warns), and
		// sites rely on that: an API answering `*` to a request with a bearer token
		if (entry.anyHeader) continue;
		return false;
	}
	return true;
}

// the values of a comma-separated response header list, trimmed, without empty ones
function headerList(value: string | null): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v);
}

/**
 * Sends the CORS preflight the browser would send before `request`, if it needs one, and throws an
 * error named "NetworkError" (a network error, to the page) if the server doesn't allow the
 * request. `headers`: the request's headers as they go to the server (Origin, Referer and the rest
 * set).
 */
export async function corsPreflight(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	headers: ScramjetHeaders
): Promise<void> {
	// only the requests a page makes with fetch(), XHR and the like: an element's never needs one
	if (parsed.destination !== "") return;
	// nor an EventSource's: its Cache-Control and Last-Event-ID are the browser's, and Chromium
	// never preflights one
	if (parsed.isEventSource) return;
	if (computeFetchMode(request, parsed) !== "cors") return;
	const origin = headers.get("origin");
	if (!origin || origin === parsed.url.origin) return;

	const method = request.method;
	const names = unsafeHeaderNames(request.initialHeaders);
	if (SAFELISTED_METHODS.includes(method) && !names.length) return;

	const include = !!parsed.fetchCredentialsInclude;
	const url = parsed.url.href.split("#")[0];
	const key = `${include ? "include" : "omit"} ${origin} ${url}`;
	const cached = preflightCache.get(key);
	if (cached) {
		if (cached.expires > Performance_now() && allows(cached, method, names))
			return;
		preflightCache.delete(key);
	}

	// as Chromium sends it: no cookies, and the browser's own headers, as the request has them
	const preflight = new ScramjetHeaders();
	preflight.set("Accept", "*/*");
	preflight.set("Access-Control-Request-Method", method);
	if (names.length)
		preflight.set("Access-Control-Request-Headers", names.join(","));
	preflight.set("Origin", origin);
	for (const name of [
		"referer",
		"user-agent",
		"accept-language",
		"sec-ch-ua",
		"sec-ch-ua-mobile",
		"sec-ch-ua-platform",
		"sec-fetch-site",
	]) {
		const value = headers.get(name);
		if (value !== null) preflight.set(name, value);
	}
	if (headers.has("sec-fetch-site")) {
		preflight.set("Sec-Fetch-Mode", "cors");
		preflight.set("Sec-Fetch-Dest", "empty");
	}

	const fail = (why: string): never => {
		const error = new Error(
			`Access to ${url} from origin ${origin} has been blocked by CORS policy: ${why}`
		);
		// the page gets a network error, as from the browser (see the controller's TransferResponse)
		error.name = "NetworkError";
		throw error;
	};
	let response: Awaited<ReturnType<typeof handler.client.fetch>>;
	try {
		response = await handler.client.fetch(parsed.url, {
			method: "OPTIONS",
			headers: preflight.toRawHeaders(),
			redirect: "manual",
		});
	} catch (e) {
		fail(`the preflight request failed (${e})`);
	}
	response.body?.cancel().catch(() => {});

	if (response.status < 200 || response.status > 299)
		fail(`the preflight response's status is ${response.status}`);
	const raw = response.rawHeaders;
	const values = (name: string) =>
		raw.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);
	const allowOrigin = values("access-control-allow-origin");
	if (allowOrigin.length !== 1)
		fail("the preflight response has no single Access-Control-Allow-Origin");
	if (!(allowOrigin[0] === origin || (allowOrigin[0] === "*" && !include)))
		fail(`Access-Control-Allow-Origin is ${allowOrigin[0]}`);
	if (
		include &&
		values("access-control-allow-credentials").join(",") !== "true"
	)
		fail("Access-Control-Allow-Credentials isn't true for a credentialed request");

	const allowMethods = headerList(
		values("access-control-allow-methods").join(",")
	);
	const allowHeaders = headerList(
		values("access-control-allow-headers").join(",")
	).map((h) => h.toLowerCase());
	const entry: PreflightEntry = {
		expires: 0,
		methods: allowMethods.includes("*") && !include ? null : allowMethods,
		headers: allowHeaders,
		anyHeader: allowHeaders.includes("*") && !include,
	};
	if (!allows(entry, method, names))
		fail(
			!SAFELISTED_METHODS.includes(method) &&
				entry.methods !== null &&
				!entry.methods.includes(method)
				? `method ${method} isn't in Access-Control-Allow-Methods`
				: `a request header isn't in Access-Control-Allow-Headers (${names.join(", ")})`
		);

	const maxAge = Number_parseInt(
		values("access-control-max-age")[0] ?? "",
		10
	);
	const seconds = Math_min(
		maxAge >= 0 ? maxAge : DEFAULT_MAX_AGE,
		MAX_AGE_CAP
	);
	if (seconds > 0) {
		entry.expires = Performance_now() + seconds * 1000;
		if (preflightCache.size >= CACHE_LIMIT)
			preflightCache.delete(preflightCache.keys().next().value!);
		preflightCache.set(key, entry);
	}
}
