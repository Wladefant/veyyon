import { randomUUID } from "node:crypto";
import { getOpenCodeUserAgent, openCodeSessionHeaderValue } from "@veyyon/catalog/wire/opencode-headers";

export { openCodeSessionHeaderValue };

/**
 * The provider ids that reach an OpenCode gateway: the OAuth provider and the
 * two API-key providers (`https://opencode.ai/zen/v1`,
 * `https://opencode.ai/zen/go/v1`).
 */
export const OPENCODE_PROVIDER_IDS: readonly string[] = ["opencode", "opencode-go", "opencode-zen"];

const OPENCODE_PROVIDERS: ReadonlySet<string> = new Set(OPENCODE_PROVIDER_IDS);

export function isOpenCodeProvider(provider: string): boolean {
	return OPENCODE_PROVIDERS.has(provider);
}

/**
 * The conversation a request belongs to: the pinned prompt-cache key when the
 * caller has one, else the session id. Independent of cache retention, because
 * the OpenCode gateway requires its session header on every request, and it
 * prefers the cache key so a side-channel turn — which deliberately routes
 * under a unique per-request session id while keeping the conversation's cache
 * key — lands on the conversation the operator is actually in.
 */
export function conversationIdForOpenCode(
	options: { promptCacheKey?: string; sessionId?: string } | undefined,
): string | undefined {
	return options?.promptCacheKey ?? options?.sessionId;
}

/**
/**
 * The `x-opencode-session` value a request with no conversation routes under:
 * one random id per process, digested like a session id. A request without the
 * header is rejected with `MissingSessionID`, and a per-request value would
 * defeat the affinity the header exists for, so every session-less request
 * this process sends (a session title, a task label, a memory pass) shares one
 * gateway session.
 */
let processSessionHeaderValue: string | undefined;

function processSessionHeader(): string {
	processSessionHeaderValue ??= openCodeSessionHeaderValue(randomUUID());
	return processSessionHeaderValue;
}
 * Headers every OpenCode request carries. The gateway documents both under
 * "Where can I use it?": a client has to identify itself with a narrow
 * user agent, and has to send `x-opencode-session` so the gateway can optimize
 * prompt caching. Traffic that omits the session header is rejected.
 */
export function getOpenCodeHeaders(conversationId?: string): Record<string, string> {
	const session = conversationId ? openCodeSessionHeaderValue(conversationId) : processSessionHeader();
	return { "User-Agent": getOpenCodeUserAgent(), "x-opencode-session": session };
}
