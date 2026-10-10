import { rewriteCss } from "@rewriters/css";
import { rewriteHtml, rewriteSrcset } from "@rewriters/html";
import { rewriteUrl, unrewriteBlob, URLMeta } from "@rewriters/url";
import { ScramjetContext } from "@/shared";
import { _URL } from "./snapshot";

// browsers ignore the download attribute on cross-origin links (they're navigated instead)
function sameOriginDownload(
	value: string,
	meta: URLMeta,
	download: string | undefined
): string | undefined {
	if (download === undefined) return undefined;
	try {
		const url = new _URL(value, meta.base);
		if (url.protocol === "data:" || url.origin === meta.origin.origin)
			return download;
	} catch {
		// unparseable hrefs aren't followed at all
	}
	return undefined;
}

export const htmlRules: {
	[key: string]: "*" | string[] | ((...any: any[]) => string | null);
	fn: (
		value: string,
		context: ScramjetContext,
		meta: URLMeta,
		attrs?: Record<string, string | undefined>
	) => string | null;
}[] = [
	{
		fn: (value, context, meta) =>
			rewriteUrl(value, context, meta, { navigateType: "location" }),

		// url rewrites
		src: ["embed", "img", "frame", "input", "track"],
		href: ["image"],
		data: ["object"],
		action: ["form"],
		formaction: ["button", "input", "textarea", "submit"],
		poster: ["video"],
		"xlink:href": ["image"],
	},
	{
		fn: (value, context, meta, attrs) =>
			rewriteUrl(value, context, meta, {
				navigateType: "location",
				download: sameOriginDownload(value, meta, attrs?.download),
			}),

		href: ["a", "area"],
	},
	{
		// browsers fetch <a download> links without going through the service worker, which 404s.
		// the attribute is hidden from the real DOM and the href is marked for download instead (see above).
		// cross-origin links keep navigating like they would natively
		fn: () => null,

		download: ["a", "area"],
	},
	{
		fn: (value, context, meta, attrs) => {
			const isModule =
				attrs?.type?.toLowerCase() === "module" ||
				attrs?.rel?.toLowerCase() === "modulepreload";

			return rewriteUrl(value, context, meta, {
				isModule,
			});
		},

		src: ["script"],
		href: ["link"],
	},
	{
		fn: (value, context, meta) => {
			const url = rewriteUrl(value, context, meta, {
				topFrame: meta.topFrameName,
				parentFrame: meta.parentFrameName,
				isIframe: "1",
			});

			return url;
		},
		src: ["iframe"],
	},
	{
		// is this a good idea?
		fn: (_value, _context, _meta) => {
			return null;
		},
		sandbox: ["iframe"],
	},
	{
		fn: (value, context, meta) => {
			if (value.startsWith("blob:")) {
				// for media elements specifically they must take the original blob
				// because they can't be fetch'd
				return unrewriteBlob(value, context, meta);
			}

			return rewriteUrl(value, context, meta);
		},
		src: ["video", "audio", "source"],
	},
	{
		fn: () => "",

		integrity: ["script", "link"],
	},
	{
		fn: () => null,

		// csp stuff that must be deleted
		nonce: "*",
		csp: ["iframe"],
		credentialless: ["iframe"],
	},
	{
		fn: (value, context, meta) => rewriteSrcset(value, context, meta),

		// srcset
		srcset: ["img", "source"],
		imagesrcset: ["link"],
	},
	{
		fn: (value, context, meta) =>
			rewriteHtml(
				value,
				context,
				{
					// for srcdoc origin is the origin of the page that the iframe is on. base and path get dropped
					origin: new _URL(meta.origin.origin),
					base: new _URL(meta.origin.origin),
					topFrameName: meta.topFrameName,
					parentFrameName: meta.parentFrameName,
					referrerPolicy: meta.referrerPolicy,
				},
				{
					loadScripts: true,
					inline: true,
					source: meta.origin.href,
					apisource: "set HTMLIFrameElement.prototype.srcdoc",
				}
			),

		// srcdoc
		srcdoc: ["iframe"],
	},
	{
		fn: (value, context, meta) => rewriteCss(value, context, meta),
		style: "*",
	},
	{
		fn: (value, context, meta) => {
			if (value === "_top" || value === "_unfencedTop")
				return meta.topFrameName;
			else if (value === "_parent") return meta.parentFrameName;
			else return value;
		},
		target: ["a", "base"],
	},
	{
		// svg elements with an href property
		fn: (value, context, meta) => {
			// #id values are not rewritten
			if (value.startsWith("#")) return value;
			return rewriteUrl(value, context, meta);
		},
		href: [
			"use",
			"textPath",
			"mpath",
			"feImage",
			"animate",
			"animateMotion",
			"animateTransform",
			"set",
			"discard",
			"linearGradient",
			"radialGradient",
			"pattern",
			"filter",
		],
	},
];
