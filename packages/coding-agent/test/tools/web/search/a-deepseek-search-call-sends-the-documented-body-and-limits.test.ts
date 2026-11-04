import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@veyyon/ai";
import {
	buildRequestBody,
	searchDeepSeek,
	truncateQuery,
} from "@veyyon/coding-agent/tools/web/search/providers/deepseek";
import type { SearchProviderError } from "@veyyon/coding-agent/tools/web/search/types";

describe("DeepSeek web search provider", () => {
	beforeEach(() => {
		process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
	});

	afterEach(() => {
		delete process.env.DEEPSEEK_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.DEEPSEEK_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.DEEPSEEK_API_KEY);
		},
		resolver(_provider: string) {
			return async () => process.env.DEEPSEEK_API_KEY ?? undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "DeepSeek test prompt",
		} as const;
	}

	it("posts the documented body with the DeepSeek bearer key and maps results", async () => {
		let requestUrl = "";
		let requestMethod = "";
		let requestBody: Record<string, unknown> | null = null;
		let authHeader = "";

		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestUrl = String(input);
			requestMethod = init?.method ?? "";
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			authHeader = new Headers(init?.headers).get("Authorization") ?? "";
			return new Response(
				JSON.stringify({
					results: [
						{
							title: "Result One",
							url: "https://example.com/one",
							snippet: "Short display snippet",
							summary: "Longer summary written for a model to read",
							date: "2026-03-01T00:00:00Z",
							site_name: "example.com",
						},
						{
							title: "  ",
							url: "https://example.com/two",
							snippet: "Only a display snippet",
						},
						{ title: "No URL here", summary: "Dropped because a source needs a url" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchDeepSeek({
			...makeParams("latest ai news"),
			numSearchResults: 2,
			fetch: fetchMock,
		});

		expect(requestUrl).toBe("https://api.deepseek.com/v1/tools/search");
		expect(requestMethod).toBe("POST");
		expect(requestBody).toMatchObject({ query: "latest ai news", count: 2, need_content: false });
		expect(authHeader).toBe("Bearer test-deepseek-key");
		expect(response).toMatchObject({
			provider: "deepseek",
			authMode: "api_key",
			sources: [
				{
					title: "Result One",
					url: "https://example.com/one",
					snippet: "Longer summary written for a model to read",
					publishedDate: "2026-03-01T00:00:00Z",
				},
				{
					title: "https://example.com/two",
					url: "https://example.com/two",
					snippet: "Only a display snippet",
				},
			],
		});
		expect(response.sources[0]?.ageSeconds).toBeTypeOf("number");
		expect(response.answer).toBeUndefined();
	});

	it("cuts an over-long query to 128 code points before sending it", async () => {
		let requestBody: Record<string, unknown> | null = null;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		// One emoji per character: counting UTF-16 units would cut the last one in half.
		const longQuery = "😀".repeat(200);
		expect(Array.from(truncateQuery(longQuery)).length).toBe(128);

		await searchDeepSeek({ ...makeParams(longQuery), fetch: fetchMock });
		const sentQuery = (requestBody as Record<string, unknown> | null)?.query;
		expect(typeof sentQuery).toBe("string");
		expect(Array.from(sentQuery as string).length).toBe(128);
	});

	it("clamps the result count to the documented 1..50 range", () => {
		expect(buildRequestBody({ query: "q", num_results: 500 }).count).toBe(50);
		expect(buildRequestBody({ query: "q", num_results: 0 }).count).toBe(10);
		expect(buildRequestBody({ query: "q" }).count).toBe(10);
		expect(buildRequestBody({ query: "q", num_results: 3 }).count).toBe(3);
	});

	it("reports an empty result set as no sources instead of failing", async () => {
		const fetchMock = (): Promise<Response> =>
			Promise.resolve(
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		const response = await searchDeepSeek({ ...makeParams("nothing matches"), fetch: fetchMock });
		expect(response.sources).toEqual([]);
		expect(response.provider).toBe("deepseek");
	});

	it("surfaces HTTP errors as a deepseek provider error", async () => {
		const fetchMock = (): Promise<Response> =>
			Promise.resolve(
				new Response(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
			);

		await expect(searchDeepSeek({ ...makeParams("bad auth"), fetch: fetchMock })).rejects.toEqual(
			expect.objectContaining({
				provider: "deepseek",
				status: 401,
				message: "deepseek: 401 unauthorized",
			}) satisfies Partial<SearchProviderError>,
		);
	});

	it("throws a clear error when DeepSeek credentials are missing", async () => {
		delete process.env.DEEPSEEK_API_KEY;
		await expect(searchDeepSeek(makeParams("missing creds"))).rejects.toThrow(
			'DeepSeek credentials not found. Set DEEPSEEK_API_KEY or configure an API key for provider "deepseek".',
		);
	});
});
