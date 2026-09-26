/**
 * WHY: an Anthropic attempt that already streamed content to the consumer must not be sent again
 * when its stream breaks.
 *
 * Every in-provider retry branch reads two facts about the failed attempt: whether a first token
 * arrived, and whether replay-unsafe content (text, thinking, a redacted thinking block, a tool
 * call) already reached the event stream. A retry after either one re-emits the same deltas under
 * a fresh request, so the consumer shows the answer twice and may run a tool call twice. Those facts
 * live in per-attempt stream state that the event handlers update. When the retry decision read a
 * copy taken after the event loop finished, a stream that threw mid-loop never reached the copy, the
 * retry saw "nothing streamed", and the request was sent again.
 *
 * The class: a retry decision reading attempt state from anywhere but the live state the handlers
 * wrote. The suite sweeps every replay-unsafe block kind against every failure shape that a
 * provider retry branch accepts, and pairs each failure with a positive control that fails before
 * any content: the control must retry, so a failure no branch would retry cannot pass vacuously.
 *
 * The failed turn also reports its time to first token, which is read from the same state: a copy
 * that never saw the first token drops it from the error message.
 *
 * What it does not catch: the strict-tool grammar and fast-mode branches, which need a request
 * carrying strict tools or the priority tier and are gated on the first token alone.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { AnthropicMessages } from "@veyyon/ai/providers/anthropic-client";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = { messages: [{ role: "user", content: "write a sentence", timestamp: 0 }] };

const messageStart = {
	type: "message_start",
	message: {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-fable-5",
		content: [],
		usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
};

/** Replay `events`, then throw `failure`, on every request; returns the number of requests sent. */
function mockBrokenStream(events: Record<string, unknown>[], failure: () => Error): { requests: () => number } {
	let requests = 0;
	vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((() => {
		requests++;
		const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
		const stream = {
			async *[Symbol.asyncIterator]() {
				for (const event of events) yield event;
				throw failure();
			},
		};
		return {
			async withResponse() {
				return { data: stream, response, request_id: "req_mock" };
			},
		};
	}) as never);
	return { requests: () => requests };
}

async function run(): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
	const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test", providerRetryWait: async () => {} });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

/** Each replay-unsafe block kind, as the events that put it on the consumer's stream. */
const unsafeContent: { kind: string; events: Record<string, unknown>[] }[] = [
	{
		kind: "text",
		events: [
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
		],
	},
	{
		kind: "thinking",
		events: [
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "partial" } },
		],
	},
	{
		kind: "redacted thinking",
		events: [{ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } }],
	},
	{
		kind: "tool call",
		events: [
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
			},
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
		],
	},
];

/** Each failure shape some provider retry branch accepts when nothing has streamed yet. */
const failures: { shape: string; make: () => Error }[] = [
	{ shape: "a truncated frame", make: () => new Error("Unexpected end of JSON input") },
	{
		shape: "a reset connection",
		make: () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
	},
	{
		shape: "a signing proxy rejecting a thinking signature",
		make: () => new Error("400 Invalid `signature` in `thinking` block"),
	},
];

describe("an Anthropic stream that broke after content is not sent again", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const failure of failures) {
		it(`retries ${failure.shape} that arrives before any content`, async () => {
			const mock = mockBrokenStream([messageStart], failure.make);

			await run();

			expect(mock.requests()).toBeGreaterThan(1);
		});

		for (const content of unsafeContent) {
			it(`does not resend after ${content.kind} streamed, on ${failure.shape}`, async () => {
				const mock = mockBrokenStream([messageStart, ...content.events], failure.make);

				const { message } = await run();

				expect(mock.requests()).toBe(1);
				expect(message.stopReason).toBe("error");
				expect(message.ttft).toBeGreaterThanOrEqual(0);
			});
		}
	}
});
