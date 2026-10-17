import { URLMeta, rewriteUrl, unrewriteUrl } from "@rewriters/url";
import { ScramjetContext } from "@/shared";
import { String } from "@/shared/snapshot";

export function rewriteCss(
	css: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	return handleCss("rewrite", css, context, meta);
}

export function unrewriteCss(css: string, context: ScramjetContext) {
	return handleCss("unrewrite", css, context);
}

function handleCss(
	type: "rewrite" | "unrewrite",
	css: string,
	context: ScramjetContext,
	meta?: URLMeta
) {
	// regex from vk6 (https://github.com/ading2210)
	// block comments are matched too, so that a url() inside one is left alone. url() is matched
	// in any case with [uU][rR][lL], not a (?i:) group: those are new (Chrome 125, Node 23), and a
	// bundle that has one fails to load anywhere older
	const urlRegex =
		/\/\*[\s\S]*?\*\/|[uU][rR][lL]\((?:\s*"((?:\\.|[^"])+)"\s*|\s*'((?:\\.|[^'])+)'\s*|((?!\s*['"])(?!\s*\))(?:\\.|[^)])+?))\)/gm;
	const Atruleregex =
		/@import\s+([uU][rR][lL]\s*?\(.{0,9999}?\)|['"].{0,9999}?['"]|.{0,9999}?)($|\s|;)/gm;
	css = String(css);
	css = css.replace(
		urlRegex,
		(
			match,
			doubleQuotedUrl: string | undefined,
			singleQuotedUrl: string | undefined,
			unquotedUrl: string | undefined
		) => {
			if (match.startsWith("/*")) return match;
			const url = doubleQuotedUrl ?? singleQuotedUrl ?? unquotedUrl;
			const encodedUrl =
				type === "rewrite"
					? rewriteUrl(url.trim(), context, meta!)
					: unrewriteUrl(url.trim(), context);

			return match.replace(url, encodedUrl);
		}
	);
	css = css.replace(Atruleregex, (match, importStatement: string) => {
		return match.replace(
			importStatement,
			importStatement.replace(
				/^(url\(['"]?|['"]|)(.+?)(['"]|['"]?\)|)$/gm,
				(match: string, firstQuote: string, url: string, endQuote: string) => {
					if (firstQuote.startsWith("url")) {
						return match;
					}
					const encodedUrl =
						type === "rewrite"
							? rewriteUrl(url.trim(), context, meta!)
							: unrewriteUrl(url.trim(), context);

					return `${firstQuote}${encodedUrl}${endQuote}`;
				}
			)
		);
	});

	return css;
}
