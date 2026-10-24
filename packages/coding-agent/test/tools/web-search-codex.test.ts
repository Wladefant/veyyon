import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, CyberAccessProgram, FetchImpl } from "@veyyon/ai";
import { resetCodexAccessProgramListings } from "@veyyon/ai/providers/openai-codex/access-programs";
import { resolveCodexResponsesLite } from "@veyyon/ai/providers/openai-codex/request-transformer";
import { getBundledModels } from "@veyyon/catalog/models";
import type { SearchParams } from "@veyyon/coding-agent/tools/web/search/providers/base";
import { searchCodex } from "@veyyon/coding-agent/tools/web/search/providers/codex";
import { SearchProviderError } from "@veyyon/coding-agent/tools/web/search/types";

type CapturedRequest = {
	url: string;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

const originalCodexSearchModel = process.env.VEYYON_CODEX_WEB_SEARCH_MODEL;

function makeSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Codex answer",
						annotations: [{ type: "url_citation", url: "https://example.com/article", title: "Example Article" }],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_codex_test",
				model,
				usage: {
					input_tokens: 12,
					output_tokens: 7,
					total_tokens: 19,
				},
			},
		})}`,
		"",
	].join("\n");
}

function makeImagePlaceholderSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_text.delta",
			delta: "OpenAI Responses API defaults `store` to false unless you opt in.",
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "(see attached image)",
						annotations: [
							{ type: "url_citation", url: "https://platform.openai.com/docs/api-reference/responses" },
						],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_codex_placeholder_test",
				model,
			},
		})}`,
		"",
	].join("\n");
}

function makeMarkdownLinkSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "See [Example Article](https://example.com/article) for details.",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_markdown_test", model },
		})}`,
		"",
	].join("\n");
}

function makePlainUrlSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Sources:\n- https://example.com/article\n- https://example.com/faq",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_plain_url_test", model },
		})}`,
		"",
	].join("\n");
}

function makeMarkdownParenthesesSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "See [Function](https://en.wikipedia.org/wiki/Function_(mathematics)) for details.",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_markdown_parentheses_test", model },
		})}`,
		"",
	].join("\n");
}

function makePlainUrlPunctuationSseResponse(model: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Read https://example.com/article. Then compare https://example.com/faq), and keep https://en.wikipedia.org/wiki/Function_(mathematics).",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_plain_url_punctuation_test", model },
		})}`,
		"",
	].join("\n");
}

/**
 * Build an SSE response whose single output item carries `text` as answer prose
 * with NO url_citation annotations, forcing searchCodex onto its extractTextSources
 * fallback. One generic builder keeps the URL-extraction edge cases from each
 * needing its own near-identical helper.
 */
function makeAnswerTextSseResponse(model: string, text: string, id: string): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		})}`,
		"",
		`data: ${JSON.stringify({ type: "response.completed", response: { id, model } })}`,
		"",
	].join("\n");
}

describe("searchCodex model selection", () => {
	const fakeAuthStorage = {
		async getOAuthAccess() {
			return {
				accessToken: "test-access-token",
				accountId: "acct-test",
			};
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;
	let capturedRequest: CapturedRequest | null = null;
	/** The models the account's `/codex/models` listing returns; a search lists its account before it searches. */
	let accountListing: unknown[] = [];
	/** The `chatgpt-account-id` of every listing request, in order. */
	const listingAccounts: Array<string | null> = [];

	/** Answers the account's model listing and forwards every other request to `fetch`. */
	function answeringListings(fetch: FetchImpl): FetchImpl {
		return (url, init) => {
			const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
			if (!new URL(href).pathname.endsWith("/models")) return fetch(url, init);
			listingAccounts.push(new Headers(init?.headers).get("chatgpt-account-id"));
			return Promise.resolve(new Response(JSON.stringify({ models: accountListing })));
		};
	}

	function makeSearchParams(query: string, fetch?: FetchImpl): SearchParams {
		return {
			query,
			systemPrompt: "Codex test system prompt",
			authStorage: fakeAuthStorage,
			...(fetch ? { fetch: answeringListings(fetch) } : {}),
		};
	}

	function mockCodexFetch(responseModel: string, responseBody?: string): FetchImpl {
		capturedRequest = null;
		return (url, init) => {
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return Promise.resolve(
				new Response(responseBody ?? makeSseResponse(responseModel), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
		capturedRequest = null;
		accountListing = [];
		listingAccounts.length = 0;
		resetCodexAccessProgramListings();
		if (originalCodexSearchModel === undefined) {
			delete process.env.VEYYON_CODEX_WEB_SEARCH_MODEL;
		} else {
			process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = originalCodexSearchModel;
		}
	});

	it("uses GPT-5.6 Luna as the first bundled default", async () => {
		delete process.env.VEYYON_CODEX_WEB_SEARCH_MODEL;
		const result = await searchCodex(makeSearchParams("default codex model", mockCodexFetch("gpt-5.6-luna")));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(capturedRequest?.body?.model).toBe("gpt-5.6-luna");
		expect(new Headers(capturedRequest?.headers).get("x-codex-routing-hint")).toBe("model=gpt-5.6-luna");
		expect(result.model).toBe("gpt-5.6-luna");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	// A search is judged under the account's program like a turn. Keyed by program, so a program added
	// to the union fails the type check until a level is recorded here.
	const SEARCH_ACCOUNT_LEVELS: Record<CyberAccessProgram, { offered: string[]; sent: unknown }> = {
		standard: { offered: ["standard"], sent: undefined },
		daybreak_blue: { offered: ["standard", "daybreak_blue"], sent: { cyber: "daybreak_blue" } },
		daybreak_red: { offered: ["standard", "daybreak_red"], sent: { cyber: "daybreak_red" } },
	};
	for (const [level, { offered, sent }] of Object.entries(SEARCH_ACCOUNT_LEVELS)) {
		it(`sends the program a ${level} account is offered for the search model`, async () => {
			delete process.env.VEYYON_CODEX_WEB_SEARCH_MODEL;
			accountListing = [
				{ slug: "gpt-5.6-luna", supported_in_api: true, available_access_programs: { cyber: offered } },
			];

			await searchCodex(makeSearchParams("vulnerability advisory", mockCodexFetch("gpt-5.6-luna")));
			await searchCodex(makeSearchParams("vulnerability advisory", mockCodexFetch("gpt-5.6-luna")));

			expect(capturedRequest?.body?.access_programs).toEqual(sent);
			// The account is listed once, under the account id the search sends, and the listing is reused.
			expect(listingAccounts).toEqual(["acct-test"]);
		});
	}

	it("falls back to the default model when VEYYON_CODEX_WEB_SEARCH_MODEL is blank", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "   ";
		const result = await searchCodex(makeSearchParams("blank codex model", mockCodexFetch("gpt-5.6-luna")));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.model).toBe("gpt-5.6-luna");
		expect(result.model).toBe("gpt-5.6-luna");
	});

	it("retries the next bundled default when Codex rejects a model for ChatGPT accounts", async () => {
		delete process.env.VEYYON_CODEX_WEB_SEARCH_MODEL;
		let calls = 0;
		capturedRequest = null;
		const fetchMock: FetchImpl = (url, init) => {
			calls += 1;
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};

			const requestedModel = capturedRequest.body?.model;
			if (calls === 1) {
				expect(requestedModel).toBe("gpt-5.6-luna");
				return Promise.resolve(
					new Response(
						JSON.stringify({
							detail: "The 'gpt-5.6-luna' model is not supported when using Codex with a ChatGPT account.",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			expect(requestedModel).toBe("gpt-5.6-terra");
			return Promise.resolve(
				new Response(makeSseResponse("gpt-5.6-terra"), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};

		const result = await searchCodex(makeSearchParams("retry unsupported default", fetchMock));

		expect(calls).toBe(2);
		expect(result.model).toBe("gpt-5.6-terra");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("stops at the first bundled default when Codex fails for a reason other than the model", async () => {
		delete process.env.VEYYON_CODEX_WEB_SEARCH_MODEL;
		let calls = 0;
		const fetchMock: FetchImpl = () => {
			calls += 1;
			return Promise.resolve(new Response("upstream failure", { status: 500 }));
		};

		await expect(searchCodex(makeSearchParams("default codex failure", fetchMock))).rejects.toThrow(
			"Codex API error (500).",
		);
		expect(calls).toBe(1);
	});

	// WHY: a search on a model the catalog marks for Responses-Lite was sent in the Lite shape, with
	// the hosted `web_search` tool moved into an `additional_tools` input item and `tool_choice` still
	// naming it. The endpoint answers that request 400 `Tool choice 'web_search_preview' not found in
	// 'tools' parameter.`, and the Lite shape with `tool_choice: auto` answers from the model's own
	// knowledge without searching, so every default search on a ChatGPT account failed. The sweep sends
	// a search on every bundled Codex model and requires the plain Responses shape. Not caught: a model
	// the endpoint later refuses in the plain shape, which only a live request shows.
	it("sends every bundled Codex model's search in the plain Responses shape, Responses-Lite models included", async () => {
		const bundled = getBundledModels("openai-codex").filter(model => model.api === "openai-codex-responses");
		expect(bundled.some(model => resolveCodexResponsesLite(model, undefined))).toBe(true);

		for (const model of bundled) {
			process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = model.id;
			const result = await searchCodex(makeSearchParams(`${model.id} web search`, mockCodexFetch(model.id)));

			const headers = new Headers(capturedRequest?.headers);
			expect(headers.get("x-openai-internal-codex-responses-lite")).toBeNull();
			expect(capturedRequest?.body).toEqual({
				model: model.id,
				stream: true,
				store: false,
				input: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: `${model.id} web search` }] },
				],
				tools: [{ type: "web_search", search_context_size: "high" }],
				tool_choice: { type: "web_search" },
				instructions: "Codex test system prompt",
			});
			expect(result.model).toBe(model.id);
		}
	});

	it("does not retry default candidates when VEYYON_CODEX_WEB_SEARCH_MODEL is explicitly unsupported", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.5";
		let calls = 0;
		capturedRequest = null;
		const fetchMock: FetchImpl = (url, init) => {
			calls += 1;
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};

			expect(capturedRequest.body?.model).toBe("gpt-5.5");
			return Promise.resolve(
				new Response(
					JSON.stringify({
						detail: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		await expect(searchCodex(makeSearchParams("explicit unsupported model", fetchMock))).rejects.toThrow(
			"requested model is not supported",
		);
		expect(calls).toBe(1);
	});

	// A 401 or a quota body rotates the credential before the error surfaces, which the fake auth store
	// here does not model; a 403 is classified without rotating.
	it("maps a failed response to a classified auth error first, then to the unsupported-model or status error", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.5";
		const cases: Array<{ status: number; body: string; message: string }> = [
			{
				status: 403,
				body: '{"detail":"The requested model is not supported."}',
				message: "codex: 403 forbidden",
			},
			{
				status: 400,
				body: '{"detail":"The requested model is not supported."}',
				message: "codex: requested model is not supported",
			},
			{ status: 500, body: "upstream failure", message: "Codex API error (500)." },
		];
		for (const { status, body, message } of cases) {
			const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status }));
			const error = await searchCodex(makeSearchParams("failed response", fetchMock)).catch(
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "codex", status, message });
		}
	});

	it("forces web_search tool choice and extracts markdown link citations when annotations are absent", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const result = await searchCodex(
			makeSearchParams("markdown citations", mockCodexFetch("gpt-5.4", makeMarkdownLinkSseResponse("gpt-5.4"))),
		);

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.tool_choice).toEqual({ type: "web_search" });
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("extracts plain text URLs when annotations are absent", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const result = await searchCodex(
			makeSearchParams("plain url citations", mockCodexFetch("gpt-5.4", makePlainUrlSseResponse("gpt-5.4"))),
		);

		expect(result.sources).toEqual([
			{ title: "https://example.com/article", url: "https://example.com/article" },
			{ title: "https://example.com/faq", url: "https://example.com/faq" },
		]);
	});

	it("preserves markdown URLs that contain balanced parentheses", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const result = await searchCodex(
			makeSearchParams(
				"markdown parentheses citations",
				mockCodexFetch("gpt-5.4", makeMarkdownParenthesesSseResponse("gpt-5.4")),
			),
		);

		expect(result.sources).toEqual([
			{ title: "Function", url: "https://en.wikipedia.org/wiki/Function_(mathematics)" },
		]);
	});

	it("strips trailing prose punctuation from plain text URLs", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const result = await searchCodex(
			makeSearchParams(
				"plain url punctuation",
				mockCodexFetch("gpt-5.4", makePlainUrlPunctuationSseResponse("gpt-5.4")),
			),
		);

		expect(result.sources).toEqual([
			{ title: "https://example.com/article", url: "https://example.com/article" },
			{ title: "https://example.com/faq", url: "https://example.com/faq" },
			{
				title: "https://en.wikipedia.org/wiki/Function_(mathematics)",
				url: "https://en.wikipedia.org/wiki/Function_(mathematics)",
			},
		]);
	});

	// The url_citation-absent fallback (extractTextSources -> normalizeExtractedUrl)
	// cleans links out of prose the model wrote. These pin the trimming rules that
	// the earlier markdown/plain/parentheses/punctuation tests do not: unmatched
	// closing brackets, the full trailing-punctuation set, non-http scheme
	// rejection, and dedup of a URL cited both as a markdown link and bare.
	it("strips unmatched closing brackets and trailing !/? from bare URLs", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		// a] and b} have an unmatched ] / } (no opener), c! and d? trail punctuation.
		const text =
			"Grab https://example.com/a] then https://example.com/b} and https://example.com/c! plus https://example.com/d?";
		const result = await searchCodex(
			makeSearchParams(
				"bracket trimming",
				mockCodexFetch("gpt-5.4", makeAnswerTextSseResponse("gpt-5.4", text, "resp_brackets")),
			),
		);

		expect(result.sources).toEqual([
			{ title: "https://example.com/a", url: "https://example.com/a" },
			{ title: "https://example.com/b", url: "https://example.com/b" },
			{ title: "https://example.com/c", url: "https://example.com/c" },
			{ title: "https://example.com/d", url: "https://example.com/d" },
		]);
	});

	it("strips trailing semicolon, colon, and apostrophe from bare URLs", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const text = "Mixed https://example.com/x; and https://example.com/y: and https://example.com/z'";
		const result = await searchCodex(
			makeSearchParams(
				"punct trimming",
				mockCodexFetch("gpt-5.4", makeAnswerTextSseResponse("gpt-5.4", text, "resp_punct2")),
			),
		);

		expect(result.sources).toEqual([
			{ title: "https://example.com/x", url: "https://example.com/x" },
			{ title: "https://example.com/y", url: "https://example.com/y" },
			{ title: "https://example.com/z", url: "https://example.com/z" },
		]);
	});

	it("drops markdown links whose URL is not http(s) and keeps the valid one", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		// ftp:// and scheme-less www. links must not become sources; only Good survives.
		const text =
			"See [Good](https://example.com/keep) and [Bad](ftp://example.com/drop) and [None](www.example.com/nope).";
		const result = await searchCodex(
			makeSearchParams(
				"scheme rejection",
				mockCodexFetch("gpt-5.4", makeAnswerTextSseResponse("gpt-5.4", text, "resp_scheme")),
			),
		);

		expect(result.sources).toEqual([{ title: "Good", url: "https://example.com/keep" }]);
	});

	it("dedups a URL cited as both a markdown link and a bare mention, keeping the link title", async () => {
		process.env.VEYYON_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const text = "Cite [Article](https://example.com/a) and again bare https://example.com/a here.";
		const result = await searchCodex(
			makeSearchParams("dedup", mockCodexFetch("gpt-5.4", makeAnswerTextSseResponse("gpt-5.4", text, "resp_dedup"))),
		);

		// The markdown pass runs first, so the "Article" title wins over the bare URL title.
		expect(result.sources).toEqual([{ title: "Article", url: "https://example.com/a" }]);
	});

	it("prefers streamed text when the final item only contains an image placeholder", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(makeImagePlaceholderSseResponse("gpt-5.4-mini"), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);

		const result = await searchCodex(makeSearchParams("responses api store semantics", fetchMock));

		expect(result.answer).toBe("OpenAI Responses API defaults `store` to false unless you opt in.");
		expect(result.sources).toEqual([
			{
				title: "https://platform.openai.com/docs/api-reference/responses",
				url: "https://platform.openai.com/docs/api-reference/responses",
			},
		]);
	});

	it("throws to advance the chain when both streamed and final answers are image placeholders without sources", async () => {
		const sse = [
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "[Attached image]",
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [{ type: "output_text", text: "See image above.", annotations: [] }],
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_codex_placeholder_only", model: "gpt-5.5" },
			})}`,
			"",
		].join("\n");

		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("image only", fetchMock))).rejects.toThrow(/image-only response/);
	});

	it("drops placeholder prose from the answer but keeps annotation sources when both are placeholders", async () => {
		const sse = [
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "(see attached image)",
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [
						{
							type: "output_text",
							text: "(See attached image.)",
							annotations: [{ type: "url_citation", url: "https://example.com/docs", title: "Docs" }],
						},
					],
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_codex_placeholder_with_sources", model: "gpt-5.5" },
			})}`,
			"",
		].join("\n");

		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		const result = await searchCodex(makeSearchParams("image with sources", fetchMock));
		expect(result.answer).toBeUndefined();
		expect(result.sources).toEqual([{ title: "Docs", url: "https://example.com/docs" }]);
	});
});
