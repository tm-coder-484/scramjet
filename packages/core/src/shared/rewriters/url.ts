import { ScramjetContext } from "@/shared";
import { rewriteJs } from "@rewriters/js";
import { QP } from "@/fetch/parse";

import {
	TextEncoder_encode,
	_Map,
	_URL,
	_URLSearchParams,
	atob,
	String,
	String_startsWith,
	URL_createObjectURL,
} from "../snapshot";

// user: manually triggered navigation
// link: link clicked by the user. still user initiated, but doesn't wipe
// location: location = ...
export type NavigationType = "user" | "link" | "location";

export type RewriteUrlOptions = {
	referrerPolicy?: string;
	isModule?: boolean;
	navigateType?: NavigationType;
	topFrame?: string;
	parentFrame?: string;
	isIframe?: string;
	mode?: string;
	credentials?: string;
	destination?: RequestDestination;
	// the download attribute of the <a> this url is for
	download?: string;
};

export type URLMeta = {
	origin: _URL;
	base: _URL;
	topFrameName?: string;
	parentFrameName?: string;
	referrerPolicy?: string;
};

// blob: and data: urls carry the module flag and the <a download> marker in
// their query string, since the service worker only sees the url it is given
// browsers fetch <a download> links without going through the service worker,
// so they are rewritten into navigations tagged with the download marker instead
function markerQuery(options?: RewriteUrlOptions, ...extra: string[]) {
	const params = [...extra];
	if (options?.isModule) params.push(QP.isModule + "=module");
	if (options?.download !== undefined)
		params.push(QP.download + "=" + encodeURIComponent(options.download));
	return params.length ? "?" + params.join("&") : "";
}

function stripMarkerQuery(url: string) {
	let end = url.length;
	for (const key of [QP.isModule, QP.download]) {
		const idx = Math.max(
			url.lastIndexOf("?" + key + "="),
			url.lastIndexOf("&" + key + "=")
		);
		if (idx !== -1 && idx < end) end = idx;
	}
	return url.slice(0, end);
}

function tryCanParseURL(url: string, origin?: string | URL): _URL | null {
	try {
		return new _URL(url, origin);
	} catch {
		return null;
	}
}

export function rewriteBlob(
	url: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	const blob = new _URL(url.substring("blob:".length));

	return "blob:" + meta.origin.origin + blob.pathname;
}

export function unrewriteBlob(
	url: string,
	context: ScramjetContext,
	_meta: URLMeta
) {
	const blob = new _URL(url.substring("blob:".length));

	return "blob:" + context.prefix.origin + blob.pathname;
}

function dataToBlob(url: string) {
	const commaIndex = url.indexOf(",");
	if (commaIndex === -1) return null;

	const meta = url.slice("data:".length, commaIndex);
	const data = url.slice(commaIndex + 1);

	const metaParts = meta.split(";");
	const mediaType = metaParts.shift() || "";
	const isBase64 = metaParts.some((part) => part.toLowerCase() === "base64");
	const params = metaParts.filter(
		(part) => part && part.toLowerCase() !== "base64"
	);

	let type = mediaType || "text/plain";
	if (!mediaType) {
		const hasCharset = params.some((part) =>
			String_startsWith(part.toLowerCase(), "charset=")
		);
		if (!hasCharset) {
			params.push("charset=US-ASCII");
		}
	}
	if (params.length) type += ";" + params.join(";");

	let bytes: Uint8Array;
	if (isBase64) {
		let base64 = data.replace(/\s/g, "");
		base64 = base64.replace(/-/g, "+").replace(/_/g, "/");
		const binString = atob(base64);
		bytes = new Uint8Array(binString.length);
		for (let i = 0; i < binString.length; i++) {
			bytes[i] = binString.charCodeAt(i);
		}
	} else {
		let decoded = data;
		try {
			decoded = decodeURIComponent(data);
		} catch {
			// If decode fails, fall back to raw data.
		}
		bytes = TextEncoder_encode(decoded);
	}

	const blob = new Blob([bytes], { type });
	const objectUrl = URL_createObjectURL(blob);
	return { blob, objectUrl };
}

export function rewriteUrl(
	url: string | URL,
	context: ScramjetContext,
	meta: URLMeta,
	options?: RewriteUrlOptions
) {
	url = String(url);

	if (String_startsWith(url, "javascript:")) {
		return (
			"javascript:" +
			rewriteJs(
				url.slice("javascript:".length),
				"(javascript: url)",
				context,
				meta
			)
		);
	} else if (String_startsWith(url, "blob:")) {
		return context.prefix.href + url + markerQuery(options);
	} else if (String_startsWith(url, "data:")) {
		const URL_MAX_LENGTH = 1024 * 1024 * 2;
		const BUFFER = 1024;
		// chrome will explode if you make a request to a service worker with a 2MB+ URL
		// there's an okayish workaround which is just Pretending It's a Blob
		if (url.length + context.prefix.href.length + BUFFER > URL_MAX_LENGTH) {
			const { objectUrl } = dataToBlob(url);
			return (
				context.prefix.href +
				rewriteBlob(objectUrl, context, meta) +
				markerQuery(options, QP.fakeDataURL + "=1")
			);
		}

		return context.prefix.href + url + markerQuery(options);
	} else if (
		String_startsWith(url, "mailto:") ||
		String_startsWith(url, "about:")
	) {
		return url;
	} else {
		let base = meta.base.href;

		if (String_startsWith(base, "about:"))
			base = unrewriteUrl(self.location.href, context); // jank!!!!! weird jank!!!
		const realUrl = tryCanParseURL(url, base);
		if (!realUrl) return url;

		if (realUrl.protocol != "http:" && realUrl.protocol != "https:") {
			// custom protocol. best thing to do is pass it through so it can open an app etc
			// there's also extension:// pages we might need to worry about later
			return url;
		}

		// the fragment is cut from href: the first "#" in a serialized url starts it, since the
		// path and query percent-encode theirs. cheaper than the hash setter, which reparses
		let href = realUrl.href;
		let fragment = "";
		const hashIndex = href.indexOf("#");
		if (hashIndex !== -1) {
			fragment = href.slice(hashIndex + 1);
			href = href.slice(0, hashIndex);
		}
		const encodedHash = context.interface.codecEncode(fragment);
		const realHash = encodedHash ? "#" + encodedHash : "";

		return (
			context.prefix.href +
			context.interface.codecEncode(href) +
			rewriteQuery(context, meta, options) +
			realHash
		);
	}
}

// the application/x-www-form-urlencoded serializer URLSearchParams uses: encodeURIComponent, plus
// "!'()~" escaped and spaces as "+"
function formEncode(value: string): string {
	try {
		return encodeURIComponent(value).replace(/%20|[!'()~]/g, (c) =>
			c === "%20" ? "+" : "%" + c.charCodeAt(0).toString(16).toUpperCase()
		);
	} catch {
		// lone surrogates, which URLSearchParams replaces with U+FFFD
		const params = new _URLSearchParams();
		params.set("", value);
		return params.toString().slice(1);
	}
}

// the query rewriteUrl appends; without options it only depends on these, so the last one is
// kept (a document's urls are rewritten with the same meta, one after another)
let lastQueryKey: string | undefined;
let lastQuery = "";

function rewriteQuery(
	context: ScramjetContext,
	meta: URLMeta,
	options?: RewriteUrlOptions
): string {
	const referrerPolicy =
		!options?.isModule && (options?.referrerPolicy ?? meta.referrerPolicy);
	// specific tracking for sec-fetch-site
	// don't send for the top level controller calling it in go()
	const origin = meta.origin.origin;
	const initiatorOrigin = origin !== context.prefix.origin ? origin : "";

	const plain = !options;
	const key = plain ? (referrerPolicy || "") + "\n" + initiatorOrigin : undefined;
	if (plain && key === lastQueryKey) return lastQuery;

	// the same parameters, in the same order, as the URLSearchParams this replaced
	const params: string[] = [];
	const add = (name: string, value: string) =>
		params.push(formEncode(name) + "=" + formEncode(value));
	if (referrerPolicy) add(QP.referrerPolicy, referrerPolicy);
	if (options?.isModule) add(QP.isModule, "module");
	if (options?.topFrame) add(QP.topFrame, options.topFrame);
	if (options?.parentFrame) add(QP.parentFrame, options.parentFrame);
	if (options?.isIframe) add(QP.isIframe, options.isIframe);
	if (options?.mode) add(QP.mode, options.mode);
	if (options?.credentials) add(QP.credentials, options.credentials);
	if (options?.destination) add(QP.destination, options.destination);
	if (options?.download !== undefined) add(QP.download, options.download);
	if (initiatorOrigin) add(QP.initiatorOrigin, initiatorOrigin);

	const query = params.length ? "?" + params.join("&") : "";
	if (plain) {
		lastQueryKey = key;
		lastQuery = query;
	}
	return query;
}

// results of unrewriting http(s) urls, for repeated reads of the same links (a.href and friends). an
// entry depends only on the url, the proxy prefix and the codec, so the table is dropped when the
// prefix changes and when it fills up
const unrewriteMemo = new _Map<string, string>();
let unrewriteMemoPrefix: string | undefined;
const UNREWRITE_MEMO_LIMIT = 512;

export function unrewriteUrl(url: string | URL, context: ScramjetContext) {
	url = String(url);
	// an empty href (the common case for a.href on a bare anchor) matches no branch below and comes back as is
	if (url === "") return url;
	if (String_startsWith(url, "javascript:")) {
		//TODO
		return url;
	} else if (String_startsWith(url, "blob:")) {
		// realistically this shouldn't happen
		return url;
	} else if (String_startsWith(url, context.prefix.href + "blob:")) {
		return stripMarkerQuery(url.substring(context.prefix.href.length));
	} else if (String_startsWith(url, context.prefix.href + "data:")) {
		return stripMarkerQuery(url.substring(context.prefix.href.length));
	} else if (
		String_startsWith(url, "mailto:") ||
		String_startsWith(url, "about:")
	) {
		return url;
	} else if (
		String_startsWith(url, "http:") ||
		String_startsWith(url, "https:")
	) {
		if (unrewriteMemoPrefix !== context.prefix.href) {
			unrewriteMemo.clear();
			unrewriteMemoPrefix = context.prefix.href;
		}
		const memoized = unrewriteMemo.get(url);
		if (memoized !== undefined) return memoized;

		const realUrl = tryCanParseURL(url);
		if (!realUrl) return url;
		if (realUrl.protocol != "http:" && realUrl.protocol != "https:") {
			// custom protocol
			return url;
		}
		if (!String_startsWith(realUrl.href, context.prefix.href)) {
			dbg.error("unrewriteurl: unexpected url", url);
			return url;
		}
		const decodedHash = context.interface.codecDecode(realUrl.hash.slice(1));
		const realHash = decodedHash ? "#" + decodedHash : "";
		realUrl.hash = "";
		realUrl.search = "";

		const result =
			context.interface.codecDecode(
				realUrl.href.slice(context.prefix.href.length)
			) + realHash;
		if (unrewriteMemo.size >= UNREWRITE_MEMO_LIMIT) unrewriteMemo.clear();
		unrewriteMemo.set(url, result);
		return result;
	} else if (url == "") {
		return url;
	} else {
		dbg.error("unrewriteurl: unexpected url", url);
		return url;
	}
}
