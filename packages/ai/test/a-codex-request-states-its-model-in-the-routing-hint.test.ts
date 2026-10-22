/**
 * WHY: codex-rs sends `x-codex-routing-hint: model=<model>;tier=<tier>`, or `model=<model>` when the
 * request sets no service tier, on every ChatGPT Codex Responses request, on the websocket upgrade
 * (startup prewarm included) and on the remote compaction (`build_routing_hint_header`, since 0.153).
 * veyyon sent none, so a websocket upgrade reached the Codex backend stating no model at all; the
 * model appeared only in the first frame.
 *
 * Class closed: every request the Codex provider sends carries the hint its own body derives, the
 * wire model (`requestModelId`, not the catalog id) and the tier the body sets. The suite drives the
 * production path for each transport: an HTTP turn, a websocket turn's upgrade, the prewarm upgrade a
 * later turn reuses, and the server-side compaction. Every request the host receives is checked
 * against the body it carries. A caller header stating another model, an `onPayload` hook rewriting
 * the model, and a model whose hint is not a valid header value are each driven.
 *
 * Not caught: the web search and image generation requests (covered in coding-agent), and a Codex
 * request site this suite does not drive. The suite asserts what is sent; how the backend routes on
 * the hint is not observable offline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetCodexAccessProgramListings } from "@veyyon/ai/providers/openai-codex/access-programs";
import { prewarmOpenAICodexResponses, streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import {
	openAIResponsesServerCompaction,
	resetServerCompactionRouteCache,
} from "@veyyon/ai/providers/openai-compaction";
import type { Context, FetchImpl, Model, ProviderSessionState, ServiceTier } from "@veyyon/ai/types";
import { codexRoutingHint } from "@veyyon/catalog/wire/codex";
import * as piUtils from "@veyyon/utils";
import { createCodexModel } from "./helpers";

const ROUTING_HINT = "x-codex-routing-hint";
const BASE_URL = "https://codex.example/backend-api";
const ACCOUNT_ID = "acc_test";
const CATALOG_ID = "gpt-daybreak-blue-latest";
const WIRE_MODEL = "gpt-daybreak-blue-wire";
const originalWebSocket = global.WebSocket;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	global.WebSocket = originalWebSocket;
	vi.restoreAllMocks();
	resetServerCompactionRouteCache();
	resetCodexAccessProgramListings();
});

/** A Codex access token naming {@link ACCOUNT_ID}. */
function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

/**
 * A Daybreak model shaped as discovery records one: websocket-preferring, Responses Lite, a wire id
 * that differs from the catalog id, and the account's program recorded so no listing is fetched.
 */
function daybreakModel(requestModelId = WIRE_MODEL): Model<"openai-codex-responses"> {
	return createCodexModel(CATALOG_ID, {
		baseUrl: BASE_URL,
		requestModelId,
		preferWebsockets: true,
		useResponsesLite: true,
		accountAccess: { [ACCOUNT_ID]: { listed: true, cyber: ["daybreak_blue"] } },
	});
}

function turnContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
	};
}

const COMPLETED_EVENTS: Array<Record<string, unknown>> = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	},
	{
		type: "response.completed",
		response: { id: "resp_1", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
	},
];

const COMPLETED_SSE = `${COMPLETED_EVENTS.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;

interface SentRequest {
	headers: Headers;
	body: Record<string, unknown>;
}

/** A Codex host recording every POST; a compaction (its last input item is the trigger) is answered 404. */
function codexHost(): { fetch: FetchImpl; sent: SentRequest[] } {
	const sent: SentRequest[] = [];
	const fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (!url.endsWith("/codex/responses")) return new Response("not found", { status: 404 });
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		sent.push({ headers: new Headers(init?.headers), body });
		const last = (Array.isArray(body.input) ? body.input : []).at(-1) as { type?: string } | undefined;
		return last?.type === "compaction_trigger"
			? new Response('{"detail":"Not Found"}', { status: 404 })
			: new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as FetchImpl;
	return { fetch, sent };
}

interface OpenedSocket {
	headers: Record<string, string>;
	frames: Array<Record<string, unknown>>;
}

/** A websocket recording the upgrade headers of each socket opened and answering each frame with a completed response. */
function installCodexWebSocket(): OpenedSocket[] {
	const sockets: OpenedSocket[] = [];
	class CodexWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readyState = CodexWebSocket.CONNECTING;
		binaryType = "blob";
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onclose: ((event: Event) => void) | null = null;
		readonly #opened: OpenedSocket;

		constructor(_url: string, options?: { headers?: Record<string, string> }) {
			this.#opened = { headers: { ...(options?.headers ?? {}) }, frames: [] };
			sockets.push(this.#opened);
			// The caller attaches `onopen` after the constructor returns, so the open event is queued.
			queueMicrotask(() => {
				this.readyState = CodexWebSocket.OPEN;
				this.onopen?.(new Event("open"));
			});
		}

		send(data: string): void {
			this.#opened.frames.push(JSON.parse(data) as Record<string, unknown>);
			for (const event of COMPLETED_EVENTS) {
				const frame = event.type === "response.completed" ? { ...event, type: "response.done" } : event;
				this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
			}
		}

		close(): void {
			this.readyState = CodexWebSocket.CLOSED;
		}
	}
	global.WebSocket = CodexWebSocket as unknown as typeof WebSocket;
	return sockets;
}

/** The hint a body derives, spelled out independently of the production builder. */
function hintFor(body: Record<string, unknown>): string {
	return typeof body.service_tier === "string"
		? `model=${body.model};tier=${body.service_tier}`
		: `model=${body.model}`;
}

/** Every request the host received carries the hint of the body it carries. */
function expectEveryRequestStatesItsBody(sent: readonly SentRequest[]): void {
	expect(sent.length).toBeGreaterThan(0);
	for (const request of sent) expect(request.headers.get(ROUTING_HINT)).toBe(hintFor(request.body));
}

/** Every tier a Codex body sends, and none. */
const TIERS: ReadonlyArray<{ tier: ServiceTier | undefined; hint: string }> = [
	{ tier: undefined, hint: `model=${WIRE_MODEL}` },
	{ tier: "priority", hint: `model=${WIRE_MODEL};tier=priority` },
	{ tier: "flex", hint: `model=${WIRE_MODEL};tier=flex` },
];

describe("an HTTP Codex turn states the model and tier its body sends", () => {
	for (const { tier, hint } of TIERS) {
		it(`sends ${hint} for service tier ${tier ?? "none"}`, async () => {
			const host = codexHost();
			const result = await streamOpenAICodexResponses(daybreakModel(), turnContext(), {
				apiKey: codexToken(),
				fetch: host.fetch,
				serviceTier: tier,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(host.sent).toHaveLength(1);
			expect(host.sent[0]?.body.model).toBe(WIRE_MODEL);
			expect(host.sent[0]?.body.access_programs).toEqual({ cyber: "daybreak_blue" });
			expect(host.sent[0]?.headers.get(ROUTING_HINT)).toBe(hint);
			expectEveryRequestStatesItsBody(host.sent);
		});
	}

	it("replaces a caller's hint that states another model", async () => {
		const host = codexHost();
		await streamOpenAICodexResponses(daybreakModel(), turnContext(), {
			apiKey: codexToken(),
			fetch: host.fetch,
			headers: { [ROUTING_HINT]: "model=gpt-other" },
		}).result();

		expect(host.sent[0]?.headers.get(ROUTING_HINT)).toBe(`model=${WIRE_MODEL}`);
	});

	it("states the model an onPayload hook rewrote the body to", async () => {
		const host = codexHost();
		await streamOpenAICodexResponses(daybreakModel(), turnContext(), {
			apiKey: codexToken(),
			fetch: host.fetch,
			onPayload: payload => ({ ...(payload as Record<string, unknown>), model: "gpt-rewritten" }),
		}).result();

		expect(host.sent[0]?.body.model).toBe("gpt-rewritten");
		expect(host.sent[0]?.headers.get(ROUTING_HINT)).toBe("model=gpt-rewritten");
	});

	it("sends no hint, and no caller's, when the model is not a valid header value", async () => {
		const host = codexHost();
		await streamOpenAICodexResponses(daybreakModel("gpt-daybreak-\u00e9"), turnContext(), {
			apiKey: codexToken(),
			fetch: host.fetch,
			headers: { [ROUTING_HINT]: "model=gpt-other" },
		}).result();

		expect(host.sent[0]?.body.model).toBe("gpt-daybreak-\u00e9");
		expect(host.sent[0]?.headers.has(ROUTING_HINT)).toBe(false);
	});
});

describe("a websocket Codex turn states its model and tier on the upgrade", () => {
	for (const { tier, hint } of TIERS) {
		it(`opens the socket with ${hint} for service tier ${tier ?? "none"}`, async () => {
			const sockets = installCodexWebSocket();
			const host = codexHost();
			const result = await streamOpenAICodexResponses(daybreakModel(), turnContext(), {
				apiKey: codexToken(),
				fetch: host.fetch,
				sessionId: "routing-hint-ws",
				providerSessionState: new Map<string, ProviderSessionState>(),
				serviceTier: tier,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(host.sent).toHaveLength(0);
			expect(sockets).toHaveLength(1);
			expect(sockets[0]?.frames[0]?.model).toBe(WIRE_MODEL);
			expect(sockets[0]?.frames[0]?.service_tier).toBe(tier);
			expect(sockets[0]?.headers[ROUTING_HINT]).toBe(hint);
		});
	}

	it("states the model an onPayload hook rewrote the frame to", async () => {
		const sockets = installCodexWebSocket();
		await streamOpenAICodexResponses(daybreakModel(), turnContext(), {
			apiKey: codexToken(),
			fetch: codexHost().fetch,
			sessionId: "routing-hint-ws-hook",
			providerSessionState: new Map<string, ProviderSessionState>(),
			onPayload: payload => ({ ...(payload as Record<string, unknown>), model: "gpt-rewritten" }),
		}).result();

		expect(sockets[0]?.frames[0]?.model).toBe("gpt-rewritten");
		expect(sockets[0]?.headers[ROUTING_HINT]).toBe("model=gpt-rewritten");
	});

	it("opens the prewarmed socket with the hint of the turn that reuses it", async () => {
		const sockets = installCodexWebSocket();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const model = daybreakModel();
		await prewarmOpenAICodexResponses(model, {
			apiKey: codexToken(),
			sessionId: "routing-hint-prewarm",
			providerSessionState,
			serviceTier: "priority",
		});
		expect(sockets).toHaveLength(1);
		expect(sockets[0]?.headers[ROUTING_HINT]).toBe(`model=${WIRE_MODEL};tier=priority`);

		const result = await streamOpenAICodexResponses(model, turnContext(), {
			apiKey: codexToken(),
			fetch: codexHost().fetch,
			sessionId: "routing-hint-prewarm",
			providerSessionState,
			serviceTier: "priority",
		}).result();

		expect(result.stopReason).toBe("stop");
		// The turn rides the prewarmed socket, so the prewarm's upgrade is the only one the backend reads.
		expect(sockets).toHaveLength(1);
		expect(sockets[0]?.frames).toHaveLength(1);
		expect(sockets[0]?.headers[ROUTING_HINT]).toBe(hintFor(sockets[0]?.frames[0] ?? {}));
	});
});

describe("a Codex compaction states the model its body sends", () => {
	it("sends the wire model the compaction body names", async () => {
		const host = codexHost();
		await expect(
			openAIResponsesServerCompaction.compact({
				sessionId: "routing-hint-compaction",
				model: daybreakModel(),
				messages: [{ role: "user", content: "compact this span", timestamp: 1 }],
				apiKey: codexToken(),
				fetch: host.fetch,
			}),
		).rejects.toThrow("Server-side compaction is not available");

		expect(host.sent).toHaveLength(1);
		expect(host.sent[0]?.body.model).toBe(WIRE_MODEL);
		expect(host.sent[0]?.headers.get(ROUTING_HINT)).toBe(`model=${WIRE_MODEL}`);
		expectEveryRequestStatesItsBody(host.sent);
	});
});

describe("codexRoutingHint", () => {
	it("states the model, and the tier when the body sets one", () => {
		expect(codexRoutingHint({ model: "gpt-x" })).toBe("model=gpt-x");
		expect(codexRoutingHint({ model: "gpt-x", service_tier: "priority" })).toBe("model=gpt-x;tier=priority");
		expect(codexRoutingHint({ model: "gpt-x", service_tier: null })).toBe("model=gpt-x");
		expect(codexRoutingHint({ model: "gpt-x", service_tier: "" })).toBe("model=gpt-x");
	});

	it("is absent for a body that states no model or a value no header can carry", () => {
		expect(codexRoutingHint({})).toBeUndefined();
		expect(codexRoutingHint({ model: "" })).toBeUndefined();
		expect(codexRoutingHint({ model: 42 })).toBeUndefined();
		expect(codexRoutingHint({ model: "gpt-x\r\nx-injected: 1" })).toBeUndefined();
		expect(codexRoutingHint({ model: "gpt-x", service_tier: "priority\n" })).toBeUndefined();
		expect(codexRoutingHint({ model: "gpt-\u00e9" })).toBeUndefined();
		expect(codexRoutingHint({ model: "gpt-\u{1F680}" })).toBeUndefined();
	});
});
