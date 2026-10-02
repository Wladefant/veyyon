import { describe, expect, it } from "bun:test";
import {
	createOpenAICodexCompatibilityMetadata,
	getOpenAICodexTransportDetails,
	resetOpenAICodexHistoryAfterCompaction,
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
		metadataSession?.turnStates.set("compat-key-2", { value: "token-2" });
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

	it("preserves turn states during mid-turn compaction and clears on pre-turn compaction", () => {
		const providerSessionState = new Map();
		const sessionId = "turn-state-compaction-session";

		createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "turn",
			startNewTurn: true,
		});

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

		const codexState = providerSessionState.get("openai-codex-responses");
		const metadataSession = codexState?.metadataSessions.get(sessionId);
		expect(metadataSession).toBeDefined();
		metadataSession?.turnStates.set("compat-key", { value: "active-token" });

		// Mid-turn compaction resets history but preserves turn states for within-turn follow-up
		resetOpenAICodexHistoryAfterCompaction({
			sessionId,
			providerSessionState,
			compaction: {
				operationId: "mid-turn-op",
				phase: "mid_turn",
				strategy: "memento",
				trigger: "auto",
				reason: "context_limit",
				implementation: "responses",
			},
		});
		let details = getOpenAICodexTransportDetails(model, { sessionId, providerSessionState });
		expect(details.hasTurnState).toBe(true);

		// Pre-turn compaction resets turn states because the next turn starts fresh
		resetOpenAICodexHistoryAfterCompaction({
			sessionId,
			providerSessionState,
			compaction: {
				operationId: "pre-turn-op",
				phase: "pre_turn",
				strategy: "memento",
				trigger: "auto",
				reason: "context_limit",
				implementation: "responses",
			},
		});
		details = getOpenAICodexTransportDetails(model, { sessionId, providerSessionState });
		expect(details.hasTurnState).toBe(false);
	});
});
