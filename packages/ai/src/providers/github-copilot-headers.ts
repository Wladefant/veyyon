import { createHash } from "node:crypto";
import {
	COPILOT_CAPI_IDENTITY_HEADERS,
	COPILOT_CHAT_INTEGRATION_ID,
	COPILOT_IDENTITY_HEADERS,
	getGitHubCopilotBaseUrl,
	normalizeCopilotIntegrationId,
	parseGitHubCopilotApiKey,
} from "@veyyon/catalog/wire/github-copilot";
import { $env, logger } from "@veyyon/utils";
import { LRUCache } from "@veyyon/utils/lru";
import type { FetchImpl, Message } from "../types";
/**
 * Infer whether the current request to Copilot is user-initiated or agent-initiated.
 * Accepts `unknown[]` because providers may pass pre-converted message shapes.
 */
export type CopilotInitiator = "user" | "agent";
export type CopilotDynamicHeaders = {
	headers: Record<string, string>;
	initiator: CopilotInitiator;
};
export function resolveGitHubCopilotBaseUrl(
	baseUrl: string | undefined,
	apiKey: string | undefined,
): string | undefined {
	if (!apiKey) return baseUrl;
	const { enterpriseUrl, apiEndpoint } = parseGitHubCopilotApiKey(apiKey);
	if (apiEndpoint && (!baseUrl || baseUrl.includes("githubcopilot.com"))) return apiEndpoint;
	if (!enterpriseUrl) return baseUrl;
	if (baseUrl && !baseUrl.includes("githubcopilot.com")) return baseUrl;
	return getGitHubCopilotBaseUrl(enterpriseUrl);
}

/**
 * Opt-in `Copilot-Integration-Id` override for chat and model-policy requests.
 * Model discovery keeps the CLI identity because it unlocks enterprise and
 * experimental models; model listing is not policy-gated like chat.
 */
export function resolveCopilotIntegrationIdOverride(
	env: Record<string, string | undefined> = $env,
): string | undefined {
	return normalizeCopilotIntegrationId(env.COPILOT_INTEGRATION_ID);
}

/** Read an integration identity only from caller-supplied request headers. */
function explicitCopilotIntegrationId(headers: Record<string, string> | undefined): unknown {
	if (!headers) return undefined;
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === "copilot-integration-id") return headers[name];
	}
	return undefined;
}

/** Resolve an explicit identity before the request's chat-surface default. */
export function resolveCopilotRequestIdentity(
	headers?: Record<string, string>,
	explicit?: unknown,
	env: Record<string, string | undefined> = $env,
): string | undefined {
	return (
		normalizeCopilotIntegrationId(explicit) ??
		normalizeCopilotIntegrationId(explicitCopilotIntegrationId(headers)) ??
		resolveCopilotIntegrationIdOverride(env)
	);
}

/** Learned working identity per credential and effective Copilot host. */
const COPILOT_WORKING_INTEGRATION_CACHE_LIMIT = 50;
const copilotWorkingIntegrationCache = new LRUCache<string, string>({ max: COPILOT_WORKING_INTEGRATION_CACHE_LIMIT });

function normalizeCopilotCacheBaseUrl(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "") ?? "";
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed);
		return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}${url.hash}`;
	} catch {
		return trimmed.toLowerCase();
	}
}

/** Build a host-scoped key without retaining raw bearer bytes in the cache. */
export function getCopilotIntegrationCacheKey(apiKeyRaw: string | undefined, baseUrl?: string): string | undefined {
	if (!apiKeyRaw) return undefined;
	const trimmed = apiKeyRaw.trim();
	if (!trimmed) return undefined;
	const parsed = parseGitHubCopilotApiKey(trimmed);
	if (!parsed.accessToken) return undefined;
	const fingerprint = createHash("sha256").update(parsed.accessToken).digest("hex");
	return `${parsed.enterpriseUrl ?? ""}\0${parsed.apiEndpoint ?? ""}\0${normalizeCopilotCacheBaseUrl(baseUrl)}\0${fingerprint}`;
}

/** Return the cached working identity, refreshing its LRU position. */
export function getCachedCopilotIntegrationId(cacheKey: string | undefined): string | undefined {
	if (!cacheKey) return undefined;
	return normalizeCopilotIntegrationId(copilotWorkingIntegrationCache.get(cacheKey));
}

/** Remember a valid identity that cleared the Copilot identity gate. */
export function rememberCopilotWorkingIntegrationId(cacheKey: string | undefined, integrationId: unknown): void {
	const normalized = normalizeCopilotIntegrationId(integrationId);
	if (!cacheKey || !normalized) return;
	copilotWorkingIntegrationCache.set(cacheKey, normalized);
}

/** Clear one cached identity, or clear the full cache when no key is given. */
export function clearCopilotIntegrationCache(cacheKey?: string): void {
	if (cacheKey === undefined) copilotWorkingIntegrationCache.clear();
	else copilotWorkingIntegrationCache.delete(cacheKey);
}

/** Check for identity denials without consuming the response body. */
async function isCopilotIdentityDenied(response: Response): Promise<boolean> {
	if (response.status === 403) return true;
	if (response.status !== 400) return false;
	try {
		const body = (await response.clone().json()) as { error?: { code?: unknown } } | null;
		return body?.error?.code === "model_not_supported";
	} catch {
		return false;
	}
}

/**
 * Retry a rejected default or cached identity once with the other Copilot surface.
 * Explicit identities are never second-guessed, and only a 2xx retry is cached.
 */
export function wrapFetchForCopilotFallback(
	base: FetchImpl | undefined,
	enabled: boolean,
	integrationId?: unknown,
	cacheKey?: string,
	cacheSnapshot?: string | null,
): FetchImpl {
	const inner = base ?? fetch;
	if (!enabled) return inner;
	const cliIntegrationId = COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"];
	return async (input, init) => {
		const cachedBeforeRequest =
			cacheSnapshot === undefined
				? getCachedCopilotIntegrationId(cacheKey)
				: normalizeCopilotIntegrationId(cacheSnapshot);
		const response = await inner(input, init);
		if (response.status !== 403 && response.status !== 400) return response;
		if (input instanceof Request) return response;
		if (normalizeCopilotIntegrationId(integrationId) !== undefined) return response;
		const outgoing = new Headers(init?.headers);
		const outgoingId = outgoing.get("Copilot-Integration-Id");
		if (outgoingId === COPILOT_CHAT_INTEGRATION_ID) {
			if (!(await isCopilotIdentityDenied(response))) return response;
			try {
				await response.arrayBuffer();
			} catch {}
			logger.warn(
				`GitHub Copilot chat identity denied (HTTP ${response.status}); retrying once as the Copilot CLI`,
			);
			const retryHeaders = new Headers(outgoing);
			retryHeaders.set("Copilot-Integration-Id", cliIntegrationId);
			const retry = await inner(input, { ...init, headers: retryHeaders });
			if (cacheKey) {
				if (retry.ok) rememberCopilotWorkingIntegrationId(cacheKey, cliIntegrationId);
				else clearCopilotIntegrationCache(cacheKey);
			}
			return retry;
		}
		if (outgoingId !== cliIntegrationId || !cacheKey || cachedBeforeRequest !== cliIntegrationId) return response;
		if (!(await isCopilotIdentityDenied(response))) return response;
		try {
			await response.arrayBuffer();
		} catch {}
		logger.warn(
			`GitHub Copilot CLI identity denied (HTTP ${response.status}); retrying once as ${COPILOT_CHAT_INTEGRATION_ID}`,
		);
		const retryHeaders = new Headers(outgoing);
		retryHeaders.set("Copilot-Integration-Id", COPILOT_CHAT_INTEGRATION_ID);
		const retry = await inner(input, { ...init, headers: retryHeaders });
		if (retry.ok) rememberCopilotWorkingIntegrationId(cacheKey, COPILOT_CHAT_INTEGRATION_ID);
		else clearCopilotIntegrationCache(cacheKey);
		return retry;
	};
}

export function inferCopilotInitiator(messages: unknown[]): CopilotInitiator {
	if (messages.length === 0) return "user";

	const last = messages[messages.length - 1] as Record<string, unknown>;
	const attribution = last.attribution;
	if (typeof attribution === "string") {
		const normalizedAttribution = attribution.trim().toLowerCase();
		if (normalizedAttribution === "user" || normalizedAttribution === "agent") {
			return normalizedAttribution;
		}
	}

	const role = last.role as string | undefined;
	if (!role) return "user";

	if (role !== "user") return "agent";

	// Check if last content block is a tool_result (Anthropic-converted shape)
	const content = last.content;
	if (Array.isArray(content) && content.length > 0) {
		const lastBlock = content[content.length - 1] as Record<string, unknown>;
		if (lastBlock.type === "tool_result") {
			return "agent";
		}
	}

	return "user";
}

/** Check whether any message in the conversation contains image content. */
export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some(msg => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some(c => c.type === "image");
		}
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return msg.content.some(c => c.type === "image");
		}
		return false;
	});
}

/**
 * Resolve an explicitly configured Copilot initiator header, if present.
 * Handles case-insensitive X-Initiator keys and returns the last valid value.
 */
export function getCopilotInitiatorOverride(headers: Record<string, string> | undefined): CopilotInitiator | undefined {
	if (!headers) return undefined;

	let override: CopilotInitiator | undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== "x-initiator") continue;
		const normalized = value.trim().toLowerCase();
		if (normalized === "user" || normalized === "agent") {
			override = normalized;
		}
	}

	return override;
}

/**
 * Build dynamic Copilot headers that vary per-request.
 * Static headers (Editor-Version, API version, etc.) come from model.headers; the User-Agent is the
 * honest Veyyon identity and is always set here, so a stale value baked into an older catalog or
 * session cannot name another client.
 *
 * `X-Initiator` is sent because Copilot clients send it. Veyyon derives NO usage figure from it: since
 * 2026-06-01 GitHub bills Copilot in credits, so "agent turn => 0 premium requests" is not a usage
 * count. The authoritative figure is the account's own usage report (`/usage`).
 */
export function buildCopilotDynamicHeaders(params: {
	messages: unknown[];
	hasImages: boolean;
	headers?: Record<string, string>;
	initiatorOverride?: CopilotInitiator;
	/** Enterprise login domain; its private endpoint defaults to the CLI identity. */
	enterpriseUrl?: string;
	/** Explicit configured identity; invalid values use the normal default. */
	integrationId?: unknown;
	/** Cached identity learned for this credential; explicit input still wins. */
	cachedIntegrationId?: unknown;
}): CopilotDynamicHeaders {
	const initiator =
		params.initiatorOverride ?? getCopilotInitiatorOverride(params.headers) ?? inferCopilotInitiator(params.messages);
	const headers: Record<string, string> = {
		...COPILOT_CAPI_IDENTITY_HEADERS,
		...COPILOT_IDENTITY_HEADERS,
		"Openai-Intent": "conversation-edits",
		"X-Initiator": initiator,
		"X-Interaction-Type": `conversation-${initiator}`,
	};
	headers["Copilot-Integration-Id"] =
		normalizeCopilotIntegrationId(params.integrationId) ??
		normalizeCopilotIntegrationId(params.cachedIntegrationId) ??
		(params.enterpriseUrl
			? COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"]
			: COPILOT_CHAT_INTEGRATION_ID);

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return { headers, initiator };
}

/**
 * Apply Copilot's dynamic headers onto `target`, replacing any entry whose name matches
 * case-insensitively. A stale `user-agent` from a catalog or session would otherwise survive next to
 * `User-Agent`, and `new Headers(...)` folds the two into one comma-joined value naming another client.
 */
export function applyCopilotHeaders(target: Record<string, string>, copilotHeaders: Record<string, string>): void {
	const incoming = new Set(Object.keys(copilotHeaders).map(name => name.toLowerCase()));
	for (const name of Object.keys(target)) {
		if (incoming.has(name.toLowerCase())) delete target[name];
	}
	Object.assign(target, copilotHeaders);
}
