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

import { redactProviderSecrets } from "../error/error-body";
import type { UsageCredential, UsageLogger } from "../usage";

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

/**
 * A plain snapshot of `value` with every string inside it redacted, property names included. The
 * snapshot is built from own enumerable data, so a `toJSON` or any other function on the input is
 * dropped rather than carried into the copy, where JSON.stringify would call it and bring the key
 * back. Other non-string leaves are shared, objects and arrays are rebuilt, and a cycle is cut rather
 * than followed, so a hostile report cannot hang the fetch. Only the nodes on the current path count
 * as a cycle: a node reachable twice without looping is copied once and reused.
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
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (ancestors.has(value)) return undefined;
	if (done.has(value)) return done.get(value);
	if (value instanceof Error) return redactUsageText(String(value), secrets);
	ancestors.add(value);
	const copy = Array.isArray(value)
		? value.map(item => redactNode(item, secrets, ancestors, done))
		: Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					redactUsageText(key, secrets),
					redactNode(item, secrets, ancestors, done),
				]),
			);
	ancestors.delete(value);
	done.set(value, copy);
	return copy;
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
