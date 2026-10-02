import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses";
import type { Context, FetchImpl, Model, ProviderSessionState } from "../src/types";

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	});
}

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;

	readyState: number = MockWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(public readonly url: string) {
		queueMicrotask(() => {
			this.readyState = MockWebSocket.OPEN;
			this.onopen?.(new Event("open"));
		});
	}

	send(_data: string): void {}
	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	sendJson(payload: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
	}

	emitCodexResponse(opts: { responseId: string; text: string }): void {
		this.sendJson({ type: "response.created", response: { id: opts.responseId } });
		this.sendJson({ type: "response.output_item.added", item: { type: "message", id: `msg_${opts.responseId}`, role: "assistant", status: "in_progress", content: [] } });
		this.sendJson({ type: "response.output_text.delta", delta: opts.text });
		this.sendJson({ type: "response.output_item.done", item: { type: "message", id: `msg_${opts.responseId}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: opts.text }] } });
		this.sendJson({ type: "response.completed", response: { id: opts.responseId, status: "completed" } });
	}
}

describe("codex websocket append state preservation on throttling", () => {
	const originalWebSocket = global.WebSocket;
	afterEach(() => {
		global.WebSocket = originalWebSocket;
	});

	it.each([
		["rate_limit_exceeded", false],
		["slow_down", true],
	] as const)("preserves append continuation when rejected with %s", async (code, emitPartialResponse) => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class ThrottledWebSocket extends MockWebSocket {
			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				if (sentRequests.length === 1) {
					this.emitCodexResponse({ responseId: "resp_1", text: "Answer 1" });
				} else if (sentRequests.length === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					if (emitPartialResponse) this.sendJson({ type: "response.created", response: { id: "resp_rejected" } });
					this.sendJson({ type: "error", code, message: "Throttled" });
				} else if (sentRequests.length === 3) {
					this.emitCodexResponse({ responseId: "resp_3", text: "Answer 3" });
				}
			}
		}

		global.WebSocket = ThrottledWebSocket as unknown as typeof WebSocket;
		const options = {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: `ws-${code}-session`,
			providerSessionState: new Map<string, ProviderSessionState>(),
		};
		const context: Context = { messages: [{ role: "user", content: "Q1", timestamp: 1 }] };
		const first = await streamOpenAICodexResponses(createCodexTestModel(), context, options).result();
		expect(first.stopReason).toBe("stop");

		const nextContext: Context = { messages: [...context.messages, first, { role: "user", content: "Q2", timestamp: 2 }] };
		const rejected = await streamOpenAICodexResponses(createCodexTestModel(), nextContext, options).result();
		expect(rejected.stopReason).toBe("error");

		const retried = await streamOpenAICodexResponses(createCodexTestModel(), nextContext, options).result();
		expect(retried.stopReason).toBe("stop");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[2]?.previous_response_id).toBe("resp_1");
	});

	it("resets append continuation on generic failure", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		class FailingWebSocket extends MockWebSocket {
			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				if (sentRequests.length === 1) {
					this.emitCodexResponse({ responseId: "resp_1", text: "Answer 1" });
				} else if (sentRequests.length === 2) {
					this.sendJson({ type: "error", code: "invalid_request_error", message: "Bad request" });
				} else if (sentRequests.length === 3) {
					this.emitCodexResponse({ responseId: "resp_3", text: "Answer 3" });
				}
			}
		}

		global.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
		const options = {
			fetch: vi.fn() as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: "ws-generic-fail-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		};
		const context: Context = { messages: [{ role: "user", content: "Q1", timestamp: 1 }] };
		const first = await streamOpenAICodexResponses(createCodexTestModel(), context, options).result();
		expect(first.stopReason).toBe("stop");

		const nextContext: Context = { messages: [...context.messages, first, { role: "user", content: "Q2", timestamp: 2 }] };
		const rejected = await streamOpenAICodexResponses(createCodexTestModel(), nextContext, options).result();
		expect(rejected.stopReason).toBe("error");

		const third = await streamOpenAICodexResponses(createCodexTestModel(), nextContext, options).result();
		expect(third.stopReason).toBe("stop");
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
	});
});
