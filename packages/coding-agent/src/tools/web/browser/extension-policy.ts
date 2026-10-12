/**
 * Security policy for the `app.extension` browser backend.
 *
 * The backend drives the operator's signed-in Chrome through the Playwright Extension. These
 * rules keep a local process or a web page from steering that browser. HTTP and HTTPS navigation
 * is open except for production hosts.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import { getAgentDir } from "@veyyon/utils";

/** The extension id of Playwright Extension 0.4.0 in the Chrome Web Store. */
export const PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";

/** The relay protocol version the pinned extension speaks (its connect page enforces it). */
export const EXTENSION_PROTOCOL_VERSION = 2;

/** Environment variable with extra allowed origins, comma separated. */
export const EXTENSION_ALLOW_ENV = "VEYYON_BROWSER_EXTENSION_ALLOW";

 * matched anywhere in the host; the domains are matched exactly (a staging subdomain can still
 * be allowed).
 */
const PRODUCTION_HOST_FRAGMENTS: readonly string[] = ["zaraprptkegxqpvnsubu", "akamai-iad-prod"];
const PRODUCTION_HOSTS: readonly string[] = [
	"polysimulator.com",
	"www.polysimulator.com",
	"app.polysimulator.com",
	"api.polysimulator.com",
];

/** CDP domains a session may use. Everything else (`Browser`, `Storage`, `DOMStorage`, `IndexedDB`, `Fetch`, ...) is refused. */
const ALLOWED_CDP_DOMAINS: ReadonlySet<string> = new Set([
	"Audits",
	"Page",
	"Runtime",
	"DOM",
	"DOMSnapshot",
	"CSS",
	"Accessibility",
	"Input",
	"Emulation",
	"Log",
	"Network",
	"Performance",
	"Inspector",
]);

/** Methods refused even inside an allowed domain: they export cookies, storage or page snapshots, or change downloads. */
const DENIED_CDP_METHODS: ReadonlySet<string> = new Set([
	"Page.printToPDF",
	"Page.captureSnapshot",
	"Page.setDownloadBehavior",
	"Page.generateTestReport",
	"Network.getAllCookies",
	"Network.getCookies",
	"Network.setCookie",
	"Network.setCookies",
	"Network.deleteCookies",
	"Network.clearBrowserCookies",
	"Network.clearBrowserCache",
	"Network.loadNetworkResource",
	"Network.streamResourceContent",
	"Network.getResponseBodyForInterception",
	"Network.takeResponseBodyForInterceptionAsStream",
	"Network.enableReportingApi",
	"Network.setRequestInterception",
]);

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };


/** True for `127.0.0.1`, `[::1]`, `::1` and `localhost`. */
export function isLoopbackHost(host: string): boolean {
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (bare === "::1" || bare === "localhost") return true;
	return /^127(?:\.\d{1,3}){3}$/.test(bare);
}

/** Refuse a relay URL that does not point at the loopback interface. */
export function assertLoopbackUrl(rawUrl: string): void {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error("The relay URL is not a valid URL.");
	}
	if (parsed.protocol !== "ws:" && parsed.protocol !== "http:") {
		throw new Error(`The relay URL must use ws: or http:, not ${parsed.protocol}`);
	}
	if (!isLoopbackHost(parsed.hostname)) {
		throw new Error("The relay must listen on the loopback interface only (127.0.0.1 or [::1]).");
	}
}

/** A fresh random secret, 32 bytes as base64url. */
export function generateSecret(): string {
	return crypto.randomBytes(32).toString("base64url");
}

/** Compare two secrets without leaking where they differ. Missing or unequal values never match. */
export function secretsEqual(expected: string, actual: string | undefined): boolean {
	if (actual === undefined || actual.length === 0 || expected.length === 0) return false;
	const a = crypto.createHash("sha256").update(expected).digest();
	const b = crypto.createHash("sha256").update(actual).digest();
	return crypto.timingSafeEqual(a, b);
}

/**
 * Normalize a hostname for matching: lowercase, no trailing dots. `URL` has already applied IDNA
 * (punycode) and removed the port and userinfo.
 */
export function normalizeHost(hostname: string): string {
	return hostname.toLowerCase().replace(/\.+$/, "");
}


/**
 * Decide whether the browser may load `rawUrl`. HTTP and HTTPS URLs pass unless they target a
 * refused production host. `about:blank` is always allowed.
 */
export function checkNavigation(rawUrl: string): PolicyDecision {
	if (rawUrl === "about:blank") return { allowed: true };
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { allowed: false, reason: `The URL is not valid: ${rawUrl.slice(0, 80)}` };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { allowed: false, reason: `The extension backend does not load ${url.protocol} URLs.` };
	}
	const host = normalizeHost(url.hostname);
	if (isProductionHost(host)) {
		return { allowed: false, reason: `${host} is a production host and is never allowed.` };
	}
	return { allowed: true };
}

/**
 * Refuse a CDP command that is not on the allowlist. Default deny: a domain not listed in
 * `ALLOWED_CDP_DOMAINS` is refused, and so is every method in `DENIED_CDP_METHODS`.
 */
export function checkCdpMethod(method: string): PolicyDecision {
	const dot = method.indexOf(".");
	const domain = dot < 0 ? "" : method.slice(0, dot);
	if (DENIED_CDP_METHODS.has(method)) {
		return { allowed: false, reason: `${method} is blocked on the extension backend; it would export profile data.` };
	}
	if (ALLOWED_CDP_DOMAINS.has(domain)) return { allowed: true };
	return { allowed: false, reason: `${method} is not on the extension backend's CDP allowlist.` };
}

export function extensionStateDir(): string {
	return path.join(getAgentDir(), "browser-extension");
}



/** Name used in file names for one Chrome profile. Only letters, digits, dot, dash and underscore survive. */
export function instanceFileName(instance: string | undefined): string {
	const name = (instance ?? "default").replace(/[^A-Za-z0-9._-]/g, "_");
	return name.length > 0 ? name : "default";
}

function tokenFilePath(instance: string | undefined): string {
	return path.join(extensionStateDir(), `${instanceFileName(instance)}.token`);
}

/** Store the extension's token for one profile. The file is private to the user. */
export function writeExtensionToken(instance: string | undefined, token: string): void {
	const file = tokenFilePath(instance);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, token.trim(), { mode: 0o600 });
}

export function readExtensionToken(instance: string | undefined): string | undefined {
	}
	return out;
}
