import { basicTest, serverTest } from "../testcommon.ts";
// historical regressions

export default [
	// scramjet/core
	// non-JS <script> data islands (Spotify, GitHub) read undefined from textContent/innerText
	// because HTMLScriptElement.prototype had a trap with no own accessor to read from
	basicTest({
		name: "regression-script-data-island-textcontent",
		js: `
			const json = document.createElement("script");
			json.type = "application/json";
			json.textContent = '{"a":1,"b":[2,3]}';
			document.head.appendChild(json);
			assertEqual(json.textContent, '{"a":1,"b":[2,3]}', "json textContent");
			assertEqual(json.innerText, '{"a":1,"b":[2,3]}', "json innerText");
			assertEqual(JSON.parse(json.textContent).b[1], 3, "json parses");

			const plain = document.createElement("script");
			plain.type = "text/plain";
			plain.id = "plain-island";
			plain.textContent = "hello island";
			document.head.appendChild(plain);
			assertEqual(document.getElementById("plain-island").textContent, "hello island", "plain textContent");

			const js = document.createElement("script");
			js.textContent = "window.__r4Ran = 7;";
			document.head.appendChild(js);
			assertEqual(js.textContent, "window.__r4Ran = 7;", "js textContent returns source");
			assertEqual(js.text, "window.__r4Ran = 7;", "js text returns source");
			assertEqual(window.__r4Ran, 7, "js script ran");

			js.textContent = "window.__r4Ran = 8;";
			assertEqual(js.text, "window.__r4Ran = 8;", "text set after creation reads back");

			const s = document.createElement("script");
			s.type = "text/plain";
			s.textContent = "before";
			s.textContent = "after";
			assertEqual(s.textContent, "after", "second write on non-JS script");
		`,
	}),

	// scramjet/core
	// introduced by: ?
	// fixed by: https://github.com/HeyPuter/browser.js/commit/1715a6aeb072284b58ce38f807f1b14f5151dd7a
	basicTest({
		name: "regression-1715-for-body-walk",
		js: `
            const a = {top: 1, parent: 2, location: 3, eval: 4};
            for (let x in a) {
                checkglobal(window[x]);
            }
            for (let x in a) checkglobal(window[x]);

            const b = ["top", "parent", "location", "eval"];
            for (const x of b) {
                checkglobal(window[x]);
            }
            for (const x of b) checkglobal(window[x]);
    `,
	}),

	// scramjet/core
	// introduced by: ?
	// fixed by: https://github.com/HeyPuter/browser.js/commit/ae35b473dd2cbb0b76d3098e9a748e296cedf425
	basicTest({
		name: "regression-ae35-optional-postmessage",
		js: `
        const messages = [];
        const fakeTarget = {
          postMessage: (msg) => messages.push(msg)
        };
        fakeTarget?.postMessage("test");
        assertEqual(messages.length, 1, "optional postMessage should work");

        const nullTarget = null;
        nullTarget?.postMessage("test");
        assertEqual(messages.length, 1, "null optional should not call");
      `,
	}),

	// scramjet/rewriter
	// tree would be culled if destructure_rewrites was off and a destructure happened
	// introduced by: ?
	// fixed by https://github.com/HeyPuter/browser.js/commit/09f823c9573f9cdd09bc94663a384ace9816fd4c
	// related issue: https://discord.com/channels/1259284248129437726/1457141828557078592
	basicTest({
		name: "regression-09f823c-rewriter-culled",
		js: `
			let [a, b] = (checkglobal(top), [0,1]);
			([b, c] = (checkglobal(top), [0,1]));
			let { d } = (checkglobal(top), ({a: 2}));
			({ d } = (checkglobal(top), ({a:1})));
		`,
	}),

	// scramjet/rewriter
	// crash on overlapping CleanFunction and importfn
	// TODO: this only happens when destructure_rewrites is on. harness does not let you set flags
	// introduced by: ?
	// fixed by https://github.com/HeyPuter/browser.js/commit/09f823c9573f9cdd09bc94663a384ace9816fd4c
	// related issue: https://discord.com/channels/1259284248129437726/1457141828557078592
	basicTest({
		name: "regression-09f823c-rewriter-crash",
		js: `
			()=>import("data:text/javascript,checkglobal(top)")
		`,
	}),

	// scramjet/html
	// module script metadata must stay in scramjet's reserved query params.
	// Leaking it as an upstream type=module query can make module graphs load twice.
	serverTest({
		name: "regression-module-script-query-does-not-leak",
		scramjetOnly: true,
		async start(server) {
			let depRequests = 0;
			server.on("request", (req, res) => {
				if (req.url === "/") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`
						<!doctype html>
						<script type="importmap">
							{
								"imports": {
									"#dep": "/dep.js?real=1"
								}
							}
						</script>
						<link rel="modulepreload" crossorigin href="/dep.js?real=1">
						<script type="module" src="/mod.js?real=1"></script>
					`);
					return;
				}

				if (req.url?.startsWith("/mod.js")) {
					const url = new URL(req.url, "http://test.invalid");
					res.writeHead(200, { "Content-Type": "application/javascript" });
					if (url.searchParams.get("real") !== "1") {
						res.end(
							`window.fail("original module script query was not preserved")`
						);
					} else if (url.searchParams.has("type")) {
						res.end(
							`window.fail("scramjet module marker leaked upstream", { search: ${JSON.stringify(url.search)} })`
						);
					} else {
						res.end(`
							import "#dep";
							setTimeout(async () => {
								const depRequests = await fetch("/dep-count").then((res) => res.text());
								if (depRequests === "1") window.pass("module URLs canonicalized without leaking proxy metadata");
								else window.fail("modulepreload and import produced duplicate upstream requests", { depRequests });
							});
						`);
					}
					return;
				}

				if (req.url?.startsWith("/dep.js")) {
					depRequests++;
					const url = new URL(req.url, "http://test.invalid");
					res.writeHead(200, { "Content-Type": "application/javascript" });
					if (url.searchParams.get("real") !== "1") {
						res.end(
							`window.fail("original module dependency query was not preserved")`
						);
					} else if (url.searchParams.has("type")) {
						res.end(
							`window.fail("scramjet module marker leaked upstream from dependency", { search: ${JSON.stringify(url.search)} })`
						);
					} else {
						res.end(`export default 1;`);
					}
					return;
				}

				if (req.url === "/dep-count") {
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.end(String(depRequests));
					return;
				}

				res.writeHead(404);
				res.end("not found");
			});
		},
	}),

	// scramjet/core/rewriter
	// non-computed keys of a destructured objects were wrapped with $scramjet$prop, causing invalid syntax
	// fixed by https://github.com/HeyPuter/browser.js/commit/7d4be594f2c49a447252e0a520ff0e144bef28b2
	basicTest({
		name: "regression-09f823c-rewriter-destructure-invalid-syntax",
		autoPass: false,
		js: `
			({
				'0': a,
				1: b,
				2n: c,
				false: d,
			} = {
				'0': 1,
				1: 2,
				2n: 3,
				false: 4,
			});

			assertEqual(a, 1);
			assertEqual(b, 2);
			assertEqual(c, 3);
			assertEqual(d, 4);

			({ '0': location } = { '0': "javascript:checkglobal(top)" });
			({ 0: location } = { 0: "javascript:checkglobal(top)" });
			({ 0n: location } = { 0n: "javascript:checkglobal(top)" });
			({ false: location } = { false: "javascript:checkglobal(top)" });

			const {
				'0': e,
				1: f,
				2n: h,
				false: g,
			} = {
				'0': 1,
				1: 2,
				2n: 3,
				false: 4,
			};
			assertEqual(e, 1);
			assertEqual(f, 2);
			assertEqual(h, 3);
			assertEqual(g, 4);

			pass();
		`,
	}),

	// scramjet/core
	// History.prototype.pushState / replaceState used the proxy's closure `client`
	// instead of the client owning `ctx.this`, so a displaced call resolved the
	// relative URL against the wrong frame.
	// lead to youtube.com search breaking in chrome
	// fixed by https://github.com/HeyPuter/browser.js/commit/1b988b4b53fac31c6627fd011d13028b9daff78c
	serverTest({
		name: "regression-1b988b4-displaced-history-pushstate",
		scramjetOnly: true,
		async start(server) {
			server.on("request", (req, res) => {
				if (req.url === "/") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`
						<!doctype html>
						<html>
						<head></head>
						<body>
							<script>
								runTest(async () => {
									const iframe = document.createElement('iframe');
									iframe.src = '/sub/page.html';
									document.body.appendChild(iframe);
									await new Promise((r) => iframe.addEventListener('load', r, { once: true }));

									// displaced call: parent's pushState proxy with iframe.history as \`this\`.
									// the relative URL must resolve against the iframe's URL (/sub/page.html),
									// not the parent's URL (/).
									history.pushState.call(iframe.contentWindow.history, {}, '', 'pushed');
									assertEqual(
										iframe.contentWindow.location.pathname,
										'/sub/pushed',
										"displaced pushState must resolve url against the target history's owning client"
									);

									history.replaceState.call(iframe.contentWindow.history, {}, '', 'replaced');
									assertEqual(
										iframe.contentWindow.location.pathname,
										'/sub/replaced',
										"displaced replaceState must resolve url against the target history's owning client"
									);

									pass();
								}, false);
							</script>
						</body>
						</html>
					`);
					return;
				}
				if (req.url === "/sub/page.html") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						"<!doctype html><html><head></head><body><p>iframe page</p></body></html>"
					);
					return;
				}
				res.writeHead(404);
				res.end("not found");
			});
		},
	}),

	// scramjet/core
	// computed keys named location/parent/top/eval were rewritten to the $scramjet__ alias even on
	// null-prototype dictionaries, which have no Object.prototype getter to resolve the alias
	basicTest({
		name: "regression-nullproto-computed-keys",
		js: `
            for (const key of ["location", "parent", "top", "eval"]) {
                const dict = Object.create(null);
                dict[key] = key + "-value";
                assertEqual(dict[key], key + "-value", "null-proto read of " + key);
                assertEqual(key in dict, true, "null-proto has " + key);
                delete dict[key];
                assertEqual(dict[key], undefined, "null-proto delete of " + key);

                const fn = Object.create(null);
                fn[key] = () => "called " + key;
                assertEqual(fn[key](), "called " + key, "null-proto call of " + key);

                const plain = {};
                plain[key] = key + "-plain";
                assertEqual(plain[key], key + "-plain", "plain object read of " + key);

                const viaThis = Object.create(null);
                viaThis[key] = 7;
                assertEqual((function () { return this[key]; }).call(viaThis), 7, "this receiver for " + key);
            }
            // the receiver form must not hand out the real window or location
            assertEqual(window["location"].href, location.href, "window[location] stays proxied");
            assertEqual(document["location"].href, location.href, "document[location] stays proxied");
            assertEqual(self["location"].href, location.href, "self[location] stays proxied");
        `,
	}),
];
