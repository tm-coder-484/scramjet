import LoadInterstitial from "./components/LoadInterstitial";
import App from "./App";
import LibcurlClient from "@mercuryworkshop/libcurl-transport";
import EpoxyClient from "@mercuryworkshop/epoxy-transport";
import { defaultConfigDev } from "@mercuryworkshop/scramjet";
import { Controller } from "@mercuryworkshop/scramjet-controller";
import { HttpCachePlugin } from "@mercuryworkshop/scramjet-utils";
import { demoSettingsStore, getRelayUrl, getWebrtcRelay } from "./store";

let app = document.getElementById("app")!;

// Retries of a proxied url that the service worker missed, shared by this tab's documents.
// A count older than RETRY_WINDOW_MS starts over, so the limit only bounds a burst of failures.
const RETRY_KEY = "scramjet-proxy-retry";
const MAX_RETRIES = 3;
const RETRY_WINDOW_MS = 30000;

function takeRetry(): boolean {
	try {
		const [count, at] = (sessionStorage.getItem(RETRY_KEY) ?? "0|0").split("|");
		const n = Date.now() - Number(at) < RETRY_WINDOW_MS ? Number(count) : 0;
		if (n >= MAX_RETRIES) return false;
		sessionStorage.setItem(RETRY_KEY, `${n + 1}|${Date.now()}`);
		return true;
	} catch {
		return false;
	}
}

// This app must never mount inside its own site frame: the frame then shows a second omnibox.
function isNestedInDemo(): boolean {
	if (window.parent === window) return false;
	try {
		return !!window.parent.document.querySelector("form.url-form");
	} catch {
		return false;
	}
}

// Retry the frame's url through the service worker, which handles it after a reload.
function recoverNestedDemo() {
	if (!takeRetry() || !navigator.serviceWorker) {
		app.innerText =
			"Could not load this page through the proxy. Reload the tab to try again.";
		return;
	}
	navigator.serviceWorker.ready.then(() =>
		setTimeout(() => location.reload(), 1000)
	);
}

let controller: InstanceType<typeof Controller>;
const cachePlugin = new HttpCachePlugin();

export function getTransport(): LibcurlClient | EpoxyClient {
	const wispUrl = demoSettingsStore.wispUrl;
	switch (demoSettingsStore.transport) {
		case "epoxy":
			return new EpoxyClient({ wisp: wispUrl });
		case "libcurl":
		default:
			return new LibcurlClient({ wisp: wispUrl });
	}
}

/**
 * The relay transport runs with the controller in a worker, so requests never wait on this
 * page's main thread, which the proxied site shares. The worker builds its own transport and
 * plugins from these (they're serialized, so they can't close over anything here).
 */
function getRelayWorker() {
	return {
		scripts: ["/utils/scramjet-utils.js"],
		transport: `() => new $scramjetUtils.RelayTransport({ url: ${JSON.stringify(getRelayUrl())}, prefetch: true, cache: true, rewriteCache: true })`,
		// the worker's frames get the fetch-hook plugins this page would otherwise install
		setupFrame: `(frame) => {
			new $scramjetUtils.HttpCachePlugin().install(frame);
			new $scramjetUtils.CatchEscapedLinksPlugin(
				(url) => new URL("/?goto=" + encodeURIComponent(url.href), location.origin)
			).install(frame);
		}`,
	};
}

async function waitForControllerOrReady(timeoutMs = 10000): Promise<void> {
	if (navigator.serviceWorker.controller) return;

	const ready = navigator.serviceWorker.ready.then(() => {});
	const controllerChanged = new Promise<void>((resolve) => {
		const onChange = () => {
			navigator.serviceWorker.removeEventListener("controllerchange", onChange);
			resolve();
		};
		navigator.serviceWorker.addEventListener("controllerchange", onChange, {
			once: true,
		} as any);
	});
	const timeout = new Promise<void>((resolve) =>
		setTimeout(resolve, timeoutMs)
	);

	// Wait for whichever happens first; on timeout we continue to avoid blocking the UI.
	await Promise.race([ready, controllerChanged, timeout]);
}

async function init() {
	const interstitial: any = (
		<LoadInterstitial status={"Loading"}></LoadInterstitial>
	);
	document.body.append(interstitial);
	interstitial.showModal();

	try {
		const registration = await navigator.serviceWorker.register("./sw.js");

		// Non-blocking progress updates on state transitions.
		const updateStatus = (sw: ServiceWorker | null) => {
			if (!sw) return;
			const set = (msg: string) => (interstitial.$.state.status = msg);
			const apply = () => {
				switch (sw.state) {
					case "installing":
						set("Installing service worker...");
						break;
					case "installed":
						set("Service worker installed, waiting to activate...");
						break;
					case "activating":
						set("Activating service worker...");
						break;
					case "activated":
						set("Service worker activated");
						break;
					case "redundant":
						set("Service worker became redundant");
						break;
				}
			};
			apply();
			sw.addEventListener("statechange", apply);
		};

		updateStatus(registration.installing ?? registration.waiting ?? null);

		// Wait for control or readiness with a timeout; don't hang the UI on updates.
		interstitial.$.state.status =
			"Waiting for service worker to take control...";
		await waitForControllerOrReady(10000);
		interstitial.$.state.status =
			"Service worker ready, waiting for controller init";
		const readySw = navigator.serviceWorker.controller ?? registration.active;
		if (!readySw) {
			throw new Error("No service worker available for controller");
		}
		controller = new Controller({
			serviceworker: readySw,
			...(demoSettingsStore.transport === "relay"
				? { worker: getRelayWorker() }
				: { transport: getTransport() }),
			scramjetConfig: { ...defaultConfigDev, webrtcRelay: getWebrtcRelay() },
		});
		await controller.wait();
		console.log(controller);
		interstitial.$.state.status = "Controller initialized";
		interstitial.close();
	} catch (e) {
		console.error("Error during service worker registration:", e);
		// Always close the modal on error to prevent hanging UI.
		try {
			interstitial.close();
		} catch {}
		app.innerText =
			"Failed to register service worker. Check console for details.";
	}
}

async function mount() {
	try {
		const root = <App />;
		app.replaceWith(root);
	} catch (e) {
		let err = e as any;
		app.replaceWith(
			document.createTextNode(
				`Error mounting: ${"message" in err ? err.message : err}`
			)
		);
		console.error(err);
		throw e;
	}
}

if (isNestedInDemo()) {
	recoverNestedDemo();
} else {
	init().then(() => mount());
}
export { controller, cachePlugin };
