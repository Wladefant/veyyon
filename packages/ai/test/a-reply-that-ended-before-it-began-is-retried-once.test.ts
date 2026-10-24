/**
 * WHY. A reply that ends before `message_start` belongs to the same class as a
 * first-event stall: nothing arrived, and another attempt against the endpoint
 * that sent it cannot produce an event sooner. The Anthropic ladder ended a run
 * of those replies only once the first-event budget was spent, and that budget
 * is time. A stall spends a whole deadline per attempt, so two of them end the
 * phase; an empty `200` body arrives at once and spends nothing, so a dead
 * endpoint ran the full provider ladder (eleven requests, ~45s of backoff)
 * under every one of the session's own retries: 121 requests and minutes of
 * silence before a headless run reported anything.
 *
 * THE CLASS IT CLOSES. Every reply shape that reaches the provider as "ended
 * before message_start" is bounded by the attempt allowance, not by time: an
 * empty body, a body holding only preamble events, and each event of a valid
 * message arriving ahead of `message_start`. The sweep reads those events off a
 * whole valid message, so an event added to that message joins it. The first
 * such reply is still retried once, and a failure the server answered with (a
 * 502) keeps its own ladder between them.
 *
 * WHAT IT DOES NOT CATCH. The session's ladder above this one still retries the
 * turn the provider gives up on; that ladder is bounded by `retry.maxRetries`
 * and is not under test here. Nor does it cover any provider other than
 * Anthropic Messages, the only ladder that admits this envelope into the
 * nothing-arrived class.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import type { AnthropicMessagesClientLike } from "@veyyon/ai/providers/anthropic-client";
import type { AssistantMessage, Context, Model } from "@veyyon/ai/types";
import { PRE_RESPONSE_STALL_ATTEMPTS } from "@veyyon/ai/utils/first-event-budget";
import { buildModel } from "@veyyon/catalog/build";

const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const CONTEXT: Context = { messages: [{ role: "user", content: "Say hi", timestamp: 1 }] };

type WireEvent = Record<string, unknown>;

/** A whole valid message, `message_start` through `message_stop`. */
const VALID_MESSAGE: WireEvent[] = [
	{
		type: "message_start",
		message: {
			id: "msg_valid",
			usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
	{ type: "message_stop" },
];

/** Every reply that reaches the ladder as one that ended before `message_start`. */
const EMPTY_REPLIES: Record<string, WireEvent[]> = {
	"an empty body": [],
	"a body of preamble events only": [{ type: "ping" }],
	...Object.fromEntries(
		VALID_MESSAGE.filter(event => event.type !== "message_start").map(event => [
			`${event.type} ahead of message_start`,
			[event],
		]),
	),
};

/** One attempt the scripted endpoint answers. */
type Reply = { events: WireEvent[] } | { reject: Error };

interface LadderRun {
	result: AssistantMessage;
	requests: number;
	waits: number[];
}

/** Stream one turn against an endpoint that answers attempt N with `replies[N]`, and the last reply after that. */
async function runLadder(replies: Reply[]): Promise<LadderRun> {
	let requests = 0;
	const create = (() => {
		const reply = replies[Math.min(requests, replies.length - 1)];
		requests += 1;
		return {
			async withResponse() {
				if ("reject" in reply) throw reply.reject;
				const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
				return {
					data: {
						async *[Symbol.asyncIterator]() {
							for (const event of reply.events) yield event;
						},
					},
					response,
					request_id: response.headers.get("request-id"),
				};
			},
		};
	}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
	const waits: number[] = [];
	const result = await streamAnthropic(MODEL, CONTEXT, {
		client: { messages: { create } } as AnthropicMessagesClientLike,
		providerRetryWait: async delayMs => {
			waits.push(delayMs);
		},
	}).result();
	return { result, requests, waits };
}

const badGateway = (): Reply => ({ reject: new AIError.AnthropicApiError(502, "502 Bad Gateway", new Headers()) });

describe("a reply that ended before it began", () => {
	for (const [shape, events] of Object.entries(EMPTY_REPLIES)) {
		it(`ends the provider ladder on its second arrival: ${shape}`, async () => {
			const run = await runLadder([{ events }]);

			expect(run.requests).toBe(PRE_RESPONSE_STALL_ATTEMPTS);
			expect(run.waits).toHaveLength(PRE_RESPONSE_STALL_ATTEMPTS - 1);
			expect(run.result.stopReason).toBe("error");
			expect(run.result.errorMessage).toContain("before message_start");
		});

		it(`still retries the first one into an answer: ${shape}`, async () => {
			const run = await runLadder([{ events }, { events: VALID_MESSAGE }]);

			expect(run.requests).toBe(2);
			expect(run.result.stopReason).toBe("stop");
			expect(JSON.parse(JSON.stringify(run.result.content))).toEqual([{ type: "text", text: "hi" }]);
		});
	}

	it("keeps the server's own ladder for a failure it answered between two empty replies", async () => {
		const run = await runLadder([{ events: [] }, badGateway(), badGateway(), { events: [] }]);

		expect(run.requests).toBe(4);
		expect(run.result.stopReason).toBe("error");
		expect(run.result.errorMessage).toContain("stream ended before message_start");
	});

	it("spends none of the allowance on a failure the server answered", async () => {
		const run = await runLadder([badGateway(), { events: [] }, { events: VALID_MESSAGE }]);

		expect(run.requests).toBe(3);
		expect(run.result.stopReason).toBe("stop");
	});

	it("starts the allowance over for a turn that asks again", async () => {
		const first = await runLadder([{ events: [] }]);
		const second = await runLadder([{ events: [] }, { events: VALID_MESSAGE }]);

		expect(first.requests).toBe(PRE_RESPONSE_STALL_ATTEMPTS);
		expect(second.requests).toBe(2);
		expect(second.result.stopReason).toBe("stop");
	});
});
