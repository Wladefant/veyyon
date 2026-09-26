import type { FetchImpl } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import { isRecord } from "@veyyon/utils/type-guards";
import type { CredentialStore } from "./credentials";
import { findCredential } from "./credentials";
import { withHardTimeout } from "./hard-timeout";

export const DEFAULT_FIRECRAWL_API_URL = "https://api.firecrawl.dev";

export interface FirecrawlScrapeOptions {
	endpoint?: string;
	apiKey?: string;
	formats?: string[];
	onlyMainContent?: boolean;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface FirecrawlScrapeResult {
	success: boolean;
	markdown?: string;
	error?: string;
}

/**
 * Resolve Firecrawl API key / auth token.
 * Order of precedence:
 * 1. Explicitly configured key in settings/options
 * 2. Environment variable (FIRECRAWL_API_KEY)
 * 3. Credential store (agent auth storage)
 */
export function findFirecrawlApiKey(
	storage: CredentialStore | null | undefined,
	configuredKey?: string,
): string | null {
	if (configuredKey && configuredKey.trim().length > 0) return configuredKey.trim();
	return findCredential(storage, getEnvApiKey("firecrawl"), "firecrawl");
}

/**
 * Normalize the scrape endpoint URL. Handles base URLs with or without version prefixes.
 */
export function normalizeFirecrawlScrapeUrl(endpoint?: string): string {
	const raw = endpoint || process.env.FIRECRAWL_ENDPOINT || DEFAULT_FIRECRAWL_API_URL;
	const base = raw.trim().replace(/\/+$/, "");
	if (base.endsWith("/v1/scrape") || base.endsWith("/v2/scrape")) {
		return base;
	}
	if (base.endsWith("/v1") || base.endsWith("/v2")) {
		return `${base}/scrape`;
	}
	return `${base}/v1/scrape`;
}

/**
 * Normalize the search endpoint URL for Firecrawl / SearXNG backend.
 * Uses /v2/search on api.firecrawl.dev and /v1/search on self-hosted instances.
 */
export function normalizeFirecrawlSearchUrl(endpoint?: string): string {
	const raw = endpoint || process.env.FIRECRAWL_ENDPOINT || DEFAULT_FIRECRAWL_API_URL;
	const base = raw.trim().replace(/\/+$/, "");
	if (base.endsWith("/v1/search") || base.endsWith("/v2/search")) {
		return base;
	}
	if (base.endsWith("/v1") || base.endsWith("/v2")) {
		return `${base}/search`;
	}
	if (base.includes("api.firecrawl.dev")) {
		return `${base}/v2/search`;
	}
	return `${base}/v1/search`;
}

/**
 * Scrape a web page using Firecrawl API (cloud or self-hosted).
 */
export async function scrapeWithFirecrawl(
	url: string,
	options: FirecrawlScrapeOptions = {},
	storage?: CredentialStore | null,
): Promise<FirecrawlScrapeResult> {
	const apiKey = findFirecrawlApiKey(storage, options.apiKey);
	const scrapeUrl = normalizeFirecrawlScrapeUrl(options.endpoint);
	const fetchImpl = options.fetch ?? fetch;

	return withHardTimeout(options.signal, async hardSignal => {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const body = {
			url,
			formats: options.formats ?? ["markdown"],
			...(options.onlyMainContent !== undefined ? { onlyMainContent: options.onlyMainContent } : {}),
		};

		const response = await fetchImpl(scrapeUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: hardSignal,
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Firecrawl scrape failed with HTTP ${response.status}`,
			};
		}

		const payload = await response.json();
		if (!isRecord(payload)) {
			return { success: false, error: "Invalid JSON response from Firecrawl" };
		}

		// Firecrawl API response shape: { success: true, data: { markdown: "..." } } or { markdown: "..." }
		const data = isRecord(payload.data) ? payload.data : payload;
		const markdown = typeof data.markdown === "string" ? data.markdown : undefined;

		return {
			success: payload.success !== false && Boolean(markdown),
			markdown,
			error: typeof payload.error === "string" ? payload.error : undefined,
		};
	});
}
