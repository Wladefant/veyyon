/**
 * Base URL and request headers shared by the Claude OAuth account endpoints: the usage report
 * (`./claude`) and the usage-limit reset client (`./anthropic-reset`).
 */
import { CLAUDE_CODE_VERSION as claudeCodeVersion } from "@veyyon/catalog/wire/anthropic";
import { trimTrailingSlashes } from "@veyyon/utils/url";

const DEFAULT_OAUTH_ENDPOINT = "https://api.anthropic.com/api/oauth";
const OAUTH_PATH_SUFFIX = "/api/oauth";

const CLAUDE_OAUTH_HEADERS = {
	accept: "application/json, text/plain, */*",
	"accept-encoding": "gzip, compress, deflate, br",
	"anthropic-beta":
		"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11",
	"content-type": "application/json",
	"user-agent": `claude-cli/${claudeCodeVersion} (external, cli)`,
	connection: "keep-alive",
} as const;

/**
 * The `/api/oauth` root for a provider base URL. A base URL that already ends in `/api/oauth` is
 * kept, a trailing `/v1` is dropped, and an empty or unparseable one resolves to
 * `https://api.anthropic.com/api/oauth`.
 */
export function normalizeClaudeBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_OAUTH_ENDPOINT;
	const trimmed = trimTrailingSlashes(baseUrl.trim());
	if (trimmed.toLowerCase().endsWith(OAUTH_PATH_SUFFIX)) return trimmed;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return DEFAULT_OAUTH_ENDPOINT;
	}
	let path = trimTrailingSlashes(url.pathname);
	if (path === "/") path = "";
	if (path.toLowerCase().endsWith("/v1")) {
		path = path.slice(0, -3);
	}
	return `${url.origin}${path}${OAUTH_PATH_SUFFIX}`;
}

/**
 * The API root that `/api/oauth` hangs off, for the organization routes
 * (`/api/organizations/{uuid}/…`) that sit beside it rather than under it.
 */
export function claudeApiRoot(baseUrl?: string): string {
	const oauthRoot = normalizeClaudeBaseUrl(baseUrl);
	return oauthRoot.slice(0, oauthRoot.length - OAUTH_PATH_SUFFIX.length);
}

/** Headers for an OAuth-authenticated request to a Claude account endpoint. */
export function claudeOAuthHeaders(accessToken: string): Record<string, string> {
	return { ...CLAUDE_OAUTH_HEADERS, authorization: `Bearer ${accessToken}` };
}
