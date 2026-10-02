import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	getOpenAICodexTransportDetails,
	streamOpenAICodexResponses,
} from "@veyyon/ai/providers/openai-codex-responses";
import type { Context, ProviderSessionState } from "@veyyon/ai/types";
import * as piUtils from "@veyyon/utils";
import { createCodexModel } from "./helpers";

const originalWebSocket = globalThis.WebSocket;

class MockWs {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static onSend?: (ws: MockWs, parsed: Record<string, unknown>) => void;
	readyState = 1;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		public readonly url: string,
		public readonly options?: { headers?: Record<string, string> },
	) {
		setTimeout(() => this.onopen?.(new Event("open")), 0);
	}
	send(data: string): void {
		const parsed = JSON.parse(data) as Record<string, unknown>;
		if (parsed.type === "response.create") {
			setTimeout(() => MockWs.onSend?.(this, parsed), 0);
		}
	}
	close(): void {
		this.readyState = 3;
	}
	sendJson(payload: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(payload) } as unknown as MessageEvent);
	}
}

function emitCompleted(ws: MockWs, id: string, items: Array<Record<string, unknown>>): void {
	ws.sendJson({ type: "response.created", response: { id } });
	for (let i = 0; i < items.length; i++) {
		ws.sendJson({ type: "response.output_item.added", output_index: i, item: items[i] });
		ws.sendJson({ type: "response.output_item.done", output_index: i, item: items[i] });
	}
	ws.sendJson({
		type: "response.completed",
		response: { id, status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
	});
}

function createTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createTestContext(content = "Say hello"): Context {
	return {
		sessionId: "ws-test-session",
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content, timestamp: Date.now() }],
	};
}

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
	globalThis.WebSocket = MockWs as unknown as typeof WebSocket;
});

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
	MockWs.onSend = undefined;
	vi.restoreAllMocks();
});

describe("Codex WebSocket append state replay sanitization", () => {
	it("enables canAppend and stores replay-sanitized items for completed responses with assistant output", async () => {
		MockWs.onSend = ws => {
			emitCompleted(ws, "resp_ws_1", [
				{
					type: "message",
					id: "msg_output_123",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello from WS" }],
				},
			]);
		};

		const model = createCodexModel("gpt-5.5", { preferWebsockets: true });
		const providerSessionState = new Map<string, ProviderSessionState>();
		const stream = streamOpenAICodexResponses(model, createTestContext(), {
			apiKey: createTestToken(),
			sessionId: "ws-test-session",
			preferWebsockets: true,
			providerSessionState,
		});

		for await (const _ of stream) {
			// drain
		}

		const details = getOpenAICodexTransportDetails(model, { sessionId: "ws-test-session", providerSessionState });
		expect(details.canAppend).toBe(true);
		expect(details.hasSessionState).toBe(true);
	});

	it("disables canAppend when response only contains reasoning items without replayable assistant output", async () => {
		MockWs.onSend = ws => {
			emitCompleted(ws, "resp_ws_reasoning", [
				{
					type: "reasoning",
					id: "reasoning_item_1",
					status: "completed",
					summary: [{ type: "summary_text", text: "internal reasoning" }],
				},
			]);
		};

		const model = createCodexModel("gpt-5.5", { preferWebsockets: true });
		const providerSessionState = new Map<string, ProviderSessionState>();
		const stream = streamOpenAICodexResponses(model, createTestContext(), {
			apiKey: createTestToken(),
			sessionId: "ws-test-reasoning",
			preferWebsockets: true,
			providerSessionState,
		});

		for await (const _ of stream) {
			// drain
		}

		const details = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-test-reasoning",
			providerSessionState,
		});
		expect(details.canAppend).toBe(false);
	});

	it("chains second-turn websocket append when assistant tool call has normalized oversized call ID", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const oversizedCallId = `call_${"a".repeat(80)}`;

		MockWs.onSend = (ws, req) => {
			sentRequests.push(req);
			if (sentRequests.length === 1) {
				emitCompleted(ws, "resp_ws_tool", [
					{
						type: "function_call",
						id: "fc_1",
						call_id: oversizedCallId,
						name: "calculator",
						arguments: '{"expr":"1+1"}',
						status: "completed",
					},
				]);
			} else {
				emitCompleted(ws, "resp_ws_final", [
					{
						type: "message",
						id: "msg_final",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Result is 2" }],
					},
				]);
			}
		};

		const model = createCodexModel("gpt-5.5", { preferWebsockets: true });
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: createTestToken(),
			sessionId: "ws-normalized-chaining",
			preferWebsockets: true,
			providerSessionState,
		};

		const firstUser = { role: "user" as const, content: "Compute 1+1", timestamp: Date.now() };
		const firstStream = streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
			options,
		);
		const firstResponse = await firstStream.result();
		const toolCall = firstResponse.content.find(
			(block): block is Extract<(typeof firstResponse.content)[number], { type: "toolCall" }> =>
				block.type === "toolCall",
		);
		expect(toolCall).toBeDefined();

		const toolResult = {
			role: "toolResult" as const,
			toolCallId: toolCall!.id,
			toolName: toolCall!.name,
			content: [{ type: "text" as const, text: "2" }],
			isError: false,
			timestamp: Date.now(),
		};

		const secondStream = streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser, firstResponse, toolResult] },
			options,
		);
		const secondResponse = await secondStream.result();
		expect(secondResponse.stopReason).toBe("stop");
		expect(secondResponse.content).toEqual([expect.objectContaining({ type: "text", text: "Result is 2" })]);

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[1]?.previous_response_id).toBe("resp_ws_tool");
		expect(sentRequests[1]?.input).toEqual([expect.objectContaining({ type: "function_call_output", output: "2" })]);
	});
});
