import { afterEach, describe, expect, test, vi } from "bun:test";
import { openCodexCompactionEventStream } from "../src/providers/openai-codex-responses";
import type { CodexWebSocketSessionState, FetchImpl, Model, ProviderSessionState } from "../src/types";

const origWs = global.WebSocket;
afterEach(() => {
	global.WebSocket = origWs;
	vi.restoreAllMocks();
});

const token = `a.${Buffer.from('{"https://api.openai.com/auth":{"chatgpt_account_id":"acc"}}').toString("base64")}.b`;
const model = { id: "gpt-5.6-sol", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", preferWebsockets: true } as Model<"openai-codex-responses">;
const body = { model: "gpt-5.6-sol", input: [{ type: "compaction_trigger" }] };

class BaseMockWs {
	static readonly OPEN = 1;
	readyState = 0;
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onclose: ((e: Event) => void) | null = null;
	constructor(public readonly url?: string, public readonly opts?: unknown) {
		queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
	}
	send(_: string) {}
	close(code = 1000) { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code })); }
	emit(d: Record<string, unknown>) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(d) })); }
}

describe("openCodexCompactionEventStream", () => {
	test("streams decoded events over WS and applies metadata on success", async () => {
		class SuccessWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({ type: "response.metadata", headers: { "x-codex-turn-state": "ts_ok", "x-models-etag": "etag_ok" } });
						this.emit({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "blob" } });
						this.emit({ type: "response.completed", response: { usage: { input_tokens: 10 } } });
					});
				}
			}
		}
		global.WebSocket = SuccessWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, { apiKey: token, sessionId: "s1", providerSessionState: pState, preferWebsockets: true });
		const events: unknown[] = [];
		for await (const ev of stream) events.push(ev);
		expect(events).toHaveLength(3);
		const wsSession = Array.from(pState.values())[0]?.webSocketSessions.values().next().value as CodexWebSocketSessionState;
		expect(wsSession?.turnState).toBe("ts_ok");
		expect(wsSession?.modelsEtag).toBe("etag_ok");
	});

	test("negative control: WS transport error discards partial events and falls back to SSE", async () => {
		class DroppingWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "discarded" } });
						this.close(1006);
					});
				}
			}
		}
		global.WebSocket = DroppingWs as unknown as typeof WebSocket;
		const sse = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "sse_blob" } })}\n\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`;
		const fetchMock: FetchImpl = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		const stream = await openCodexCompactionEventStream(model, body, { apiKey: token, sessionId: "s2", preferWebsockets: true, fetch: fetchMock });
		const events: Array<Record<string, unknown>> = [];
		for await (const ev of stream) events.push(ev);
		expect(events).toHaveLength(2);
		const firstItem = events[0]?.item as { encrypted_content?: string } | undefined;
		expect(firstItem?.encrypted_content).toBe("sse_blob");
	});

	test("negative control: metadata rolls back to previous state on stream failure", async () => {
		class FailWs extends BaseMockWs { send() { queueMicrotask(() => this.close(1006)); } }
		global.WebSocket = FailWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		const fetch400: FetchImpl = async () => new Response("error", { status: 400 });
		const stream = await openCodexCompactionEventStream(model, body, { apiKey: token, sessionId: "s3", providerSessionState: pState, preferWebsockets: true, fetch: fetch400 });
		const wsKey = Array.from(pState.values())[0]?.webSocketSessions.keys().next().value;
		const wsSession = Array.from(pState.values())[0]?.webSocketSessions.get(wsKey!);
		if (wsSession) { wsSession.turnState = "prev_ts"; wsSession.modelsEtag = "prev_etag"; }
		await expect(async () => { for await (const _ of stream) {} }).toThrow();
		expect(wsSession?.turnState).toBe("prev_ts");
		expect(wsSession?.modelsEtag).toBe("prev_etag");
	});

	test("negative control: caller abort never retries via SSE", async () => {
		const abort = new AbortController();
		abort.abort();
		let sseCalled = false;
		const fetchMock: FetchImpl = async () => { sseCalled = true; return new Response("ok"); };
		await expect(openCodexCompactionEventStream(model, body, { apiKey: token, sessionId: "s4", preferWebsockets: true, fetch: fetchMock, signal: abort.signal })).rejects.toThrow();
		expect(sseCalled).toBe(false);
	});
});
