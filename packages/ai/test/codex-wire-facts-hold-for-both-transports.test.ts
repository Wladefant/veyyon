import { describe, expect, it } from "bun:test";
import { toWebSocketUrl } from "@veyyon/ai/providers/openai-codex/websocket";
import {
	isCodexStreamProgressEvent,
	updateCodexSessionMetadataFromHeaders,
	wireInteger,
} from "@veyyon/ai/providers/openai-codex/wire";
import type { CodexWebSocketSessionState } from "@veyyon/ai/providers/openai-codex-responses";

/**
 * The Codex wire facts both transports read from one module: the WebSocket client and the SSE client
 * each record the turn-state and models-etag headers a response returns, count the same events as
 * stream progress, and coerce wire indexes the same way. A transport that read its own copy of one of
 * these drifted from the other the first time a header or an event type was added.
 *
 * Not covered here: the socket lifecycle itself (handshake joining, heartbeat, idle reuse), which the
 * stream suites drive through a real request.
 */
function freshSessionState(): CodexWebSocketSessionState {
	return {
		disableWebsocket: false,
		canAppend: false,
		fallbackCount: 0,
		prewarmed: false,
		stats: { fullContextRequests: 0, deltaRequests: 0, lastInputItems: 0 },
	};
}

describe("A Codex response's continuation headers are carried into the session", () => {
	it("records the turn state and models etag from a Headers object", () => {
		const state = freshSessionState();
		updateCodexSessionMetadataFromHeaders(
			state,
			new Headers({ "x-codex-turn-state": "turn-1", "x-models-etag": "etag-1" }),
		);
		expect(state.turnState).toBe("turn-1");
		expect(state.modelsEtag).toBe("etag-1");
	});

	it("records them from a plain header record, matching names case-insensitively", () => {
		const state = freshSessionState();
		updateCodexSessionMetadataFromHeaders(state, { "X-Codex-Turn-State": "turn-2", "X-Models-Etag": "etag-2" });
		expect(state.turnState).toBe("turn-2");
		expect(state.modelsEtag).toBe("etag-2");
	});

	it("keeps the previous values when a response omits or empties a header", () => {
		const state = freshSessionState();
		state.turnState = "turn-kept";
		state.modelsEtag = "etag-kept";
		updateCodexSessionMetadataFromHeaders(state, { "x-codex-turn-state": "" });
		expect(state.turnState).toBe("turn-kept");
		expect(state.modelsEtag).toBe("etag-kept");
	});
});

describe("Codex counts its own terminal events as stream progress", () => {
	it.each(["response.done", "response.incomplete", "response.output_text.delta"])("counts %s", type => {
		expect(isCodexStreamProgressEvent({ type })).toBe(true);
	});

	it.each([{ type: "codex.rate_limits" }, { type: 7 }, null, "response.done"])("does not count %p", event => {
		expect(isCodexStreamProgressEvent(event)).toBe(false);
	});
});

describe("A wire index is an integer or absent", () => {
	it.each([
		[3.9, 3],
		[-2.5, -2],
		[0, 0],
	])("truncates %p to %p", (raw, expected) => {
		expect(wireInteger(raw)).toBe(expected);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, "4", undefined])("drops %p", raw => {
		expect(wireInteger(raw)).toBeUndefined();
	});
});

describe("The Codex WebSocket endpoint is the HTTP endpoint on the socket scheme", () => {
	it.each([
		["https://chatgpt.com/backend-api/codex/responses", "wss://chatgpt.com/backend-api/codex/responses"],
		["http://127.0.0.1:8080/v1/responses?x=1", "ws://127.0.0.1:8080/v1/responses?x=1"],
		["wss://already.example/responses", "wss://already.example/responses"],
	])("maps %s to %s", (url, expected) => {
		expect(toWebSocketUrl(url)).toBe(expected);
	});
});
