import {
	BareRequestInit,
	BareResponse,
	RawHeaders,
} from "@mercuryworkshop/proxy-transports";
import {
	BodyType,
	ScramjetFetchHandler,
	ScramjetFetchParsed,
	ScramjetFetchRequest,
	ScramjetFetchResponse,
} from ".";
import { rewriteUrl, unrewriteBlob, unrewriteUrl } from "@rewriters/url";
import { QP, parseRequest } from "./parse";
import { ScramjetHeaders, flagEnabled } from "@/shared";
import { NATIVE_BODY, REWRITE_HEADER, rewriteCacheHeader } from "@rewriters/js";
import { isDocument, isRedirect, normalizeContentType } from "./util";
import { rewriteBody } from "./body";
import { corsPreflight } from "./cors";
import { Tap } from "@/Tap";
import {
	computeFetchSite,
	rewriteContentDisposition,
	rewriteRequestHeaders,
	rewriteResponseHeaders,
	worstFetchSite,
} from "./headers";
import { Array_isArray, _URL } from "@/shared/snapshot";

export async function doHandleFetch(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest
): Promise<ScramjetFetchResponse> {
	const parsed = parseRequest(request, handler);

	if (isBlobOrDataUrl(parsed.url)) {
		return handleBlobOrDataUrlFetch(handler, request, parsed);
	}

	const interceptCtx: typeof handler.hooks.fetch.intercept.context = {
		request,
		parsed,
	};
	const interceptProps: typeof handler.hooks.fetch.intercept.props = {};
	await Tap.dispatch(
		handler.hooks.fetch.intercept,
		interceptCtx,
		interceptProps
	);
	if (interceptProps.response) {
		return interceptProps.response;
	}

	if (parsed.hadExtraParams && isDocument(parsed)) {
		const location = rewriteUrl(parsed.url, handler.context, parsed.meta);
		if (location !== request.rawUrl.href) {
			const responseHeaders = new ScramjetHeaders();
			responseHeaders.set("location", location);
			return {
				body: "",
				headers: responseHeaders,
				status: 307,
				statusText: "Temporary Redirect",
			};
		}
	}

	const newheaders = rewriteRequestHeaders(request, handler, parsed);
	if (flagEnabled("corsPreflight", handler.context, parsed.meta.base))
		await corsPreflight(handler, request, parsed, newheaders);

	let responseBody: BodyType;
	const response = await doNetworkFetch(handler, request, parsed, newheaders);

	// set-cookie needs to take the raw headers. after this, we can flatten the headers into a ScramjetHeaders object
	const cookieSync = handleCookies(
		handler,
		request,
		parsed,
		response.rawHeaders
	);
	// the cookies reach the page's clients while the body is on its way, for a response the page
	// can only use once all of it is in (see ScramjetFetchResponse.cookieSync). The rest wait here:
	// a fetch() can read document.cookie as soon as it has the headers. By the browser's own
	// destination: the one in the url (QP.destination) is the page's to set
	const deferCookies =
		cookieSync !== undefined &&
		WHOLE_BODY_DESTINATIONS.has(request.rawDestination) &&
		WHOLE_BODY_DESTINATIONS.has(parsed.destination) &&
		!isRedirect(response);
	if (cookieSync && !deferCookies) await cookieSync;
	// whoever gets the response waits for it too, and ends its body either way
	else
		cookieSync?.catch((err) =>
			console.error(
				"scramjet: couldn't send a response's cookies to the page",
				err
			)
		);

	if (isDocument(parsed)) {
		// for document.referer
		parsed.trackedClient?.history.push({
			url: parsed.url.href,
			referrer: newheaders.get("Referer") ?? "",
			refererPolicy: ScramjetHeaders.fromRawHeaders(response.rawHeaders).get(
				"referrer-policy"
			),
		});
	}

	const responseHeaders = await rewriteResponseHeaders(
		handler,
		request,
		parsed,
		response.rawHeaders
	);

	if (isRedirect(response)) {
		const location = new _URL(responseHeaders.get("location"));
		const referer = newheaders.get("Referer");

		// Compute the page (initiator) URL once. The initiator never changes
		// through a redirect chain, so prefer the propagated `sj$io` value if
		// the chain has already started; otherwise fall back to rawClientUrl
		// or rawReferrer (which point at the page for the *first* hop).
		let initiatorOriginUrl: URL | undefined;
		if (parsed.fetchInitiatorOrigin) {
			try {
				initiatorOriginUrl = new URL(parsed.fetchInitiatorOrigin);
			} catch {
				initiatorOriginUrl = undefined;
			}
		}
		if (!initiatorOriginUrl) {
			const rawClient =
				request.rawClientUrl ||
				(request.rawReferrer ? new URL(request.rawReferrer) : undefined);
			initiatorOriginUrl =
				rawClient &&
				rawClient.pathname.startsWith(handler.context.prefix.pathname)
					? new URL(unrewriteUrl(rawClient, handler.context))
					: undefined;
		}

		// Cross-site redirect poisoning (SameSite): if this hop was cross-site, or a
		// previous hop already was, propagate the flag so the final destination
		// enforces cross-site SameSite restrictions.
		const crossSiteRedirect =
			parsed.crossSiteRedirect ||
			(!!initiatorOriginUrl &&
				registrableDomainForRedirect(initiatorOriginUrl.hostname) !==
					registrableDomainForRedirect(parsed.url.hostname));

		// Sec-Fetch-Site chain state: combine the worst classification seen so
		// far with the relation between the initiator and *this* hop's URL.
		// Once "cross-site" appears, it sticks for the rest of the chain.
		let propagatedFetchSite: "same-site" | "cross-site" | undefined;
		if (initiatorOriginUrl) {
			const hopSite = computeFetchSite(initiatorOriginUrl, parsed.url);
			const propagated = parsed.fetchSiteState
				? worstFetchSite(parsed.fetchSiteState, hopSite)
				: hopSite;
			if (propagated !== "same-origin" && propagated !== "none") {
				propagatedFetchSite = propagated;
			}
		}

		location.searchParams.set(QP.referrerSource, referer ?? "");
		if (crossSiteRedirect) location.searchParams.set(QP.crossSiteRedirect, "1");
		if (propagatedFetchSite)
			location.searchParams.set(QP.fetchSite, propagatedFetchSite);
		if (initiatorOriginUrl)
			location.searchParams.set(QP.initiatorOrigin, initiatorOriginUrl.origin);
		if (parsed.isModule) location.searchParams.set(QP.isModule, "module");
		if (parsed.downloadName !== undefined)
			location.searchParams.set(QP.download, parsed.downloadName);

		responseHeaders.set("location", location.href);
	}

	let status = response.status;
	if (!isRedirect(response)) {
		status = rewriteContentDisposition(parsed, responseHeaders, status);
		if (status === 204 && response.body) response.body.cancel().catch(() => {});
	}

	if (response.body && !isRedirect(response) && status !== 204) {
		responseBody = await rewriteBody(handler, request, parsed, response);

		// After rewriting HTML, the body is a JS string which will be encoded as
		// UTF-8 by the Response constructor. Normalize the Content-Type charset so
		// the browser doesn't try to decode UTF-8 bytes with the original encoding.
		normalizeContentType(parsed, responseHeaders);
	}

	const respcontext: typeof handler.hooks.fetch.response.context = {
		request,
		parsed,
	};
	const respprops: typeof handler.hooks.fetch.response.props = {
		response: {
			body: responseBody,
			headers: responseHeaders,
			status,
			statusText: status === response.status ? response.statusText : "",
		},
	};

	await Tap.dispatch(handler.hooks.fetch.response, respcontext, respprops);

	// the body passes through as the transport gave it
	const native = (response.rawHeaders as any)?.[NATIVE_BODY];
	if (
		typeof native === "function" &&
		respprops.response.body != null &&
		respprops.response.body === response.body
	)
		respprops.response.nativeBody = native;

	if (deferCookies) {
		// no body to hold back
		if (respprops.response.body == null) await cookieSync;
		else respprops.response.cookieSync = cookieSync;
	}
	return respprops.response;
}

// destinations whose response the page can only use once its last byte is in: a script runs, a
// stylesheet applies, an image or font loads, a worker starts only then (an image may show, and
// report its size, while it loads; its load event waits). Not "" (fetch, XHR, beacons), media, or
// navigations
const WHOLE_BODY_DESTINATIONS = new Set<string>([
	"script",
	"style",
	"image",
	"font",
	"worker",
	"sharedworker",
	"manifest",
	"track",
	"xslt",
	"audioworklet",
	"paintworklet",
	"json",
]);

export async function doNetworkFetch(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	newheaders: ScramjetHeaders
): Promise<BareResponse> {
	const init = {
		body: request.body,
		headers: newheaders.toRawHeaders(),
		method: request.method,
		redirect: "manual",
	} as BareRequestInit;

	const reqcontext: typeof handler.hooks.fetch.request.context = {
		client: handler.client,
		request,
		parsed,
	};
	const reqprops: typeof handler.hooks.fetch.request.props = {
		init,
		url: parsed.url,
	};
	await Tap.dispatch(handler.hooks.fetch.request, reqcontext, reqprops);
	let earlyResponse: BareResponse;

	if (reqprops.earlyResponse) {
		const resp = reqprops.earlyResponse;
		if ("rawHeaders" in resp) {
			// it's a bare response
			earlyResponse = resp;
		} else {
			// it's a native response, convert it
			earlyResponse = BareResponse.fromNativeResponse(resp);
		}
	} else {
		// a script's rewrite-cache header, for a transport whose server can rewrite it (see
		// REWRITE_HEADER); rewriteBody rewrites it under the same header
		const headers = reqprops.init.headers;
		if (
			parsed.destination === "script" &&
			request.method === "GET" &&
			Array_isArray(headers) &&
			flagEnabled("rewriteCache", handler.context, parsed.meta.base)
		)
			(headers as any)[REWRITE_HEADER] = rewriteCacheHeader(
				new _URL(reqprops.url).href,
				handler.context,
				parsed.meta,
				parsed.isModule
			);
		earlyResponse = await handler.client.fetch(reqprops.url, reqprops.init);
	}

	const prerespcontext: typeof handler.hooks.fetch.preresponse.context = {
		request,
		parsed,
	};

	const prerespprops: typeof handler.hooks.fetch.preresponse.props = {
		response: earlyResponse,
	};

	await Tap.dispatch(
		handler.hooks.fetch.preresponse,
		prerespcontext,
		prerespprops
	);

	return prerespprops.response;
}

function isBlobOrDataUrl(url: _URL): boolean {
	return url.protocol === "blob:" || url.protocol === "data:";
}

async function handleBlobOrDataUrlFetch(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed
): Promise<ScramjetFetchResponse> {
	let dataUrl = request.rawUrl.pathname.substring(
		handler.context.prefix.pathname.length
	);
	let response: BareResponse;

	if (dataUrl.startsWith("blob:")) {
		dataUrl = unrewriteBlob(dataUrl, handler.context, parsed.meta);
		response = BareResponse.fromNativeResponse(
			await handler.fetchBlobUrl(dataUrl)
		);
	} else {
		response = BareResponse.fromNativeResponse(
			await handler.fetchDataUrl(dataUrl)
		);
	}

	const headers = ScramjetHeaders.fromRawHeaders(response.rawHeaders);
	const status = rewriteContentDisposition(parsed, headers, response.status);

	let body: BodyType;
	if (response.body && status !== 204) {
		body = await rewriteBody(
			handler,
			request,
			parsed,
			response as BareResponse
		);
	}
	// blob urls actually *can* set charsets, so we need to normalize them if it goes down the html path
	normalizeContentType(parsed, headers);

	if (handler.crossOriginIsolated) {
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
		headers.set("Cross-Origin-Embedder-Policy", "require-corp");
	}

	if (parsed.isFakeDataURL) URL.revokeObjectURL(dataUrl);

	return {
		body,
		status,
		statusText: status === response.status ? response.statusText : "",
		headers: headers,
	};
}

/** Simplified registrable-domain check used for cross-site redirect detection. */
export function registrableDomainForRedirect(hostname: string): string {
	if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;
	const labels = hostname.split(".");
	if (labels.length <= 1) return hostname;
	if (labels[0] === "www") return labels.slice(1).join(".");
	if (labels.length === 2) return hostname;
	return labels.slice(-2).join(".");
}

// the last cookie sync that changed what a page can see, until the page's clients have it
let visibleSync: Promise<void> | undefined;

// stores the response's cookies in the jar, then sends them to the page's clients. Returns what the
// response must wait for before the page may see it: the sync, if it changed what a page can see
// through document.cookie. Many sites set the same cookie again on every response (Cloudflare's
// on ~90 of its front page's), and each sync waits for a page's main thread. A response that only
// sets cookies again waits for nothing, or for the sync that set those values if the page doesn't
// have it yet. undefined when there's nothing to wait for
function handleCookies(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	rawHeaders: RawHeaders
): Promise<void> | undefined {
	const cookies = [];
	let visible = false;
	// the document that could see the cookies first: the one this response is, or the one that asked
	// for it. Another site's cookies, or HttpOnly ones, it can't see
	const observer = isDocument(parsed) ? parsed.url : parsed.clientUrl;

	for (const [key, value] of rawHeaders) {
		if (key.toLowerCase() !== "set-cookie") continue;

		if (handler.context.cookieJar.setCookies(value, parsed.url, observer))
			visible = true;
		cookies.push({
			url: parsed.url,
			cookie: value,
		});
	}

	if (cookies.length === 0) {
		return;
	}

	const sync = handler.sendSetCookie(cookies, {
		destination: parsed.destination,
	});
	if (!visible) {
		// still sent, for the new expiry, but nothing waits on it
		sync.catch((err) =>
			console.error(
				"scramjet: couldn't send a response's cookies to the page",
				err
			)
		);
		return visibleSync;
	}
	visibleSync = sync;
	const done = () => {
		if (visibleSync === sync) visibleSync = undefined;
	};
	sync.then(done, done);
	return sync;
}
