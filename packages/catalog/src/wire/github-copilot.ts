/**
 * GitHub Copilot wire metadata: API-key envelope parsing and endpoint
 * derivation shared by catalog discovery and the pi-ai OAuth flow. The device
 * login / token refresh flow lives in `@veyyon/ai`'s registry.
 */
import { VERSION } from "@veyyon/utils/dirs";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import type { FetchImpl } from "../types";
import { isRecord } from "../utils";

/**
 * The honest client identity Veyyon sends to GitHub and the Copilot API. It names this product and its
 * version, and nothing else: Veyyon does not present itself as opencode, VS Code or any other client.
 */
export const COPILOT_USER_AGENT = `veyyon/${VERSION}`;

/** Identity headers for every request Veyyon makes to GitHub or the Copilot API on a user's behalf. */
export const COPILOT_IDENTITY_HEADERS = {
	"User-Agent": COPILOT_USER_AGENT,
} as const;

/**
 * Copilot API identity. The User-Agent and Editor-Version name Veyyon. The integration, harness and intent ids are
 * the Copilot CLI surface that Copilot gates some model access on (issue #11372), so the chat fallback in
 * `@veyyon/ai` depends on them.
 */
export const COPILOT_CAPI_IDENTITY_HEADERS = {
	...COPILOT_IDENTITY_HEADERS,
	"Editor-Version": COPILOT_USER_AGENT,
	"Copilot-Integration-Id": "copilot-developer-cli",
	"Copilot-Harness-Id": "copilot-sdk",
	"Openai-Intent": "conversation-agent",
} as const;

/**
 * Chat-surface identity for Copilot chat and model-policy requests.
 * Some Business organizations gate premium models per client surface and
 * block the CLI identity while allowing chat (issue #11372), so chat traffic
 * defaults to this id with `COPILOT_INTEGRATION_ID` as an explicit pin and a
 * one-shot CLI retry on denial.
 */
export const COPILOT_CHAT_INTEGRATION_ID = "copilot-chat" as const;

/**
 * Copilot API version sent on `api.githubcopilot.com` requests (`/models`,
 * chat endpoints). Newer versions unlock tiered context metadata: `/models`
 * reports the full long-context window in `capabilities.limits` plus per-tier
 * boundaries/prices under `billing.token_prices.{default,long_context}`.
 * Without it the endpoint serves default-tier limits only (e.g. 264k instead
 * of 1M for Claude Opus). Never send this to `api.github.com` REST endpoints —
 * they validate `X-GitHub-Api-Version` against the REST version vocabulary.
 */
export const COPILOT_API_VERSION = "2026-08-01" as const;

/**
 * Static, version-pinned headers for `api.githubcopilot.com` (capi) requests. Identity comes from
 * {@link COPILOT_CAPI_IDENTITY_HEADERS}, so the User-Agent names this product and its version.
 */
export const COPILOT_API_HEADERS = {
	...COPILOT_CAPI_IDENTITY_HEADERS,
	"X-GitHub-Api-Version": COPILOT_API_VERSION,
} as const;

/** Copilot identity headers for user-initiated model discovery. */
export const COPILOT_DISCOVERY_HEADERS = {
	...COPILOT_API_HEADERS,
	"X-Initiator": "user",
} as const;

const MANAGED_COPILOT_HEADER_NAMES: Record<string, true> = {
	"user-agent": true,
	"editor-version": true,
	"copilot-integration-id": true,
	"copilot-harness-id": true,
	"openai-intent": true,
	"x-github-api-version": true,
	"x-initiator": true,
	"x-interaction-type": true,
};

/** Preserve model-specific headers while enforcing the current Copilot API identity. */
export function mergeCopilotApiHeaders(headers?: Readonly<Record<string, string>>): Record<string, string> {
	const merged: Record<string, string> = {};
	if (headers) {
		for (const name in headers) {
			const value = headers[name];
			if (value !== undefined && !MANAGED_COPILOT_HEADER_NAMES[name.toLowerCase()]) {
				merged[name] = value;
			}
		}
	}
	return { ...merged, ...COPILOT_API_HEADERS };
}

/**
 * GitHub REST API version sent on `api.github.com` requests made on Copilot's
 * behalf (`/user`, premium-request billing). This is the other vocabulary
 * {@link COPILOT_API_VERSION} warns about: REST validates the header against
 * dated REST versions and rejects a capi version outright. The two live side
 * by side so bumping one cannot read as bumping both.
 */
export const GITHUB_REST_API_VERSION = "2022-11-28" as const;

/** Headers for `api.github.com` REST requests. Callers add `Authorization`. */
export const GITHUB_REST_HEADERS = {
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
} as const;

/**
 * Validate an explicit `Copilot-Integration-Id` override. Callers pass the raw `COPILOT_INTEGRATION_ID` value;
 * blank or CR/LF-bearing values are rejected so the header stays well-formed and the default identity applies.
 */
export function normalizeCopilotIntegrationId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;
	return trimmed;
}

type GitHubCopilotApiKeyPayload = {
	token?: unknown;
	enterpriseUrl?: unknown;
	apiEndpoint?: unknown;
};

export type ParsedGitHubCopilotApiKey = {
	accessToken: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
};

const PUBLIC_GITHUB_HOSTS = new Set(["api.github.com", "github.com", "www.github.com"]);

export function isPublicGitHubHost(host: string): boolean {
	return PUBLIC_GITHUB_HOSTS.has(host.trim().toLowerCase());
}

/** Canonical personal-Copilot API host. */
export const PERSONAL_GITHUB_COPILOT_BASE_URL = "https://api.githubcopilot.com" as const;

/** `true` when the resolved base URL is the canonical personal-Copilot host. */
export function isPersonalGitHubCopilotBaseUrl(baseUrl: string | undefined): boolean {
	return baseUrl === PERSONAL_GITHUB_COPILOT_BASE_URL;
}

export function normalizeGitHubCopilotEnterpriseDomain(input: string | undefined): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed) return undefined;
	const normalized = normalizeDomain(trimmed) ?? trimmed.toLowerCase();
	if (!normalized || isPublicGitHubHost(normalized)) return undefined;
	return normalized;
}

export function normalizeGitHubCopilotApiEndpoint(input: string | undefined): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed?.startsWith("https://")) return undefined;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "https:" || !url.hostname) return undefined;
		return trimTrailingSlashes(trimmed);
	} catch {
		// This asks whether a string is a usable https URL, so a parse failure IS the answer: not usable. The
		// caller falls back to its documented default endpoint, exactly as for a value that was never set.
		return undefined;
	}
}

/**
 * Resolve the plan-specific Copilot API endpoint advertised for a GitHub token.
 * Login and raw environment-token discovery share this best-effort probe. Pass
 * a `signal` to bound it against the same discovery deadline as `/models`; a
 * stalled probe otherwise blocks discovery indefinitely.
 */
export async function discoverGitHubCopilotApiEndpoint(
	token: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await fetchImpl("https://api.github.com/copilot_internal/user", {
			headers: {
				Accept: "application/json",
				Authorization: `token ${token}`,
				...COPILOT_IDENTITY_HEADERS,
			},
			signal,
		});
		if (!response.ok) return undefined;
		const data: unknown = await response.json();
		if (!isRecord(data) || !isRecord(data.endpoints)) return undefined;
		const endpoint = data.endpoints.api;
		return typeof endpoint === "string" ? normalizeGitHubCopilotApiEndpoint(endpoint) : undefined;
	} catch {
		return undefined;
	}
}

export function parseGitHubCopilotApiKey(apiKeyRaw: string): ParsedGitHubCopilotApiKey {
	try {
		const parsed = JSON.parse(apiKeyRaw) as GitHubCopilotApiKeyPayload;
		if (typeof parsed.token === "string") {
			return {
				accessToken: parsed.token,
				enterpriseUrl:
					typeof parsed.enterpriseUrl === "string"
						? normalizeGitHubCopilotEnterpriseDomain(parsed.enterpriseUrl)
						: undefined,
				apiEndpoint:
					typeof parsed.apiEndpoint === "string"
						? normalizeGitHubCopilotApiEndpoint(parsed.apiEndpoint)
						: undefined,
			};
		}
	} catch {}

	return { accessToken: apiKeyRaw };
}

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		// This asks whether a string is a usable https URL, so a parse failure IS the answer: not usable. The
		// caller falls back to its documented default endpoint, exactly as for a value that was never set.
		return null;
	}
}

export function getGitHubCopilotBaseUrl(enterpriseDomain?: string): string {
	const normalizedEnterpriseDomain = normalizeGitHubCopilotEnterpriseDomain(enterpriseDomain);
	if (!normalizedEnterpriseDomain) return "https://api.githubcopilot.com";
	const host = normalizedEnterpriseDomain.startsWith("copilot-api.")
		? normalizedEnterpriseDomain
		: `copilot-api.${normalizedEnterpriseDomain}`;
	return `https://${host}`;
}
