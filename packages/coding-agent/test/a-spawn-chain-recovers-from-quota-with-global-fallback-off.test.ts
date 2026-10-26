/** WHY: Quota failures must use the spawn's chain independently of global fallback.
 * Fake auth, registry and persistence boundaries keep this suite offline and in memory.
 * It covers cooldown selection and bounded retries, not SDK discovery or real accounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { AgentSessionEvent } from "../src/session/agent-session-types";
import { RetryRuntime, type RetrySession } from "../src/session/runtime/retry-runtime";
import { type StartupModelInputs, StartupModelSelection } from "../src/session/startup-model";
import { resolveAgentModel } from "../src/task/agent-settings";

const selectors = [
	"openai-codex/gpt-6-luna:medium",
	"google-antigravity/gemini-3.8-flash:high",
	"anthropic/claude-haiku-5-5:max",
];
const models = selectors.map(selector => {
	const [provider, id] = selector.split(":")[0].split("/");
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
});

function fixture(explicit = true, global = false) {
	const settings = Settings.isolated({
		"retry.modelFallback": global,
		"retry.maxDelayMs": 1,
		"retry.maxRetries": 1,
		"retry.baseDelayMs": 1,
		"retry.fallbackChains": { [selectors[0]]: selectors.slice(1), default: ["unrelated/model"] },
	});
	const cooldowns = new Map<string, number>();
	const events: AgentSessionEvent[] = [];
	const session = {
		agent: new Agent({ initialState: { model: models[0], messages: [], tools: [] } }),
		sessionManager: {
			appendModelChange: () => "change",
			getBranch: () => [],
		} as unknown as SessionManager,
		settings,
		modelRegistry: {
			find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
			getAll: () => models,
			getAvailable: () => models,
			getApiKey: async () => "fake-key",
			refreshSelectedModelMetadata: async model => model,
			authStorage: { markUsageLimitReached: async () => ({ switched: false }) },
			isSelectorSuppressed: (selector: string) => (cooldowns.get(selector.split(":")[0]) ?? 0) > Date.now(),
			suppressSelector: (selector: string, until: number) => cooldowns.set(selector.split(":")[0], until),
		} as unknown as ModelRegistry,
		model: models[0],
		thinkingLevel: undefined,
		modelPatternFallbackKey: explicit ? selectors[0] : undefined,
		sessionId: "fake-session",
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		operatorNotices: { warn: () => {} },
	} as unknown as RetrySession;
	const runtime = new RetryRuntime(session, {
		emitSessionEvent: async event => {
			events.push(event);
		},
		setModelWithProviderSessionReset: model => {
			Object.assign(session, { model });
		},
		promptGeneration: () => 0,
		scheduleAgentContinue: () => {},
		abortIsDeliberate: () => false,
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		removeAssistantMessageFromActiveContext: () => {},
		persistLifecycleErrorMessage: async () => {},
		resetSessionStopContinuationState: () => {},
	});
	return { runtime, session, events, settings, cooldowns };
}

function quota(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "fake",
		model: "fake",
		stopReason: "error",
		timestamp: 0,
		errorStatus: 429,
		errorMessage: "429 QUOTA_EXHAUSTED: usage limit reached. retry-after-ms=172800000",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("spawn quota fallback", () => {
	beforeEach(() => {
		vi.spyOn(AgentStorage, "forAgentDir").mockReturnValue(null);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([false, true])("walks the explicit chain and stops at its end (global=%s)", async global => {
		const { runtime, session, events } = fixture(true, global);
		try {
			for (const expected of models.slice(1)) {
				expect(await runtime.recoverFailedTurn(quota())).toBe(true);
				expect(session.model).toBe(expected);
			}
			expect(await runtime.recoverFailedTurn(quota())).toBe(false);
			expect(events.filter(event => event.type === "retry_fallback_applied").map(event => event.to)).toEqual(
				selectors.slice(1),
			);
			expect(runtime.isRetrying).toBe(false);
		} finally {
			runtime.abort();
		}
	});

	it.each([[], ["unavailable/full-model"]])("keeps a resolved explicit list closed when no tail resolves (%j)", async tail => {
		const { runtime, session, settings, events } = fixture(false, true);
		try {
			const selection = await StartupModelSelection.begin({
				options: { modelPattern: [selectors[0], ...tail], modelPatternFallbackChain: true },
				settings,
				modelRegistry: session.modelRegistry,
				sessionManager: session.sessionManager,
				existingSession: {} as StartupModelInputs["existingSession"],
				hasExistingSession: false,
				hasThinkingEntry: false,
			});
			await selection.completeAfterExtensions();
			Object.assign(session, { model: selection.model, modelPatternFallbackKey: selection.modelPatternFallbackKey });
			expect(await runtime.recoverFailedTurn(quota())).toBe(false);
			expect(session.model).toBe(models[0]);
			expect(events.filter(event => event.type === "retry_fallback_applied")).toEqual([]);
		} finally {
			runtime.abort();
		}
	});

	it.each([false, true])("keeps an empty or missing explicit chain closed before global Flash (missing=%s)", async missing => {
		const { runtime, session, settings, events } = fixture(true, true);
		settings.override("retry.fallbackChains", {
			...(missing ? {} : { [selectors[0]]: [] }),
			"openai-codex/*": [selectors[1]],
			default: [selectors[1]],
		});
		try {
			expect(await runtime.recoverFailedTurn(quota())).toBe(false);
			expect(session.model).toBe(models[0]);
			expect(events.filter(event => event.type === "retry_fallback_applied")).toEqual([]);
			expect(runtime.isRetrying).toBe(false);
		} finally {
			runtime.abort();
		}
	});

	it("does not enable inherited chains for a session without an explicit list", async () => {
		const { runtime, session } = fixture(false);
		try {
			expect(await runtime.recoverFailedTurn(quota())).toBe(false);
			expect(session.model).toBe(models[0]);
		} finally {
			runtime.abort();
		}
	});

	it("starts new spawns on the healthy tail after both pools return quota errors", async () => {
		const { runtime, session, cooldowns } = fixture();
		try {
			await runtime.recoverFailedTurn(quota());
			await runtime.recoverFailedTurn(quota());
			const settings = Settings.isolated({ "agent.agents": { "qa-verifier": { model: selectors } } });
			for (let index = 0; index < 20; index++) {
				const resolved = resolveAgentModel({
					settings,
					agentName: "qa-verifier",
					spawnId: `quota-${index}`,
					modelRegistry: session.modelRegistry,
				});
				expect(resolved.patterns[0]).toBe(selectors[2]);
			}
			cooldowns.clear();
			const healthyFirst = new Set<string>();
			for (let index = 0; index < 100; index++) {
				healthyFirst.add(
					resolveAgentModel({
						settings,
						agentName: "qa-verifier",
						spawnId: `quota-${index}`,
						modelRegistry: session.modelRegistry,
					}).patterns[0],
				);
			}
			expect([...healthyFirst].sort()).toEqual(selectors.slice(0, 2).sort());
		} finally {
			runtime.abort();
		}
	});

	it("backtests the recorded Cloud Code Assist quota response without global fallback", async () => {
		const { runtime, session, settings } = fixture();
		Object.assign(session, { model: models[1] });
		Object.assign(session, { modelPatternFallbackKey: selectors[1] });
		settings.override("retry.fallbackChains", { [selectors[1]]: [selectors[2]] });
		const message = quota();
		message.api = "google-gemini-cli";
		message.errorId = 659456;
		message.errorMessage = `Cloud Code Assist API error (429): ${JSON.stringify({
			error: {
				code: 429,
				status: "RESOURCE_EXHAUSTED",
				message: "Individual quota reached. Resets in 30h46m49s.",
				details: [
					{
						"@type": "type.googleapis.com/google.rpc.ErrorInfo",
						reason: "QUOTA_EXHAUSTED",
						metadata: { quotaResetDelay: "30h46m49.374072376s" },
					},
					{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "110809.374072376s" },
				],
			},
		})}`;
		try {
			expect(await runtime.recoverFailedTurn(message)).toBe(true);
			expect(session.model).toBe(models[2]);
		} finally {
			runtime.abort();
		}
	});
});
