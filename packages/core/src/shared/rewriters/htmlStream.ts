import { Parser } from "htmlparser2";
import { DomHandler, Element } from "domhandler";
import render from "dom-serializer";
import { URLMeta } from "@rewriters/url";
import { ScramjetContext, flagEnabled } from "@/shared";
import { Tap } from "@/Tap";
import { sniffEncoding } from "@/shared/sniffEncoding";
import {
	Object_keys,
	Performance_now,
	Promise_all,
	TextEncoder_encode,
	_Map,
	_ReadableStream,
	_Set,
	_TextDecoder,
	_Uint8Array,
} from "@/shared/snapshot";
import {
	HtmlContext,
	INLINE_SCRIPT_URL,
	renderBlockingScript,
	renderOptions,
	rewriteElementAttributes,
	traverseParsedHtml,
} from "./html";
import { rewriteJsOffloaded } from "./js";

/*
 * Streaming HTML rewriter. Its output is byte-identical to rewriteHtml (html.ts) on the whole
 * input. The serializer below mirrors dom-serializer@2 (lib/esm/index.js) with renderOptions
 * (encodeEntities "utf8", decodeEntities false, selfClosingTags false), applied token by token:
 *
 * - the escapers are entities@4.5.0's (lib/escape.js), the version dom-serializer uses;
 * - the foreign name maps are copied from dom-serializer's foreignNames.js;
 * - "mode" is dom-serializer's opts.xmlMode: false, or "foreign" inside <svg>/<math>.
 *
 * <script> and <style> are buffered whole, since their rewrites read the element's text, then
 * rewritten and rendered by the reference traversal and dom-serializer. Everything else is
 * rewritten and written as its tokens arrive.
 */

type Mode = false | "foreign";

const UNENCODED_ELEMENTS = new _Set([
	"style",
	"script",
	"xmp",
	"iframe",
	"noembed",
	"noframes",
	"plaintext",
	"noscript",
]);

const SINGLE_TAG = new _Set([
	"area",
	"base",
	"basefont",
	"br",
	"col",
	"command",
	"embed",
	"frame",
	"hr",
	"img",
	"input",
	"isindex",
	"keygen",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

const FOREIGN_INTEGRATION_POINTS = new _Set([
	"mi",
	"mo",
	"mn",
	"ms",
	"mtext",
	"annotation-xml",
	"foreignObject",
	"desc",
	"title",
]);

const FOREIGN_ELEMENTS = new _Set(["svg", "math"]);

const FOREIGN_ELEMENT_NAMES = new _Map<string, string>([
	["altglyph", "altGlyph"],
	["altglyphdef", "altGlyphDef"],
	["altglyphitem", "altGlyphItem"],
	["animatecolor", "animateColor"],
	["animatemotion", "animateMotion"],
	["animatetransform", "animateTransform"],
	["clippath", "clipPath"],
	["feblend", "feBlend"],
	["fecolormatrix", "feColorMatrix"],
	["fecomponenttransfer", "feComponentTransfer"],
	["fecomposite", "feComposite"],
	["feconvolvematrix", "feConvolveMatrix"],
	["fediffuselighting", "feDiffuseLighting"],
	["fedisplacementmap", "feDisplacementMap"],
	["fedistantlight", "feDistantLight"],
	["fedropshadow", "feDropShadow"],
	["feflood", "feFlood"],
	["fefunca", "feFuncA"],
	["fefuncb", "feFuncB"],
	["fefuncg", "feFuncG"],
	["fefuncr", "feFuncR"],
	["fegaussianblur", "feGaussianBlur"],
	["feimage", "feImage"],
	["femerge", "feMerge"],
	["femergenode", "feMergeNode"],
	["femorphology", "feMorphology"],
	["feoffset", "feOffset"],
	["fepointlight", "fePointLight"],
	["fespecularlighting", "feSpecularLighting"],
	["fespotlight", "feSpotLight"],
	["fetile", "feTile"],
	["feturbulence", "feTurbulence"],
	["foreignobject", "foreignObject"],
	["glyphref", "glyphRef"],
	["lineargradient", "linearGradient"],
	["radialgradient", "radialGradient"],
	["textpath", "textPath"],
]);

const FOREIGN_ATTRIBUTE_NAMES = new _Map<string, string>([
	["definitionurl", "definitionURL"],
	["attributename", "attributeName"],
	["attributetype", "attributeType"],
	["basefrequency", "baseFrequency"],
	["baseprofile", "baseProfile"],
	["calcmode", "calcMode"],
	["clippathunits", "clipPathUnits"],
	["diffuseconstant", "diffuseConstant"],
	["edgemode", "edgeMode"],
	["filterunits", "filterUnits"],
	["glyphref", "glyphRef"],
	["gradienttransform", "gradientTransform"],
	["gradientunits", "gradientUnits"],
	["kernelmatrix", "kernelMatrix"],
	["kernelunitlength", "kernelUnitLength"],
	["keypoints", "keyPoints"],
	["keysplines", "keySplines"],
	["keytimes", "keyTimes"],
	["lengthadjust", "lengthAdjust"],
	["limitingconeangle", "limitingConeAngle"],
	["markerheight", "markerHeight"],
	["markerunits", "markerUnits"],
	["markerwidth", "markerWidth"],
	["maskcontentunits", "maskContentUnits"],
	["maskunits", "maskUnits"],
	["numoctaves", "numOctaves"],
	["pathlength", "pathLength"],
	["patterncontentunits", "patternContentUnits"],
	["patterntransform", "patternTransform"],
	["patternunits", "patternUnits"],
	["pointsatx", "pointsAtX"],
	["pointsaty", "pointsAtY"],
	["pointsatz", "pointsAtZ"],
	["preservealpha", "preserveAlpha"],
	["preserveaspectratio", "preserveAspectRatio"],
	["primitiveunits", "primitiveUnits"],
	["refx", "refX"],
	["refy", "refY"],
	["repeatcount", "repeatCount"],
	["repeatdur", "repeatDur"],
	["requiredextensions", "requiredExtensions"],
	["requiredfeatures", "requiredFeatures"],
	["specularconstant", "specularConstant"],
	["specularexponent", "specularExponent"],
	["spreadmethod", "spreadMethod"],
	["startoffset", "startOffset"],
	["stddeviation", "stdDeviation"],
	["stitchtiles", "stitchTiles"],
	["surfacescale", "surfaceScale"],
	["systemlanguage", "systemLanguage"],
	["tablevalues", "tableValues"],
	["targetx", "targetX"],
	["targety", "targetY"],
	["textlength", "textLength"],
	["viewbox", "viewBox"],
	["viewtarget", "viewTarget"],
	["xchannelselector", "xChannelSelector"],
	["ychannelselector", "yChannelSelector"],
	["zoomandpan", "zoomAndPan"],
]);

// entities@4.5.0 lib/escape.js
const xmlReplacer = /["&'<>$\x80-\uFFFF]/g;
const xmlCodeMap = new _Map([
	[34, "&quot;"],
	[38, "&amp;"],
	[39, "&apos;"],
	[60, "&lt;"],
	[62, "&gt;"],
]);

function encodeXML(str: string): string {
	let ret = "";
	let lastIdx = 0;
	let match: RegExpExecArray | null;
	while ((match = xmlReplacer.exec(str)) !== null) {
		const i = match.index;
		const char = str.charCodeAt(i);
		const next = xmlCodeMap.get(char);
		if (next !== undefined) {
			ret += str.substring(lastIdx, i) + next;
			lastIdx = i + 1;
		} else {
			ret += `${str.substring(lastIdx, i)}&#x${str.codePointAt(i)!.toString(16)};`;
			// a surrogate pair is one code point, so skip its low half
			lastIdx = xmlReplacer.lastIndex += (char & 0xfc00) === 0xd800 ? 1 : 0;
		}
	}
	return ret + str.substr(lastIdx);
}

function getEscaper(regex: RegExp, map: Map<number, string>) {
	return (data: string): string => {
		let match: RegExpExecArray | null;
		let lastIdx = 0;
		let result = "";
		while ((match = regex.exec(data))) {
			if (lastIdx !== match.index) {
				result += data.substring(lastIdx, match.index);
			}
			result += map.get(match[0].charCodeAt(0));
			lastIdx = match.index + 1;
		}
		return result + data.substring(lastIdx);
	};
}

const escapeAttribute = getEscaper(
	/["&\u00A0]/g,
	new _Map([
		[34, "&quot;"],
		[38, "&amp;"],
		[160, "&nbsp;"],
	])
);

const escapeText = getEscaper(
	/[&<>\u00A0]/g,
	new _Map([
		[38, "&amp;"],
		[60, "&lt;"],
		[62, "&gt;"],
		[160, "&nbsp;"],
	])
);

// dom-serializer formatAttributes, with encodeEntities "utf8"
function formatAttributes(
	attribs: Record<string, string | undefined>,
	mode: Mode
) {
	const encode = mode ? encodeXML : escapeAttribute;
	return Object_keys(attribs)
		.map((key) => {
			const value = attribs[key] ?? "";
			const name =
				mode === "foreign" ? (FOREIGN_ATTRIBUTE_NAMES.get(key) ?? key) : key;
			if (!mode && value === "") return name;
			return `${name}="${encode(value)}"`;
		})
		.join(" ");
}

// dom-serializer renderTag, for the start tag only
function startTag(
	name: string,
	attribs: Record<string, string | undefined>,
	mode: Mode
): string {
	const attrs = formatAttributes(attribs, mode);
	return attrs ? `<${name} ${attrs}>` : `<${name}>`;
}

// dom-serializer renderTag, for the end tag: void elements get none in HTML mode
function endTag(name: string, mode: Mode): string {
	return mode || !SINGLE_TAG.has(name) ? `</${name}>` : "";
}

// dom-serializer renderText, with encodeEntities "utf8"
function renderText(data: string, mode: Mode, parentName: string | undefined) {
	if (!mode && parentName !== undefined && UNENCODED_ELEMENTS.has(parentName)) {
		return data;
	}
	return mode ? encodeXML(data) : escapeText(data);
}

type Frame = {
	// the element name as dom-serializer renders it (foreign-mode case fix-up applied)
	name: string;
	// the children's mode, dom-serializer's opts.xmlMode for the children
	mode: Mode;
	// "elem" is written as tags, "replaced" became a comment, "captured" is buffered in a Capture
	kind: "elem" | "replaced" | "captured";
};

type Capture = {
	dom: DomHandler;
	// stack depth while the captured element is open
	depth: number;
	// the parent's children mode and name, which dom-serializer needs to render the element in place
	parentMode: Mode;
	parentName: string | undefined;
};

// output that is still being rewritten elsewhere (a big inline script, see finishCapture)
type Pending = { promise: Promise<void>; text?: string };

// where the scramjet scripts go, decided the way detectQuirks in html.ts decides it:
// "quirks" puts them at the start of the document, "head" at the start of the existing <head>,
// "html" in a new <head> at the start of <html>. "off" when the scripts are not loaded.
type Injection = "undecided" | "quirks" | "head" | "html" | "off";

class HtmlStreamRewriter {
	private readonly parser: Parser;
	private readonly stack: Frame[] = [];
	private capture: Capture | null = null;
	private injection: Injection;
	// a decision made from the first element child of <html> can still change if root-level
	// content follows </html>, and the stream cannot wait for that
	private provisional = false;
	private scriptsHtml: string | undefined;
	// output that waits for the injection decision (only while it is undecided)
	private held = "";
	// length of held just after the root <html> open tag
	private heldHtmlEnd = 0;
	private sawRootHtml = false;
	private pendingAfterHeadOpen: string | undefined;
	private sawBody = false;
	private out = "";
	// output from before the latest pending part, in order: everything in out comes after it
	private queue: (string | Pending)[] = [];

	// root-level content arrived after a provisional decision, so the output may differ from detectQuirks
	lateRootContent = false;

	constructor(
		private readonly context: ScramjetContext,
		private readonly meta: URLMeta,
		private readonly htmlcontext: HtmlContext
	) {
		this.injection = htmlcontext.loadScripts ? "undecided" : "off";
		this.parser = new Parser(
			{
				onopentag: (name, attribs) => this.openTag(name, attribs),
				onclosetag: (name) => this.closeTag(name),
				ontext: (data) => this.text(data),
				oncomment: (data) => this.comment(data),
				oncommentend: () => this.capture?.dom.oncommentend(),
				onprocessinginstruction: (name, data) => this.directive(name, data),
				// the buffered rewriter ignores parser errors too
				onerror: () => {},
			},
			{ startingForeignContext: htmlcontext.foreignContext }
		);
	}

	write(text: string) {
		if (text) this.parser.write(text);
	}

	end() {
		this.parser.end();
		// no <html> element at all: detectQuirks returns true
		if (this.injection === "undecided") this.commitQuirks(false);
	}

	// returns the output produced since the last call, up to the first part still being rewritten
	takeOutput(): string {
		let out = "";
		while (this.queue.length) {
			const part = this.queue[0];
			if (typeof part === "string") out += part;
			else if (part.text !== undefined) out += part.text;
			else return out;
			this.queue.shift();
		}
		out += this.out;
		this.out = "";
		return out;
	}

	/** settles when the first part still being rewritten is done, if there is one */
	firstPending(): Promise<void> | undefined {
		for (const part of this.queue)
			if (typeof part !== "string" && part.text === undefined)
				return part.promise;
		return undefined;
	}

	private emit(s: string) {
		if (this.injection === "undecided") this.held += s;
		else this.out += s;
	}

	private scripts(): string {
		if (this.scriptsHtml === undefined) {
			const nodes = this.context.interface.getInjectScripts(
				this.meta,
				null,
				this.htmlcontext,
				(src) => new Element("script", { src, "scramjet-injected": "true" })
			);
			this.scriptsHtml = nodes
				.map((node) => render(node, renderOptions))
				.join("");
		}
		return this.scriptsHtml;
	}

	// final: the document is quirky whatever comes later (a root-level element other than <html>)
	private commitQuirks(final: boolean) {
		dbg.warn(
			`detected quirky document structure parsing @ ${this.meta.origin.href}!`
		);
		this.injection = "quirks";
		this.provisional = !final;
		this.out += this.scripts() + this.held;
		this.held = "";
	}

	private commitHead() {
		this.injection = "head";
		this.provisional = true;
		this.out += this.held;
		this.held = "";
		this.pendingAfterHeadOpen = this.scripts();
	}

	private commitHtmlStart() {
		this.injection = "html";
		this.provisional = true;
		const head = `<head>${this.scripts()}</head>`;
		this.out +=
			this.held.slice(0, this.heldHtmlEnd) +
			head +
			this.held.slice(this.heldHtmlEnd);
		this.held = "";
	}

	private openTag(name: string, attribs: Record<string, string>) {
		if (this.capture) {
			this.stack.push({ name, mode: false, kind: "captured" });
			this.capture.dom.onopentag(name, attribs);
			return;
		}

		const depth = this.stack.length;
		const parent = depth > 0 ? this.stack[depth - 1] : undefined;

		if (this.injection === "undecided") {
			if (depth === 0) {
				// a root-level element other than <html> makes the document quirky for good
				if (name !== "html") this.commitQuirks(true);
			} else if (name === "head") {
				this.commitHead();
			} else if (name === "body") {
				this.commitHtmlStart();
			} else {
				// first element child of <html> is neither head nor body
				this.commitQuirks(false);
			}
		} else if (
			this.provisional &&
			depth === 0 &&
			(name !== "html" || this.sawRootHtml)
		) {
			this.lateRootContent = true;
		}
		if (depth === 0 && name === "html") this.sawRootHtml = true;

		// dom-serializer renderTag: the name and mode the element is written with
		let mode: Mode = parent ? parent.mode : false;
		let tagName = name;
		if (mode === "foreign") {
			tagName = FOREIGN_ELEMENT_NAMES.get(name) ?? name;
			if (parent && FOREIGN_INTEGRATION_POINTS.has(parent.name)) mode = false;
		}
		if (!mode && FOREIGN_ELEMENTS.has(tagName)) mode = "foreign";

		if (name === "script" || name === "style") {
			this.stack.push({ name: tagName, mode, kind: "captured" });
			const dom = new DomHandler();
			dom.onopentag(name, attribs);
			this.capture = {
				dom,
				depth: this.stack.length,
				parentMode: parent ? parent.mode : false,
				parentName: parent?.name,
			};
			return;
		}

		const replacement = rewriteElementAttributes(
			name,
			attribs,
			this.context,
			this.meta
		);
		if (replacement) {
			this.emit(`<!--${replacement.data}-->`);
			this.stack.push({ name: tagName, mode, kind: "replaced" });
			return;
		}

		this.emit(startTag(tagName, attribs, mode));
		if (this.pendingAfterHeadOpen !== undefined) {
			this.out += this.pendingAfterHeadOpen;
			this.pendingAfterHeadOpen = undefined;
		}
		if (depth === 0 && name === "html") this.heldHtmlEnd = this.held.length;
		// the first <body> in <html> starts with renderBlockingScript, as in the buffered rewrite
		if (
			name === "body" &&
			depth === 1 &&
			!this.sawBody &&
			parent?.name === "html" &&
			(this.injection === "head" || this.injection === "html")
		) {
			this.sawBody = true;
			if (flagEnabled("renderBlocking", this.context, this.meta.base))
				this.emit(render(renderBlockingScript(), renderOptions));
		}
		this.stack.push({ name: tagName, mode, kind: "elem" });
	}

	private closeTag(_name: string) {
		if (this.capture) {
			this.capture.dom.onclosetag();
			this.stack.pop();
			if (this.stack.length < this.capture.depth) this.finishCapture();
			return;
		}

		const frame = this.stack.pop();
		if (!frame || frame.kind === "replaced") return;

		// </html> (or the end of input) with no element child: detectQuirks puts the new head first in <html>
		if (this.injection === "undecided" && this.stack.length === 0) {
			this.commitHtmlStart();
		}

		this.emit(endTag(frame.name, frame.mode));
	}

	private finishCapture() {
		const { dom, parentMode, parentName } = this.capture!;
		this.capture = null;

		const element = dom.root.children[0] as Element;
		// dom-serializer reads only the parent's name, from elem.parent, to render the element
		element.parent = { name: parentName } as unknown as Element["parent"];
		const options = { ...renderOptions, xmlMode: parentMode };
		// big inline scripts are rewritten on the rewriter threads, and what follows waits for them.
		// usually one, but in foreign content a script's text is markup, which can hold more
		const offloaded: Promise<void>[] = [];
		traverseParsedHtml(element, this.context, this.meta, (node, js, isModule) => {
			const job = rewriteJsOffloaded(
				js,
				INLINE_SCRIPT_URL,
				this.context,
				this.meta,
				isModule
			);
			if (!job) return false;
			offloaded.push(job.then((rewritten) => void (node.children[0].data = rewritten)));
			return true;
		});
		if (!offloaded.length) {
			this.emit(render(element, options));
			return;
		}
		const part: Pending = {
			promise: Promise_all(offloaded).then(() => {
				part.text = render(element, options);
			}),
		};
		// the injection is decided before any <script> is captured, so this output isn't held
		this.queue.push(this.out, part);
		this.out = "";
	}

	private text(data: string) {
		if (this.capture) {
			this.capture.dom.ontext(data);
			return;
		}
		const parent =
			this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
		this.emit(renderText(data, parent ? parent.mode : false, parent?.name));
	}

	private comment(data: string) {
		if (this.capture) this.capture.dom.oncomment(data);
		else this.emit(`<!--${data}-->`);
	}

	private directive(name: string, data: string) {
		if (this.capture) this.capture.dom.onprocessinginstruction(name, data);
		else this.emit(`<${data}>`);
	}
}

// the buffered rewriter's sniff and decode need the first bytes before any text can be parsed
const SNIFF_BYTES = 1024;

function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
	if (chunks.length === 1) return chunks[0];
	const out = new _Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

// the stream's chunks are read in microtasks, one after another while they are queued, so a
// document arriving faster than it is rewritten would hold the thread (the controller's, which also
// answers the page's other requests) until its end. after this much work, the rewrite waits for a
// task, so the requests queued meanwhile (the stylesheets the document needs first) go through.
// a cold first document can take 100ms+ to rewrite
const SLICE_MS = 4;
const _MessageChannel = globalThis.MessageChannel;

// one channel for every yield on this thread: a new channel per yield cost ~0.5ms in a worker
let yieldPorts: MessageChannel | undefined;
const yieldWaiters: (() => void)[] = [];

function yieldToTasks(): Promise<void> {
	if (!yieldPorts) {
		yieldPorts = new _MessageChannel();
		// each message ends one yield, in order
		yieldPorts.port1.onmessage = () => {
			yieldWaiters.shift()?.();
			// in node, a port with a listener keeps the process alive: only while a yield waits
			if (!yieldWaiters.length) (yieldPorts!.port1 as any).unref?.();
		};
	}
	if (!yieldWaiters.length) (yieldPorts.port1 as any).ref?.();
	return new Promise((resolve) => {
		yieldWaiters.push(resolve);
		yieldPorts!.port2.postMessage(null);
	});
}

/**
 * Whether documents can be streamed: the html pre/post hooks see the whole tree, so any plugin
 * on them keeps the buffered path.
 */
export function canStreamHtml(context: ScramjetContext): boolean {
	const hooks = context.hooks?.rewriter.html;
	return !hooks || (!Tap.hasTaps(hooks.pre) && !Tap.hasTaps(hooks.post));
}

/**
 * Rewrites a document somewhere else (one of the controller's rewriter threads), so the thread
 * handling requests keeps answering the ones for the document's stylesheets and scripts while it
 * streams. Takes what rewriteHtmlStream takes, and the srcs of the scripts to inject, which this
 * thread makes (they carry its cookie jar). Returns null, without touching the body, to have the
 * document rewritten here instead.
 */
export type HtmlRewriteOffload = (
	body: ReadableStream<Uint8Array>,
	contentType: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext,
	injectScripts: string[]
) => ReadableStream<Uint8Array> | null;

let htmlRewriteOffload: HtmlRewriteOffload | null = null;

/** routes streamed document rewrites (rewriteHtmlStreamOffloaded) through `offload` */
export function setHtmlRewriteOffload(offload: HtmlRewriteOffload | null) {
	htmlRewriteOffload = offload;
}

/** rewriteHtmlStream, on the offload when there is one that takes the document */
export function rewriteHtmlStreamOffloaded(
	body: ReadableStream<Uint8Array>,
	contentType: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
): ReadableStream<Uint8Array> {
	if (htmlRewriteOffload) {
		const injectScripts = htmlcontext.loadScripts
			? (context.interface.getInjectScripts(
					meta,
					null,
					htmlcontext,
					(src) => src as any
				) as unknown as string[])
			: [];
		const out = htmlRewriteOffload(
			body,
			contentType,
			context,
			meta,
			htmlcontext,
			injectScripts
		);
		if (out) return out;
	}

	return rewriteHtmlStream(body, contentType, context, meta, htmlcontext);
}

/**
 * Rewrites an HTML response body as it arrives. The concatenated output is byte-identical to
 * rewriteHtml on the whole body, encoded as UTF-8 like the buffered path's string body.
 */
export function rewriteHtmlStream(
	body: ReadableStream<Uint8Array>,
	contentType: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const started = Performance_now();
	let sniffChunks: Uint8Array[] = [];
	let sniffLength = 0;
	let decoder: TextDecoder | undefined;
	let rewriter: HtmlStreamRewriter | undefined;

	const begin = (prefix: Uint8Array) => {
		decoder = new _TextDecoder(sniffEncoding(prefix, contentType));
		rewriter = new HtmlStreamRewriter(context, meta, htmlcontext);
	};

	// when this run of work started: reset by a yield, or by a read that had to wait for data
	let sliceStart = Performance_now();
	// the input has ended: what's left is the output still queued
	let finished = false;

	return new _ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				/* eslint-disable no-await-in-loop */
				for (;;) {
					if (_MessageChannel && Performance_now() - sliceStart > SLICE_MS) {
						await yieldToTasks();
						sliceStart = Performance_now();
					}
					if (rewriter) {
						const out = rewriter.takeOutput();
						if (out) {
							controller.enqueue(TextEncoder_encode(out));
							return;
						}
						// an inline script is being rewritten elsewhere: its output comes first
						const pending = rewriter.firstPending();
						if (pending) {
							await pending;
							sliceStart = Performance_now();
							continue;
						}
						if (finished) {
							controller.close();
							return;
						}
					}
					const before = Performance_now();
					const { done, value } = await reader.read();
					const after = Performance_now();
					if (after - before > 1) sliceStart = after;

					if (done) {
						if (!rewriter) {
							const prefix = concatBytes(sniffChunks, sniffLength);
							begin(prefix);
							rewriter!.write(decoder!.decode(prefix, { stream: true }));
						}
						rewriter!.write(decoder!.decode());
						rewriter!.end();
						if (flagEnabled("rewriterLogs", context, meta.base)) {
							dbg.time(meta, started, "html rewrite (stream)");
						}
						if (rewriter!.lateRootContent) {
							dbg.warn(
								`streamed html rewrite saw root-level content after </html> @ ${meta.origin.href}; the injected scripts may differ from the buffered rewrite`
							);
						}
						// the rest of the output, once any pending parts are done, then the end
						finished = true;
						continue;
					}

					let text: string;
					if (rewriter) {
						text = decoder!.decode(value, { stream: true });
					} else {
						sniffChunks.push(value);
						sniffLength += value.length;
						if (sniffLength < SNIFF_BYTES) continue;
						const prefix = concatBytes(sniffChunks, sniffLength);
						sniffChunks = [];
						begin(prefix);
						text = decoder!.decode(prefix, { stream: true });
					}

					// the output (if any yet: it can be held for the injection point) is taken above
					rewriter!.write(text);
				}
				/* eslint-enable no-await-in-loop */
			} catch (err) {
				controller.error(err);
				reader.cancel(err).catch(() => {});
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}
