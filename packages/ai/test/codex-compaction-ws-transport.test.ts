import { afterEach, describe, expect, test, vi } from "bun:test";
import { collectCodexCompactionV2Events } from "../src/providers/openai-codex/compaction-v2";
import {
	CODEX_COMPACTION_WS_MAX_BUFFERED_BYTES,
	CODEX_COMPACTION_WS_MAX_BUFFERED_EVENTS,
	openCodexCompactionEventStream,
} from "../src/providers/openai-codex-responses";
import type { CodexWebSocketSessionState, FetchImpl, Model, ProviderSessionState } from "../src/types";

const origWs = global.WebSocket;
afterEach(() => {
	global.WebSocket = origWs;
	vi.restoreAllMocks();
});

const token = `a.${Buffer.from('{"https://api.openai.com/auth":{"chatgpt_account_id":"acc"}}').toString("base64")}.b`;
const model = {
	id: "gpt-5.6-sol",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	preferWebsockets: true,
} as Model<"openai-codex-responses">;
const body = { model: "gpt-5.6-sol", input: [{ type: "compaction_trigger" }] };

class BaseMockWs {
	static readonly OPEN = 1;
	readyState = 0;
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onclose: ((e: Event) => void) | null = null;
	constructor(
		public readonly url?: string,
		public readonly opts?: unknown,
	) {
		queueMicrotask(() => {
			this.readyState = 1;
			this.onopen?.(new Event("open"));
		});
	}
	send(_: string) {}
	close(code = 1000) {
		this.readyState = 3;
		this.onclose?.(new CloseEvent("close", { code }));
	}
	emit(d: Record<string, unknown>) {
		this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(d) }));
	}
}

function getSessionTurnState(pState: Map<string, ProviderSessionState>, sessionId: string): string | undefined {
	const codexState = pState.get("openai-codex-responses") as
		| {
				metadataSessions?: Map<string, { turnStates: Map<string, { value?: string }> }>;
		  }
		| undefined;
	return codexState?.metadataSessions?.get(sessionId)?.turnStates.values().next().value?.value;
}

function getSessionModelsEtag(pState: Map<string, ProviderSessionState>): string | undefined {
	const codexState = pState.get("openai-codex-responses") as
		| {
				webSocketSessions?: Map<string, CodexWebSocketSessionState>;
		  }
		| undefined;
	return Array.from(codexState?.webSocketSessions?.values() ?? [])[0]?.modelsEtag;
}

function seedPriorState(
	pState: Map<string, ProviderSessionState>,
	sessionId: string,
	turnState: string,
	modelsEtag: string,
): void {
	const codexState = pState.get("openai-codex-responses") as
		| {
				metadataSessions?: Map<string, { turnStates: Map<string, { value?: string }> }>;
				webSocketSessions?: Map<string, CodexWebSocketSessionState>;
		  }
		| undefined;
	const turnCell = codexState?.metadataSessions?.get(sessionId)?.turnStates.values().next().value;
	if (turnCell) turnCell.value = turnState;
	const ws = Array.from(codexState?.webSocketSessions?.values() ?? [])[0];
	if (ws) ws.modelsEtag = modelsEtag;
}

describe("openCodexCompactionEventStream", () => {
	test("streams decoded events over WS and applies metadata on success", async () => {
		class SuccessWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "ts_ok", "x-models-etag": "etag_ok" },
						});
						this.emit({
							type: "response.output_item.done",
							item: { type: "compaction", encrypted_content: "blob" },
						});
						this.emit({ type: "response.completed", response: { usage: { input_tokens: 10 } } });
					});
				}
			}
		}
		global.WebSocket = SuccessWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s1",
			providerSessionState: pState,
			preferWebsockets: true,
		});
		const events: unknown[] = [];
		for await (const ev of stream) events.push(ev);
		expect(events).toHaveLength(3);
		expect(getSessionTurnState(pState, "s1")).toBe("ts_ok");
		expect(getSessionModelsEtag(pState)).toBe("etag_ok");
	});

	test("negative control: WS transport error discards partial events and falls back to SSE", async () => {
		class DroppingWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.output_item.done",
							item: { type: "compaction", encrypted_content: "discarded" },
						});
						this.close(1006);
					});
				}
			}
		}
		global.WebSocket = DroppingWs as unknown as typeof WebSocket;
		const sse = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "sse_blob" } })}\n\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`;
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s2",
			preferWebsockets: true,
			fetch: fetchMock,
		});
		const events: Array<Record<string, unknown>> = [];
		for await (const ev of stream) events.push(ev);
		expect(events).toHaveLength(2);
		const firstItem = events[0]?.item as { encrypted_content?: string } | undefined;
		expect(firstItem?.encrypted_content).toBe("sse_blob");
	});

	test("negative control: metadata rolls back to previous state on stream failure", async () => {
		class FailWs extends BaseMockWs {
			send() {
				queueMicrotask(() => this.close(1006));
			}
		}
		global.WebSocket = FailWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		const fetch400: FetchImpl = async () => new Response("error", { status: 400 });
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s3",
			providerSessionState: pState,
			preferWebsockets: true,
			fetch: fetch400,
		});
		seedPriorState(pState, "s3", "prev_ts", "prev_etag");
		await expect(async () => {
			for await (const _ of stream) {
			}
		}).toThrow();
		expect(getSessionTurnState(pState, "s3")).toBe("prev_ts");
		expect(getSessionModelsEtag(pState)).toBe("prev_etag");
	});

	test("negative control: caller abort never retries via SSE", async () => {
		const abort = new AbortController();
		abort.abort();
		const fetchSpy = vi.fn(async () => new Response("ok"));
		await expect(
			openCodexCompactionEventStream(model, body, {
				apiKey: token,
				sessionId: "s4",
				preferWebsockets: true,
				signal: abort.signal,
				fetch: fetchSpy as unknown as FetchImpl,
			}),
		).rejects.toThrow();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("semantic rejection on WS: missing compaction item rejects and preserves prior state", async () => {
		class MissingCompactionWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "new_ts", "x-models-etag": "new_etag" },
						});
						this.emit({
							type: "response.output_item.done",
							item: { type: "message", content: "no compaction item here" },
						});
						this.emit({ type: "response.completed", response: { usage: { input_tokens: 5 } } });
					});
				}
			}
		}
		global.WebSocket = MissingCompactionWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_missing",
			providerSessionState: pState,
			preferWebsockets: true,
		});
		seedPriorState(pState, "s_sem_missing", "prior_ts", "prior_etag");

		await expect(collectCodexCompactionV2Events(stream, undefined, t => t)).rejects.toThrow("expected exactly one");
		expect(getSessionTurnState(pState, "s_sem_missing")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("semantic rejection on WS: malformed encrypted_content rejects and preserves prior state", async () => {
		class MalformedWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "new_ts", "x-models-etag": "new_etag" },
						});
						this.emit({
							type: "response.output_item.done",
							item: { type: "compaction" },
						});
						this.emit({ type: "response.completed" });
					});
				}
			}
		}
		global.WebSocket = MalformedWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_malformed",
			providerSessionState: pState,
			preferWebsockets: true,
		});
		seedPriorState(pState, "s_sem_malformed", "prior_ts", "prior_etag");

		await expect(collectCodexCompactionV2Events(stream, undefined, t => t)).rejects.toThrow("no encrypted_content");
		expect(getSessionTurnState(pState, "s_sem_malformed")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("semantic rejection on WS: duplicate compaction items rejects and preserves prior state", async () => {
		class DuplicateCompactionWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "new_ts", "x-models-etag": "new_etag" },
						});
						this.emit({
							type: "response.output_item.done",
							item: { type: "compaction", encrypted_content: "blob1" },
						});
						this.emit({
							type: "response.output_item.done",
							item: { type: "compaction", encrypted_content: "blob2" },
						});
						this.emit({ type: "response.completed" });
					});
				}
			}
		}
		global.WebSocket = DuplicateCompactionWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_dup",
			providerSessionState: pState,
			preferWebsockets: true,
		});
		seedPriorState(pState, "s_sem_dup", "prior_ts", "prior_etag");

		await expect(collectCodexCompactionV2Events(stream, undefined, t => t)).rejects.toThrow("expected exactly one");
		expect(getSessionTurnState(pState, "s_sem_dup")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("semantic rejection on WS: stream closed before response.completed rejects and preserves prior state", async () => {
		class EarlyCloseWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "new_ts", "x-models-etag": "new_etag" },
						});
						this.emit({
							type: "response.output_item.done",
							item: { type: "compaction", encrypted_content: "blob" },
						});
						this.emit({ type: "response.done" });
					});
				}
			}
		}
		global.WebSocket = EarlyCloseWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_close",
			providerSessionState: pState,
			preferWebsockets: true,
		});
		seedPriorState(pState, "s_sem_close", "prior_ts", "prior_etag");

		await expect(collectCodexCompactionV2Events(stream, undefined, t => t)).rejects.toThrow(
			"stream closed before response.completed",
		);
		expect(getSessionTurnState(pState, "s_sem_close")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("semantic rejection on WS: provider failure rejects and preserves prior state", async () => {
		class ProviderFailedWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "new_ts", "x-models-etag": "new_etag" },
						});
						this.emit({
							type: "response.failed",
							response: { error: { message: "Model is unavailable" } },
						});
					});
				}
			}
		}
		global.WebSocket = ProviderFailedWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_fail",
			providerSessionState: pState,
			preferWebsockets: true,
		});
		seedPriorState(pState, "s_sem_fail", "prior_ts", "prior_etag");

		await expect(collectCodexCompactionV2Events(stream, undefined, t => t)).rejects.toThrow("Model is unavailable");
		expect(getSessionTurnState(pState, "s_sem_fail")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("semantic rejection on direct SSE: missing compaction item rejects and preserves prior state", async () => {
		const sse = [
			`data: ${JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "sse_ts", "x-models-etag": "sse_etag" } })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: "not compaction" } })}`,
			`data: ${JSON.stringify({ type: "response.completed" })}`,
		].join("\n\n");
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sse_missing",
			providerSessionState: pState,
			preferWebsockets: false,
			fetch: fetchMock,
		});
		seedPriorState(pState, "s_sse_missing", "prior_ts", "prior_etag");

		await expect(collectCodexCompactionV2Events(stream, undefined, t => t)).rejects.toThrow("expected exactly one");
		expect(getSessionTurnState(pState, "s_sse_missing")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("semantic rejection on direct SSE: stream closed before completed rejects and preserves prior state", async () => {
		const sse = [
			`data: ${JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "sse_ts", "x-models-etag": "sse_etag" } })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "blob" } })}`,
		].join("\n\n");
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sse_close",
			providerSessionState: pState,
			preferWebsockets: false,
			fetch: fetchMock,
		});
		seedPriorState(pState, "s_sse_close", "prior_ts", "prior_etag");

		await expect(collectCodexCompactionV2Events(stream, undefined, t => t)).rejects.toThrow(
			"stream closed before response.completed",
		);
		expect(getSessionTurnState(pState, "s_sse_close")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("semantic rejection on WS->SSE fallback: malformed fallback stream rejects and preserves prior state", async () => {
		class DroppingWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => this.close(1006));
				}
			}
		}
		global.WebSocket = DroppingWs as unknown as typeof WebSocket;

		const sse = [
			`data: ${JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "fallback_ts", "x-models-etag": "fallback_etag" } })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction" } })}`, // missing encrypted_content
			`data: ${JSON.stringify({ type: "response.completed" })}`,
		].join("\n\n");
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_fallback_malformed",
			providerSessionState: pState,
			preferWebsockets: true,
			fetch: fetchMock,
		});
		seedPriorState(pState, "s_fallback_malformed", "prior_ts", "prior_etag");

		await expect(collectCodexCompactionV2Events(stream, undefined, t => t)).rejects.toThrow("no encrypted_content");
		expect(getSessionTurnState(pState, "s_fallback_malformed")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("bounds: exceeding frame count limit triggers fallback to SSE without exposing partial events", async () => {
		class FloodFramesWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						for (let i = 0; i <= CODEX_COMPACTION_WS_MAX_BUFFERED_EVENTS; i++) {
							this.emit({
								type: "response.output_item.done",
								item: { type: "filler", seq: i },
							});
						}
					});
				}
			}
		}
		global.WebSocket = FloodFramesWs as unknown as typeof WebSocket;

		const sse = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "sse_recovery_frames" } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 42 } } })}`,
		].join("\n\n");
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_bounds_frames",
			preferWebsockets: true,
			fetch: fetchMock,
		});

		const result = await collectCodexCompactionV2Events(stream, undefined, t => t);
		expect(result.compactionItem.encrypted_content).toBe("sse_recovery_frames");
		expect(result.usage?.inputTokens).toBe(42);
	});

	test("bounds: exceeding byte budget triggers fallback to SSE without exposing partial events", async () => {
		class OversizedFrameWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.output_item.done",
							item: {
								type: "huge",
								payload: "x".repeat(CODEX_COMPACTION_WS_MAX_BUFFERED_BYTES + 1024),
							},
						});
					});
				}
			}
		}
		global.WebSocket = OversizedFrameWs as unknown as typeof WebSocket;

		const sse = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "sse_recovery_bytes" } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 99 } } })}`,
		].join("\n\n");
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_bounds_bytes",
			preferWebsockets: true,
			fetch: fetchMock,
		});

		const result = await collectCodexCompactionV2Events(stream, undefined, t => t);
		expect(result.compactionItem.encrypted_content).toBe("sse_recovery_bytes");
		expect(result.usage?.inputTokens).toBe(99);
	});

	test("bounds: allowed boundary stream succeeds over WS directly without fallback", async () => {
		class ExactLimitWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "ws_ok_ts", "x-models-etag": "ws_ok_etag" },
						});
						for (let i = 0; i < CODEX_COMPACTION_WS_MAX_BUFFERED_EVENTS - 3; i++) {
							this.emit({
								type: "response.output_item.done",
								item: { type: "filler", index: i },
							});
						}
						this.emit({
							type: "response.output_item.done",
							item: { type: "compaction", encrypted_content: "ws_exact_bound_blob" },
						});
						this.emit({
							type: "response.completed",
							response: { usage: { input_tokens: 1024 } },
						});
					});
				}
			}
		}
		global.WebSocket = ExactLimitWs as unknown as typeof WebSocket;
		const fetchSpy = vi.fn(async () => new Response("fallback should not be called", { status: 500 }));

		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_allowed_bound",
			providerSessionState: pState,
			preferWebsockets: true,
			fetch: fetchSpy as unknown as FetchImpl,
		});

		const result = await collectCodexCompactionV2Events(stream, undefined, t => t);
		expect(result.compactionItem.encrypted_content).toBe("ws_exact_bound_blob");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(getSessionTurnState(pState, "s_allowed_bound")).toBe("ws_ok_ts");
		expect(getSessionModelsEtag(pState)).toBe("ws_ok_etag");
	});

	test("bounds: caller abort during WS buffering aborts immediately without retrying over SSE", async () => {
		const abort = new AbortController();
		class StreamingWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.output_item.done",
							item: { type: "filler" },
						});
					});
				}
			}
		}
		global.WebSocket = StreamingWs as unknown as typeof WebSocket;
		const fetchSpy = vi.fn(async () => new Response("fallback should not be called", { status: 500 }));

		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_abort_mid",
			providerSessionState: pState,
			preferWebsockets: true,
			signal: abort.signal,
			fetch: fetchSpy as unknown as FetchImpl,
		});

		const consumptionPromise = collectCodexCompactionV2Events(stream, abort.signal, t => t);
		abort.abort(new Error("caller cancelled mid-stream"));
		await expect(consumptionPromise).rejects.toThrow("aborted");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
