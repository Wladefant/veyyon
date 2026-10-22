import { createHash } from "node:crypto";
import { lazy } from "@veyyon/utils/abortable";
import { type CodexDiscoveryAccount, fetchCodexAccountModels } from "../discovery/codex";
import type { DevinModelDiscoveryOptions } from "../discovery/devin";
import { buildGitLabDuoWorkflowFallbackModel, fetchGitLabDuoWorkflowModels } from "../discovery/gitlab-duo-workflow";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

export interface OpenAICodexModelManagerConfig {
	/** Access token of the account discovery lists when `accounts` resolves none. Discovery runs only with one. */
	accessToken?: string;
	/** `chatgpt-account-id` of `accessToken`'s account. */
	accountId?: string;
	/**
	 * Every signed-in account discovery lists, resolved when a listing runs, so a launch served from the
	 * cache refreshes no token. Each account is listed the models its tier may use, and the listings merge.
	 */
	accounts?: () => Promise<readonly CodexDiscoveryAccount[]>;
	/** Ids of the accounts `accounts` resolves. They select the model cache row; see {@link openaiCodexCacheProviderId}. */
	accountIds?: readonly string[];
	clientVersion?: string;
}

/**
 * The model cache row Codex discovery reads and writes for a set of accounts. The listing differs by
 * account tier, so each account set has its own row: a login, logout or account switch reads a row that
 * does not exist yet and lists again. Ids are hashed, so the row name is bounded and holds no account id.
 * The bare provider id when no account id is known.
 */
export function openaiCodexCacheProviderId(accountIds: readonly string[] = []): string {
	const ids = accountIds.filter((id, index) => id.trim() !== "" && accountIds.indexOf(id) === index).sort();
	if (ids.length === 0) return "openai-codex";
	const digest = createHash("sha256").update(ids.join("\u0000")).digest("hex").slice(0, 16);
	return `openai-codex:accounts-${digest}`;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { accessToken, accountId, accounts, accountIds, clientVersion } = config;
	return {
		providerId: "openai-codex",
		cacheProviderId: openaiCodexCacheProviderId(accountIds),
		...(accessToken
			? {
					fetchDynamicModels: async hooks => {
						const resolved = (await accounts?.()) ?? [];
						return fetchCodexAccountModels({
							accounts: resolved.length > 0 ? resolved : [{ accessToken, accountId }],
							clientVersion,
							onFailure: hooks?.onFailure,
						});
					},
				}
			: undefined),
	};
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	clientVersion?: string;
}

// Bumped from `max-mode-v2` when the gateway-name prefix rewrite landed: every
// `cursor-<vendor model>` row in an existing cache carries the 200k assumption for a
// model whose real window is up to 1.05M, and a cached row is served for the full TTL.
// A stale window is not cosmetic here, it decides when compaction fires.
const CURSOR_CACHE_PROVIDER_ID = "cursor:max-mode-v3";

export function resolveCursorCacheProviderId(_config?: CursorModelManagerConfig): string {
	return CURSOR_CACHE_PROVIDER_ID;
}

export function cursorModelManagerOptions(config: CursorModelManagerConfig = {}): ModelManagerOptions<"cursor-agent"> {
	const { apiKey, baseUrl, clientVersion } = config;
	return {
		providerId: "cursor",
		cacheProviderId: CURSOR_CACHE_PROVIDER_ID,
		...(apiKey
			? {
					fetchDynamicModels: async hooks => {
						const { fetchCursorUsableModels } = await cursorDiscovery.value;
						return fetchCursorUsableModels({ apiKey, baseUrl, clientVersion, onFailure: hooks?.onFailure });
					},
				}
			: undefined),
	};
}

const cursorDiscovery = lazy(() => import("../discovery/cursor"));

// ---------------------------------------------------------------------------
// GitLab Duo Workflow
// ---------------------------------------------------------------------------

export interface GitLabDuoWorkflowModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	namespaceId?: string;
	projectId?: string;
	cwd?: string;
}

export function gitLabDuoWorkflowModelManagerOptions(
	config: GitLabDuoWorkflowModelManagerConfig = {},
): ModelManagerOptions<"gitlab-duo-agent"> {
	const apiKey = config.apiKey;
	return {
		providerId: "gitlab-duo-agent",
		// GitLab Duo discovery is credential- and namespace-specific
		// (`aiChatAvailableModels(rootNamespaceId:)` also surfaces namespace-pinned
		// models), so the default provider-id cache namespace would let a second
		// account/namespace load the first one's authoritative model list at startup
		// and skip refetching. Partition the cache by a non-reversible fingerprint of
		// the exact inputs `fetchGitLabDuoWorkflowModels` resolves the namespace from
		// (credential + base URL + namespace/project config + the same env vars + the
		// effective workspace cwd whose git remote drives auto-discovery). Built-in
		// discovery only passes apiKey/baseUrl/fetch, so the cwd/env terms — not the
		// empty config fields — are what actually separate workspace A from B here.
		// Falls back to the bare provider id when no credential is present.
		...(apiKey ? { cacheProviderId: gitLabDuoWorkflowModelCacheProviderId(apiKey, config) } : undefined),
		dynamicModelsAuthoritative: true,
		staticModels: [
			buildGitLabDuoWorkflowFallbackModel("claude_sonnet_4_6_vertex", "Claude Sonnet 4.6 - Vertex", config.baseUrl),
		],
		...(apiKey
			? {
					fetchDynamicModels: async hooks =>
						fetchGitLabDuoWorkflowModels({
							apiKey,
							baseUrl: config.baseUrl,
							fetch: config.fetch,
							namespaceId: config.namespaceId,
							projectId: config.projectId,
							cwd: config.cwd,
							onFailure: hooks?.onFailure,
						}),
				}
			: undefined),
	};
}

function gitLabDuoWorkflowModelCacheProviderId(apiKey: string, config: GitLabDuoWorkflowModelManagerConfig): string {
	// Mirror the exact inputs `discoverGitLabDuoWorkflowNamespace` keys off: explicit
	// namespace/project config OR the same env vars, then the git remote at the
	// effective cwd. Built-in discovery leaves the config fields empty, so the env +
	// resolved cwd terms are what actually distinguish two workspaces sharing a token.
	const namespaceId = config.namespaceId ?? Bun.env.GITLAB_DUO_NAMESPACE_ID ?? "";
	const projectId = config.projectId ?? Bun.env.GITLAB_DUO_PROJECT_ID ?? Bun.env.GITLAB_DUO_PROJECT_PATH ?? "";
	const cwd = config.cwd ?? process.cwd();
	const scope = [config.baseUrl ?? "", namespaceId, projectId, cwd].join("\u0000");
	return `gitlab-duo-agent:${Bun.hash(`${apiKey}\u0000${scope}`).toString(36)}`;
}

export function resolveGitLabDuoWorkflowCacheProviderId(config?: GitLabDuoWorkflowModelManagerConfig): string {
	const apiKey = config?.apiKey;
	return apiKey ? gitLabDuoWorkflowModelCacheProviderId(apiKey, config ?? {}) : "gitlab-duo-agent";
}

// Devin (Codeium Cascade)
// ---------------------------------------------------------------------------

export interface DevinModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: DevinModelDiscoveryOptions["fetch"];
}

export function devinModelManagerOptions(config: DevinModelManagerConfig = {}): ModelManagerOptions<"devin-agent"> {
	const { apiKey, baseUrl, fetch } = config;
	return {
		providerId: "devin",
		...(apiKey ? { dynamicModelsAuthoritative: true } : undefined),
		...(apiKey
			? {
					fetchDynamicModels: async hooks => {
						const { fetchDevinModels } = await devinDiscovery.value;
						return fetchDevinModels({ apiKey, baseUrl, fetch, onFailure: hooks?.onFailure });
					},
				}
			: undefined),
	};
}

const devinDiscovery = lazy(() => import("../discovery/devin"));
// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

export function zaiModelManagerOptions(_config: ZaiModelManagerConfig = {}): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "zai" };
}
