import {
	COPILOT_IDENTITY_HEADERS,
	getGitHubCopilotBaseUrl,
	parseGitHubCopilotApiKey,
} from "@veyyon/catalog/wire/github-copilot";
import type { Message } from "../types";
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
}): CopilotDynamicHeaders {
	const initiator =
		params.initiatorOverride ?? getCopilotInitiatorOverride(params.headers) ?? inferCopilotInitiator(params.messages);
	const headers: Record<string, string> = {
		...COPILOT_IDENTITY_HEADERS,
		"X-Initiator": initiator,
		"Openai-Intent": "conversation-edits",
	};

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
