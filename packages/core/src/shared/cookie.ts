// thnank you node unblocker guy
import { JSON_parse, JSON_stringify } from "@/shared/snapshot";
import { _Date } from "./snapshot";
import parse from "./set-cookie-parser";

export type Cookie = {
	name: string;
	value: string;
	path?: string;
	expires?: number;
	maxAge?: number;
	domain?: string;
	hostOnly?: boolean;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: string; // "strict"|"lax"|"none" or titlecase variants from parsers
};

// a document that may read cookies, by its URL's hostname and pathname
export type CookieObserver = { hostname: string; pathname: string };

export class CookieJar {
	private cookies: Record<string, Cookie> = {};
	// Index by domain (without leading dot)
	private byDomain: Map<string, Cookie[]> = new Map();
	// the last getCookies result, for the same host, path and call options. it stays valid until a
	// cookie in it expires (expiry is the only time-dependent input), and any change to the jar clears it
	private cached: {
		hostname: string;
		pathname: string;
		fromJs: boolean;
		sameSiteContext: string;
		result: string;
		computedAt: number;
		validUntil: number;
	} | null = null;

	private invalidate() {
		this.cached = null;
	}

	private defaultPath(url: URL): string {
		const pathname = url.pathname;
		if (!pathname || !pathname.startsWith("/")) return "/";
		const lastSlash = pathname.lastIndexOf("/");
		if (lastSlash <= 0) return "/";
		return pathname.slice(0, lastSlash);
	}

	private pathMatches(requestPath: string, cookiePath: string): boolean {
		if (requestPath === cookiePath) return true;
		if (!requestPath.startsWith(cookiePath)) return false;
		if (cookiePath.endsWith("/")) return true;
		return requestPath.charAt(cookiePath.length) === "/";
	}

	private indexCookie(c: Cookie) {
		const key = c.domain!.slice(1);
		let bucket = this.byDomain.get(key);
		if (!bucket) {
			bucket = [];
			this.byDomain.set(key, bucket);
		}
		bucket.push(c);
	}

	private unindexCookie(c: Cookie) {
		const key = c.domain!.slice(1);
		const bucket = this.byDomain.get(key);
		if (!bucket) return;
		const i = bucket.indexOf(c);
		if (i >= 0) bucket.splice(i, 1);
		if (bucket.length === 0) this.byDomain.delete(key);
	}

	private removeById(id: string) {
		const prev = this.cookies[id];
		if (prev) this.unindexCookie(prev);
		delete this.cookies[id];
	}

	// whether document.cookie would show this cookie to a document at `observer` (HttpOnly ones it never
	// shows to anyone)
	private shownTo(
		c: Cookie | undefined,
		observer: CookieObserver | undefined
	): boolean {
		if (!c || c.httpOnly) return false;
		if (!observer) return true;
		const domain = c.domain!.slice(1);
		const host = observer.hostname;
		if (
			c.hostOnly
				? host !== domain
				: host !== domain && !host.endsWith("." + domain)
		)
			return false;
		return this.pathMatches(observer.pathname, c.path!);
	}

	/**
	 * Stores the cookies of a Set-Cookie value. Returns whether that changed anything a page can see
	 * through document.cookie (at `observer`, if given): a new cookie, another value or
	 * HttpOnly/Secure flag, an earlier expiry, or a removal. Setting a cookie again as it is (with a
	 * later expiry) changes nothing, and neither does an HttpOnly cookie
	 */
	setCookies(
		cookieString: string,
		url: URL,
		observer?: CookieObserver
	): boolean {
		this.invalidate();
		const parsedCookies = parse(cookieString);
		let visible = false;

		for (const parsedCookie of parsedCookies) {
			const lowerName = parsedCookie.name.toLowerCase();

			if (lowerName.startsWith("__secure-")) {
				if (!parsedCookie.secure) continue;
			} else if (lowerName.startsWith("__host-")) {
				if (!parsedCookie.secure) continue;
				if (parsedCookie.domain) continue;
				if (parsedCookie.path !== "/") continue;
			}

			const hostOnly = !parsedCookie.domain;
			const expiresTime = parsedCookie.expires?.getTime();
			const expires = Number.isFinite(expiresTime) ? expiresTime : undefined;
			const cookie: Cookie = {
				...parsedCookie,
				hostOnly,
				expires,
			};

			if (!cookie.domain) cookie.domain = url.hostname;
			if (!cookie.domain.startsWith(".")) cookie.domain = "." + cookie.domain;
			if (!cookie.path || !cookie.path.startsWith("/")) {
				cookie.path = this.defaultPath(url);
			}
			if (!cookie.sameSite) cookie.sameSite = "lax";

			const id = `${cookie.domain}@${cookie.path}@${cookie.name}`;

			if (typeof cookie.maxAge === "number") {
				if (!Number.isFinite(cookie.maxAge)) {
					delete cookie.maxAge;
				} else if (cookie.maxAge <= 0) {
					if (this.shownTo(this.cookies[id], observer)) visible = true;
					this.removeById(id);
					continue;
				} else {
					cookie.expires = _Date.now() + cookie.maxAge * 1000;
				}
			}

			const prev = this.cookies[id];
			if (
				(this.shownTo(prev, observer) || this.shownTo(cookie, observer)) &&
				(!prev ||
					prev.value !== cookie.value ||
					!!prev.httpOnly !== !!cookie.httpOnly ||
					!!prev.secure !== !!cookie.secure ||
					(cookie.expires ?? Infinity) < (prev.expires ?? Infinity))
			)
				visible = true;
			if (prev) this.unindexCookie(prev);
			this.cookies[id] = cookie;
			this.indexCookie(cookie);
		}
		return visible;
	}

	// SameSite enforcement context passed to getCookies.
	// "strict"     – same-site request; all cookies allowed
	// "lax"        – cross-site top-level GET/HEAD navigation; Strict blocked, Lax+None allowed
	// "cross-site" – cross-site subresource or non-GET navigation; only None allowed
	getCookies(
		url: URL,
		fromJs: boolean,
		sameSiteContext: "strict" | "lax" | "cross-site" = "strict"
	): string {
		const now = _Date.now();
		const hostname = url.hostname;
		const pathname = url.pathname;
		const cached = this.cached;
		if (
			cached !== null &&
			cached.hostname === hostname &&
			cached.pathname === pathname &&
			cached.fromJs === fromJs &&
			cached.sameSiteContext === sameSiteContext &&
			now >= cached.computedAt &&
			now <= cached.validUntil
		)
			return cached.result;
		const validCookies: Cookie[] = [];
		// the earliest expiry among the cookies returned: once it passes, the result can change
		let validUntil = Infinity;

		// Walk the hostname's domain suffix chain
		let key: string | undefined = hostname;
		while (key !== undefined) {
			const bucket = this.byDomain.get(key);
			if (bucket) {
				for (const cookie of bucket) {
					if (cookie.expires !== undefined && cookie.expires < now) continue;

					if (cookie.hostOnly && key !== hostname) continue;

					// Scramjet proxies all origins as HTTPS (including those served over HTTP),
					// so we don't enforce the Secure attribute based on protocol here.
					// if (cookie.secure && url.protocol !== "https:") continue;
					if (cookie.httpOnly && fromJs) continue;
					if (!this.pathMatches(pathname, cookie.path!)) continue;

					// SameSite enforcement — compare case-insensitively since parsers may
					// return "Strict"/"Lax"/"None" (titlecase) or "strict"/"lax"/"none".
					const cs = (cookie.sameSite ?? "lax").toLowerCase();
					if (sameSiteContext === "cross-site") {
						// Only SameSite=None cookies are sent cross-site
						if (cs !== "none") continue;
					} else if (sameSiteContext === "lax") {
						// Lax top-level navigation: block Strict, allow Lax and None
						if (cs === "strict") continue;
					}
					// "strict" context: all cookies allowed (no filtering)

					validCookies.push(cookie);
					if (cookie.expires !== undefined && cookie.expires < validUntil)
						validUntil = cookie.expires;
				}
			}
			const dot = key.indexOf(".");
			key = dot === -1 ? undefined : key.slice(dot + 1);
		}

		const result = validCookies
			.map((cookie) =>
				cookie.name ? `${cookie.name}=${cookie.value}` : cookie.value
			)
			.join("; ");
		this.cached = {
			hostname,
			pathname,
			fromJs,
			sameSiteContext,
			result,
			computedAt: now,
			validUntil,
		};
		return result;
	}

	load(cookies: string | Record<string, Cookie>) {
		this.invalidate();
		if (typeof cookies === "object") {
			console.error("??");
			return;
		}
		const parsed: Record<string, Cookie> = JSON_parse(cookies);
		this.cookies = {};
		this.byDomain.clear();
		const ids = Object.keys(parsed);
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i];
			const c = parsed[id];
			if (typeof c.expires === "string") {
				const t = Date.parse(c.expires as unknown as string);
				c.expires = Number.isFinite(t) ? t : undefined;
			}
			this.cookies[id] = c;
			this.indexCookie(c);
		}
	}

	clear() {
		this.invalidate();
		this.cookies = {};
		this.byDomain.clear();
	}

	dump(): string {
		return JSON_stringify(this.cookies);
	}
}
