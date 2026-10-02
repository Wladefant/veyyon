import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	getOpenAICodexTransportDetails,
	streamOpenAICodexResponses,
} from "@veyyon/ai/providers/openai-codex-responses";
import type { Context, ProviderSessionState } from "@veyyon/ai/types";
import * as piUtils from "@veyyon/utils";
import { createCodexModel } from "./helpers";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
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
		sessionId: "ws-test-session",
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

class TestWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = TestWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		public readonly url: string,
		public readonly options?: { headers?: Record<string, string> },
	) {
		setTimeout(() => {
			this.readyState = TestWebSocket.OPEN;
			this.emit("open", new Event("open"));
		}, 0);
	}

	send(data: string): void {
		const parsed = JSON.parse(data);
		if (parsed.type === "response.create") {
			setTimeout(() => {
				this.onResponseCreate(parsed);
			}, 0);
		}
	}

	close(): void {
		this.readyState = TestWebSocket.CLOSED;
	}

	emit(type: string, event: Event): void {
		const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
		if (typeof handler === "function") (handler as (e: Event) => void).call(this, event);
	}

	sendJson(payload: Record<string, unknown>): void {
		this.emit("message", { data: JSON.stringify(payload) } as unknown as MessageEvent);
	}

	onResponseCreate(_request: Record<string, unknown>): void {}
}

describe("Codex WebSocket append state replay sanitization", () => {
	it("enables canAppend and stores replay-sanitized items for completed responses with assistant output", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();

		class ReplayableWs extends TestWebSocket {
			override onResponseCreate(): void {
				this.sendJson({
					type: "response.created",
					response: { id: "resp_ws_1" },
				});
				this.sendJson({
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_output_123",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "Hello from WS" });
				this.sendJson({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_output_123",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello from WS" }],
					},
				});
				this.sendJson({
					type: "response.completed",
					response: {
						id: "resp_ws_1",
						status: "completed",
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					},
				});
			}
		}

		globalThis.WebSocket = ReplayableWs as unknown as typeof WebSocket;

		const model = createCodexModel("gpt-5.5", { preferWebsockets: true });
		const stream = streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			sessionId: "ws-test-session",
			preferWebsockets: true,
			providerSessionState,
		});

		for await (const _ of stream) {
			// drain
		}

		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-test-session",
			providerSessionState,
		});

		expect(transportDetails.canAppend).toBe(true);
		expect(transportDetails.hasSessionState).toBe(true);
	});

	it("disables canAppend when response only contains reasoning items without replayable assistant output", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();

		class ReasoningOnlyWs extends TestWebSocket {
			override onResponseCreate(): void {
				this.sendJson({
					type: "response.created",
					response: { id: "resp_ws_reasoning_only" },
				});
				this.sendJson({
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "reasoning",
						id: "reasoning_item_1",
						status: "in_progress",
						summary: [],
					},
				});
				this.sendJson({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "reasoning",
						id: "reasoning_item_1",
						status: "completed",
						summary: [{ type: "summary_text", text: "internal reasoning" }],
					},
				});
				this.sendJson({
					type: "response.completed",
					response: {
						id: "resp_ws_reasoning_only",
						status: "completed",
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					},
				});
			}
		}

		globalThis.WebSocket = ReasoningOnlyWs as unknown as typeof WebSocket;

		const model = createCodexModel("gpt-5.5", { preferWebsockets: true });
		const stream = streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			sessionId: "ws-test-session-reasoning",
			preferWebsockets: true,
			providerSessionState,
		});

		for await (const _ of stream) {
			// drain
		}

		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-test-session-reasoning",
			providerSessionState,
		});

		// Without replayable assistant output, append cannot be trusted: canAppend must be false
		expect(transportDetails.canAppend).toBe(false);
	});
	it("chains second-turn websocket append when assistant tool call has normalized oversized call ID", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const oversizedCallId = `call_${"a".repeat(80)}`;

		class NormalizedIdChainingWs extends TestWebSocket {
			override send(data: string): void {
				const parsed = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(parsed);
				if (parsed.type === "response.create") {
					setTimeout(() => {
						if (sentRequests.length === 1) {
							this.sendJson({
								type: "response.created",
								response: { id: "resp_ws_tool" },
							});
							this.sendJson({
								type: "response.output_item.added",
								output_index: 0,
								item: {
									type: "function_call",
									id: "fc_1",
									call_id: oversizedCallId,
									name: "calculator",
									arguments: "",
								},
							});
							this.sendJson({
								type: "response.output_item.done",
								output_index: 0,
								item: {
									type: "function_call",
									id: "fc_1",
									call_id: oversizedCallId,
									name: "calculator",
									arguments: '{"expr":"1+1"}',
									status: "completed",
								},
							});
							this.sendJson({
								type: "response.completed",
								response: {
									id: "resp_ws_tool",
									status: "completed",
									usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
								},
							});
						} else {
							this.sendJson({
								type: "response.created",
								response: { id: "resp_ws_final" },
							});
							this.sendJson({
								type: "response.output_item.added",
								output_index: 0,
								item: {
									type: "message",
									id: "msg_final",
									role: "assistant",
									status: "in_progress",
									content: [],
								},
							});
							this.sendJson({
								type: "response.content_part.added",
								part: { type: "output_text", text: "" },
							});
							this.sendJson({ type: "response.output_text.delta", delta: "Result is 2" });
							this.sendJson({
								type: "response.output_item.done",
								output_index: 0,
								item: {
									type: "message",
									id: "msg_final",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "Result is 2" }],
								},
							});
							this.sendJson({
								type: "response.completed",
								response: {
									id: "resp_ws_final",
									status: "completed",
									usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
								},
							});
						}
					}, 0);
				}
			}
		}

		globalThis.WebSocket = NormalizedIdChainingWs as unknown as typeof WebSocket;

		const model = createCodexModel("gpt-5.5", { preferWebsockets: true });
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "ws-normalized-chaining";

		const firstUser = { role: "user" as const, content: "Compute 1+1", timestamp: Date.now() };
		const options = {
			apiKey: createCodexTestToken(),
			sessionId,
			preferWebsockets: true,
			providerSessionState,
		};

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
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [firstUser, firstResponse, toolResult],
			},
			options,
		);
		const secondResponse = await secondStream.result();
		expect(secondResponse.stopReason).toBe("stop");
		expect(secondResponse.content).toEqual([
			expect.objectContaining({ type: "text", text: "Result is 2" }),
		]);

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[1]?.previous_response_id).toBe("resp_ws_tool");
		expect(sentRequests[1]?.input).toEqual([
			expect.objectContaining({
				type: "function_call_output",
				output: "2",
			}),
		]);
	});
});
