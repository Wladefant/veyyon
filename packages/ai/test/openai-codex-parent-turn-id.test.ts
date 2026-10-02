import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	createOpenAICodexCompatibilityMetadata,
	streamOpenAICodexResponses,
} from "@veyyon/ai/providers/openai-codex-responses";
import type { Context, FetchImpl, ProviderSessionState } from "@veyyon/ai/types";
import { OPENAI_HEADERS } from "@veyyon/catalog/wire/codex";
import * as piUtils from "@veyyon/utils";
import { createCodexModel } from "./helpers";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createCodexSse(events: Array<Record<string, unknown>>): string {
	return `${events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
}
function sseText(text: string, extraEvents: Array<Record<string, unknown>> = []): string {
	return createCodexSse([
		...extraEvents,
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{ type: "response.completed", response: { status: "completed", usage: { total_tokens: 5 } } },
	]);
}

describe("Codex parentTurnId and turn-state refreshes", () => {
	describe("createOpenAICodexCompatibilityMetadata", () => {
		it("emits parent_turn_id in clientMetadata and turn-metadata JSON when non-blank", () => {
			const result = createOpenAICodexCompatibilityMetadata({
				requestKind: "turn",
				sessionId: "session-test",
				parentTurnId: "turn_parent_12345",
			});

			expect(result.clientMetadata.parent_turn_id).toBe("turn_parent_12345");
			const rawJson = result.clientMetadata[OPENAI_HEADERS.TURN_METADATA];
			expect(typeof rawJson).toBe("string");
			const parsed = JSON.parse(rawJson);
			expect(parsed.parent_turn_id).toBe("turn_parent_12345");

			const rawHeaderJson = result.headers[OPENAI_HEADERS.TURN_METADATA];
			expect(rawHeaderJson).toBe(rawJson);
		});

		it("ignores blank or whitespace-only parentTurnId", () => {
			const result = createOpenAICodexCompatibilityMetadata({
				requestKind: "turn",
				sessionId: "session-test",
				parentTurnId: "   ",
			});

			expect(result.clientMetadata.parent_turn_id).toBeUndefined();
			const parsed = JSON.parse(result.clientMetadata[OPENAI_HEADERS.TURN_METADATA]);
			expect(parsed.parent_turn_id).toBeUndefined();
		});

		it("prevents caller clientMetadata from overriding parent_turn_id when options.parentTurnId is absent", () => {
			const result = createOpenAICodexCompatibilityMetadata({
				requestKind: "turn",
				sessionId: "session-test",
				clientMetadata: {
					parent_turn_id: "spoofed_turn_id",
					custom_key: "preserved_value",
				},
			});

			expect(result.clientMetadata.parent_turn_id).toBeUndefined();
			const parsed = JSON.parse(result.clientMetadata[OPENAI_HEADERS.TURN_METADATA]);
			expect(parsed.parent_turn_id).toBeUndefined();
			expect(parsed.custom_key).toBe("preserved_value");
		});
	});

	describe("streamOpenAICodexResponses with parentTurnId", () => {
		it("forwards parentTurnId to client_metadata in stream request body", async () => {
			let sentBody: Record<string, unknown> | undefined;

			const mockFetch: FetchImpl = async (_url, init) => {
				if (init?.body && typeof init.body === "string") sentBody = JSON.parse(init.body);
				return new Response(sseText("Hello"), { status: 200, headers: { "content-type": "text/event-stream" } });
			};
			const stream = streamOpenAICodexResponses(createCodexModel("gpt-5.5"), createCodexTestContext(), {
				apiKey: createCodexTestToken(),
				parentTurnId: "turn_parent_abc",
				fetch: mockFetch,
			});
			for await (const _ of stream) {
			}
			expect(sentBody).toBeDefined();
			const clientMetadata = sentBody?.client_metadata as Record<string, string>;
			expect(clientMetadata.parent_turn_id).toBe("turn_parent_abc");
			const turnMetadata = JSON.parse(clientMetadata[OPENAI_HEADERS.TURN_METADATA]);
			expect(turnMetadata.parent_turn_id).toBe("turn_parent_abc");
		});
	});

	describe("turn-state refreshes in response.metadata events", () => {
		it("captures x-codex-turn-state from response.metadata event headers and echoes on subsequent request", async () => {
			const providerSessionState = new Map<string, ProviderSessionState>();
			const capturedRequests: Array<{ url: string; headers: Headers }> = [];
			const mockFetch: FetchImpl = async (url, init) => {
				capturedRequests.push({ url: String(url), headers: new Headers(init?.headers) });
				const extra = [
					{ type: "response.metadata", headers: { "x-codex-turn-state": "turn_state_from_event_999" } },
				];
				return new Response(sseText("ok", extra), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			};
			const model = createCodexModel("gpt-5.5");
			const context: Context = {
				sessionId: "shared-test-session",
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "First turn", timestamp: Date.now() }],
			};
			const stream1 = streamOpenAICodexResponses(model, context, {
				apiKey: createCodexTestToken(),
				sessionId: "shared-test-session",
				providerSessionState,
				fetch: mockFetch,
			});
			for await (const _ of stream1) {
			}
			// Tool loop continuation within the same turn
			context.messages.push({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "test_tool",
						arguments: {},
					},
				],
				timestamp: Date.now(),
			});
			context.messages.push({
				role: "toolResult",
				toolCallId: "call_1",
				content: [{ type: "text", text: "tool result output" }],
				isError: false,
				timestamp: Date.now(),
			});

			const stream2 = streamOpenAICodexResponses(model, context, {
				apiKey: createCodexTestToken(),
				sessionId: "shared-test-session",
				providerSessionState,
				fetch: mockFetch,
			});
			for await (const _ of stream2) {
			}
			expect(capturedRequests.length).toBe(2);
			expect(capturedRequests[0].headers.get("x-codex-turn-state")).toBeNull();
			expect(capturedRequests[1].headers.get("x-codex-turn-state")).toBe("turn_state_from_event_999");
		});
	});
});
