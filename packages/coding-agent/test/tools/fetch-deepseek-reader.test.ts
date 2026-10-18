import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { renderHtmlToText } from "@veyyon/coding-agent/tools/web/fetch";

/** Substantive HTML so the local renderers clear the reader-mode quality gate. */
const ARTICLE_HTML = `<!doctype html><html><head><title>Example</title></head><body><article><h1>Example article</h1>${Array.from(
	{ length: 6 },
	(_, i) =>
		`<p>Paragraph number ${i + 1} carries some real content for the article body so the native renderer has enough text to satisfy the length threshold.</p>`,
).join("")}</article></body></html>`;

describe("renderHtmlToText: DeepSeek fetch backend", () => {
	beforeEach(() => {
		process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
	});

	afterEach(() => {
		delete process.env.DEEPSEEK_API_KEY;
	});

	it("reads the page through DeepSeek Fetch and keeps its title", async () => {
		const settings = Settings.isolated({ "providers.fetch": "deepseek" });
		let requestUrl = "";
		let requestBody: unknown = null;
		let authHeader = "";

		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestUrl = String(input);
			requestBody = JSON.parse(String(init?.body ?? "null"));
			authHeader = new Headers(init?.headers).get("Authorization") ?? "";
			return new Response(
				JSON.stringify({ title: "DeepSeek Page Title", content: `# Heading\n\n${"Body text. ".repeat(30)}` }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await renderHtmlToText(
			"https://example.com/article",
			ARTICLE_HTML,
			5,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(requestUrl).toBe("https://api.deepseek.com/v1/tools/fetch");
		expect(requestBody).toEqual({ url: "https://example.com/article" });
		expect(authHeader).toBe("Bearer test-deepseek-key");
		expect(result.method).toBe("deepseek");
		expect(result.ok).toBe(true);
		expect(result.content.startsWith("# DeepSeek Page Title\n\n# Heading")).toBe(true);
	});

	it("never sends a credential-bearing URL to DeepSeek", async () => {
		const settings = Settings.isolated({ "providers.fetch": "deepseek" });
		let calls = 0;

		const fetchMock = async (): Promise<Response> => {
			calls += 1;
			return new Response(JSON.stringify({ title: "t", content: "Body text. ".repeat(30) }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const result = await renderHtmlToText(
			"https://user:secret@example.com/article",
			ARTICLE_HTML,
			5,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(calls).toBe(0);
		expect(result.method).not.toBe("deepseek");
	});

	it("falls through to a local renderer when DeepSeek refuses the read", async () => {
		const settings = Settings.isolated({ "providers.fetch": "deepseek" });
		const fetchMock = async (): Promise<Response> =>
			new Response(JSON.stringify({ error: { message: "rate limited" } }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			});

		const result = await renderHtmlToText(
			"https://example.com/article",
			ARTICLE_HTML,
			5,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(["native", "trafilatura", "lynx"]).toContain(result.method);
		expect(result.ok).toBe(true);
	});

	it("does not call DeepSeek at all without a key", async () => {
		delete process.env.DEEPSEEK_API_KEY;
		const settings = Settings.isolated({ "providers.fetch": "deepseek" });
		let calls = 0;
		const fetchMock = async (): Promise<Response> => {
			calls += 1;
			return new Response(JSON.stringify({ title: "t", content: "Body text. ".repeat(30) }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const result = await renderHtmlToText(
			"https://example.com/article",
			ARTICLE_HTML,
			5,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(calls).toBe(0);
		expect(result.method).not.toBe("deepseek");
	});
});
