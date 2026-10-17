import { htmlRules } from "@/shared/htmlRules";
import {
	String,
	Array_isArray,
	TextEncoder_encode,
	Object_keys,
	Object_defineProperty,
	atob,
	_Set,
} from "@/shared/snapshot";
import { bytesToBase64 } from "@/shared/util";
import { rewriteCss, unrewriteCss } from "@rewriters/css";
import { rewriteHtml, unrewriteHtml } from "@rewriters/html";
import { rewriteJs } from "@rewriters/js";
import { unrewriteUrl } from "@rewriters/url";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import {
	getScriptBlockTypeString,
	isHtmlMimeType,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";
import { eventAttributes, ForeignContext } from "@/shared/rewriters/html";

// lowercase attribute names that an htmlRules entry can apply to: a "*" or a tag list. the rule lookup
// on any other name finds nothing. __proto__ is in the set anyway: its lookup is not a tag list and
// throws, so it keeps the slow path
const ruleAttributeNames = new _Set<string>(["__proto__"]);
for (const rule of htmlRules) {
	for (const key of Object_keys(rule)) {
		const r = rule[key];
		if (r === "*" || Array_isArray(r)) ruleAttributeNames.add(key);
	}
}
const eventAttributeNames = new _Set<string>(eventAttributes);

// unrewriteHtml changes a serialized string unless it is one of the forms below. a native
// serialization that has none of them comes back from unrewriteHtml unchanged:
// - scramjet-attr-* read-backs are renamed, and script sources are decoded
// - entities (&) are re-encoded, and an empty attribute (x="") comes back as a bare name (x)
// - foreign content (svg, math) and uppercase tag or attribute names are case-folded by the parser
// - raw text elements, comments and doctypes are re-tokenized
// the first regex matches case-insensitively, the second is case-sensitive on purpose
const htmlNeedsUnrewrite = (html: string) =>
	/scramjet-attr-|&|=""|<!|<\/?(?:svg|math|noscript|iframe|noembed|noframes|xmp|plaintext)/i.test(
		html
	) ||
	/<[a-z0-9-]*[A-Z]| [^ =<>]*[A-Z][^ =<>]*=/.test(html) ||
	html.indexOf("\u0000") !== -1;

function isScriptElement(client: ScramjetClient, element: Element): boolean {
	return (
		client.box.instanceof(element, "HTMLScriptElement") ||
		client.box.instanceof(element, "SVGScriptElement")
	);
}

// reverses the storage of script source: UTF-8 bytes, base64 encoded
function decodeScriptSource(base64: string): string {
	const binary = atob(base64);
	let escaped = "";
	for (let i = 0; i < binary.length; i++) {
		escaped += "%" + binary.charCodeAt(i).toString(16).padStart(2, "0");
	}
	return decodeURIComponent(escaped);
}

function isEventAttributeName(name: string): boolean {
	return eventAttributeNames.has(name.toLowerCase());
}

// Copies an Attr through the element's setAttribute so the attribute rules run; returns the replaced Attr.
function setAttributeViaSetter(element: Element, attr: Attr): Attr | null {
	const previous = element.getAttributeNode(attr.name);
	element.setAttribute(attr.name, attr.value);
	return previous;
}

export function foreignContextForElement(
	client: ScramjetClient,
	element: Element
): ForeignContext {
	if (client.box.instanceof(element, "SVGElement")) return "svg";
	if (client.box.instanceof(element, "MathMLElement")) return "math";
	return "html";
}

// NOTE: NOT INCLUSIVE OF THE CURRENT ELEMENT
export function insideForeignContext(
	client: ScramjetClient,
	element: Element | null
): ForeignContext {
	let current: Element | null = element.parentElement;

	while (current) {
		const context = foreignContextForElement(client, current);
		if (context !== "html") return context;
		// EXPLICITLY an html context, don't go up further
		if (client.box.instanceof(current, "SVGForeignObjectElement"))
			return "html";
		current = current.parentElement;
	}

	return "html";
}

function scriptBlockTypeForElement(
	client: ScramjetClient,
	element: Element
): string {
	const hasType = client.natives.call(
		"Element.prototype.hasAttribute",
		element,
		"type"
	) as boolean;
	const hasLanguage = client.natives.call(
		"Element.prototype.hasAttribute",
		element,
		"language"
	) as boolean;
	const type = hasType
		? (client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"type"
			) as string | null)
		: null;
	const language = hasLanguage
		? (client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"language"
			) as string | null)
		: null;
	return getScriptBlockTypeString(type, language, hasType, hasLanguage);
}

// TODO: this is pretty bad. really this whole file sucks
function collectAttributeMap(
	client: ScramjetClient,
	element: Element,
	overrideName: string,
	overrideValue: unknown
) {
	const attrs: Record<string, string | undefined> = {};
	const attrNames =
		client.natives.call("Element.prototype.getAttributeNames", element) ?? [];

	for (const attrName of attrNames) {
		if (String(attrName).startsWith("scramjet-attr-")) {
			// attributes whose rule returned null only exist as scramjet-attr-*
			const original = String(attrName).slice("scramjet-attr-".length);
			if (!attrNames.includes(original)) {
				attrs[original.toLowerCase()] = client.natives.call(
					"Element.prototype.getAttribute",
					element,
					attrName
				);
			}
			continue;
		}
		const value = client.natives.call(
			"Element.prototype.getAttribute",
			element,
			attrName
		);
		attrs[String(attrName).toLowerCase()] =
			typeof value === "string" ? value : undefined;
	}

	attrs[String(overrideName).toLowerCase()] = String(overrideValue);
	return attrs;
}

function findRule(name: string, tagName: string) {
	return htmlRules.find((rule) => {
		const r = rule[name.toLowerCase()];
		if (r === "*") return true;
		// only tag lists are rules: this also skips the fn key and Object.prototype keys such as __proto__
		if (!Array_isArray(r)) return false;

		return r.includes(tagName.toLowerCase());
	});
}

function isDownloadAttribute(element: Element, name: string) {
	const tagName = element.tagName.toLowerCase();
	return (
		String(name).toLowerCase() === "download" &&
		(tagName === "a" || tagName === "area")
	);
}

// Attributes of a node that the parser built without the HTML rewriter: the originals go to
// scramjet-attr-*, the same way setAttribute stores them, so reads still return the original.
// Natives are used so the rewritten values are not rewritten again by the hooks.
function setParsedAttribute(
	client: ScramjetClient,
	element: Element,
	name: string,
	value: string,
	rewritten: string | null
) {
	if (rewritten === null) {
		client.natives.call("Element.prototype.removeAttribute", element, name);
	} else {
		const attr = client.natives.call(
			"Element.prototype.getAttributeNode",
			element,
			name
		) as Attr | null;
		// keep the namespace, so xlink:href and friends stay namespaced
		client.natives.call(
			"Element.prototype.setAttributeNS",
			element,
			attr?.namespaceURI ?? null,
			name,
			rewritten
		);
	}
	client.natives.call(
		"Element.prototype.setAttribute",
		element,
		`scramjet-attr-${name}`,
		value
	);
}

function rewriteParsedScript(client: ScramjetClient, element: Element) {
	const scriptBlockType = scriptBlockTypeForElement(client, element);
	if (!isScriptType(scriptBlockType)) return;

	// the whole text, across every text and CDATA child, is the script source
	const source = client.descriptors.get(
		"Node.prototype.textContent",
		element
	) as string;
	if (!source) return;

	client.natives.call(
		"Element.prototype.setAttribute",
		element,
		"scramjet-attr-script-source-src",
		bytesToBase64(TextEncoder_encode(source))
	);
	// the native setter replaces the children with one text node holding the rewritten source
	client.descriptors.set(
		"Node.prototype.textContent",
		element,
		rewriteJs(
			source,
			"(anonymous script element)",
			client.context,
			client.meta,
			isModuleScriptType(scriptBlockType)
		) as string
	);
}

// Rewrites an element parsed outside the HTML path (XML/XHTML documents, XHR documents, XSLT output),
// with the same attribute rules the HTML rewriter applies
function rewriteParsedElement(client: ScramjetClient, element: Element) {
	const names = client.natives.call(
		"Element.prototype.getAttributeNames",
		element
	) as string[];
	for (const name of names) {
		const lower = name.toLowerCase();
		const rule = findRule(lower, element.tagName);
		if (!rule && !isEventAttributeName(lower)) continue;

		const value = client.natives.call(
			"Element.prototype.getAttribute",
			element,
			name
		) as string;
		if (rule) {
			const rewritten = rule.fn(
				value,
				client.context,
				client.meta,
				collectAttributeMap(client, element, name, value)
			);
			setParsedAttribute(client, element, name, value, rewritten);
		} else {
			// inline handlers such as onerror have no htmlRules entry
			setParsedAttribute(
				client,
				element,
				name,
				value,
				rewriteJs(
					value,
					`(inline ${name} on element)`,
					client.context,
					client.meta
				) as string
			);
		}
	}

	if (isScriptElement(client, element)) rewriteParsedScript(client, element);
}

// The HTML path rewrites its parsed tree as a string; documents from DOMParser (XML types), XHR
// responses and XSLT results are already DOM trees, so this walks them once after they are built.
// Only the parse APIs call this, never the normal DOM operations.
export function rewriteParsedDocument(
	client: ScramjetClient,
	root: Document | DocumentFragment
) {
	const elements = root.querySelectorAll("*");
	for (let i = 0; i < elements.length; i++) {
		rewriteParsedElement(client, elements[i]);
	}
}

export default function (client: ScramjetClient, self: typeof window) {
	// the rewritten href of an <a> depends on its download attribute, so redo it when that changes
	function refreshDownloadHref(element: Element) {
		const href = client.natives.call(
			"Element.prototype.getAttribute",
			element,
			"scramjet-attr-href"
		);
		if (href === null) return;
		const rule = findRule("href", element.tagName);
		client.natives.call(
			"Element.prototype.setAttribute",
			element,
			"href",
			rule.fn(
				href,
				client.context,
				client.meta,
				collectAttributeMap(client, element, "href", href)
			)
		);
	}

	const attrObject = {
		nonce: [self.HTMLElement],
		integrity: [self.HTMLScriptElement, self.HTMLLinkElement],
		csp: [self.HTMLIFrameElement],
		credentialless: [self.HTMLIFrameElement],
		src: [
			self.HTMLImageElement,
			self.HTMLMediaElement,
			self.HTMLIFrameElement,
			self.HTMLFrameElement,
			self.HTMLEmbedElement,
			self.HTMLScriptElement,
			self.HTMLSourceElement,
		],
		href: [self.HTMLAnchorElement, self.HTMLLinkElement],
		data: [self.HTMLObjectElement],
		action: [self.HTMLFormElement],
		formaction: [self.HTMLButtonElement, self.HTMLInputElement],
		srcdoc: [self.HTMLIFrameElement],
		poster: [self.HTMLVideoElement],
		// without these, a srcset set from script went to the browser unrewritten, and it fetched
		// the images straight from the site
		srcset: [self.HTMLImageElement, self.HTMLSourceElement],
		imagesrcset: [self.HTMLLinkElement],
	};

	const urlinterfaces = [
		self.HTMLAnchorElement.prototype,
		self.HTMLAreaElement.prototype,
	];
	const originalhrefs = [
		client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.HTMLAnchorElement.prototype,
			"href"
		),
		client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.HTMLAreaElement.prototype,
			"href"
		),
	];

	const attrs = Object_keys(attrObject);

	const urlAttrs = ["src", "data", "href", "action", "formaction", "poster"];
	// these reflect the attribute as it was written: the page reads back what it set, not the
	// rewritten urls (which it would rewrite a second time if it set them again)
	const verbatimAttrs = ["srcset", "imagesrcset"];
	for (const attr of attrs) {
		const isUrlAttr = urlAttrs.includes(attr);
		const isVerbatim = verbatimAttrs.includes(attr);
		for (const element of attrObject[attr]) {
			const descriptor = client.natives.call(
				"Object.getOwnPropertyDescriptor",
				null,
				element.prototype,
				attr
			);
			Object_defineProperty(element.prototype, attr, {
				get() {
					if (isUrlAttr) {
						return unrewriteUrl(descriptor.get.call(this), client.context);
					}
					if (isVerbatim) {
						const original = client.natives.call(
							"Element.prototype.getAttribute",
							this,
							`scramjet-attr-${attr}`
						);
						if (original !== null) return original;
					}

					return descriptor.get.call(this);
				},

				set(value) {
					// if (
					// 	this.tagName === "IFRAME" &&
					// 	attr === "src" &&
					// 	value === "about:blank"
					// ) {
					// 	this.setAttribute("srcdoc", "");
					// 	return;
					// }
					return this.setAttribute(attr, value);
				},
			});
		}
	}

	client.Trap("HTMLImageElement.prototype.currentSrc", {
		get(ctx) {
			const currentSrc = ctx.get() as string;
			if (!currentSrc) return currentSrc;
			return unrewriteUrl(currentSrc, client.context);
		},
	});

	// note that href is not here
	const urlprops = [
		"protocol",
		"hash",
		"host",
		"hostname",
		"origin",
		"pathname",
		"port",
		"search",
	];
	for (const prop of urlprops) {
		for (const i in urlinterfaces) {
			const target = urlinterfaces[i];
			const desc = originalhrefs[i];
			client.RawTrap(target, prop, {
				get(ctx) {
					const href = desc.get.call(ctx.this);
					if (!href) return href;

					const url = new URL(unrewriteUrl(href, client.context));

					return url[prop];
				},
			});
		}
	}

	client.Trap("Node.prototype.baseURI", {
		get(ctx) {
			const node = ctx.this as Node;
			const doc = client.box.instanceof(node, "Document")
				? (node as Document)
				: node.ownerDocument;
			if (doc === client.global.document) return client.meta.base.href;

			const base = doc?.querySelector("base[href]") as HTMLBaseElement | null;

			if (base) {
				const href = base.getAttribute("href") || base.href;
				if (href) return new URL(href, client.url.href).href;
			}

			return client.url.href;
		},
		set() {
			return false;
		},
	});

	// a name can only have a scramjet-attr-* read-back if some write created one: the setAttribute and
	// setAttributeNS hooks create them for rule and event names only, and a page that writes a
	// scramjet-attr-* name itself (or markup containing one) sets forgedReadBack, which disables this
	let forgedReadBack = false;
	const mayHaveReadBack = (lowerName: string) =>
		ruleAttributeNames.has(lowerName) ||
		eventAttributeNames.has(lowerName) ||
		lowerName === "script-source-src";

	client.Proxy("Element.prototype.getAttribute", {
		apply(ctx) {
			const [name] = ctx.args;

			if (name.startsWith("scramjet-attr")) {
				return ctx.return(null);
			}

			// no read-back can exist for this name, so the native getAttribute answers
			if (!forgedReadBack && !mayHaveReadBack(name.toLowerCase())) return;

			if (
				client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					`scramjet-attr-${name}`
				)
			) {
				const attrib = ctx.fn.call(ctx.this, `scramjet-attr-${name}`);
				if (attrib === null) return ctx.return("");

				return ctx.return(attrib);
			}
		},
	});

	client.Proxy("Element.prototype.getAttributeNames", {
		apply(ctx) {
			const attrNames = ctx.call() as string[];
			const cleaned = attrNames.filter(
				(attr) => !attr.startsWith("scramjet-attr")
			);
			for (const attr of attrNames) {
				if (!attr.startsWith("scramjet-attr-")) continue;
				const original = attr.slice("scramjet-attr-".length);
				if (original !== "script-source-src" && !cleaned.includes(original))
					cleaned.push(original);
			}

			ctx.return(cleaned);
		},
	});

	client.Proxy("Element.prototype.getAttributeNode", {
		apply(ctx) {
			if (String(ctx.args[0]).startsWith("scramjet-attr"))
				return ctx.return(null);
		},
	});

	client.Proxy("Element.prototype.hasAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith("scramjet-attr")) return ctx.return(false);
			if (
				!ctx.call() &&
				client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					`scramjet-attr-${name}`
				)
			)
				ctx.return(true);
		},
	});

	client.Proxy("Element.prototype.setAttribute", {
		apply(ctx) {
			let [name, value] = ctx.args;

			if (value != null) value = String(value);
			ctx.args[1] = value;

			// no rule and no inline-handler rewrite applies to this name, so the native call stands
			const lowerName = name.toLowerCase();
			if (lowerName.startsWith("scramjet-attr")) forgedReadBack = true;
			if (
				!ruleAttributeNames.has(lowerName) &&
				!(value != null && eventAttributeNames.has(lowerName))
			)
				return;

			const tagName = ctx.this.tagName.toLowerCase();

			const ruleList = htmlRules.find((rule) => {
				const r = rule[name.toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(tagName);
			});

			if (ruleList) {
				const ret = ruleList.fn(
					value,
					client.context,
					client.meta,
					collectAttributeMap(client, ctx.this, name, value)
				);
				if (ret == null) {
					client.natives.call(
						"Element.prototype.removeAttribute",
						ctx.this,
						name
					);
					ctx.fn.call(ctx.this, `scramjet-attr-${name}`, value);
					if (isDownloadAttribute(ctx.this, name))
						refreshDownloadHref(ctx.this);
					ctx.return(undefined);

					return;
				}
				ctx.args[1] = ret;
				ctx.fn.call(ctx.this, `scramjet-attr-${ctx.args[0]}`, value);
			} else if (value != null && isEventAttributeName(name)) {
				// inline handlers such as onclick have no htmlRules entry, so they were set unrewritten
				ctx.args[1] = rewriteJs(
					value,
					`(inline ${name} on element)`,
					client.context,
					client.meta
				) as string;
				ctx.fn.call(ctx.this, `scramjet-attr-${name}`, value);
			}
		},
	});

	// Attr nodes were set natively, skipping the attribute rules, so route them through setAttribute
	client.Proxy("Element.prototype.setAttributeNode", {
		apply(ctx) {
			ctx.return(setAttributeViaSetter(ctx.this, ctx.args[0] as Attr));
		},
	});

	client.Proxy("Element.prototype.setAttributeNS", {
		apply(ctx) {
			// TODO: this could leak by like calling stringify twice or some dumb shit lol
			const name = String(ctx.args[1]);
			const value = String(ctx.args[2]);
			if (name.toLowerCase().startsWith("scramjet-attr")) forgedReadBack = true;

			const ruleList = htmlRules.find((rule) => {
				const r = rule[String(name).toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(ctx.this.tagName.toLowerCase());
			});

			if (ruleList) {
				ctx.args[2] = ruleList.fn(
					value,
					client.context,
					client.meta,
					collectAttributeMap(client, ctx.this, name, value)
				);
				client.natives.call(
					"Element.prototype.setAttribute",
					ctx.this,
					`scramjet-attr-${ctx.args[1]}`,
					value
				);
				if (ctx.args[2] == null) {
					client.natives.call(
						"Element.prototype.removeAttribute",
						ctx.this,
						name
					);
					if (isDownloadAttribute(ctx.this, name))
						refreshDownloadHref(ctx.this);
					ctx.return(undefined);
				}
			} else if (isEventAttributeName(name)) {
				ctx.args[2] = rewriteJs(
					value,
					`(inline ${name} on element)`,
					client.context,
					client.meta
				) as string;
				client.natives.call(
					"Element.prototype.setAttribute",
					ctx.this,
					`scramjet-attr-${name}`,
					value
				);
			}
		},
	});

	// this is separate from the regular href handlers because it returns an SVGAnimatedString
	client.Trap("SVGAnimatedString.prototype.baseVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href) return href;

			return unrewriteUrl(href, client.context);
		},
		set(ctx, val: string) {
			ctx.set(client.rewriteUrl(val));
		},
	});
	client.Trap("SVGAnimatedString.prototype.animVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href) return href;

			return unrewriteUrl(href, client.context);
		},
		// it has no setter
	});

	client.Proxy("Element.prototype.removeAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith("scramjet-attr")) return ctx.return(undefined);
			const hidden = client.natives.call(
				"Element.prototype.hasAttribute",
				ctx.this,
				`scramjet-attr-${name}`
			);
			if (
				hidden ||
				client.natives.call("Element.prototype.hasAttribute", ctx.this, name)
			) {
				ctx.fn.call(ctx.this, `scramjet-attr-${ctx.args[0]}`);
			}
			if (hidden && isDownloadAttribute(ctx.this, name)) {
				ctx.call();
				refreshDownloadHref(ctx.this);
			}
		},
	});

	client.Proxy("Element.prototype.toggleAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith("scramjet-attr")) return ctx.return(false);
			const real = client.natives.call(
				"Element.prototype.hasAttribute",
				ctx.this,
				name
			);
			const hidden =
				!real &&
				client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					`scramjet-attr-${name}`
				);
			if (hidden || findRule(name, ctx.this.tagName)) {
				// go through set/removeAttribute so the rewrite rules apply
				const present = real || hidden;
				const force = ctx.args.length > 1 ? !!ctx.args[1] : !present;
				if (force !== present) {
					if (force) ctx.this.setAttribute(name, "");
					else ctx.this.removeAttribute(name);
				}
				return ctx.return(force);
			}
			if (real) {
				client.natives.call(
					"Element.prototype.removeAttribute",
					ctx.this,
					`scramjet-attr-${name}`
				);
			}
		},
	});

	client.Trap(
		[
			"HTMLAnchorElement.prototype.download",
			"HTMLAreaElement.prototype.download",
		],
		{
			get(ctx) {
				return ctx.this.getAttribute("download") ?? "";
			},
			set(ctx, value) {
				ctx.this.setAttribute("download", value);
			},
		}
	);

	client.Trap("Element.prototype.innerHTML", {
		set(ctx, value: string) {
			// null specifically becomes "" and not "null". undefined does not
			if (value === null) return;
			const html = String(value);
			if (/scramjet-attr-/i.test(html)) forgedReadBack = true;
			let newval;
			const scriptBlockType = client.box.instanceof(
				ctx.this,
				"HTMLScriptElement"
			)
				? scriptBlockTypeForElement(client, ctx.this)
				: null;
			if (
				client.box.instanceof(ctx.this, "HTMLScriptElement") &&
				isScriptType(scriptBlockType)
			) {
				newval = rewriteJs(
					html,
					"(anonymous script element)",
					client.context,
					client.meta,
					isModuleScriptType(scriptBlockType)
				);
				client.natives.call(
					"Element.prototype.setAttribute",
					ctx.this,
					"scramjet-attr-script-source-src",
					bytesToBase64(TextEncoder_encode(html))
				);
			} else if (client.box.instanceof(ctx.this, "HTMLStyleElement")) {
				newval = rewriteCss(html, client.context, client.meta);
			} else {
				try {
					newval = rewriteHtml(html, client.context, client.meta, {
						loadScripts: false,
						inline: true,
						source: client.url.href,
						apisource: "set Element.prototype.innerHTML",
						foreignContext: foreignContextForElement(client, ctx.this),
					});
				} catch {
					newval = html;
				}
			}

			ctx.set(newval);
		},
		get(ctx) {
			if (client.box.instanceof(ctx.this, "HTMLScriptElement")) {
				const scriptSource = client.natives.call(
					"Element.prototype.getAttribute",
					ctx.this,
					"scramjet-attr-script-source-src"
				);

				if (scriptSource) {
					return decodeScriptSource(scriptSource);
				}

				return ctx.get();
			}
			if (client.box.instanceof(ctx.this, "HTMLStyleElement")) {
				return ctx.get();
			}

			const html = ctx.get();
			const foreign = foreignContextForElement(client, ctx.this);
			// the browser's serialization is what unrewriteHtml would return for these
			if (
				foreign === "html" &&
				typeof html === "string" &&
				!htmlNeedsUnrewrite(html)
			)
				return html;

			return unrewriteHtml(html, foreign);
		},
	});

	const rewriteTextForElement = (element: Element, value: string) => {
		const scriptBlockType = isScriptElement(client, element)
			? scriptBlockTypeForElement(client, element)
			: null;

		if (isScriptElement(client, element) && isScriptType(scriptBlockType)) {
			const newval: string = rewriteJs(
				value,
				"(anonymous script element)",
				client.context,
				client.meta,
				isModuleScriptType(scriptBlockType)
			) as string;
			client.natives.call(
				"Element.prototype.setAttribute",
				element,
				"scramjet-attr-script-source-src",
				bytesToBase64(TextEncoder_encode(value))
			);

			return newval;
		} else if (client.box.instanceof(element, "HTMLStyleElement")) {
			return rewriteCss(value, client.context, client.meta);
		} else {
			return value;
		}
	};
	const getTextForElement = (element: Element, text: string) => {
		if (isScriptElement(client, element)) {
			const scriptSource = client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"scramjet-attr-script-source-src"
			);
			if (scriptSource) return decodeScriptSource(scriptSource);
			return text;
		}
		if (client.box.instanceof(element, "HTMLStyleElement")) {
			return unrewriteCss(text, client.context);
		}
		// with scripting on, a <noscript>'s content is text, and the HTML rewriter rewrote the markup
		// in it like any other. pages that lazy-load from it (Apple's front page) parse that text and
		// insert it, which would rewrite its urls a second time: they read the original markup
		if (
			element.localName === "noscript" &&
			text.includes("scramjet-attr-")
		) {
			return unrewriteHtml(text, "html");
		}
		return text;
	};

	// a Text node's source lives on its parent <script>, so writes to it are rewritten against that script
	const textOwnerFor = (node: Node): Element | null =>
		client.box.instanceof(node, "Text")
			? client.descriptors.get("Node.prototype.parentElement", node)
			: (node as Element);

	// Script text. A JS script keeps its original source in scramjet-attr-script-source-src, and its
	// children hold the rewritten output. A change to the text rewrites the whole source once: the
	// stored source stands in for the carrier Text child, an edited node contributes its new value,
	// and other children contribute their raw text. Non-JS scripts are left alone.
	const isText = (node: unknown): node is Text =>
		client.box.instanceof(node, "Text");

	const isJsScript = (node: Element): boolean =>
		isScriptElement(client, node) &&
		isScriptType(scriptBlockTypeForElement(client, node));

	const parentElementOf = (node: Node): Element | null =>
		client.descriptors.get("Node.prototype.parentElement", node);

	// the stored original source, or null when the script's text was never rewritten
	const storedScriptSource = (script: Element): string | null => {
		const stored = client.natives.call(
			"Element.prototype.getAttribute",
			script,
			"scramjet-attr-script-source-src"
		);
		return stored === null ? null : decodeScriptSource(stored);
	};

	const scriptChildren = (script: Element): Node[] => {
		const children: Node[] = [];
		for (
			let child = client.descriptors.get("Node.prototype.firstChild", script);
			child;
			child = client.descriptors.get("Node.prototype.nextSibling", child)
		) {
			children.push(child);
		}
		return children;
	};

	// the text a child adds to its script; comments and processing instructions add none
	const childText = (node: Node): string => {
		const type = client.descriptors.get("Node.prototype.nodeType", node);
		if (type === 7 || type === 8) return "";
		return client.descriptors.get("Node.prototype.textContent", node) ?? "";
	};

	const firstText = (children: Node[]): Text | null =>
		children.find(isText) ?? null;

	// the script source after a change: the stored source stands for `carrier`, and `edited` takes `editedText`
	const sourceAfter = (
		children: Node[],
		carrier: Node | null,
		prior: string,
		edited: Node | null,
		editedText: string
	): string => {
		let source = "";
		for (const child of children) {
			if (child === edited) source += editedText;
			else if (child === carrier) source += prior;
			else source += childText(child);
		}
		return source;
	};

	// rewrites the whole source once and stores it, then leaves one Text child holding the output.
	// `keep` keeps its identity while it is still a child, so later edits through it still reach the script
	const commitScript = (
		script: Element,
		children: Node[],
		source: string,
		keep: Node | null
	) => {
		const rewritten = rewriteTextForElement(script, source);
		const kept = keep && children.includes(keep) ? keep : firstText(children);
		for (const child of children) {
			if (child !== kept)
				client.natives.call("Node.prototype.removeChild", script, child);
		}
		if (kept) {
			const current = childText(kept);
			if (current !== rewritten) {
				client.natives.call(
					"CharacterData.prototype.replaceData",
					kept,
					0,
					current.length,
					rewritten
				);
			}
		} else if (rewritten) {
			const doc = client.descriptors.get(
				"Node.prototype.ownerDocument",
				script
			);
			client.natives.call(
				"Node.prototype.appendChild",
				script,
				client.natives.call("Document.prototype.createTextNode", doc, rewritten)
			);
		}
	};

	// runs a native insertion into a JS script, then rewrites the script's whole source
	const insertIntoScript = <R>(
		script: Element,
		insert: () => R,
		inserted: unknown[]
	): R => {
		const stored = storedScriptSource(script);
		const prior = stored ?? "";
		const carrier = stored === null ? null : firstText(scriptChildren(script));
		const result = insert();
		const children = scriptChildren(script);
		const keep =
			inserted.find(
				(node): node is Text => isText(node) && children.includes(node)
			) ?? null;
		commitScript(
			script,
			children,
			sourceAfter(children, carrier, prior, null, ""),
			keep
		);
		return result;
	};

	// edits one Text child of a JS script; `next` maps the child's old logical text to its new text
	const editScriptText = (
		text: Text,
		script: Element,
		next: (current: string) => string
	) => {
		const stored = storedScriptSource(script);
		const prior = stored ?? "";
		const children = scriptChildren(script);
		const carrier = stored === null ? null : firstText(children);
		const current = text === carrier ? prior : childText(text);
		commitScript(
			script,
			children,
			sourceAfter(children, carrier, prior, text, next(current)),
			text
		);
	};

	// a CharacterData method run on a detached copy of the logical text, so argument errors throw as natively
	const editTextOnScript = (
		text: Text,
		script: Element,
		run: (scratch: Text) => void
	) =>
		editScriptText(text, script, (current) => {
			const doc = client.descriptors.get(
				"Node.prototype.ownerDocument",
				script
			);
			const scratch = client.natives.call(
				"Document.prototype.createTextNode",
				doc,
				current
			);
			run(scratch);
			return childText(scratch);
		});

	// Only prototypes that own the accessor can be trapped: HTMLScriptElement.prototype
	// has no own textContent/innerText, so a trap there would read undefined from ctx.get().
	// Node.prototype.textContent and HTMLElement.prototype.innerText already cover scripts.
	client.Trap(
		["Node.prototype.textContent", "HTMLScriptElement.prototype.text"],
		{
			set(ctx, value) {
				const text = String(value);
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				const node = ctx.this;
				const parent = isText(node) ? parentElementOf(node) : null;
				if (isText(node) && parent && isJsScript(parent)) {
					return editScriptText(node, parent, () => text);
				}
				// the raw node is passed only to client helpers, as rewriteTextForElement(ctx.this) already is
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				const owner = textOwnerFor(ctx.this);
				if (!owner) return ctx.set(text);
				return ctx.set(rewriteTextForElement(owner, text));
			},
			get(ctx) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				const owner = textOwnerFor(ctx.this);
				if (!owner) return ctx.get();
				return getTextForElement(owner, ctx.get());
			},
		}
	);
	client.Trap(["CharacterData.prototype.data", "Node.prototype.nodeValue"], {
		set(ctx, value) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const node = ctx.this;
			if (!isText(node)) return ctx.set(value);
			const text = String(value);
			const parent = parentElementOf(node);
			if (parent && isJsScript(parent)) {
				return editScriptText(node, parent, () => text);
			}
			if (!parent) return ctx.set(text);
			return ctx.set(rewriteTextForElement(parent, text));
		},
		get(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const node = ctx.this;
			if (!client.box.instanceof(node, "Text")) return ctx.get();
			const owner = textOwnerFor(node);
			if (!owner) return ctx.get();
			return getTextForElement(owner, ctx.get());
		},
	});
	client.Trap(["HTMLElement.prototype.innerText"], {
		set(ctx, value: string) {
			const text = String(value);
			return ctx.set(rewriteTextForElement(ctx.this, text));
		},
		get(ctx) {
			return getTextForElement(ctx.this, ctx.get());
		},
	});

	client.Trap("Element.prototype.outerHTML", {
		set(ctx, value: string) {
			const html = String(value);
			if (/scramjet-attr-/i.test(html)) forgedReadBack = true;
			ctx.set(
				rewriteHtml(html, client.context, client.meta, {
					loadScripts: false,
					inline: true,
					source: client.url.href,
					apisource: "set Element.prototype.outerHTML",
					foreignContext: insideForeignContext(client, ctx.this),
				})
			);
		},
		get(ctx) {
			const html = ctx.get();
			const foreign = insideForeignContext(client, ctx.this);
			if (
				foreign === "html" &&
				typeof html === "string" &&
				!htmlNeedsUnrewrite(html)
			)
				return html;

			return unrewriteHtml(html, foreign);
		},
	});

	client.Proxy("Element.prototype.setHTMLUnsafe", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "set Element.prototype.setHTMLUnsafe",
				foreignContext: foreignContextForElement(client, ctx.this),
			});
		},
	});

	client.Trap("ShadowRoot.prototype.innerHTML", {
		set(ctx, value: string) {
			ctx.set(
				rewriteHtml(String(value), client.context, client.meta, {
					loadScripts: false,
					inline: true,
					source: client.url.href,
					apisource: "set ShadowRoot.prototype.innerHTML",
					foreignContext: "html",
				})
			);
		},
		get(ctx) {
			return unrewriteHtml(ctx.get(), "html");
		},
	});

	client.Proxy("ShadowRoot.prototype.setHTMLUnsafe", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "set ShadowRoot.prototype.setHTMLUnsafe",
				foreignContext: "html",
			});
		},
	});

	client.Proxy("Element.prototype.getHTML", {
		apply(ctx) {
			ctx.return(unrewriteHtml(ctx.call()));
		},
	});

	client.Proxy("Element.prototype.insertAdjacentHTML", {
		apply(ctx) {
			const html = String(ctx.args[1]);
			ctx.args[1] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "set Element.prototype.insertAdjacentHTML",
				foreignContext: foreignContextForElement(client, ctx.this),
			});
		},
	});

	// Insertions into a script. The target check runs first, so other nodes pay only the tag check.
	// nodeName is "SCRIPT" for HTML and "script" for SVG; the native getter is cheaper than the realm-wide
	// instanceof walks, and the full check runs only when the name matches
	const nodeNameGetter =
		client.descriptors.store["Node.prototype.nodeName"].get!;
	const isJsScriptNode = (node: any): boolean => {
		const name = nodeNameGetter.call(node);
		return (
			(name === "SCRIPT" || name === "script") &&
			isScriptElement(client, node) &&
			isJsScript(node)
		);
	};

	client.Proxy("Node.prototype.appendChild", {
		apply(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (!isJsScriptNode(ctx.this)) return;
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			ctx.return(insertIntoScript(ctx.this, () => ctx.call(), [ctx.args[0]]));
		},
	});
	client.Proxy("Node.prototype.insertBefore", {
		apply(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (!isJsScriptNode(ctx.this)) return;
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			ctx.return(insertIntoScript(ctx.this, () => ctx.call(), [ctx.args[0]]));
		},
	});
	client.Proxy("Node.prototype.replaceChild", {
		apply(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (!isJsScriptNode(ctx.this)) return;
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			ctx.return(insertIntoScript(ctx.this, () => ctx.call(), [ctx.args[0]]));
		},
	});
	client.Proxy(
		[
			"Element.prototype.append",
			"Element.prototype.prepend",
			"Element.prototype.replaceChildren",
		],
		{
			apply(ctx) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				if (!isJsScriptNode(ctx.this)) return;
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				ctx.return(insertIntoScript(ctx.this, () => ctx.call(), ctx.args));
			},
		}
	);
	client.Proxy("Element.prototype.insertAdjacentText", {
		apply(ctx) {
			// beforebegin and afterend insert into the parent, the other positions into the element
			const position = String(ctx.args[0]).toLowerCase();
			const target =
				position === "beforebegin" || position === "afterend"
					? // eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
						client.descriptors.get("Node.prototype.parentNode", ctx.this)
					: // eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
						ctx.this;
			if (!target || !isJsScriptNode(target)) return;
			ctx.return(insertIntoScript(target, () => ctx.call(), []));
		},
	});

	client.Proxy("Audio", {
		construct(ctx) {
			if (ctx.args[0]) ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});
	client.Proxy("Text.prototype.appendData", {
		apply(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const parent = parentElementOf(ctx.this);
			if (parent && isJsScript(parent)) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				const args = ctx.args;
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				editTextOnScript(ctx.this, parent, (s) =>
					// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
					client.natives.call("CharacterData.prototype.appendData", s, ...args)
				);
				return ctx.return(undefined);
			}
			ctx.args[0] = rewriteTextForElement(parent, String(ctx.args[0]));
		},
	});

	client.Proxy("Text.prototype.insertData", {
		apply(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const parent = parentElementOf(ctx.this);
			if (parent && isJsScript(parent)) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				const args = ctx.args;
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				editTextOnScript(ctx.this, parent, (s) =>
					// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
					client.natives.call("CharacterData.prototype.insertData", s, ...args)
				);
				return ctx.return(undefined);
			}
			ctx.args[1] = rewriteTextForElement(parent, String(ctx.args[1]));
		},
	});

	client.Proxy("Text.prototype.replaceData", {
		apply(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const parent = parentElementOf(ctx.this);
			if (parent && isJsScript(parent)) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				const args = ctx.args;
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				editTextOnScript(ctx.this, parent, (s) =>
					// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
					client.natives.call("CharacterData.prototype.replaceData", s, ...args)
				);
				return ctx.return(undefined);
			}
			ctx.args[2] = rewriteTextForElement(parent, String(ctx.args[2]));
		},
	});

	client.Trap("Text.prototype.wholeText", {
		get(ctx) {
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				ctx.this
			);
			return getTextForElement(parent, ctx.get());
		},
		set(ctx, v) {
			const text = String(v);
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const parent = parentElementOf(ctx.this);
			if (parent && isJsScript(parent)) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				return editScriptText(ctx.this, parent, () => text);
			}
			return ctx.set(rewriteTextForElement(parent, text));
		},
	});

	client.Proxy("HTMLAnchorElement.prototype.toString", {
		apply(ctx) {
			const href = ctx.call();
			if (!href) return href;
			return ctx.return(unrewriteUrl(href, client.context));
		},
	});

	client.Trap(
		[
			"HTMLIFrameElement.prototype.contentWindow",
			"HTMLFrameElement.prototype.contentWindow",
			"HTMLObjectElement.prototype.contentWindow",
			"HTMLEmbedElement.prototype.contentWindow",
		],
		{
			get(ctx) {
				const realwin = ctx.get() as Window;
				if (!realwin) return realwin;

				try {
					if (!(SCRAMJETCLIENT in realwin)) {
						// hook the iframe before the client can start to steal globals out of it
						client.init.hookSubcontext(realwin, ctx.this);
					}
				} catch {
					// cross-origin iframe, can't do anything here
					return realwin;
				}

				return realwin;
			},
		}
	);

	client.Trap(
		[
			"HTMLIFrameElement.prototype.contentDocument",
			"HTMLFrameElement.prototype.contentDocument",
			"HTMLObjectElement.prototype.contentDocument",
			"HTMLEmbedElement.prototype.contentDocument",
		],
		{
			get(ctx) {
				const realwin = client.descriptors.get(
					`${ctx.this.constructor.name}.prototype.contentWindow`,
					ctx.this
				);
				if (!realwin) return realwin;

				if (!(SCRAMJETCLIENT in realwin)) {
					client.init.hookSubcontext(realwin, ctx.this);
				}

				// every proxied site shares one real origin, so the browser's same-origin check
				// passes for another site's frame. refuse it here, as the browser would
				const framed = (realwin as Self)[SCRAMJETCLIENT];
				if (
					framed &&
					framed.url.protocol.startsWith("http") &&
					framed.url.origin !== client.url.origin
				) {
					return null;
				}

				return realwin.document;
			},
		}
	);

	client.Proxy(
		[
			"HTMLIFrameElement.prototype.getSVGDocument",
			"HTMLObjectElement.prototype.getSVGDocument",
			"HTMLEmbedElement.prototype.getSVGDocument",
		],
		{
			apply(ctx) {
				const doc = ctx.call();
				if (doc) {
					// we trap the contentDocument, this is really the scramjet version
					return ctx.return(ctx.this.contentDocument);
				}
			},
		}
	);

	client.Proxy("DOMParser.prototype.parseFromString", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			const mime = String(ctx.args[1]);
			if (!isHtmlMimeType(mime)) {
				// xml and xhtml are parsed by the browser, so rewrite the resulting tree instead
				const doc = ctx.call();
				rewriteParsedDocument(client, doc);
				return ctx.return(doc);
			}
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "DOMParser.prototype.parseFromString",
			});
		},
	});

	client.Proxy(
		[
			"XSLTProcessor.prototype.transformToDocument",
			"XSLTProcessor.prototype.transformToFragment",
		],
		{
			apply(ctx) {
				const result = ctx.call();
				if (result) rewriteParsedDocument(client, result);
				return ctx.return(result);
			},
		}
	);
}
