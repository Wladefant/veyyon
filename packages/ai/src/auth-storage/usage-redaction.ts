/**
 * Keeps a usage credential out of everything a usage backend can say about a failure.
 *
 * A backend is handed the live key. Anything it throws, logs or returns can carry that key back: an
 * upstream that echoes the Authorization header into its error body, a `String(error)` in a warning, a
 * report whose metadata copied the request. Those strings reach the log, the credential-check result
 * shown to the user, a stored disable reason, and the `usage_cache:` row the store writes as plaintext.
 *
 * Two layers, both applied where the text is built rather than where it is displayed:
 *  - the exact secrets of the credential in hand, which catches a key of any shape (a self-hosted or
 *    extension backend's key has no vendor prefix), and
 *  - the shape-based families in `redactProviderSecrets`, which catch a credential the backend echoed
 *    that is not the one in hand (a refreshed token, a header from a redirect).
 */

import { types } from "node:util";
import { redactProviderSecrets } from "../error/error-body";
import type { UsageCredential, UsageLimit, UsageLogger, UsageReport } from "../usage";

/**
 * A credential is removed whatever its length: a short key can only be a test key or a misconfiguration,
 * and a leaked one is still a leaked one. The cost is a mangled word in an error message, which is cheap.
 */
const MIN_EXACT_SECRET_LENGTH = 1;

/** Every secret a usage credential holds, longest first so a key that contains another is removed whole. */
export function usageCredentialSecrets(credential: UsageCredential): string[] {
	const found = new Set<string>();
	for (const value of [credential.apiKey, credential.accessToken, credential.refreshToken]) {
		if (typeof value === "string" && value.length >= MIN_EXACT_SECRET_LENGTH) found.add(value);
	}
	return [...found].sort((a, b) => b.length - a.length);
}

interface SecretForm {
	/** What to look for in text. */
	pattern: string;
	/** Whether `pattern` is percent-encoded, which a server may spell with lowercase hex. */
	percentEncoded: boolean;
	/** The length of the credential this is a form of, which is what the replacement states. */
	secretLength: number;
}

const formsBySecrets = new WeakMap<readonly string[], SecretForm[]>();

/**
 * The spellings of each secret an echo can carry: as is, URL-encoded (component, whole-URL and form
 * encoding) and as the inside of a JSON string. Longest first.
 */
function secretForms(secrets: readonly string[]): SecretForm[] {
	const cached = formsBySecrets.get(secrets);
	if (cached) return cached;
	const forms = new Map<string, SecretForm>();
	const add = (pattern: string, percentEncoded: boolean, secret: string): void => {
		if (pattern.length > 0 && !forms.has(pattern)) {
			forms.set(pattern, { pattern, percentEncoded, secretLength: secret.length });
		}
	};
	for (const secret of secrets) {
		add(secret, false, secret);
		const component = encodeURIComponent(secret);
		add(component, component !== secret, secret);
		add(component.replace(/%20/g, "+"), true, secret);
		const whole = encodeURI(secret);
		add(whole, whole !== secret, secret);
		add(JSON.stringify(secret).slice(1, -1), false, secret);
	}
	const result = [...forms.values()].sort((a, b) => b.pattern.length - a.pattern.length);
	formsBySecrets.set(secrets, result);
	return result;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove the given secrets in every spelling, then every credential-shaped run, from `text`. */
export function redactUsageText(text: string, secrets: readonly string[]): string {
	let result = text;
	for (const form of secretForms(secrets)) {
		const replacement = `<redacted ${form.secretLength} chars>`;
		result = form.percentEncoded
			? result.replace(new RegExp(escapeRegExp(form.pattern), "gi"), replacement)
			: result.split(form.pattern).join(replacement);
	}
	return redactProviderSecrets(result);
}

/** What stands in for anything the snapshot could not read without running the value's own code. */
const UNREADABLE = "[unreadable]";

const dateToISOString = Date.prototype.toISOString;
const dateGetTime = Date.prototype.getTime;

/** The own data value of `key`: an accessor is never invoked, so no code of the value's runs. */
function ownDataValue(object: object, key: PropertyKey): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * A plain snapshot of `value` with every string inside it redacted, property names included. It runs
 * none of the value's own code: only own enumerable data properties are read, so an accessor, a
 * `toJSON`, a `toString` or a `toISOString` on the input is never called and a function is dropped.
 * Binary data becomes a placeholder, a Date is read through the intrinsic methods and an Error keeps
 * its own name and message. Anything that still throws (a Proxy trap) becomes a fixed placeholder, never
 * the error's message. Objects and arrays are rebuilt and a cycle is cut rather than followed, so a
 * hostile report cannot hang the fetch. Only the nodes on the current path count as a cycle: a node
 * reachable twice without looping is copied once and reused.
 */
export function redactUsageValue<T>(value: T, secrets: readonly string[]): T {
	return redactNode(value, secrets, new Set(), new Map()) as T;
}

function redactNode(
	value: unknown,
	secrets: readonly string[],
	ancestors: Set<object>,
	done: Map<object, unknown>,
): unknown {
	if (typeof value === "string") return redactUsageText(value, secrets);
	if (typeof value === "function" || typeof value === "symbol") return undefined;
	if (value === null || typeof value !== "object") return value;
	// A Proxy runs its traps on every reflective read, so it is never reflected on.
	if (types.isProxy(value)) return UNREADABLE;
	if (ancestors.has(value)) return undefined;
	if (done.has(value)) return done.get(value);
	ancestors.add(value);
	try {
		const copy = snapshotObject(value, secrets, ancestors, done);
		done.set(value, copy);
		return copy;
	} catch {
		return UNREADABLE;
	} finally {
		ancestors.delete(value);
	}
}

function snapshotObject(
	value: object,
	secrets: readonly string[],
	ancestors: Set<object>,
	done: Map<object, unknown>,
): unknown {
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
		return "[binary data]";
	}
	if (value instanceof Date) {
		const time = dateGetTime.call(value);
		return Number.isNaN(time) ? null : redactUsageText(dateToISOString.call(value), secrets);
	}
	if (value instanceof Error) {
		const name = ownDataValue(value, "name");
		const message = ownDataValue(value, "message");
		const label = typeof name === "string" ? name : "Error";
		return redactUsageText(typeof message === "string" ? `${label}: ${message}` : label, secrets);
	}
	if (Array.isArray(value)) {
		const length = ownDataValue(value, "length");
		const items: unknown[] = [];
		for (let index = 0; typeof length === "number" && index < length; index++) {
			items.push(redactNode(ownDataValue(value, index), secrets, ancestors, done));
		}
		return items;
	}
	const entries: Array<[string, unknown]> = [];
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor)) continue;
		entries.push([redactUsageText(key, secrets), redactNode(descriptor.value, secrets, ancestors, done)]);
	}
	return Object.fromEntries(entries);
}

/**
 * The redacted snapshot of a usage report, or undefined when what came back is not a report: not a plain
 * object, or missing `provider`, `fetchedAt` or a `limits` array once snapshotted (an unreadable root
 * becomes a placeholder string, a getter is not read). A limit without an `amount` and a `scope` object is
 * dropped, so a reader may take `limit.scope` and `limit.amount` unguarded.
 */
export function redactUsageReport(report: UsageReport, secrets: readonly string[]): UsageReport | undefined {
	const snapshot = redactUsageValue<unknown>(report, secrets);
	if (!isRecord(snapshot)) return undefined;
	if (typeof snapshot.provider !== "string" || typeof snapshot.fetchedAt !== "number") return undefined;
	if (!Array.isArray(snapshot.limits)) return undefined;
	return {
		...(snapshot as unknown as UsageReport),
		limits: snapshot.limits.filter(
			(limit): limit is UsageLimit => isRecord(limit) && isRecord(limit.amount) && isRecord(limit.scope),
		),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Redacted text for a caught value, taken from the same no-user-code snapshot as a report: an Error
 * keeps its own message (its name when it has none), an accessor or a Proxy is never run, and a throw while reading
 * gives a fixed placeholder. Use it instead of `String(error)` wherever the error came from a backend.
 */
export function redactUsageError(error: unknown, secrets: readonly string[]): string {
	if (types.isProxy(error)) return UNREADABLE;
	if (error instanceof Error) {
		const message = ownDataValue(error, "message");
		if (typeof message === "string") return redactUsageText(message, secrets);
	}
	const snapshot = redactUsageValue(error, secrets);
	return typeof snapshot === "string" ? snapshot : (JSON.stringify(snapshot) ?? String(snapshot));
}

/** A logger that redacts the message and every string in the metadata before the wrapped logger sees it. */
export function redactingUsageLogger(
	logger: UsageLogger | undefined,
	secrets: readonly string[],
): UsageLogger | undefined {
	if (!logger) return undefined;
	return {
		debug: (message, meta) => logger.debug(redactUsageText(message, secrets), redactUsageValue(meta, secrets)),
		warn: (message, meta) => logger.warn(redactUsageText(message, secrets), redactUsageValue(meta, secrets)),
	};
}
