import { serverTest } from "../testcommon.ts";

// Scripts of 16 KB and up are rewritten on the controller's rewriter threads, and from 64 KB on
// they go through the rewrite cache. The rewriter's sourcemap call is put in front of them as
// bytes, after a "use strict" directive if they start with one: the directive has to stay the
// script's first statement, or the script silently stops being strict.

// ~200 KB of statements after `head`, then a check of strict mode against `strict`
const bigScript = (head: string, strict: boolean) => {
	let filler = "";
	for (let i = 0; i < 8000; i++) filler += `var filler${i} = ${i} * 2;\n`;
	return `${head}
${filler}
(function () {
	var isStrict = (function () { return this === undefined; })();
	if (isStrict === ${strict}) window.pass("strict mode as written: " + isStrict);
	else window.fail("strict mode changed by the rewrite", { isStrict: isStrict });
})();
`;
};

const bigScriptTest = (name: string, body: () => Buffer) =>
	serverTest({
		name,
		scramjetOnly: true,
		async start(server) {
			server.on("request", (req, res) => {
				if (req.url === "/") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`<!doctype html><script src="/big.js"></script>`);
					return;
				}
				if (req.url === "/big.js") {
					res.writeHead(200, { "Content-Type": "application/javascript" });
					res.end(body());
					return;
				}
				res.writeHead(404);
				res.end();
			});
		},
	});

export default [
	bigScriptTest("bigscripts-use-strict-stays-first", () =>
		Buffer.from(bigScript(`"use strict";`, true))
	),
	bigScriptTest("bigscripts-sloppy-stays-sloppy", () =>
		Buffer.from(bigScript(`// no directive`, false))
	),
	bigScriptTest("bigscripts-use-strict-after-bom", () =>
		Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from(bigScript(`'use strict'`, true)),
		])
	),
	// past the bytes the rewriter looks at for the directive
	bigScriptTest("bigscripts-use-strict-after-long-whitespace", () =>
		Buffer.from(bigScript(`${" \n\t".repeat(200)}"use strict";`, true))
	),
	bigScriptTest("bigscripts-use-strict-non-ascii-before", () =>
		Buffer.from(bigScript(`  \n"use strict";`, true))
	),
];
