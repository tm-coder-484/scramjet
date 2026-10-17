import { ElementType, Parser } from "htmlparser2";
import { ChildNode, DomHandler, Element, Comment, Text } from "domhandler";
import render from "dom-serializer";
import { URLMeta, rewriteUrl } from "@rewriters/url";
import { rewriteCss } from "@rewriters/css";
import { rewriteJs } from "@rewriters/js";
import { ScramjetContext } from "@/shared";
import { htmlRules } from "@/shared/htmlRules";
import { parseDeclarativeRefresh } from "@/shared/refresh";
import { bytesToBase64 } from "@/shared/util";
import { Tap } from "@/Tap";
import { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { TrackedHistoryState } from "@/fetch";
import {
	Performance_now,
	atob,
	Object_keys,
	JSON_parse,
	JSON_stringify,
	TextEncoder_encode,
	Array_from,
	String_fromCodePoint,
	btoa,
	_URL,
	_Set,
	_Map,
} from "@/shared/snapshot";
import { flagEnabled } from "..";
import {
	getScriptBlockTypeString,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";

export type ForeignContext = "svg" | "math" | "html";

export type HtmlContext = {
	// should we inject scramjet scripts at the top of the document?
	loadScripts: boolean;
	// did the document come from the service worker, or from document.write/innerHTML?
	inline: boolean;
	// for worker originating documents, the source URL, otherwise the url of the page that triggered the rewrite
	source: string;
	// for api originating documents, the name of the api that triggered the rewrite
	apisource?: string;
	// response headers for worker originating documents
	headers?: RawHeaders;
	foreignContext?: ForeignContext;
	history?: TrackedHistoryState[];
};

export const renderOptions = {
	encodeEntities: "utf8" as const,
	decodeEntities: false,
	// dom-serializer self-closes empty elements inside <svg>/<math> (`<path/>`), but the HTML
	// serialization that innerHTML and outerHTML must return is always `<path></path>`
	selfClosingTags: false,
};
function serializeHtmlNode(node: ChildNode) {
	return render(node, renderOptions);
}

function isElementNode(node: ChildNode): node is Element {
	return (
		node.type === ElementType.Tag ||
		node.type === ElementType.Script ||
		node.type === ElementType.Style
	);
}

export class IncrementalHtmlRewriter {
	private readonly handler: DomHandler;
	private readonly parser: Parser;
	private readonly completedElements = new WeakSet<Element>();
	private readonly emittedLengths = new WeakMap<ChildNode, number>();
	private readonly rewrittenNodes = new WeakMap<ChildNode, string>();
	private ended = false;

	constructor(
		private readonly context: ScramjetContext,
		private readonly meta: URLMeta,
		private readonly htmlcontext: HtmlContext
	) {
		this.handler = new DomHandler(undefined, undefined, (element) => {
			this.completedElements.add(element);
		});
		this.parser = new Parser(this.handler, {
			startingForeignContext: htmlcontext.foreignContext,
		});
	}

	write(html: string) {
		if (this.ended) {
			throw new Error("IncrementalHtmlRewriter stream already ended");
		}

		this.parser.write(html);

		return this.flush();
	}

	end(html = "") {
		if (this.ended) {
			return "";
		}

		if (html) {
			this.parser.write(html);
		}

		this.parser.end();
		this.ended = true;

		return this.flush();
	}

	private flush() {
		let output = "";

		for (const node of this.handler.root.childNodes) {
			const rewritten = this.getAvailableOutput(node);
			if (rewritten === null) {
				break;
			}

			const emittedLength = this.emittedLengths.get(node) ?? 0;
			if (rewritten.length > emittedLength) {
				output += rewritten.slice(emittedLength);
				this.emittedLengths.set(node, rewritten.length);
			}
		}

		return output;
	}

	private getAvailableOutput(node: ChildNode) {
		if (!isElementNode(node)) {
			return serializeHtmlNode(node);
		}

		if (!this.completedElements.has(node)) {
			return null;
		}

		let rewritten = this.rewrittenNodes.get(node);
		if (rewritten === undefined) {
			rewritten = rewriteHtmlInner(
				node,
				this.context,
				this.meta,
				this.htmlcontext
			);
			this.rewrittenNodes.set(node, rewritten);
		}

		return rewritten;
	}
}

function rewriteHtmlInner(
	html: string | ChildNode,
	context: ScramjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	if (typeof html !== "string") {
		html = serializeHtmlNode(html);
	}

	const handler = new DomHandler((err, dom) => dom);
	const parser = new Parser(handler, {
		startingForeignContext: htmlcontext.foreignContext,
	});

	parser.write(html);
	parser.end();
	Tap.dispatch(
		context.hooks!.rewriter.html.pre,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		undefined
	);
	traverseParsedHtml(handler.root, context, meta);

	let htmlRoot: Element | undefined;
	let headElement: Element | undefined;
	let bodyElement: Element | undefined;

	function detectQuirks() {
		for (const child of handler.root.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "html") {
				htmlRoot = child as Element;
			} else {
				// there's a child of the root that isn't an html element or a doctype/comment/text
				return true;
			}
		}

		if (!htmlRoot) return true; // no html tag or it's somewhere else other than first child

		for (const child of htmlRoot.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "head") {
				if (bodyElement) {
					// head comes after body
					return true;
				}
				headElement = child as Element;
			} else if (child.type === ElementType.Tag && child.name === "body") {
				bodyElement = child as Element;
			} else {
				// there's a child of html that isn't head or body
				// fine if head already exists, bad if it doesn't
				if (!headElement) {
					return true;
				}
			}

			return false;
		}
	}

	const isQuirky = detectQuirks();

	if (htmlcontext.loadScripts) {
		const script = (src: string) =>
			new Element("script", { src, "scramjet-injected": "true" });
		const injectScripts = context.interface.getInjectScripts(
			meta,
			handler,
			htmlcontext,
			script
		);

		if (isQuirky) {
			dbg.warn(
				`detected quirky document structure parsing @ ${meta.origin.href}!`
			);
			// there's weird stuff going on with the document that could result in page scripts being loaded before our inject scripts
			// so inject them at position 0
			handler.root.children.unshift(...injectScripts);
		} else {
			if (!headElement) {
				headElement = new Element("head", {}, []);
				htmlRoot.children.unshift(headElement);
			}

			headElement.children.unshift(...injectScripts);

			const body = htmlRoot.children.find(
				(child) => child.type === ElementType.Tag && child.name === "body"
			);
			if (body && flagEnabled("renderBlocking", context, meta.base))
				(body as Element).children.unshift(renderBlockingScript());
		}
	}

	const props: typeof context.hooks.rewriter.html.post.props = {};
	Tap.dispatch(
		context.hooks!.rewriter.html.post,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		props
	);

	if (props.setRawHtml !== undefined) {
		return props.setRawHtml;
	}

	return render(handler.root, renderOptions);
}

// a script at the start of <body>, which the parser only runs once the stylesheets before it have
// loaded, so the body waits for them. a top-level document is not rendered while its head
// stylesheets load, but an iframe is laid out (and its text shaped) unstyled meanwhile, then again
// once they arrive: ~100ms of extra main thread work for a long article. it removes itself.
// off by default (the renderBlocking flag): while the parser waits here, Chromium also holds back
// the body's scripts and images, which cost more than the layout it saves on most sites
export function renderBlockingScript(): Element {
	return new Element("script", { "scramjet-injected": "true" }, [
		new Text("document.currentScript.remove()"),
	]);
}

export function rewriteHtml(
	html: string,
	context: ScramjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	const before = Performance_now();
	const ret = rewriteHtmlInner(html, context, meta, htmlcontext);
	if (flagEnabled("rewriterLogs", context, meta.base)) {
		dbg.time(meta, before, "html rewrite");
	}

	return ret;
}

// type ParseState = {
// 	base: string;
// 	origin?: URL;
// };

export function unrewriteHtml(html: string, foreignContext?: ForeignContext) {
	const handler = new DomHandler((err, dom) => dom);
	const parser = new Parser(handler, {
		startingForeignContext: foreignContext,
	});

	parser.write(html);
	parser.end();

	function traverse(node: ChildNode) {
		if ("attribs" in node) {
			for (const key in node.attribs) {
				if (key == "scramjet-attr-script-source-src") {
					if (node.children[0] && "data" in node.children[0])
						node.children[0].data = atob(node.attribs[key]);
					continue;
				}

				if (key.startsWith("scramjet-attr-")) {
					node.attribs[key.slice("scramjet-attr-".length)] = node.attribs[key];
					delete node.attribs[key];
				}
			}
		}

		if ("childNodes" in node) {
			for (const child of node.childNodes) {
				traverse(child);
			}
		}
	}

	traverse(handler.root);

	return render(handler.root, {
		...renderOptions,
	});
}

type AttrRule = {
	attr: string;
	sel: "*" | string[];
	fn: (typeof htmlRules)[number]["fn"];
};

type AttrRuleIndex = {
	// rules that apply to each tag named by some selector, in htmlRules order
	byTag: Map<string, AttrRule[]>;
	// rules that apply to every element ("*"), in htmlRules order
	wildcard: AttrRule[];
};

let attrRuleIndex: AttrRuleIndex | undefined;

// built on first use: htmlRules imports this module, so it may not be initialized when this file loads
function getAttrRuleIndex(): AttrRuleIndex {
	if (attrRuleIndex) return attrRuleIndex;

	const rules: AttrRule[] = [];
	const tags = new _Set<string>();
	for (const rule of htmlRules) {
		for (const attr in rule) {
			const sel = rule[attr.toLowerCase()];
			if (typeof sel === "function") continue;
			rules.push({ attr, sel, fn: rule.fn });
			if (sel !== "*") for (const tag of sel) tags.add(tag);
		}
	}

	const byTag = new _Map<string, AttrRule[]>();
	for (const tag of tags) {
		byTag.set(
			tag,
			rules.filter((rule) => rule.sel === "*" || rule.sel.includes(tag))
		);
	}
	attrRuleIndex = {
		byTag,
		wildcard: rules.filter((rule) => rule.sel === "*"),
	};
	return attrRuleIndex;
}

/**
 * Rewrites one element's own attributes: <base>, the htmlRules attribute rules, event handlers
 * and <meta http-equiv>. Only the element itself is touched, never its children.
 *
 * Returns a comment when the element must be replaced by one (CSP meta), otherwise null.
 */
export function rewriteElementAttributes(
	name: string | undefined,
	attribs: Record<string, string | undefined>,
	context: ScramjetContext,
	meta: URLMeta
): Comment | null {
	if (name === "base" && attribs.href !== undefined) {
		meta.base = new _URL(attribs.href, meta.origin);
	}

	const index = getAttrRuleIndex();
	const rules = (name !== undefined && index.byTag.get(name)) || index.wildcard;
	for (const { attr, fn } of rules) {
		if (attribs[attr] === undefined) continue;
		const value = attribs[attr];
		const v = fn(value!, context, meta, attribs);

		if (v === null) delete attribs[attr];
		else attribs[attr] = v;
		attribs[`scramjet-attr-${attr}`] = value;
	}

	for (const attr of Object_keys(attribs)) {
		if (!eventAttributeSet.has(attr)) continue;
		const value = attribs[attr];
		attribs[`scramjet-attr-${attr}`] = value;
		attribs[attr] = rewriteJs(
			value as string,
			`(inline ${attr} on element)`,
			context,
			meta
		) as string;
	}

	if (name === "meta" && attribs["http-equiv"] !== undefined) {
		if (attribs["http-equiv"].toLowerCase() === "content-security-policy") {
			// just delete it. this needs to be emulated eventually but like
			return new Comment(attribs.content as string);
		} else if (attribs["http-equiv"].toLowerCase() === "refresh") {
			const refresh = parseDeclarativeRefresh(attribs.content || "");
			if (refresh && refresh.url !== null && refresh.url.length > 0) {
				const rewritten = rewriteUrl(refresh.url.trim(), context, meta);
				attribs.content =
					(attribs.content as string).slice(0, refresh.urlStart) +
					rewritten +
					(attribs.content as string).slice(refresh.urlEnd);
			}
		}
	}

	return null;
}

/** the url inline scripts are rewritten with */
export const INLINE_SCRIPT_URL = "(inline script element)";

export function traverseParsedHtml(
	node: any,
	context: ScramjetContext,
	meta: URLMeta,
	// takes an inline script's rewrite elsewhere (htmlStream.ts sends big ones to the rewriter
	// threads): given the script node and the text to rewrite, returns true when it will hand the
	// rewrite to `finish` itself
	deferScript?: (
		node: any,
		js: string,
		isModule: boolean,
		finish: (rewritten: string) => void
	) => boolean
) {
	if (node.attribs) {
		const replacement = rewriteElementAttributes(
			node.name,
			node.attribs,
			context,
			meta
		);
		if (replacement) return replacement;
	}

	if (node.name === "style" && node.children[0] !== undefined)
		node.children[0].data = rewriteCss(node.children[0].data, context, meta);

	if (
		node.name === "script" &&
		node.attribs.type?.toLowerCase() === "importmap" &&
		node.children[0] !== undefined
	) {
		const json = node.children[0].data;
		try {
			const map = JSON_parse(json);
			if (map.imports) {
				for (const key in map.imports) {
					let url = map.imports[key];
					if (typeof url === "string") {
						url = rewriteUrl(url, context, meta, { isModule: true });
						map.imports[key] = url;
					}
				}
			}

			node.children[0].data = JSON_stringify(map);
		} catch (e) {
			dbg.error("Failed to parse importmap JSON:", e);
		}
	}
	if (
		node.name === "script" &&
		node.attribs &&
		node.children[0] !== undefined
	) {
		const scriptBlockType = getScriptBlockTypeString(
			"type" in node.attribs ? node.attribs.type : undefined,
			"language" in node.attribs ? node.attribs.language : undefined,
			"type" in node.attribs,
			"language" in node.attribs
		);
		if (isScriptType(scriptBlockType)) {
			const source: string = node.children[0].data;
			const module = isModuleScriptType(scriptBlockType);
			const htmlcomment = /<!--[\s\S]*?-->/g;
			const js = source.replace(htmlcomment, "");
			// the script's text becomes the rewrite, and the page reads its source back from the
			// attribute: not needed when the rewrite is the source (Aljazeera's 241 KB Apollo state
			// doubled in size with it, and the frame's parser took the time to read it)
			const finish = (rewritten: string) => {
				node.children[0].data = rewritten;
				if (rewritten !== source)
					node.attribs["scramjet-attr-script-source-src"] = bytesToBase64(
						TextEncoder_encode(source)
					);
			};
			if (!deferScript?.(node, js, module, finish))
				finish(
					rewriteJs(js, INLINE_SCRIPT_URL, context, meta, module) as string
				);
		}
	}

	if (node.childNodes) {
		for (const childNode in node.childNodes) {
			node.childNodes[childNode] = traverseParsedHtml(
				node.childNodes[childNode],
				context,
				meta,
				deferScript
			);
		}
	}

	return node;
}

// a srcset is a comma-separated list of candidates: a URL (a run of non-whitespace) and optional
// descriptors. URLs may contain commas themselves (`img.png?resize=300,225 300w`), so this follows
// the HTML parsing algorithm instead of splitting on commas: dropping candidates makes the browser
// pick another one, often the full-size original
const isSrcsetSpace = (c: string) =>
	c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

export function rewriteSrcset(
	srcset: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	const out: string[] = [];
	const n = srcset.length;
	let i = 0;
	while (i < n) {
		while (i < n && (isSrcsetSpace(srcset[i]) || srcset[i] === ",")) i++;
		if (i >= n) break;

		const urlStart = i;
		while (i < n && !isSrcsetSpace(srcset[i])) i++;
		let url = srcset.slice(urlStart, i);

		let descriptors = "";
		if (url.endsWith(",")) {
			// a URL that ends in commas ends the candidate, and loses the commas
			while (url.endsWith(",")) url = url.slice(0, -1);
		} else {
			// descriptors run to the next comma outside parentheses
			const descStart = i;
			let inParens = false;
			while (i < n) {
				const c = srcset[i];
				if (c === "(") inParens = true;
				else if (c === ")") inParens = false;
				else if (c === "," && !inParens) break;
				i++;
			}
			descriptors = srcset.slice(descStart, i).trim();
			i++;
		}
		if (!url) continue;

		const rewrittenUrl = rewriteUrl(url, context, meta);
		out.push(descriptors ? `${rewrittenUrl} ${descriptors}` : rewrittenUrl);
	}

	return out.join(", ");
}

// function base64ToBytes(base64) {
// 	const binString = atob(base64);

// 	return Uint8Array.from(binString, (m) => m.codePointAt(0));
// }

export const eventAttributes = [
	"onbeforexrselect",
	"onabort",
	"onbeforeinput",
	"onbeforematch",
	"onbeforetoggle",
	"onblur",
	"oncancel",
	"oncanplay",
	"oncanplaythrough",
	"onchange",
	"onclick",
	"onclose",
	"oncontentvisibilityautostatechange",
	"oncontextlost",
	"oncontextmenu",
	"oncontextrestored",
	"oncuechange",
	"ondblclick",
	"ondrag",
	"ondragend",
	"ondragenter",
	"ondragleave",
	"ondragover",
	"ondragstart",
	"ondrop",
	"ondurationchange",
	"onemptied",
	"onended",
	"onerror",
	"onfocus",
	"onformdata",
	"oninput",
	"oninvalid",
	"onkeydown",
	"onkeypress",
	"onkeyup",
	"onload",
	"onloadeddata",
	"onloadedmetadata",
	"onloadstart",
	"onmousedown",
	"onmouseenter",
	"onmouseleave",
	"onmousemove",
	"onmouseout",
	"onmouseover",
	"onmouseup",
	"onmousewheel",
	"onpause",
	"onplay",
	"onplaying",
	"onprogress",
	"onratechange",
	"onreset",
	"onresize",
	"onscroll",
	"onsecuritypolicyviolation",
	"onseeked",
	"onseeking",
	"onselect",
	"onslotchange",
	"onstalled",
	"onsubmit",
	"onsuspend",
	"ontimeupdate",
	"ontoggle",
	"onvolumechange",
	"onwaiting",
	"onwebkitanimationend",
	"onwebkitanimationiteration",
	"onwebkitanimationstart",
	"onwebkittransitionend",
	"onwheel",
	"onauxclick",
	"ongotpointercapture",
	"onlostpointercapture",
	"onpointerdown",
	"onpointermove",
	"onpointerrawupdate",
	"onpointerup",
	"onpointercancel",
	"onpointerover",
	"onpointerout",
	"onpointerenter",
	"onpointerleave",
	"onselectstart",
	"onselectionchange",
	"onanimationend",
	"onanimationiteration",
	"onanimationstart",
	"ontransitionrun",
	"ontransitionstart",
	"ontransitionend",
	"ontransitioncancel",
	"oncopy",
	"oncut",
	"onpaste",
	"onscrollend",
	"onscrollsnapchange",
	"onscrollsnapchanging",
];

const eventAttributeSet = new _Set<string>(eventAttributes);
