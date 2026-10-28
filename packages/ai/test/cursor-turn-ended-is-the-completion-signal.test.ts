import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { frameConnectMessage } from "@veyyon/ai/utils/connect-frames";
import {
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	InteractionUpdateSchema,
	TokenDeltaUpdateSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { type CursorH2Server, replayCursorScript, runCursorTurn, turnEndedFrame } from "./helpers/cursor-h2-server";

// WHY THIS SUITE EXISTS
// ---------------------
// `turn_ended` is the only thing Cursor sends that means the turn is over. The
// HTTP/2 stream also ends when the connection merely stops, and the provider
// used to treat the two as the same event: `stopReason` was initialised to
// "stop" and nothing on the success path ever revisited it, so a turn cut off
// mid-reply was persisted looking exactly like a finished one. The compaction
// anchor skips only "aborted" and "error" turns, so it then trusted the partial
// token counts of a turn that never completed.
//
// The same suite drives the accounting fold end to end, because the two are one
// question: what the turn is worth is only meaningful once you know the turn
// happened. `used_tokens` is the whole conversation measured with this turn's
// reply already in it, so the prompt side is the gauge minus the completion.

function tokenDeltaFrame(tokens: number): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens }) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function checkpointFrame(usedTokens: number, maxTokens: number): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "conversationCheckpointUpdate",
			value: create(ConversationStateStructureSchema, {
				tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens, maxTokens }),
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

let srv: CursorH2Server | undefined;

beforeEach(() => {
	srv = undefined;
});

afterEach(async () => {
	await srv?.close();
});

describe("cursor turn completion", () => {
	it("reports a turn the server never ended as an incomplete stream, not a clean stop", async () => {
		srv = await replayCursorScript([tokenDeltaFrame(120)]);

		const { message } = await runCursorTurn(srv.baseUrl);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("turn_ended");
	});

	it("reports a turn the server ended as a clean stop", async () => {
		srv = await replayCursorScript([tokenDeltaFrame(120), turnEndedFrame()]);

		const { message } = await runCursorTurn(srv.baseUrl);

		expect(message.stopReason).toBe("stop");
	});

	it("bills the completion once and reports the conversation gauge as the total", async () => {
		// The gauge lands before the last deltas on purpose: whichever order the
		// server uses, the numbers must still describe one conversation.
		srv = await replayCursorScript([
			tokenDeltaFrame(100),
			checkpointFrame(50_000, 256_000),
			tokenDeltaFrame(400),
			turnEndedFrame(),
		]);

		const { message } = await runCursorTurn(srv.baseUrl);

		expect(message.usage.output).toBe(500);
		expect(message.usage.input).toBe(49_500);
		expect(message.usage.totalTokens).toBe(50_000);
		// Cursor states the window per turn; it outranks the catalog's 200k guess.
		expect(message.providerContextWindow).toBe(256_000);
		expect(message.usage.cost.total).toBeCloseTo((49_500 * 3 + 500 * 15) / 1_000_000, 9);
	});

	it("still reports what an unfinished turn spent", async () => {
		srv = await replayCursorScript([tokenDeltaFrame(2_000), checkpointFrame(50_000, 256_000)]);

		const { message } = await runCursorTurn(srv.baseUrl);

		expect(message.stopReason).toBe("error");
		expect(message.usage.output).toBe(2_000);
		expect(message.usage.cost.total).toBeGreaterThan(0);
	});
});
