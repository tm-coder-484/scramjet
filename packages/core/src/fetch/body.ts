import { BareResponse } from "@mercuryworkshop/proxy-transports";
import {
	BodyType,
	ScramjetFetchHandler,
	ScramjetFetchParsed,
	ScramjetFetchRequest,
} from ".";
import {
	flagEnabled,
	isHtmlMimeType,
	isJavascriptMimeType,
	rewriteCss,
	rewriteHtml,
	rewriteJsCached,
	rewriteWorkers,
} from "@/shared";
import { sniffEncoding } from "@/shared/sniffEncoding";
import { _TextDecoder } from "@/shared/snapshot";
import {
	canStreamHtml,
	rewriteHtmlStreamOffloaded,
} from "@/shared/rewriters/htmlStream";

export async function rewriteBody(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	response: BareResponse
): Promise<BodyType> {
	switch (parsed.destination) {
		case "iframe":
		case "document":
			if (isHtmlMimeType(response.headers.get("content-type") ?? "")) {
				// stream the document unless a plugin needs the whole tree (see canStreamHtml)
				if (response.body && canStreamHtml(handler.context)) {
					return rewriteHtmlStreamOffloaded(
						response.body,
						response.headers.get("content-type"),
						handler.context,
						parsed.meta,
						{
							loadScripts: true,
							inline: true,
							source: parsed.url.href,
							headers: response.rawHeaders,
							history: parsed.trackedClient!.history,
						}
					);
				}

				const buf = await response.arrayBuffer();
				const bytes = new Uint8Array(buf);
				const encoding = sniffEncoding(
					bytes,
					response.headers.get("content-type")
				);
				const htmlContent = new _TextDecoder(encoding).decode(bytes);

				return rewriteHtml(htmlContent, handler.context, parsed.meta, {
					loadScripts: true,
					inline: true,
					source: parsed.url.href,
					headers: response.rawHeaders,
					// reasonably confident that a document fetch is impossible without a client
					history: parsed.trackedClient!.history,
				});
			} else {
				return response.body;
			}
		case "script": {
			// do not attempt to rewrite a 404 response
			if (response.ok) {
				const ct = response.headers.get("content-type");
				// don't rewrite invalid module scripts when the server declares a non-JS type
				if (parsed.isModule && ct && !isJavascriptMimeType(ct)) {
					return response.body;
				}

				let rewritten = await rewriteJsCached(
					new Uint8Array(await response.arrayBuffer()),
					response.url,
					handler.context,
					parsed.meta,
					parsed.isModule
				);

				if (
					flagEnabled("debugSourceURL", handler.context, parsed.meta.origin)
				) {
					if (rewritten instanceof Uint8Array) {
						rewritten = new TextDecoder().decode(rewritten);
					}
					rewritten += `\n//# sourceURL=${parsed.url.href}`;
				}

				// the rewriter's output is always its own copy: as an ArrayBuffer, the controller
				// transfers it to the service worker instead of copying it
				if (
					typeof rewritten !== "string" &&
					rewritten.byteOffset === 0 &&
					rewritten.byteLength === rewritten.buffer.byteLength
				)
					return rewritten.buffer as ArrayBuffer;

				return rewritten as unknown as ArrayBuffer;
			}
			return response.body;
		}
		case "style":
			return rewriteCss(await response.text(), handler.context, parsed.meta);
		case "sharedworker":
		case "worker":
			return await rewriteWorkers(
				new Uint8Array(await response.arrayBuffer()),
				response.url,
				handler.context,
				parsed.meta,
				parsed.isModule
			);
		default:
			return response.body;
	}
}
