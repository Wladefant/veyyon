/**
 * Contract: a `2xx` answer from an OpenAI-wire endpoint whose body is not an event stream fails on
 * the request that received it, states what came back and from where, and is not retried unless
 * the provider's own sentence reads as transient. A mislabelled event stream still streams.
 *
 * WHY THIS EXISTS. A `baseUrl` that points at a login page, a docs site or a non-streaming endpoint
 * answers `200` with HTML or a JSON document. The body was handed to the SSE decoder as it was,
 * which found no events in it, and the turn ended as "stream closed before a terminal finish
 * reason". That is an `incomplete-stream` failure, which is retryable, so the session sent the same
 * request to the same page until its retry budget ran out: eleven requests and close to a minute
 * before the error, and the error described a cut stream that never existed.
 *
 * THE CLASS: every provider that reads its body through `postOpenAIStream`, crossed with every body
 * shape that cannot be an event stream (HTML with and without a title, a JSON document, a JSON
 * array, a JSON error envelope) and every way such a body arrives (any content type but
 * `text/event-stream`, a blank lead, the lead split across chunks, a body that never ends). The
 * converse is swept too: an event stream under the wrong content type, behind blank lines or behind
 * a comment, must still decode, so the check cannot be satisfied by rejecting every unlabelled body.
 *
 * WHAT IT DOES NOT CATCH: a body labelled `text/event-stream` that is HTML is decoded as an event
 * stream and still reads as a truncated one. The label is taken at its word there. A provider that
 * reads its body without `postOpenAIStream` is outside the sweep; the three below are its callers.
 */

import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { streamAzureOpenAIResponses } from "@veyyon/ai/providers/azure-openai-responses";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import type { AssistantMessage, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

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

/** Answers every request with `chunks`, recording the URL of each. */
function answering(chunks: readonly string[], contentType: string | undefined): { fetch: FetchImpl; urls: string[] } {
	const urls: string[] = [];
	const fetch: FetchImpl = async input => {
		urls.push(input instanceof Request ? input.url : String(input));
		const headers = contentType === undefined ? undefined : { "content-type": contentType };
		return new Response(chunked(chunks), { status: 200, headers });
	};
	return { fetch, urls };
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
			const limited = await provider.run(transient.fetch);
			expect(transient.urls.length).toBe(1);
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
			const fetch: FetchImpl = async () =>
				new Response(body, { status: 200, headers: { "content-type": "text/html" } });

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
				chunks: ["\n", "\n", "da", provider.answer.slice(2)],
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
