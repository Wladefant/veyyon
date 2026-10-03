import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import {
	createOpenAICodexCompatibilityMetadata,
	getOpenAICodexTransportDetails,
	resetOpenAICodexHistoryAfterCompaction,
} from "../src/providers/openai-codex-responses";

describe("openai-codex turn-state lifecycle", () => {
	const model = buildModel({
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
	});
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

		// Initially no turn state
		let details = getOpenAICodexTransportDetails(model, { sessionId, providerSessionState });
		expect(details.hasTurnState).toBe(false);

		// Seed compatibility-scoped turn-state cells into the session
		const codexState = providerSessionState.get("openai-codex-responses");
		expect(codexState).toBeDefined();
		const metadataSession = codexState?.metadataSessions.get(sessionId);
		expect(metadataSession).toBeDefined();
		metadataSession?.turnStates.set("compat-key-1", { value: "token-1" });
		metadataSession?.turnStates.set("compat-key-2", { value: "token-2" });

		details = getOpenAICodexTransportDetails(model, { sessionId, providerSessionState });
		expect(details.hasTurnState).toBe(true);

		// Mid-turn call preserves turn state
		createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "turn",
			startNewTurn: false,
		});
		details = getOpenAICodexTransportDetails(model, { sessionId, providerSessionState });
		expect(details.hasTurnState).toBe(true);

		// Standalone compaction turn does not clear live turn states
		createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "compaction",
			startNewTurn: true,
			compaction: {
				operationId: "comp-1",
				phase: "standalone_turn",
				strategy: "memento",
				trigger: "auto",
				reason: "context_limit",
				implementation: "responses",
			},
		});
		details = getOpenAICodexTransportDetails(model, { sessionId, providerSessionState });
		expect(details.hasTurnState).toBe(true);

		// New logical turn clears previous turn states
		createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "turn",
			startNewTurn: true,
		});
		details = getOpenAICodexTransportDetails(model, { sessionId, providerSessionState });
		expect(details.hasTurnState).toBe(false);
		expect(metadataSession?.turnStates.size).toBe(0);
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

		const codexState = providerSessionState.get("openai-codex-responses");
		const metadataSession = codexState?.metadataSessions.get(sessionId);
		expect(metadataSession).toBeDefined();
		metadataSession?.turnStates.set("compat-key", { value: "active-token" });

		const compaction = (phase: "mid_turn" | "pre_turn") => ({
			operationId: `${phase}-op`,
			phase,
			strategy: "memento" as const,
			trigger: "auto" as const,
			reason: "context_limit" as const,
			implementation: "responses" as const,
		});

		// Mid-turn compaction resets history but preserves turn states for within-turn follow-up
		resetOpenAICodexHistoryAfterCompaction({
			sessionId,
			providerSessionState,
			compaction: compaction("mid_turn"),
		});
		let details = getOpenAICodexTransportDetails(model, { sessionId, providerSessionState });
		expect(details.hasTurnState).toBe(true);

		// Pre-turn compaction resets turn states because the next turn starts fresh
		resetOpenAICodexHistoryAfterCompaction({
			sessionId,
			providerSessionState,
			compaction: compaction("pre_turn"),
		});
		details = getOpenAICodexTransportDetails(model, { sessionId, providerSessionState });
		expect(details.hasTurnState).toBe(false);
	});
});
