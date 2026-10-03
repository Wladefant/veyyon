import { createHash } from "node:crypto";
import packageJson from "../../package.json" with { type: "json" };

/**
 * The user agent OpenCode gateway traffic carries.
 *
 * OpenCode requires a narrow client user agent on requests to
 * `https://opencode.ai/zen/v1` and `https://opencode.ai/zen/go/v1`, and flags
 * traffic that sends none. Model discovery reads the same gateway with the same
 * API key as a completion request, so the header belongs on both paths, not
 * only on the streaming transports.
 *
 * Defined here rather than in the request layer because catalog discovery is
 * the earlier consumer: `@veyyon/catalog` cannot import `@veyyon/ai`, and a
 * second copy of the string in the request layer is how the two drift.
 */
export function getOpenCodeUserAgent(): string {
	return `Veyyon/${packageJson.version}`;
}

/**
 * Derive the `x-opencode-session` value from a local session or install id.
 *
 * Hashed rather than sent verbatim: the gateway needs one stable value per
 * conversation to route a session's requests to the same upstream provider and
 * hit its prompt cache, and nothing more. A digest supplies that without
 * handing a third party the identifier the local session, its transcript and
 * its files are keyed by. `ses_` plus 32 hex characters matches the shape the
 * gateway issues for its own sessions.
 *
 * Defined here beside {@link getOpenCodeUserAgent} because catalog discovery
 * sends the header too and `@veyyon/catalog` cannot import `@veyyon/ai`.
 */
export function openCodeSessionHeaderValue(sessionId: string): string {
	return `ses_${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}
