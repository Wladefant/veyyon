/**
 * Security policy for the `app.extension` browser backend.
 *
 * The backend drives the operator's signed-in Chrome through the Playwright Extension. These
 * rules keep a local process or a web page from steering that browser, and keep an agent away
 * from hosts it was not given. Everything here is pure except `loadExtensionPolicy`, which
 * reads one JSON file and one environment variable.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@veyyon/utils";
import { type } from "arktype";

/** The extension id of Playwright Extension 0.4.0 in the Chrome Web Store. */
export const PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";

/** The relay protocol version the pinned extension speaks (its connect page enforces it). */
export const EXTENSION_PROTOCOL_VERSION = 2;

/** Environment variable with extra allowed origins, comma separated. */
export const EXTENSION_ALLOW_ENV = "VEYYON_BROWSER_EXTENSION_ALLOW";

/**
 * Hosts and fragments that are never reachable, whatever the allowlist says. The two ids are
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

/** Commands that would export data out of the operator's profile. Refused on every session. */
const BLOCKED_CDP_METHODS: ReadonlySet<string> = new Set([
	"Page.printToPDF",
	"Network.getAllCookies",
	"Network.getCookies",
	"Storage.getCookies",
]);

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

export interface ExtensionPolicy {
	/** Allowed origins (`https://host`) and host patterns (`host`, `*.host`). */
	readonly allow: readonly string[];
}

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

/** The host of a URL, or undefined when the text is not a URL. */
function hostOf(rawUrl: string): string | undefined {
	try {
		return new URL(rawUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function isProductionHost(host: string): boolean {
	if (PRODUCTION_HOSTS.includes(host)) return true;
	return PRODUCTION_HOST_FRAGMENTS.some(fragment => host.includes(fragment));
}

function patternMatches(pattern: string, url: URL): boolean {
	const entry = pattern.trim().toLowerCase();
	if (entry.length === 0) return false;
	if (entry.includes("://")) return url.origin.toLowerCase() === entry.replace(/\/+$/, "");
	if (entry.startsWith("*.")) {
		const suffix = entry.slice(1);
		return url.hostname.toLowerCase().endsWith(suffix) && url.hostname.length > suffix.length;
	}
	return url.hostname.toLowerCase() === entry;
}

/**
 * Decide whether the browser may load `rawUrl`. Default deny: only `about:blank` and entries of the
 * allowlist pass, and production hosts never pass.
 */
export function checkNavigation(policy: ExtensionPolicy, rawUrl: string): PolicyDecision {
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
	const host = hostOf(rawUrl);
	if (host !== undefined && isProductionHost(host)) {
		return { allowed: false, reason: `${host} is a production host and is never allowed.` };
	}
	if (policy.allow.some(entry => patternMatches(entry, url))) return { allowed: true };
	return {
		allowed: false,
		reason: `${url.origin} is not on the extension allowlist. Add it to ${EXTENSION_ALLOW_ENV} or to allow[] in ${policyFilePath()}.`,
	};
}

/** Refuse a CDP command that exports profile data. */
export function checkCdpMethod(method: string): PolicyDecision {
	if (BLOCKED_CDP_METHODS.has(method)) {
		return { allowed: false, reason: `${method} is blocked on the extension backend; it would export profile data.` };
	}
	return { allowed: true };
}

export function extensionStateDir(): string {
	return path.join(getAgentDir(), "browser-extension");
}

export function policyFilePath(): string {
	return path.join(extensionStateDir(), "policy.json");
}

const policyFileSchema = type({ "allow?": "string[]" });

/** Read the allowlist from the policy file and the environment. A bad file is an error, not an empty list. */
export function loadExtensionPolicy(env: NodeJS.ProcessEnv = process.env): ExtensionPolicy {
	const allow: string[] = [];
	const file = policyFilePath();
	if (fs.existsSync(file)) {
		const parsed = policyFileSchema(JSON.parse(fs.readFileSync(file, "utf8")));
		if (parsed instanceof type.errors) throw new Error(`${file} is not valid: ${parsed.summary}`);
		allow.push(...(parsed.allow ?? []));
	}
	const fromEnv = env[EXTENSION_ALLOW_ENV];
	if (fromEnv) allow.push(...fromEnv.split(",").map(entry => entry.trim()));
	return { allow: allow.filter(entry => entry.length > 0) };
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
	const file = tokenFilePath(instance);
	if (!fs.existsSync(file)) return undefined;
	const token = fs.readFileSync(file, "utf8").trim();
	return token.length > 0 ? token : undefined;
}

export function hasExtensionToken(instance: string | undefined): boolean {
	return readExtensionToken(instance) !== undefined;
}

/** Remove the stored token. Returns whether one existed. */
export function removeExtensionToken(instance: string | undefined): boolean {
	const file = tokenFilePath(instance);
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file, { force: true });
	return true;
}

/** Replace every known secret in `text` with a marker. Defence in depth for anything that logs. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length >= 8) out = out.split(secret).join("[redacted]");
	}
	return out;
}
