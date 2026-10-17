import { viteStaticCopy } from "vite-plugin-static-copy";
import type { Plugin } from "vite";

// Proxied urls (/~/sj/...) belong to the service worker. When it misses one, Vite's SPA
// fallback answers with the demo app, which then loads inside the site frame. Answer with a
// page that retries the same url once the service worker is ready instead (index.tsx has the
// matching guard for the demo itself).
const proxyMissPage = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>Loading</title>
		<style>
			body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; background: #fff; color: #222; }
			@media (prefers-color-scheme: dark) { body { background: #1b1b1f; color: #eee; } }
		</style>
	</head>
	<body>
		<p id="status">Loading through the proxy...</p>
		<script>
			(function () {
				var KEY = "scramjet-proxy-retry", MAX = 3, WINDOW = 30000;
				var status = document.getElementById("status");
				function fail(msg) { status.textContent = msg; }
				function takeRetry() {
					try {
						var parts = (sessionStorage.getItem(KEY) || "0|0").split("|");
						var n = Date.now() - Number(parts[1]) < WINDOW ? Number(parts[0]) : 0;
						if (n >= MAX) return false;
						sessionStorage.setItem(KEY, n + 1 + "|" + Date.now());
						return true;
					} catch (e) {
						return false;
					}
				}
				var msg = "Could not load this page through the proxy. Reload the tab to try again.";
				if (!takeRetry() || !navigator.serviceWorker) return fail(msg);
				var timeout = new Promise(function (_, reject) { setTimeout(reject, 10000); });
				Promise.race([navigator.serviceWorker.ready, timeout]).then(
					function () { setTimeout(function () { location.reload(); }, 1000); },
					function () { fail(msg); }
				);
			})();
		</script>
	</body>
</html>
`;

const proxyMiss: Plugin = {
	name: "scramjet-proxy-miss",
	configureServer(server) {
		// registered before Vite's own middlewares, so this runs ahead of the SPA fallback
		server.middlewares.use((req, res, next) => {
			if (
				!req.url?.startsWith("/~/sj/") ||
				!req.headers.accept?.includes("text/html")
			) {
				return next();
			}
			res.statusCode = 503;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.setHeader("Cache-Control", "no-store");
			res.end(proxyMissPage);
		});
	},
};

export default {
	plugins: [
		proxyMiss,
		viteStaticCopy({
			structured: false,
			targets: [
				{
					src: "node_modules/@mercuryworkshop/scramjet/dist/*",
					dest: "scramjet",
				},
				{
					src: "node_modules/@mercuryworkshop/scramjet-controller/dist/*",
					dest: "controller",
				},
				// loaded into the controller worker for the relay transport and plugins
				{
					src: "node_modules/@mercuryworkshop/scramjet-utils/dist/*",
					dest: "utils",
				},
			],
			watch: {
				reloadPageOnChange: true,
			},
		}),
	],
};
