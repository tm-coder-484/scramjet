/**
 * Version information for the current Scramjet build.
 * Contains both the semantic version string and the git commit hash for build identification.
 */
export interface ScramjetVersionInfo {
	/** The semantic version */
	version: string;
	/** The git commit hash that this build was created from */
	build: string;
	/** The date of the build */
	date: string;
}

/**
 * Scramjet Feature Flags, configured at build time
 */
export type ScramjetFlags = {
	syncxhr: boolean;
	disableComputedWrap: boolean;
	rewriterLogs: boolean;
	captureErrors: boolean;
	cleanErrors: boolean;
	scramitize: boolean;
	sourcemaps: boolean;
	destructureRewrites: boolean;
	allowInvalidJs: boolean;
	allowFailedIntercepts: boolean;
	debugTrampolines: boolean;
	debugSourceURL: boolean;
	encapsulateWorkers: boolean;
	viewTransitions: boolean;
	rewriteCache: boolean;
	renderBlocking: boolean;
	/** send the CORS preflights a browser would, and fail the requests they don't allow */
	corsPreflight: boolean;
};

export interface ScramjetConfig {
	globals: {
		wrapfn: string;
		wrappropertybase: string;
		wrappropertyfn: string;
		cleanrestfn: string;
		importfn: string;
		rewritefn: string;
		metafn: string;
		wrappostmessagefn: string;
		pushsourcemapfn: string;
		trysetfn: string;
		templocid: string;
		tempunusedid: string;
	};
	flags: ScramjetFlags;
	siteFlags: Record<string, Partial<ScramjetFlags>>;
	maskedfiles: string[];
	/**
	 * TURN servers that every RTCPeerConnection must relay through. WebRTC media
	 * otherwise goes straight from the browser to the peer, bypassing the proxy (and
	 * exposing the user's IP). When set, sites only get relay candidates from these
	 * servers; their own ice servers are dropped.
	 */
	webrtcRelay?: RTCIceServer[] | null;
}

/**
 * The config for Scramjet initialization.
 */
export interface ScramjetInitConfig
	extends Omit<ScramjetConfig, "codec" | "flags"> {
	flags: Partial<ScramjetFlags>;
	codec: {
		encode: (url: string) => string;
		decode: (url: string) => string;
	};
}

//eslint-disable-next-line
export type AnyFunction = Function;
