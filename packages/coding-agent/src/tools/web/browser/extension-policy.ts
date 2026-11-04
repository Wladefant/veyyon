/**
 * Security policy for the `app.extension` browser backend.
 *
 * Navigation allows HTTP and HTTPS origins except for production hosts. The module also keeps
 * transport checks, CDP restrictions, and per-profile token handling.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@veyyon/utils";

/** The extension id of Playwright Extension 0.4.0 in the Chrome Web Store. */
export const PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";

/** The relay protocol version the pinned extension speaks (its connect page enforces it). */
export const EXTENSION_PROTOCOL_VERSION = 2;

const PRODUCTION_HOST_FRAGMENTS: readonly string[] = ["zaraprptkegxqpvnsubu", "akamai-iad-prod"];
const PRODUCTION_HOSTS: readonly string[] = [
	"polysimulator.com",
	"www.polysimulator.com",
	"app.polysimulator.com",
	"api.polysimulator.com",
];

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
	"Network.setBypassServiceWorker",
	"Page.setBypassCSP",
	"Page.removeScriptToEvaluateOnNewDocument",
	"Page.addScriptToEvaluateOnNewDocument",
]);

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

export function isLoopbackHost(host: string): boolean {
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (bare === "::1" || bare === "localhost") return true;
	return /^127(?:\.\d{1,3}){3}$/.test(bare);
}

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

export function generateSecret(): string {
	return crypto.randomBytes(32).toString("base64url");
}

export function secretsEqual(expected: string, actual: string | undefined): boolean {
	if (actual === undefined || actual.length === 0 || expected.length === 0) return false;
	const a = crypto.createHash("sha256").update(expected).digest();
	const b = crypto.createHash("sha256").update(actual).digest();
	return crypto.timingSafeEqual(a, b);
}

export function normalizeHost(hostname: string): string {
	return hostname.toLowerCase().replace(/\.+$/, "");
}

function isProductionHost(host: string): boolean {
	if (PRODUCTION_HOSTS.includes(host)) return true;
	return PRODUCTION_HOST_FRAGMENTS.some(fragment => host.includes(fragment));
}

export function isProductionUrl(rawUrl: string): boolean {
	try {
		return isProductionHost(normalizeHost(new URL(rawUrl).hostname));
	} catch {
		return false;
	}
}

/** Allows HTTP and HTTPS navigation except for production hosts. */
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
	if (isProductionHost(host)) return { allowed: false, reason: `${host} is a production host and is never allowed.` };
	return { allowed: true };
}

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

export function instanceFileName(instance: string | undefined): string {
	const name = (instance ?? "default").replace(/[^A-Za-z0-9._-]/g, "_");
	return name.length > 0 ? name : "default";
}

function tokenFilePath(instance: string | undefined): string {
	return path.join(extensionStateDir(), `${instanceFileName(instance)}.token`);
}

export function writeExtensionToken(instance: string | undefined, token: string): void {
	const file = tokenFilePath(instance);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, token.trim(), { mode: 0o600 });
}

export function readExtensionToken(instance: string | undefined): string | undefined {
	const file = tokenFilePath(instance);
	if (!fs.existsSync(file)) return undefined;
	const token = fs.readFileSync(file, "utf8").trim();
	return token.length > 0 ? token : undefined;
}

export function hasExtensionToken(instance: string | undefined): boolean {
	return readExtensionToken(instance) !== undefined;
}

export function removeExtensionToken(instance: string | undefined): boolean {
	const file = tokenFilePath(instance);
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file, { force: true });
	return true;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length >= 8) out = out.split(secret).join("[redacted]");
	}
	return out;
}

const SENSITIVE_URL_PARAM =
	/(?:token|secret|password|passwd|auth|credential|cookie|session|code|api[-_]?key|access[-_]?key|signature|(?:^|[-_])key(?:$|[-_])|(?:^|[-_])state(?:$|[-_]))/i;

/** Redact URL credentials and sensitive values before an inventory row reaches tool output. */
export function redactTabInventoryUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "[URL omitted]";
	}
	if (url.username) url.username = "[redacted]";
	if (url.password) url.password = "[redacted]";
	for (const key of [...url.searchParams.keys()]) {
		if (SENSITIVE_URL_PARAM.test(key)) url.searchParams.set(key, "[redacted]");
	}
	if (url.hash) {
		const fragment = new URLSearchParams(url.hash.slice(1));
		let redacted = false;
		for (const key of [...fragment.keys()]) {
			if (!SENSITIVE_URL_PARAM.test(key)) continue;
			fragment.set(key, "[redacted]");
			redacted = true;
		}
		if (redacted) url.hash = fragment.toString();
	}
	return url.toString();
}
