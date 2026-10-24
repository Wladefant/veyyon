/**
 * Contract: a `2xx` answer whose body is not an event stream fails on the request that received it,
 * states what came back and from where, and is not retried unless the provider's own sentence reads
 * as transient. A mislabelled event stream still streams.
 *
 * WHY THIS EXISTS. A `baseUrl` that points at a login page, a docs site or a non-streaming endpoint,
 * or a proxy that answers with its own page, returns `200` with HTML or a JSON document. The body was
 * handed to the SSE decoder as it was, which found no events in it, and the turn ended as a cut
 * stream: "stream closed before a terminal finish reason" on the OpenAI wire, "stream ended before
 * message_start" on Anthropic, "stream ended without a finish reason" on Google. Each of those is
 * retryable, so the same request went to the same page until the retry budget ran out: eleven to
 * twenty-two requests and close to a minute before the error, and the error described a truncated
 * stream that never existed.
 *
 * THE CLASS: every provider stream that reads an HTTP body as an event stream, through
 * `eventStreamBody`, crossed with every body shape that cannot be an event stream (HTML with and
 * without a title, a JSON document, a JSON array, a JSON error envelope) and every way such a body
 * arrives (any content type but `text/event-stream`, a blank lead, the lead split across chunks, a
 * body that never ends). The converse is swept too: an event stream under the wrong content type,
 * behind blank lines or behind a comment, must still decode, so the check cannot be satisfied by
 * rejecting every unlabelled body.
 *
 * WHAT IT DOES NOT CATCH: a body labelled `text/event-stream` that is HTML is decoded as an event
 * stream and still reads as a truncated one; the label is taken at its word. A provider list is
 * written out below, so a new provider that reads its body without `eventStreamBody` is outside the
 * sweep. Codex server-side compaction reads its body without it and falls back to local compaction
 * on any failure; the auth broker and Ollama's NDJSON wire are not event streams.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { streamAzureOpenAIResponses } from "@veyyon/ai/providers/azure-openai-responses";
import { streamGoogle } from "@veyyon/ai/providers/google";
import { streamGoogleGeminiCli } from "@veyyon/ai/providers/google-gemini-cli";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import { streamPiNative } from "@veyyon/ai/providers/pi-native-client";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec } from "@veyyon/ai/types";
import { eventStreamBody } from "@veyyon/ai/utils/http-inspector";
import { buildModel } from "@veyyon/catalog/build";
import { emptyUsage } from "@veyyon/catalog/models";
import * as piUtils from "@veyyon/utils";
import { createCodexModel } from "./helpers";

const SPEC = {
	name: "Probe",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function context(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] };
}

function sseText(events: unknown[]): string {
	return `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

const RESPONSES_ANSWER = sseText([
	{ type: "response.created", response: { id: "resp_probe" } },
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_probe", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_probe",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "hello" }],
		},
	},
	{
		type: "response.completed",
		response: {
			id: "resp_probe",
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]);

/** Anthropic names each event; the decoder reads the name. */
const ANTHROPIC_ANSWER = [
	{
		type: "message_start",
		message: {
			id: "msg_probe",
			usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

const GOOGLE_CHUNK = {
	candidates: [{ content: { parts: [{ text: "hello" }], role: "model" }, finishReason: "STOP", index: 0 }],
	usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
};

/** A Codex access token naming an account. */
function codexToken(): string {
	const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acc_probe" } };
	return `aaa.${Buffer.from(JSON.stringify(claims), "utf8").toBase64()}.bbb`;
}

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface Provider {
	readonly name: string;
	/** An event stream this provider reads as a finished turn whose text is `hello`. */
	readonly answer: string;
	run(fetch: FetchImpl): Promise<AssistantMessage>;
}

/** Every caller of `postOpenAIStream`. */
const PROVIDERS: readonly Provider[] = [
	{
		name: "openai-completions",
		answer: `${sseText([
			{ choices: [{ index: 0, delta: { content: "hello" } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		])}data: [DONE]\n\n`,
		run: fetch =>
			streamOpenAICompletions(
				buildModel({
					...SPEC,
					id: "probe-chat",
					api: "openai-completions",
					provider: "probe",
					baseUrl: "https://llm.example.test/v1",
				}) as Model<"openai-completions">,
				context(),
				{ apiKey: "test-key", fetch },
			).result(),
	},
	{
		name: "openai-responses",
		answer: RESPONSES_ANSWER,
		run: fetch =>
			streamOpenAIResponses(
				buildModel({
					...SPEC,
					id: "probe-responses",
					api: "openai-responses",
					provider: "probe",
					baseUrl: "https://llm.example.test/v1",
				}) as Model<"openai-responses">,
				context(),
				{ apiKey: "test-key", fetch },
			).result(),
	},
	{
		name: "azure-openai-responses",
		answer: RESPONSES_ANSWER,
		run: fetch =>
			streamAzureOpenAIResponses(
				buildModel({
					...SPEC,
					id: "probe-azure",
					api: "azure-openai-responses",
					provider: "azure",
					baseUrl: "https://probe.openai.azure.com/openai/v1",
				}) as Model<"azure-openai-responses">,
				context(),
				{
					apiKey: "test-key",
					fetch,
					azureBaseUrl: "https://probe.openai.azure.com/openai/v1",
					azureApiVersion: "2025-04-01-preview",
				},
			).result(),
	},
	{
		name: "anthropic-messages",
		answer: ANTHROPIC_ANSWER,
		run: fetch =>
			streamAnthropic(
				buildModel({
					...SPEC,
					id: "probe-claude",
					api: "anthropic-messages",
					provider: "probe",
					baseUrl: "https://llm.example.test",
				}) as Model<"anthropic-messages">,
				context(),
				{ apiKey: "test-key", fetch, providerRetryWait: async () => {} },
			).result(),
	},
	{
		name: "google-generative-ai",
		answer: sseText([GOOGLE_CHUNK]),
		run: fetch =>
			streamGoogle(
				buildModel({
					...SPEC,
					id: "probe-gemini",
					api: "google-generative-ai",
					provider: "probe",
					baseUrl: "https://llm.example.test/v1beta",
				}) as Model<"google-generative-ai">,
				context(),
				{ apiKey: "test-key", fetch },
			).result(),
	},
	{
		name: "google-gemini-cli",
		answer: sseText([{ response: GOOGLE_CHUNK }]),
		run: fetch =>
			streamGoogleGeminiCli(
				buildModel({
					...SPEC,
					id: "gemini-2.5-flash",
					api: "google-gemini-cli",
					provider: "google-gemini-cli",
					baseUrl: "https://llm.example.test",
				}) as Model<"google-gemini-cli">,
				context(),
				{ apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }), fetch },
			).result(),
	},
	{
		name: "openai-codex-responses",
		answer: RESPONSES_ANSWER,
		run: fetch =>
			streamOpenAICodexResponses(
				createCodexModel("gpt-5.1-codex", { baseUrl: "https://llm.example.test/backend-api" }),
				context(),
				{ apiKey: codexToken(), fetch },
			).result(),
	},
	{
		name: "pi-native",
		answer: sseText([
			{
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "probe-native",
					usage: emptyUsage(),
					stopReason: "stop",
					timestamp: 0,
				},
			},
		]),
		run: fetch =>
			streamPiNative(
				buildModel({
					...SPEC,
					id: "probe-native",
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://llm.example.test",
					transport: "pi-native",
				} as ModelSpec<"anthropic-messages">),
				context(),
				{ apiKey: "gw-bearer", fetch },
			)
				.result()
				.catch(failedTurn),
	},
];

function chunked(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function isTurnRequest(input: string | URL | Request, init: RequestInit | undefined): boolean {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST";
}

/**
 * Answers every turn request (a POST) with `chunks`, recording the URL of each. Anything else, such as
 * the model listing Codex reads first, is a 404.
 */
function answering(chunks: readonly string[], contentType: string | undefined): { fetch: FetchImpl; urls: string[] } {
	const urls: string[] = [];
	const fetch: FetchImpl = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!isTurnRequest(input, init)) return new Response("not found", { status: 404 });
		urls.push(url);
		const headers = contentType === undefined ? undefined : { "content-type": contentType };
		return withUrl(new Response(chunked(chunks), { status: 200, headers }), url);
	};
	return { fetch, urls };
}

/**
 * The turn a consumer records for a stream whose result rejects, which is how pi-native reports a
 * failure: the error's message, classified.
 */
function failedTurn(error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "probe-native",
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		errorId: AIError.classify(error),
		timestamp: 0,
	};
}

/** A constructed `Response` has an empty `url`; `fetch` sets it to the URL it fetched. */
function withUrl(response: Response, url: string): Response {
	Object.defineProperty(response, "url", { value: url });
	return response;
}

function retriable(message: AssistantMessage): boolean {
	return AIError.retriable(AIError.classifyMessage(message));
}

/** The endpoint as the failure states it: no query string, which can hold a key or a version pin. */
function endpoint(url: string): string {
	const parsed = new URL(url);
	return `${parsed.origin}${parsed.pathname}`;
}

const SIGN_IN_PAGE =
	'<!DOCTYPE html><html><head><title>Sign in</title></head><body><form method="post"></form></body></html>';

/** Bodies that cannot be an event stream, with the sentence each one states after the endpoint. */
const NON_STREAM_BODIES: ReadonlyArray<{ name: string; chunks: readonly string[]; states: string }> = [
	{
		name: "an HTML page with a title",
		chunks: [SIGN_IN_PAGE],
		states: `is an HTML page titled "Sign in", not an event stream. Check the provider's baseUrl.`,
	},
	{
		name: "an HTML page behind blank lines, split before its first tag closes",
		chunks: ["\r\n", "  \n\t", "<ht", "ml><body>Not here</body></html>"],
		states: "is an HTML page, not an event stream. Check the provider's baseUrl.",
	},
	{
		name: "a non-streamed completion",
		chunks: [JSON.stringify({ id: "x", object: "chat.completion", choices: [{ message: { content: "hello" } }] })],
		states: "is a JSON document, not an event stream. Check the provider's baseUrl and that the endpoint streams.",
	},
	{
		name: "a JSON array",
		chunks: ["\n[", '{"data":[]}]'],
		states: "is a JSON document, not an event stream. Check the provider's baseUrl and that the endpoint streams.",
	},
];

/** Every content type a body that is not labelled an event stream arrives under, and none. */
const NON_STREAM_LABELS = [undefined, "text/html; charset=utf-8", "application/json", "text/plain"] as const;

describe("a 2xx body that is not an event stream fails on the request that received it", () => {
	for (const provider of PROVIDERS) {
		for (const body of NON_STREAM_BODIES) {
			for (const label of NON_STREAM_LABELS) {
				it(`${provider.name}: ${body.name} under ${label ?? "no content type"}`, async () => {
					const { fetch, urls } = answering(body.chunks, label);
					const result = await provider.run(fetch);

					expect(urls.length).toBe(1);
					expect(result.stopReason).toBe("error");
					expect(result.errorMessage).toBe(`200 from ${endpoint(urls[0])} ${body.states}`);
					expect(retriable(result)).toBe(false);
				});
			}
		}

		it(`${provider.name}: an error envelope states the provider's sentence and keeps its verdict`, async () => {
			const permanent = answering(
				[JSON.stringify({ error: { message: "Model probe does not exist", type: "invalid_request_error" } })],
				"application/json",
			);
			const refused = await provider.run(permanent.fetch);
			expect(permanent.urls.length).toBe(1);
			expect(refused.errorMessage).toBe("200 Model probe does not exist");
			expect(retriable(refused)).toBe(false);

			const transient = answering([JSON.stringify({ error: { message: "Rate limit exceeded" } })], undefined);
			// Retried by any ladder that retries a transient failure, which is what the sentence asks for.
			const limited = await provider.run(transient.fetch);
			expect(limited.errorMessage).toBe("200 Rate limit exceeded");
			expect(retriable(limited)).toBe(true);
		});

		it(`${provider.name}: a body that never ends is read to a bound and released`, async () => {
			const chunk = new TextEncoder().encode(`<div>${"x".repeat(4090)}</div>`.slice(0, 4096));
			let pulled = 0;
			let released = false;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("<html><head><title>Docs</title></head>"));
				},
				pull(controller) {
					pulled += 1;
					controller.enqueue(chunk);
				},
				cancel() {
					released = true;
				},
			});
			const fetch: FetchImpl = async (input, init) =>
				isTurnRequest(input, init)
					? new Response(body, { status: 200, headers: { "content-type": "text/html" } })
					: new Response("not found", { status: 404 });

			const result = await provider.run(fetch);

			expect(result.errorMessage).toContain('is an HTML page titled "Docs", not an event stream.');
			expect(released).toBe(true);
			expect(pulled * chunk.byteLength).toBeLessThanOrEqual(65_536 + 2 * chunk.byteLength);
		});
	}
});

describe("an event stream decodes whatever it is labelled", () => {
	for (const provider of PROVIDERS) {
		const variants: ReadonlyArray<{ name: string; chunks: readonly string[]; label: string | undefined }> = [
			{ name: "labelled an event stream", chunks: [provider.answer], label: "text/event-stream; charset=utf-8" },
			{ name: "under no content type", chunks: [provider.answer], label: undefined },
			{ name: "labelled JSON", chunks: [provider.answer], label: "application/json" },
			{ name: "labelled plain text", chunks: [provider.answer], label: "text/plain" },
			{
				name: "behind blank chunks, split inside its first field",
				chunks: ["\n", "\n", provider.answer.slice(0, 2), provider.answer.slice(2)],
				label: undefined,
			},
			{ name: "behind a comment", chunks: [": keep-alive\n\n", provider.answer], label: "application/octet-stream" },
		];
		for (const variant of variants) {
			it(`${provider.name}: ${variant.name}`, async () => {
				const { fetch, urls } = answering(variant.chunks, variant.label);
				const result = await provider.run(fetch);

				expect(result.errorMessage).toBeUndefined();
				expect(result.stopReason).toBe("stop");
				expect(result.content.flatMap(part => (part.type === "text" ? [part.text] : []))).toEqual(["hello"]);
				expect(urls.length).toBe(1);
			});
		}
	}
});

describe("a blank unlabelled body is an empty event stream", () => {
	// Nothing but whitespace is neither markup nor JSON: it reads as an event stream that held no
	// events, and it ends instead of waiting for a first byte that is never coming.
	for (const chunks of [[], ["\n"], ["\r\n", "  \t\n"]]) {
		it(`passes ${JSON.stringify(chunks)} through and closes`, async () => {
			const stream = eventStreamBody(new Response(null, { status: 200 }), chunked(chunks), undefined);
			expect(await new Response(stream).text()).toBe(chunks.join(""));
		});
	}
});
