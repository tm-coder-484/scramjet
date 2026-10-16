import http from "http";
import type { AddressInfo } from "node:net";
import type { Test } from "../testcommon.ts";

// Each test runs twice at once, through scramjet and through bare Chromium, against the same two
// servers. The servers can't tell the two runs apart, and a verdict a server reaches is the verdict
// both runs get. So the servers never decide: every request the page makes carries the run's ID
// (`run=`), the servers keep what each run sent, and each page asks for its own run's record
// (`/verify`) and decides from that.

type Seen = {
	method: string;
	headers: http.IncomingHttpHeaders;
};

type Preflight = {
	status: number;
	headers: Record<string, string>;
};

type Outcome = Record<string, any>;

type Check = (args: {
	/** what the target received for this run, in arrival order */
	seen: Seen[];
	/** what the page's requests reported */
	outcome: Outcome;
	/** the page's origin */
	origin: string;
}) => string | undefined;

function listen(server: http.Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, () => {
			resolve((server.address() as AddressInfo).port);
		});
	});
}

function close(server?: http.Server): Promise<void> {
	if (!server) return Promise.resolve();

	return new Promise((resolve) => {
		server.closeAllConnections?.();
		server.close(() => resolve());
	});
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of req) body += chunk;
	return body;
}

function sequence(seen: Seen[]): string {
	return seen.map((s) => s.method).join(",");
}

function expectSequence(seen: Seen[], expected: string): string | undefined {
	const actual = sequence(seen);
	if (actual === expected) return undefined;
	return `the target received ${actual || "nothing"}, expected ${expected}`;
}

// whether a preflight is what a browser sends before `method` (with `requestHeaders`, if any)
function preflightProblem(
	preflight: Seen,
	origin: string,
	method: string,
	requestHeaders?: string
): string | undefined {
	const h = preflight.headers;
	if (h.origin !== origin)
		return `the preflight's Origin is ${h.origin}, expected ${origin}`;
	if (h["access-control-request-method"] !== method)
		return `the preflight's Access-Control-Request-Method is ${h["access-control-request-method"]}, expected ${method}`;
	if (
		requestHeaders !== undefined &&
		h["access-control-request-headers"] !== requestHeaders
	)
		return `the preflight's Access-Control-Request-Headers is ${h["access-control-request-headers"]}, expected ${requestHeaders}`;
	if (h.cookie !== undefined)
		return `the preflight carried a Cookie header: ${h.cookie}`;
	return undefined;
}

function headerProblem(
	request: Seen,
	name: string,
	expected: string
): string | undefined {
	const actual = request.headers[name];
	if (actual === expected) return undefined;
	return `the target got ${name}: ${actual ?? "nothing"} on ${request.method}, expected ${expected}`;
}

function okProblem(outcome: Outcome): string | undefined {
	if (outcome.ok === true) return undefined;
	return `the page's request did not resolve OK: ${JSON.stringify(outcome)}`;
}

function corsPreflightTest(props: {
	name: string;
	/** the page fetches its own server, so there is no second origin */
	sameOrigin?: boolean;
	/** the page's host has a cookie, which no preflight may carry */
	cookie?: boolean;
	/** the page's requests, as a function body run in the page; returns what they reported */
	page: string;
	/** the target's answer to OPTIONS (default: 204, allowing the page's origin) */
	preflight?: (origin: string) => Preflight;
	/** the target's answer to the request itself (default: text/plain "ok") */
	response?: { contentType: string; body: string };
	check: Check;
}): Test {
	let sourceServer: http.Server | undefined;
	let targetServer: http.Server | undefined;
	let sourcePort = 0;
	let targetPort = 0;
	// what each run's requests did at the servers, by run ID
	const runs = new Map<string, Seen[]>();

	const origin = () => `http://localhost:${sourcePort}`;
	const targetOrigin = () =>
		props.sameOrigin ? origin() : `http://localhost:${targetPort}`;

	// the target: records the request under its run, then answers it with CORS headers for the page
	const answer = async (
		req: http.IncomingMessage,
		res: http.ServerResponse
	) => {
		const run =
			new URL(req.url ?? "/", "http://localhost").searchParams.get("run") ??
			"";
		const seen = runs.get(run) ?? [];
		seen.push({ method: req.method ?? "", headers: req.headers });
		runs.set(run, seen);
		await readBody(req);

		if (req.method === "OPTIONS") {
			const reply = props.preflight?.(origin()) ?? {
				status: 204,
				headers: { "Access-Control-Allow-Origin": origin() },
			};
			res.writeHead(reply.status, reply.headers);
			res.end();
			return;
		}
		res.writeHead(200, {
			"Access-Control-Allow-Origin": origin(),
			"Content-Type": props.response?.contentType ?? "text/plain",
		});
		res.end(props.response?.body ?? "ok");
	};

	const clearCookie = props.cookie
		? `try { document.cookie = "runway_cors_probe=; Max-Age=0; Path=/"; } catch (e) {}`
		: "";

	const page = () => `<!doctype html>
<html><body><script>
runTest(async () => {
	const runId = Math.random().toString(36).slice(2) + Date.now().toString(36);
	const target = (path) => ${JSON.stringify(targetOrigin())} + path + "?run=" + runId;
	const within = (promise, what) =>
		Promise.race([
			promise,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error(what + " did not finish within 10s")), 10000)
			),
		]);
	let outcome;
	try {
		outcome = await within((async () => {
			${props.page}
		})(), "the request");
		// a request that should not have been sent still has time to show up before the verdict
		await new Promise((resolve) => setTimeout(resolve, 300));
	} finally {
		${clearCookie}
	}
	const problem = await within(
		fetch("/verify?run=" + runId, { method: "POST", body: JSON.stringify(outcome) }).then((r) => r.text()),
		"the verdict"
	);
	if (problem) throw new Error(problem);
}, true);
</script></body></html>`;

	const test: Test = {
		name: props.name,
		port: 0,
		async start() {
			sourceServer = http.createServer(async (req, res) => {
				const url = new URL(req.url ?? "/", "http://localhost");

				if (url.pathname === "/") {
					res.writeHead(200, {
						"Content-Type": "text/html",
						...(props.cookie
							? { "Set-Cookie": "runway_cors_probe=1; Path=/" }
							: {}),
					});
					res.end(page());
					return;
				}

				if (url.pathname === "/inspect") {
					await answer(req, res);
					return;
				}

				if (url.pathname === "/verify") {
					const run = url.searchParams.get("run") ?? "";
					const seen = runs.get(run) ?? [];
					runs.delete(run);
					const outcome: Outcome = JSON.parse(await readBody(req));
					const problem =
						props.check({ seen, outcome, origin: origin() }) ?? "";
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.end(problem);
					return;
				}

				res.writeHead(404);
				res.end("Not found");
			});

			sourcePort = await listen(sourceServer);
			if (!props.sameOrigin) {
				targetServer = http.createServer(async (req, res) => {
					if (new URL(req.url ?? "/", "http://localhost").pathname !== "/inspect") {
						res.writeHead(404);
						res.end("Not found");
						return;
					}
					await answer(req, res);
				});
				targetPort = await listen(targetServer);
			}
			test.port = sourcePort;
		},
		async stop() {
			runs.clear();
			await Promise.all([close(sourceServer), close(targetServer)]);
		},
	};

	return test;
}

export default [
	corsPreflightTest({
		name: "cors-preflight-custom-header",
		cookie: true,
		page: `
			const res = await fetch(target("/inspect"), { headers: { "X-Custom": "1" } });
			return { ok: res.ok, status: res.status };
		`,
		preflight: (origin) => ({
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Headers": "x-custom",
			},
		}),
		check: ({ seen, outcome, origin }) =>
			expectSequence(seen, "OPTIONS,GET") ??
			preflightProblem(seen[0], origin, "GET", "x-custom") ??
			headerProblem(seen[1], "x-custom", "1") ??
			okProblem(outcome),
	}),

	corsPreflightTest({
		name: "cors-preflight-simple-request-skipped",
		page: `
			const plain = await fetch(target("/inspect"));
			const post = await fetch(target("/inspect"), {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "hello",
			});
			return { ok: plain.ok && post.ok };
		`,
		check: ({ seen, outcome }) =>
			expectSequence(seen, "GET,POST") ??
			headerProblem(seen[1], "content-type", "text/plain") ??
			okProblem(outcome),
	}),

	corsPreflightTest({
		name: "cors-preflight-rejected",
		page: `
			try {
				const res = await fetch(target("/inspect"), { headers: { "X-Custom": "1" } });
				return { rejected: false, status: res.status, body: (await res.text()).slice(0, 300) };
			} catch (err) {
				return { rejected: true, name: err.name, message: String(err.message) };
			}
		`,
		// allows the origin, but not the request header: no Access-Control-Allow-Headers
		preflight: (origin) => ({
			status: 204,
			headers: { "Access-Control-Allow-Origin": origin },
		}),
		check: ({ seen, outcome, origin }) => {
			// the one thing that must never happen comes first
			const sent = seen.filter((s) => s.method !== "OPTIONS");
			if (sent.length)
				return `the target received ${sequence(sent)} after refusing the preflight`;
			if (seen.length !== 1)
				return `expected one OPTIONS preflight, the target received ${sequence(seen) || "nothing"}`;
			if (!outcome.rejected)
				return `the page's fetch resolved (${JSON.stringify(outcome)}); it should have failed with a network error`;
			if (outcome.name !== "TypeError")
				return `the page's fetch rejected with ${outcome.name}, expected TypeError`;
			return preflightProblem(seen[0], origin, "GET", "x-custom");
		},
	}),

	corsPreflightTest({
		name: "cors-preflight-put-method",
		page: `
			const res = await fetch(target("/inspect"), { method: "PUT" });
			return { ok: res.ok, status: res.status };
		`,
		preflight: (origin) => ({
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Methods": "PUT",
			},
		}),
		check: ({ seen, outcome, origin }) =>
			expectSequence(seen, "OPTIONS,PUT") ??
			preflightProblem(seen[0], origin, "PUT") ??
			okProblem(outcome),
	}),

	corsPreflightTest({
		name: "cors-preflight-max-age-cache",
		page: `
			const first = await fetch(target("/inspect"), { headers: { "X-Custom": "1" } });
			const second = await fetch(target("/inspect"), { headers: { "X-Custom": "1" } });
			return { ok: first.ok && second.ok };
		`,
		preflight: (origin) => ({
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Headers": "x-custom",
				"Access-Control-Max-Age": "600",
			},
		}),
		check: ({ seen, outcome, origin }) =>
			expectSequence(seen, "OPTIONS,GET,GET") ??
			preflightProblem(seen[0], origin, "GET", "x-custom") ??
			headerProblem(seen[1], "x-custom", "1") ??
			headerProblem(seen[2], "x-custom", "1") ??
			okProblem(outcome),
	}),

	corsPreflightTest({
		name: "cors-preflight-same-origin-skipped",
		sameOrigin: true,
		page: `
			const res = await fetch(target("/inspect"), { headers: { "X-Custom": "1" } });
			return { ok: res.ok, status: res.status };
		`,
		check: ({ seen, outcome }) =>
			expectSequence(seen, "GET") ??
			headerProblem(seen[0], "x-custom", "1") ??
			okProblem(outcome),
	}),

	corsPreflightTest({
		name: "cors-preflight-wildcard-covers-authorization",
		// Fetch says a `*` in Access-Control-Allow-Headers doesn't cover Authorization; Chromium
		// lets it, and APIs that take bearer tokens rely on that
		page: `
			const res = await fetch(target("/inspect"), { headers: { Authorization: "Bearer runway" } });
			return { ok: res.ok, status: res.status };
		`,
		preflight: () => ({
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "*",
			},
		}),
		check: ({ seen, outcome, origin }) =>
			expectSequence(seen, "OPTIONS,GET") ??
			preflightProblem(seen[0], origin, "GET", "authorization") ??
			headerProblem(seen[1], "authorization", "Bearer runway") ??
			okProblem(outcome),
	}),

	corsPreflightTest({
		name: "cors-preflight-eventsource-skipped",
		// an EventSource's request carries the browser's own Cache-Control (and Last-Event-ID when
		// it reconnects), which aren't the page's and never make it ask
		page: `
			return await new Promise((resolve) => {
				const es = new EventSource(target("/inspect"));
				es.onmessage = (e) => { es.close(); resolve({ message: e.data }); };
				es.onerror = () => { es.close(); resolve({ error: true }); };
			});
		`,
		// a server that doesn't answer preflights at all, as many event-stream endpoints don't
		preflight: () => ({ status: 405, headers: {} }),
		response: { contentType: "text/event-stream", body: "data: hi\n\n" },
		check: ({ seen, outcome }) =>
			expectSequence(seen, "GET") ??
			headerProblem(seen[0], "accept", "text/event-stream") ??
			(outcome.message === "hi"
				? undefined
				: `the EventSource got ${JSON.stringify(outcome)}, expected the message "hi"`),
	}),

	corsPreflightTest({
		name: "cors-preflight-xhr",
		page: `
			const status = await new Promise((resolve, reject) => {
				const xhr = new XMLHttpRequest();
				xhr.open("GET", target("/inspect"));
				xhr.setRequestHeader("X-Custom", "1");
				xhr.onload = () => resolve(xhr.status);
				xhr.onerror = () => reject(new TypeError("the XMLHttpRequest failed"));
				xhr.send();
			});
			return { ok: status === 200, status };
		`,
		preflight: (origin) => ({
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Headers": "x-custom",
			},
		}),
		check: ({ seen, outcome, origin }) =>
			expectSequence(seen, "OPTIONS,GET") ??
			preflightProblem(seen[0], origin, "GET", "x-custom") ??
			headerProblem(seen[1], "x-custom", "1") ??
			okProblem(outcome),
	}),
];
