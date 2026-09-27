import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@veyyon/ai";
import type { CredentialStore } from "../src/credentials";
import {
	findFirecrawlApiKey,
	normalizeFirecrawlScrapeUrl,
	normalizeFirecrawlSearchUrl,
	scrapeWithFirecrawl,
} from "../src/firecrawl";

describe("normalizeFirecrawlScrapeUrl", () => {
	it("defaults to api.firecrawl.dev v1 scrape URL", () => {
		expect(normalizeFirecrawlScrapeUrl()).toBe("https://api.firecrawl.dev/v1/scrape");
	});

	it("appends /v1/scrape to a base domain", () => {
		expect(normalizeFirecrawlScrapeUrl("https://firecrawl.wladefant.de")).toBe(
			"https://firecrawl.wladefant.de/v1/scrape",
		);
	});

	it("preserves existing /v1/scrape or /v2/scrape path", () => {
		expect(normalizeFirecrawlScrapeUrl("https://custom.firecrawl.io/v1/scrape")).toBe(
			"https://custom.firecrawl.io/v1/scrape",
		);
		expect(normalizeFirecrawlScrapeUrl("https://api.firecrawl.dev/v2/scrape/")).toBe(
			"https://api.firecrawl.dev/v2/scrape",
		);
	});

	it("appends /scrape when /v1 or /v2 base is provided", () => {
		expect(normalizeFirecrawlScrapeUrl("https://firecrawl.local/v1")).toBe("https://firecrawl.local/v1/scrape");
	});
});

describe("normalizeFirecrawlSearchUrl", () => {
	it("uses /v2/search for api.firecrawl.dev", () => {
		expect(normalizeFirecrawlSearchUrl("https://api.firecrawl.dev")).toBe("https://api.firecrawl.dev/v2/search");
	});

	it("uses /v1/search for self-hosted instances without version", () => {
		expect(normalizeFirecrawlSearchUrl("https://firecrawl.wladefant.de")).toBe(
			"https://firecrawl.wladefant.de/v1/search",
		);
	});

	it("preserves explicit version paths", () => {
		expect(normalizeFirecrawlSearchUrl("https://firecrawl.wladefant.de/v1/search")).toBe(
			"https://firecrawl.wladefant.de/v1/search",
		);
	});
});

describe("findFirecrawlApiKey", () => {
	it("prefers explicitly configured key", () => {
		expect(findFirecrawlApiKey(null, "fc_test_123")).toBe("fc_test_123");
	});

	it("falls back to credential storage when available", () => {
		const mockStorage: CredentialStore = {
			listAuthCredentials: (provider?: string) =>
				provider === "firecrawl" ? [{ credential: { type: "api_key", key: "stored_token" } }] : [],
		};
		expect(findFirecrawlApiKey(mockStorage, undefined)).toBe("stored_token");
	});
});

describe("scrapeWithFirecrawl", () => {
	it("parses successful markdown response", async () => {
		const mockFetch = async () =>
			new Response(
				JSON.stringify({
					success: true,
					data: {
						markdown: "# Example Title\n\nExample content from page.",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const result = await scrapeWithFirecrawl("https://example.com", {
			apiKey: "fc_test",
			fetch: mockFetch as unknown as FetchImpl,
		});

		expect(result.success).toBe(true);
		expect(result.markdown).toBe("# Example Title\n\nExample content from page.");
	});

	it("returns error on HTTP failure", async () => {
		const mockFetch = async () =>
			new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			});

		const result = await scrapeWithFirecrawl("https://example.com", {
			apiKey: "fc_test",
			fetch: mockFetch as unknown as FetchImpl,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("429");
	});
});
