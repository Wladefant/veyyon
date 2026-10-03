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

/** Shorter than this and a literal replace would mangle ordinary words, so it is left to the shape layer. */
const MIN_EXACT_SECRET_LENGTH = 8;

/** Every secret a usage credential holds, longest first so a key that contains another is removed whole. */
export function usageCredentialSecrets(credential: UsageCredential): string[] {
	const found = new Set<string>();
	for (const value of [credential.apiKey, credential.accessToken, credential.refreshToken]) {
		if (typeof value === "string" && value.length >= MIN_EXACT_SECRET_LENGTH) found.add(value);
	}
	return [...found].sort((a, b) => b.length - a.length);
}

/** Remove the given secrets, then every credential-shaped run, from `text`. */
export function redactUsageText(text: string, secrets: readonly string[]): string {
	let result = text;
	for (const secret of secrets) result = result.split(secret).join(`<redacted ${secret.length} chars>`);
	return redactProviderSecrets(result);
}

/**
 * A copy of `value` with every string inside it redacted. Non-string leaves are shared, objects and
 * arrays are rebuilt, and a cycle is cut rather than followed, so a hostile report cannot hang the fetch.
 */
export function redactUsageValue<T>(value: T, secrets: readonly string[]): T {
	return redactNode(value, secrets, new WeakSet()) as T;
}

function redactNode(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactUsageText(value, secrets);
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return undefined;
	seen.add(value);
	if (Array.isArray(value)) return value.map(item => redactNode(item, secrets, seen));
	if (value instanceof Error) return redactUsageText(String(value), secrets);
	const copy: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) copy[key] = redactNode(item, secrets, seen);
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
