import { afterEach, describe, expect, test, vi } from "bun:test";
import { collectCodexCompactionV2Events } from "../src/providers/openai-codex/compaction-v2";
import type { CodexWebSocketSessionState } from "../src/providers/openai-codex-responses";
import {
	CODEX_COMPACTION_WS_MAX_BUFFERED_BYTES,
	CODEX_COMPACTION_WS_MAX_BUFFERED_EVENTS,
	openCodexCompactionEventStream,
} from "../src/providers/openai-codex-responses";
import type { FetchImpl, Model, ProviderSessionState } from "../src/types";

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
	turnState: string | undefined,
	modelsEtag: string,
): void {
	const sessionKey = `account:acc:https://chatgpt.com/backend-api:gpt-5.6-sol:${sessionId}`;
	const publicSessionKey = `https://chatgpt.com/backend-api:gpt-5.6-sol:${sessionId}`;
	let codexState = pState.get("openai-codex-responses") as
		| {
				metadataSessions: Map<
					string,
					{ sessionId: string; turnId: string; turnStates: Map<string, { value?: string }> }
				>;
				webSocketSessions: Map<string, CodexWebSocketSessionState>;
				webSocketPublicToPrivate: Map<string, string>;
				close?: () => void;
		  }
		| undefined;
	if (!codexState) {
		codexState = {
			metadataSessions: new Map(),
			webSocketSessions: new Map(),
			webSocketPublicToPrivate: new Map(),
			close: () => {},
		};
		pState.set("openai-codex-responses", codexState as unknown as ProviderSessionState);
	}
	codexState.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);

	let metadataSession = codexState.metadataSessions.get(sessionId);
	if (!metadataSession) {
		metadataSession = {
			sessionId,
			turnId: "prior_turn_id",
			turnStates: new Map(),
		};
		codexState.metadataSessions.set(sessionId, metadataSession);
	}
	metadataSession.turnStates.set(sessionKey, { value: turnState });

	let ws = codexState.webSocketSessions.get(sessionKey);
	if (!ws) {
		ws = {
			disableWebsocket: false,
			canAppend: false,
			fallbackCount: 0,
			prewarmed: false,
			stats: {
				fullContextRequests: 0,
				deltaRequests: 0,
				lastInputItems: 0,
			},
			modelsEtag,
		} as CodexWebSocketSessionState;
		codexState.webSocketSessions.set(sessionKey, ws);
	} else {
		ws.modelsEtag = modelsEtag;
	}
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
		seedPriorState(pState, "s3", "prev_ts", "prev_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s3",
			providerSessionState: pState,
			preferWebsockets: true,
			fetch: fetch400,
		});
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
		seedPriorState(pState, "s_sem_missing", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_missing",
			providerSessionState: pState,
			preferWebsockets: true,
		});

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
		seedPriorState(pState, "s_sem_malformed", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_malformed",
			providerSessionState: pState,
			preferWebsockets: true,
		});

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
		seedPriorState(pState, "s_sem_dup", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_dup",
			providerSessionState: pState,
			preferWebsockets: true,
		});

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
		seedPriorState(pState, "s_sem_close", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_close",
			providerSessionState: pState,
			preferWebsockets: true,
		});

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
		seedPriorState(pState, "s_sem_fail", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sem_fail",
			providerSessionState: pState,
			preferWebsockets: true,
		});

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
			new Response(sse, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-models-etag": "sse_http_etag",
					"x-codex-turn-state": "sse_http_ts",
				},
			});

		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_sse_missing", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sse_missing",
			providerSessionState: pState,
			preferWebsockets: false,
			fetch: fetchMock,
		});

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
			new Response(sse, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-models-etag": "sse_http_etag",
					"x-codex-turn-state": "sse_http_ts",
				},
			});

		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_sse_close", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sse_close",
			providerSessionState: pState,
			preferWebsockets: false,
			fetch: fetchMock,
		});

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
			new Response(sse, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-models-etag": "fallback_http_etag",
					"x-codex-turn-state": "fallback_http_ts",
				},
			});

		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_fallback_malformed", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_fallback_malformed",
			providerSessionState: pState,
			preferWebsockets: true,
			fetch: fetchMock,
		});

		await expect(collectCodexCompactionV2Events(stream, undefined, t => t)).rejects.toThrow("no encrypted_content");
		expect(getSessionTurnState(pState, "s_fallback_malformed")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("bounds: exceeding frame count limit triggers fallback to SSE without exposing partial events", async () => {
		let wsAttempts = 0;
		class FloodFramesWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					wsAttempts++;
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
		let sseCalled = false;
		const fetchMock: FetchImpl = async () => {
			sseCalled = true;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		};

		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_bounds_frames",
			providerSessionState: pState,
			preferWebsockets: true,
			fetch: fetchMock,
		});

		const result = await collectCodexCompactionV2Events(stream, undefined, t => t);
		expect(wsAttempts).toBe(1);
		expect(sseCalled).toBe(true);
		expect(result.compactionItem.encrypted_content).toBe("sse_recovery_frames");
		expect(result.usage?.inputTokens).toBe(42);
	});

	test("bounds: exceeding byte budget triggers fallback to SSE without exposing partial events", async () => {
		let wsAttempts = 0;
		class OversizedFrameWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					wsAttempts++;
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
		let sseCalled = false;
		const fetchMock: FetchImpl = async () => {
			sseCalled = true;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		};

		const pState = new Map<string, ProviderSessionState>();
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_bounds_bytes",
			providerSessionState: pState,
			preferWebsockets: true,
			fetch: fetchMock,
		});

		const result = await collectCodexCompactionV2Events(stream, undefined, t => t);
		expect(wsAttempts).toBe(1);
		expect(sseCalled).toBe(true);
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

	test("valid SSE body commits HTTP response metadata", async () => {
		const sse = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "valid_blob" } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 42 } } })}`,
		].join("\n\n");
		const fetchMock: FetchImpl = async () =>
			new Response(sse, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-models-etag": "committed_etag",
					"x-codex-turn-state": "committed_ts",
				},
			});

		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_sse_commit", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_sse_commit",
			providerSessionState: pState,
			preferWebsockets: false,
			fetch: fetchMock,
		});

		const result = await collectCodexCompactionV2Events(stream, undefined, t => t);
		expect(result.compactionItem.encrypted_content).toBe("valid_blob");
		expect(getSessionTurnState(pState, "s_sse_commit")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("committed_etag");
	});

	test("opening failure restores baseline state if metadata reached transport", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(null, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-models-etag": "reached_etag",
					"x-codex-turn-state": "reached_ts",
				},
			});

		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_open_fail", "prior_ts", "prior_etag");
		await expect(
			openCodexCompactionEventStream(model, body, {
				apiKey: token,
				sessionId: "s_open_fail",
				providerSessionState: pState,
				preferWebsockets: false,
				fetch: fetchMock,
			}),
		).rejects.toThrow();

		expect(getSessionTurnState(pState, "s_open_fail")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});
	test("suspendedStart on direct SSE: calling return before next cancels body and aborts requestSignal", async () => {
		let cancelCalled = false;
		let observedSignal: AbortSignal | undefined;
		const streamBody = new ReadableStream<Uint8Array>({
			start() {},
			cancel() {
				cancelCalled = true;
			},
		});

		const fetchMock: FetchImpl = async (_input, init) => {
			observedSignal = init?.signal ?? undefined;
			return new Response(streamBody, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-models-etag": "sse_etag_unconsumed",
					"x-codex-turn-state": "sse_ts_unconsumed",
				},
			});
		};

		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_suspended_sse", "prior_ts", "prior_etag");
		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_suspended_sse",
			providerSessionState: pState,
			preferWebsockets: false,
			fetch: fetchMock,
		});

		expect(cancelCalled).toBe(false);
		expect(observedSignal).toBeDefined();
		expect(observedSignal!.aborted).toBe(false);

		await stream.return(undefined);

		expect(cancelCalled).toBe(true);
		expect(streamBody.locked).toBe(false);
		expect(observedSignal!.aborted).toBe(true);
		expect(getSessionTurnState(pState, "s_suspended_sse")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("early WS abandonment: cold return preserves the reusable session socket", async () => {
		let wsClosed = false;
		class AbandonWs extends BaseMockWs {
			close() {
				wsClosed = true;
			}
		}
		global.WebSocket = AbandonWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_abandon_ws", "prior_ts", "prior_etag");

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_abandon_ws",
			providerSessionState: pState,
			preferWebsockets: true,
		});

		expect(wsClosed).toBe(false);
		await stream.return(undefined);

		expect(wsClosed).toBe(false);
		expect(getSessionTurnState(pState, "s_abandon_ws")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	for (const completeBeforeReturn of [false, true]) {
		test(`cold WS return does not disturb another request (${completeBeforeReturn ? "completed" : "active"})`, async () => {
			const sent = Promise.withResolvers<void>();
			let socket: SharedWs | undefined;
			let constructors = 0;
			let requests = 0;
			let closes = 0;
			const fetchSpy = vi.fn(async () => new Response("unexpected SSE", { status: 400 }));
			class SharedWs extends BaseMockWs {
				constructor(url?: string, opts?: unknown) {
					super(url, opts);
					socket = this;
					constructors++;
				}
				send(data: string) {
					if (JSON.parse(data).type === "response.create") {
						requests++;
						sent.resolve();
					}
				}
				close(code = 1000) {
					closes++;
					super.close(code);
				}
			}
			global.WebSocket = SharedWs as unknown as typeof WebSocket;
			const pState = new Map<string, ProviderSessionState>();
			const sessionId = `shared_cold_${completeBeforeReturn}`;
			seedPriorState(pState, sessionId, undefined, "prior_etag");
			const options = {
				apiKey: token,
				sessionId,
				providerSessionState: pState,
				responsesLite: false,
				preferWebsockets: true,
				fetch: fetchSpy as unknown as FetchImpl,
			};
			const active = await openCodexCompactionEventStream(model, body, options);
			const first = active.next();
			await sent.promise;
			const cold = await openCodexCompactionEventStream(model, body, options);
			const completeActive = async () => {
				socket!.emit({
					type: "response.metadata",
					headers: { "x-codex-turn-state": "active_ts", "x-models-etag": "active_etag" },
				});
				socket!.emit({
					type: "response.output_item.done",
					item: { type: "compaction", encrypted_content: "active_blob" },
				});
				socket!.emit({ type: "response.completed" });
				expect((await first).value?.type).toBe("response.metadata");
				const remaining: Array<Record<string, unknown>> = [];
				for await (const event of active) remaining.push(event);
				expect(remaining.map(event => event.type)).toEqual(["response.output_item.done", "response.completed"]);
			};
			if (completeBeforeReturn) await completeActive();
			await cold.return(undefined);
			expect(closes).toBe(0);
			if (!completeBeforeReturn) await completeActive();
			expect(constructors).toBe(1);
			expect(requests).toBe(1);
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(getSessionTurnState(pState, sessionId)).toBe("active_ts");
			expect(getSessionModelsEtag(pState)).toBe("active_etag");
			socket!.close();
		});
	}

	test("fake secret echo on WS with sanitize: marker absent, sanitizer called, metadata rolled back", async () => {
		const SECRET_MARKER = "SECRET_MARKER_WS_987654";
		const SECRET_CODE = "SECRET_CODE_WS_1234";
		class SecretEchoWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "new_ws_ts", "x-models-etag": "new_ws_etag" },
						});
						this.emit({
							type: "response.failed",
							response: {
								error: {
									message: `Provider failed with token ${SECRET_MARKER}`,
									code: SECRET_CODE,
								},
							},
						});
					});
				}
			}
		}
		global.WebSocket = SecretEchoWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_secret_ws", "prior_ts", "prior_etag");

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_secret_ws",
			providerSessionState: pState,
			preferWebsockets: true,
		});

		let sanitizeCalls = 0;
		const sanitize = (text: string): string => {
			sanitizeCalls += 1;
			return text.replaceAll(SECRET_MARKER, "[REDACTED_MSG]").replaceAll(SECRET_CODE, "[REDACTED_CODE]");
		};

		let thrownError: Error | undefined;
		try {
			await collectCodexCompactionV2Events(stream, undefined, sanitize);
		} catch (error) {
			thrownError = error as Error;
		}

		expect(thrownError).toBeDefined();
		expect(sanitizeCalls).toBeGreaterThan(0);
		expect(thrownError!.message).not.toContain(SECRET_MARKER);
		expect(thrownError!.message).not.toContain(SECRET_CODE);
		expect(thrownError!.message).toContain("[REDACTED_MSG]");
		expect(thrownError!.message).toContain("[REDACTED_CODE]");
		expect(getSessionTurnState(pState, "s_secret_ws")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("fake secret echo on direct SSE with sanitize: marker absent, sanitizer called, metadata rolled back", async () => {
		const SECRET_MARKER = "SECRET_MARKER_SSE_987654";
		const SECRET_CODE = "SECRET_CODE_SSE_1234";
		const sse = [
			`data: ${JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "new_sse_ts", "x-models-etag": "new_sse_etag" } })}`,
			`data: ${JSON.stringify({
				type: "response.failed",
				response: {
					error: {
						message: `SSE failed with token ${SECRET_MARKER}`,
						code: SECRET_CODE,
					},
				},
			})}`,
		].join("\n\n");

		const fetchMock: FetchImpl = async () =>
			new Response(sse, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-models-etag": "sse_meta_etag",
					"x-codex-turn-state": "sse_meta_ts",
				},
			});

		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_secret_sse", "prior_ts", "prior_etag");

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_secret_sse",
			providerSessionState: pState,
			preferWebsockets: false,
			fetch: fetchMock,
		});

		let sanitizeCalls = 0;
		const sanitize = (text: string): string => {
			sanitizeCalls += 1;
			return text.replaceAll(SECRET_MARKER, "[REDACTED_MSG]").replaceAll(SECRET_CODE, "[REDACTED_CODE]");
		};

		let thrownError: Error | undefined;
		try {
			await collectCodexCompactionV2Events(stream, undefined, sanitize);
		} catch (error) {
			thrownError = error as Error;
		}

		expect(thrownError).toBeDefined();
		expect(sanitizeCalls).toBeGreaterThan(0);
		expect(thrownError!.message).not.toContain(SECRET_MARKER);
		expect(thrownError!.message).not.toContain(SECRET_CODE);
		expect(thrownError!.message).toContain("[REDACTED_MSG]");
		expect(thrownError!.message).toContain("[REDACTED_CODE]");
		expect(getSessionTurnState(pState, "s_secret_sse")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("consumer ignores failure on WS: transport still rolls back and rejects on completion", async () => {
		class IgnoreFailureWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "ignore_ts", "x-models-etag": "ignore_etag" },
						});
						this.emit({
							type: "response.failed",
							response: { error: { message: "Ignored failure" } },
						});
					});
				}
			}
		}
		global.WebSocket = IgnoreFailureWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_ignore_ws", "prior_ts", "prior_etag");

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_ignore_ws",
			providerSessionState: pState,
			preferWebsockets: true,
		});

		const events: unknown[] = [];
		await expect(
			(async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})(),
		).rejects.toThrow("provider error");

		expect(events.length).toBeGreaterThan(0);
		expect(getSessionTurnState(pState, "s_ignore_ws")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("consumer ignores failure on direct SSE: transport still rolls back and rejects on completion", async () => {
		const sse = [
			`data: ${JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "sse_ign_ts", "x-models-etag": "sse_ign_etag" } })}`,
			`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "Ignored SSE failure" } } })}`,
		].join("\n\n");

		const fetchMock: FetchImpl = async () =>
			new Response(sse, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-models-etag": "sse_ign_http_etag",
					"x-codex-turn-state": "sse_ign_http_ts",
				},
			});

		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_ignore_sse", "prior_ts", "prior_etag");

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_ignore_sse",
			providerSessionState: pState,
			preferWebsockets: false,
			fetch: fetchMock,
		});

		const events: unknown[] = [];
		await expect(
			(async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})(),
		).rejects.toThrow("provider error");

		expect(events.length).toBeGreaterThan(0);
		expect(getSessionTurnState(pState, "s_ignore_sse")).toBe("prior_ts");
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});
	test("raw API consumer: abort during buffered replay after first next() rejects and rolls back state", async () => {
		class ReplayAbortWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "abort_mid_ts", "x-models-etag": "abort_mid_etag" },
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
		global.WebSocket = ReplayAbortWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_replay_abort", undefined, "prior_etag");
		const abortController = new AbortController();

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_replay_abort",
			providerSessionState: pState,
			preferWebsockets: true,
			signal: abortController.signal,
		});

		const first = await stream.next();
		expect(first.done).toBe(false);
		expect(first.value).toMatchObject({ type: "response.metadata" });
		expect(getSessionTurnState(pState, "s_replay_abort")).toBeUndefined();
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");

		abortController.abort(new Error("caller canceled mid-replay"));

		await expect(stream.next()).rejects.toThrow("caller canceled mid-replay");
		expect(getSessionTurnState(pState, "s_replay_abort")).toBeUndefined();
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	test("raw API consumer: abort after final yielded completed before final next() rejects and rolls back state", async () => {
		class ReplayAbortAfterCompleteWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "abort_post_ts", "x-models-etag": "abort_post_etag" },
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
		global.WebSocket = ReplayAbortAfterCompleteWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_replay_abort_post", undefined, "prior_etag");
		const abortController = new AbortController();

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_replay_abort_post",
			providerSessionState: pState,
			preferWebsockets: true,
			signal: abortController.signal,
		});

		const first = await stream.next();
		expect(first.done).toBe(false);
		expect(first.value).toMatchObject({ type: "response.metadata" });
		expect(getSessionTurnState(pState, "s_replay_abort_post")).toBeUndefined();
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");

		const second = await stream.next();
		expect(second.done).toBe(false);
		expect(second.value).toMatchObject({ type: "response.output_item.done" });

		const third = await stream.next();
		expect(third.done).toBe(false);
		expect(third.value).toMatchObject({ type: "response.completed" });

		// Caller aborts after receiving the completed event, before the final terminal next()
		abortController.abort(new Error("caller canceled after completed"));

		await expect(stream.next()).rejects.toThrow("caller canceled after completed");
		expect(getSessionTurnState(pState, "s_replay_abort_post")).toBeUndefined();
		expect(getSessionModelsEtag(pState)).toBe("prior_etag");
	});

	for (const exit of ["return", "semantic"] as const) {
		for (const committedEtag of [undefined, "b_etag", "a_etag"]) {
			test(`SSE ${exit} preserves ${committedEtag ?? "baseline"} after another request`, async () => {
				const encoder = new TextEncoder();
				let controller: ReadableStreamDefaultController<Uint8Array>;
				let canceled = false;
				const activeBody = new ReadableStream<Uint8Array>({
					start(source) {
						controller = source;
						source.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({
									type: "response.metadata",
									headers: { "x-codex-turn-state": "a_ts", "x-models-etag": "a_etag" },
								})}\n\n`,
							),
						);
					},
					cancel() {
						canceled = true;
					},
				});
				const successfulBody = [
					{ type: "response.metadata", headers: { "x-codex-turn-state": "b_ts" } },
					{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "b_blob" } },
					{ type: "response.completed" },
				]
					.map(event => `data: ${JSON.stringify(event)}\n\n`)
					.join("");
				let fetches = 0;
				const fetchMock: FetchImpl = async () => {
					fetches++;
					return fetches === 1
						? new Response(activeBody, { headers: { "x-models-etag": "a_header" } })
						: new Response(successfulBody, { headers: { "x-models-etag": committedEtag! } });
				};
				const pState = new Map<string, ProviderSessionState>();
				const sessionId = `stage_${exit}_${committedEtag ?? "control"}`;
				seedPriorState(pState, sessionId, undefined, "prior_etag");
				const options = {
					apiKey: token,
					sessionId,
					providerSessionState: pState,
					preferWebsockets: false,
					fetch: fetchMock,
				};
				const active = await openCodexCompactionEventStream(model, body, options);
				expect((await active.next()).value?.type).toBe("response.metadata");
				if (committedEtag) {
					const other = await openCodexCompactionEventStream(model, body, options);
					const result = await collectCodexCompactionV2Events(other, undefined, text => text);
					expect(result.compactionItem.encrypted_content).toBe("b_blob");
				}
				if (exit === "return") {
					await active.return(undefined);
					expect(canceled).toBe(true);
				} else {
					controller!.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
					controller!.close();
					await expect(collectCodexCompactionV2Events(active, undefined, text => text)).rejects.toThrow(
						"expected exactly one",
					);
				}
				expect(getSessionModelsEtag(pState)).toBe(committedEtag ?? "prior_etag");
				expect(getSessionTurnState(pState, sessionId)).toBe(committedEtag ? "b_ts" : undefined);
				expect(fetches).toBe(committedEtag ? 2 : 1);
				expect(activeBody.locked).toBe(false);
			});
		}
	}

	test("raw API consumer uncanceled control: consumes full replay successfully and commits metadata", async () => {
		class ReplaySuccessControlWs extends BaseMockWs {
			send(data: string) {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.create") {
					queueMicrotask(() => {
						this.emit({
							type: "response.metadata",
							headers: { "x-codex-turn-state": "ok_replay_ts", "x-models-etag": "ok_replay_etag" },
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
		global.WebSocket = ReplaySuccessControlWs as unknown as typeof WebSocket;
		const pState = new Map<string, ProviderSessionState>();
		seedPriorState(pState, "s_replay_ok", undefined, "prior_etag");
		const abortController = new AbortController();

		const stream = await openCodexCompactionEventStream(model, body, {
			apiKey: token,
			sessionId: "s_replay_ok",
			providerSessionState: pState,
			preferWebsockets: true,
			signal: abortController.signal,
		});

		const first = await stream.next();
		expect(first.done).toBe(false);
		expect(first.value).toMatchObject({ type: "response.metadata" });

		const second = await stream.next();
		expect(second.done).toBe(false);
		expect(second.value).toMatchObject({ type: "response.output_item.done" });

		const third = await stream.next();
		expect(third.done).toBe(false);
		expect(third.value).toMatchObject({ type: "response.completed" });

		const fourth = await stream.next();
		expect(fourth.done).toBe(true);

		expect(getSessionTurnState(pState, "s_replay_ok")).toBe("ok_replay_ts");
		expect(getSessionModelsEtag(pState)).toBe("ok_replay_etag");
	});
});
