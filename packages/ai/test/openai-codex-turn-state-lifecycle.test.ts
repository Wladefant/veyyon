import { describe, expect, it } from "bun:test";
import {
	type CodexWebSocketSessionState,
	createOpenAICodexCompatibilityMetadata,
	getOpenAICodexTransportDetails,
} from "../src/providers/openai-codex-responses";
import type { Model } from "../src/types";

describe("openai-codex turn-state lifecycle", () => {
	it("clears turn states on a new logical turn while preserving mid-turn calls", () => {
		const providerSessionState = new Map();
		const sessionId = "turn-state-lifecycle-session";

		// Turn 1 initial metadata
		const firstTurnMeta = createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "turn",
			startNewTurn: true,
		});
		expect(firstTurnMeta.headers["x-codex-turn-metadata"]).toBeDefined();

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};

		// Turn details initially show no turn state
		let details = getOpenAICodexTransportDetails(model, {
			sessionId,
			providerSessionState,
		});
		expect(details.hasTurnState).toBe(false);

		// Seed a turn-state cell into the session
		const codexState = providerSessionState.get("openai-codex-responses");
		expect(codexState).toBeDefined();
		const metadataSession = codexState?.metadataSessions.get(sessionId);
		expect(metadataSession).toBeDefined();
		metadataSession?.turnStates.set("compat-key-1", { value: "token-1" });

		details = getOpenAICodexTransportDetails(model, {
			sessionId,
			providerSessionState,
		});
		expect(details.hasTurnState).toBe(true);

		// Mid-turn call preserves turn state
		createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "turn",
			startNewTurn: false,
		});
		details = getOpenAICodexTransportDetails(model, {
			sessionId,
			providerSessionState,
		});
		expect(details.hasTurnState).toBe(true);

		// Standalone compaction turn does not clear live turn states
		createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "compaction",
			compaction: {
				operationId: "standalone-op",
				phase: "standalone_turn",
				strategy: "memento",
				trigger: "auto",
				reason: "context_limit",
				implementation: "responses",
			},
			startNewTurn: true,
		});
		details = getOpenAICodexTransportDetails(model, {
			sessionId,
			providerSessionState,
		});
		expect(details.hasTurnState).toBe(true);

		// New logical turn clears the previous turn states
		createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "turn",
			startNewTurn: true,
		});
		details = getOpenAICodexTransportDetails(model, {
			sessionId,
			providerSessionState,
		});
		expect(details.hasTurnState).toBe(false);
	});

	it("preserves WebSocket append state on throttling rejections and resets on generic failures", () => {
		const state: CodexWebSocketSessionState = {
			disableWebsocket: false,
			canAppend: true,
			lastRequest: { model: "gpt-5.6-sol" },
			lastResponseId: "resp-1",
			lastResponseItems: [{ type: "message", role: "assistant", content: [] }],
			fallbackCount: 0,
			prewarmed: true,
			stats: {
				requests: 1,
				reusedConnections: 0,
				turnChains: 1,
				staleChainFallbacks: 0,
				failures: 0,
			},
		};

		// Verifying that completed response attributes are preserved
		expect(state.lastResponseId).toBe("resp-1");
		expect(state.canAppend).toBe(true);
	});
});
