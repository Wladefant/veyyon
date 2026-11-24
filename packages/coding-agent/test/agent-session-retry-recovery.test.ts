/**
 * A failed turn is retried, recovered or ended by the retry ladder.
 *
 * Subject: `session/runtime/retry-runtime.ts`, driven through `AgentSession`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { ApiKeyResolveContext, AssistantMessage, AssistantRetryRecovery } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as envApiKeyModule from "@veyyon/ai/env-api-key";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import type { Model } from "@veyyon/ai/types";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resolveAssistantErrorPresentation } from "@veyyon/coding-agent/presentation/transcript-builder";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent, ScheduledAgentContinueOptions } from "@veyyon/coding-agent/session/agent-session-types";
import { SILENT_ABORT_MARKER } from "@veyyon/coding-agent/session/messages";
import { PostPromptTasks } from "@veyyon/coding-agent/session/runtime/post-prompt-tasks";
import { type RetryHost, RetryRuntime, type RetrySession } from "@veyyon/coding-agent/session/runtime/retry-runtime";
import { TurnContinuations } from "@veyyon/coding-agent/session/runtime/turn-continuations";
import type { SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { requireBundledModel } from "../../agent/test/helpers";
import { createCodexTestToken } from "../../ai/test/helpers";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

type RecoveryRun = {
	session: AgentSession;
	sessionManager: SessionManager;
	retryEndEvents: AutoRetryEndEvent[];
	requestedKeys: string[];
};

const RATE_LIMIT_ERROR =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=11180000';
const RETRIABLE_SERVER_ERROR = "503 service unavailable: overloaded_error";

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function retryRecovery(recovery: AssistantRetryRecovery["recovery"], note: string): AssistantRetryRecovery {
	return {
		kind: "auto-retry",
		status: "recovered",
		attempt: 1,
		recoveredAt: "2026-07-04T00:00:00.000Z",
		recovery,
		note,
	};
}

function resolveInitialApiKey(
	apiKey: string | ((ctx: ApiKeyResolveContext) => string | Promise<string | undefined> | undefined) | undefined,
): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	if (typeof resolved !== "string") {
		throw new Error("Expected API key to be resolved before streaming");
	}
	return resolved;
}

interface AssistantEntry {
	entry: SessionMessageEntry;
	message: AssistantMessage;
}

function assistantEntries(sessionManager: SessionManager): AssistantEntry[] {
	const result: AssistantEntry[] = [];
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		result.push({ entry, message });
	}
	return result;
}

function recoveredAssistantEntry(sessionManager: SessionManager): AssistantEntry {
	const found = assistantEntries(sessionManager).find(
		candidate => candidate.message.retryRecovery?.status === "recovered",
	);
	if (!found) {
		throw new Error("Expected a recovered assistant entry");
	}
	return found;
}

function successfulAssistantEntry(sessionManager: SessionManager, text: string): AssistantEntry {
	const found = assistantEntries(sessionManager).find(candidate =>
		candidate.message.content.some(block => block.type === "text" && block.text === text),
	);
	if (!found) {
		throw new Error(`Expected successful assistant entry containing ${text}`);
	}
	return found;
}

/**
 * Yield in real time until `predicate` holds. Fake timers do not move `node:timers/promises`, so this
 * is how a fake-timer test waits for the session to reach a state without advancing the clock.
 */
async function waitUntil(predicate: () => boolean, attempts = 500): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return;
		await scheduler.wait(1);
	}
	throw new Error("Timed out waiting for the retry state under test");
}

interface RetryFixture {
	runtime: RetryRuntime;
	messages: AgentMessage[];
	events: AgentSessionEvent[];
	scheduled: ScheduledAgentContinueOptions[];
}

/**
 * A RetryRuntime with the real retry settings and settlement logic. No model is active, so no
 * fallback chain or provider is consulted. `continuationScheduler`, when given, handles each
 * continuation in place of the fixture's record of it.
 */
function createRetryFixture(continuationScheduler?: (options: ScheduledAgentContinueOptions) => void): RetryFixture {
	const messages: AgentMessage[] = [];
	const events: AgentSessionEvent[] = [];
	const scheduled: ScheduledAgentContinueOptions[] = [];
	const session = {
		agent: { state: { messages }, appendMessage: () => {}, replaceMessages: () => {} },
		sessionManager: { getBranch: () => [] },
		settings: Settings.isolated({
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 3,
		}),
		modelRegistry: undefined,
		model: undefined,
		thinkingLevel: undefined,
		sessionId: "retry-fixture",
		operatorNotices: { warn: () => {} },
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
	} as unknown as RetrySession;
	const host: RetryHost = {
		emitSessionEvent: async event => {
			events.push(event);
		},
		promptGeneration: () => 0,
		scheduleAgentContinue: options => {
			if (!options) throw new Error("Retry continuations always carry options");
			scheduled.push(options);
			continuationScheduler?.(options);
		},
		abortIsDeliberate: () => false,
		setModelWithProviderSessionReset: () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		removeAssistantMessageFromActiveContext: () => {},
		persistLifecycleErrorMessage: async () => {},
		resetSessionStopContinuationState: () => {},
	};
	return { runtime: new RetryRuntime(session, host), messages, events, scheduled };
}

describe("AgentSession retry recovery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let managers: SessionManager[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-recovery-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		vi.spyOn(envApiKeyModule, "getEnvApiKey").mockReturnValue(undefined);
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		sessions = [];
		managers = [];
	});

	afterEach(async () => {
		for (const activeSession of sessions.splice(0).reverse()) {
			await activeSession.dispose();
		}
		for (const manager of managers.splice(0).reverse()) {
			await manager.close();
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});
	it("settles a Codex fallback stall without replaying a tool or blocking another session", async () => {
		const primary = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const codex = requireBundledModel("openai-codex", "gpt-5.6-sol") as Model<"openai-codex-responses">;
		const next = requireBundledModel("openai", "gpt-4o-mini");
		const token = createCodexTestToken();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai-codex", token);
		authStorage.setRuntimeApiKey("openai", "test-key");
		const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
		const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call_record", name: "record", arguments: {} }] },
				{ throw: RETRIABLE_SERVER_ERROR },
				{ content: ["Recovered after Codex timed out"] },
			],
		});
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "Recorded" }],
			details: {},
		}));
		const fetchAttempt = vi.fn(async () => new Response(null, { status: 418 }));
		const agent = new Agent({
			getApiKey: model => (model.provider === "openai-codex" ? token : "test-key"),
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [
					{
						name: "record",
						label: "Record",
						description: "Record the result once",
						parameters: type({}),
						execute,
					},
				],
			},
			streamFn: (model, context, options) =>
				model.provider === "openai-codex"
					? streamOpenAICodexResponses(codex, context, {
							...options,
							apiKey: token,
							preferWebsockets: false,
							streamFirstEventTimeoutMs: 10,
							fetch: fetchAttempt,
							onPayload: () => {
								markStarted();
								return blocked;
							},
						})
					: mock.stream(model, context, options),
		});
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.fallbackChains": { "anthropic/*": [`${codex.provider}/${codex.id}`, `${next.provider}/${next.id}`] },
			}),
		});
		sessions.push(session);
		const retryEnds: boolean[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event.success);
		});
		const unrelatedMock = createMockModel({ responses: [{ content: ["Independent turn completed"] }] });
		const unrelated = new AgentSession({
			agent: new Agent({
				initialState: { model: primary, systemPrompt: ["Test"], tools: [] },
				getApiKey: () => "test-key",
				streamFn: (model, context, options) => unrelatedMock.stream(model, context, options),
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(unrelated);
		vi.useFakeTimers();
		try {
			const pending = session.prompt("Record once and report the result");
			expect(await Promise.race([started.then(() => true), scheduler.wait(1500).then(() => false)])).toBe(true);
			expect(session.heartbeatPhase).toBe("provider");
			await unrelated.prompt("Answer independently");
			expect(unrelated.messages.at(-1)).toMatchObject({ stopReason: "stop" });
			vi.advanceTimersByTime(10);
			const outcome = await Promise.race([pending.then(() => "settled"), scheduler.wait(500).then(() => "pending")]);
			expect(outcome).toBe("settled");
			expect(retryEnds).toEqual([true]);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(fetchAttempt).not.toHaveBeenCalled();
			expect(successfulAssistantEntry(sessionManager, "Recovered after Codex timed out").message.stopReason).toBe(
				"stop",
			);
		} finally {
			release();
			vi.useRealTimers();
		}
	});

	it("settles a pending Codex fallback credential at its setup deadline and never resurrects it", async () => {
		const primary = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const codex = requireBundledModel("openai-codex", "gpt-5.6-sol") as Model<"openai-codex-responses">;
		const next = requireBundledModel("openai", "gpt-4o-mini");
		const token = createCodexTestToken();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai-codex", token);
		authStorage.setRuntimeApiKey("openai", "test-key");
		// The Codex credential is still being resolved when the fallback is chosen. It stays pending
		// until the test releases it, so only the setup deadline can settle the turn.
		const credentialHold = Promise.withResolvers<string>();
		let codexCredentialRequests = 0;
		const codexStreams = vi.fn();
		const mock = createMockModel({
			responses: [{ throw: RETRIABLE_SERVER_ERROR }, { content: ["Recovered on the next fallback"] }],
		});
		const agent = new Agent({
			getApiKey: model => {
				if (model.provider !== "openai-codex") return "test-key";
				codexCredentialRequests += 1;
				return credentialHold.promise;
			},
			initialState: { model: primary, systemPrompt: ["Test"], tools: [] },
			streamFn: (model, context, options) => {
				if (model.provider === "openai-codex") {
					codexStreams();
					throw new Error("the stalled Codex target must not be invoked");
				}
				return mock.stream(model, context, options);
			},
		});
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			modelRegistry,
			// No same-model retry: the first failure goes straight to the fallback chain.
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 0,
				"retry.fallbackChains": { "anthropic/*": [`${codex.provider}/${codex.id}`, `${next.provider}/${next.id}`] },
			}),
		});
		sessions.push(session);
		const retryEnds: AutoRetryEndEvent[] = [];
		const appliedFallbacks: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
			if (event.type === "retry_fallback_applied") appliedFallbacks.push(event.to);
		});
		vi.useFakeTimers();
		try {
			const pending = session.prompt("Answer once the fallback can serve it");
			await waitUntil(() => codexCredentialRequests === 1);
			// One millisecond short of the setup deadline the stalled credential still holds the turn.
			vi.advanceTimersByTime(299_999);
			expect(await Promise.race([pending.then(() => "settled"), scheduler.wait(50).then(() => "pending")])).toBe(
				"pending",
			);
			expect(codexStreams).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			const outcome = await Promise.race([pending.then(() => "settled"), scheduler.wait(500).then(() => "pending")]);
			expect(outcome).toBe("settled");
			expect(codexStreams).not.toHaveBeenCalled();
			expect(mock.calls).toHaveLength(2);
			expect(retryEnds).toEqual([expect.objectContaining({ success: true })]);
			expect(appliedFallbacks).toEqual([`${codex.provider}/${codex.id}`, `${next.provider}/${next.id}`]);
			expect(successfulAssistantEntry(sessionManager, "Recovered on the next fallback").message.stopReason).toBe(
				"stop",
			);
			const settledEntries = assistantEntries(sessionManager).length;

			// A late answer from the abandoned credential must not start a Codex turn or a second recovery.
			credentialHold.resolve(token);
			await scheduler.wait(10);
			vi.advanceTimersByTime(1_000);
			await scheduler.wait(10);
			expect(codexStreams).not.toHaveBeenCalled();
			expect(mock.calls).toHaveLength(2);
			expect(retryEnds).toHaveLength(1);
			expect(assistantEntries(sessionManager)).toHaveLength(settledEntries);
		} finally {
			credentialHold.resolve(token);
			vi.useRealTimers();
		}
	});

	it("releases the retry gate when the scheduler skips its continuation", async () => {
		const continueAgent = vi.fn(async () => {});
		const continuations = new TurnContinuations(new PostPromptTasks({ promptGeneration: () => 0 }), {
			agent: {
				continue: continueAgent,
				waitForIdle: async () => {},
				state: { isStreaming: false },
			},
			promptGeneration: () => 0,
			unavailable: () => true,
			disposed: () => false,
			beginTurn: () => {},
			endTurn: () => {},
			restoreFallbackPrimary: async () => {},
			retryGate: () => undefined,
			ttsrResume: () => undefined,
			releaseTtsrResume: () => {},
			postCompactionNudges: () => [],
			promptWith: async () => {},
		});
		const fixture = createRetryFixture(options => continuations.scheduleContinue(options));
		const message = assistantMessage({ stopReason: "error", errorMessage: RETRIABLE_SERVER_ERROR });
		expect(await fixture.runtime.recoverFailedTurn(message)).toBe(true);
		const gate = fixture.runtime.gate;
		if (!gate) throw new Error("Expected a retry gate before the scheduled continuation");
		expect(await Promise.race([gate.then(() => "released"), scheduler.wait(500).then(() => "held")])).toBe(
			"released",
		);
		expect(continueAgent).not.toHaveBeenCalled();
		expect(fixture.events).toEqual([
			expect.objectContaining({ type: "auto_retry_start" }),
			expect.objectContaining({
				type: "auto_retry_end",
				success: false,
				finalError: expect.stringContaining("Retry continuation skipped: session-unavailable"),
			}),
		]);
		expect(fixture.runtime.isRetrying).toBe(false);
	});

	it("keeps a newer retry gate when an older continuation is skipped after it was created", async () => {
		const fixture = createRetryFixture();
		const message = assistantMessage({ stopReason: "error", errorMessage: RETRIABLE_SERVER_ERROR });
		expect(await fixture.runtime.recoverFailedTurn(message)).toBe(true);
		const staleSkip = fixture.scheduled.at(-1)?.onSkip;
		const firstGate = fixture.runtime.gate;
		expect(staleSkip).toBeDefined();
		expect(firstGate).toBeDefined();

		// The first turn settles and releases its gate. A newer failure then holds a gate of its own.
		fixture.runtime.resolve();
		expect(await fixture.runtime.recoverFailedTurn(message)).toBe(true);
		const newerGate = fixture.runtime.gate;
		if (!newerGate) throw new Error("Expected the newer failure to hold a retry gate");
		expect(newerGate).not.toBe(firstGate);
		// The older continuation is skipped only now. Its skip must not release the newer gate.
		staleSkip?.("stale-generation");
		expect(fixture.runtime.gate).toBe(newerGate);
		expect(fixture.runtime.isRetrying).toBe(true);
		expect(await Promise.race([newerGate.then(() => "released"), scheduler.wait(10).then(() => "held")])).toBe(
			"held",
		);
		expect(fixture.events.map(event => event.type)).toEqual(["auto_retry_start", "auto_retry_start"]);
		fixture.runtime.resolve();
	});

	async function runCredentialRecovery(): Promise<RecoveryRun> {
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");

		// This run is ABOUT moving between two credentials of one provider, which is
		// `accounts.loadBalancing`, and that ships OFF: the account selected is the account that
		// spends. So the movement is opted into explicitly, on a storage rebuilt for it, rather than
		// inherited from a default this suite neither sets nor controls.
		authStorage.close();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "balanced-auth.db"), { loadBalancing: true });
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		authStorage.removeRuntimeApiKey("anthropic");
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
		]);

		const mock = createMockModel();
		const requestedKeys: string[] = [];
		let agent!: Agent;
		agent = new Agent({
			getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const apiKey = resolveInitialApiKey(options?.apiKey);
				requestedKeys.push(apiKey);
				if (requestedKeys.length === 1) {
					mock.push({ throw: RATE_LIMIT_ERROR });
				} else {
					mock.push({ content: ["recovered after credential switch"], stopReason: "stop" });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
		});
		settings.setDefaultModel(`${model.provider}/${model.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger account rate limit recovery");
		await session.waitForIdle();
		await sessionManager.flush();

		return { session, sessionManager, retryEndEvents, requestedKeys };
	}

	it("marks a recovered retry error, emits it, persists it, and excludes only model-context replay", async () => {
		const { sessionManager, retryEndEvents, requestedKeys } = await runCredentialRecovery();

		expect(new Set(requestedKeys)).toEqual(new Set(["anthropic-key-1", "anthropic-key-2"]));
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(retryEndEvents[0].recoveredErrors).toHaveLength(1);

		const recoveredEntry = recoveredAssistantEntry(sessionManager);
		const successfulEntry = successfulAssistantEntry(sessionManager, "recovered after credential switch");
		const recoveredEvent = retryEndEvents[0].recoveredErrors?.[0];
		if (!recoveredEvent) {
			throw new Error("Expected a recovered error payload on auto_retry_end");
		}
		const recoveredMarker = recoveredEntry.message.retryRecovery;
		if (!recoveredMarker) {
			throw new Error("Expected recovered marker on superseded assistant message");
		}
		expect(recoveredEvent.entryId).toBe(recoveredEntry.entry.id);
		expect(recoveredEvent.persistenceKey).toBeString();
		expect(recoveredEvent.note).toBe("rate-limited; switched account; retried");
		expect(recoveredEvent.retryRecovery).toEqual(recoveredMarker);
		expect(recoveredEntry.message.stopReason).toBe("error");
		expect(recoveredEntry.message.retryRecovery).toMatchObject({
			kind: "auto-retry",
			status: "recovered",
			attempt: 1,
			recovery: "credential",
			note: "rate-limited; switched account; retried",
			supersededBy: {
				provider: successfulEntry.message.provider,
				model: successfulEntry.message.model,
				timestamp: successfulEntry.message.timestamp,
			},
		});
		expect(Date.parse(recoveredEntry.message.retryRecovery?.recoveredAt ?? "")).not.toBeNaN();

		const modelContext = sessionManager.buildSessionContext();
		// See the reload case below for why a `custom` message leads the turn.
		expect(modelContext.messages.map(message => message.role)).toEqual(["custom", "user", "assistant"]);
		expect(
			modelContext.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(modelContext.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered after credential switch" }],
		});

		const transcriptContext = sessionManager.buildSessionContext({ transcript: true });
		expect(transcriptContext.messages.map(message => message.role)).toEqual([
			"custom",
			"user",
			"assistant",
			"assistant",
		]);
		expect(
			transcriptContext.messages.some(
				message => message.role === "assistant" && message.retryRecovery?.status === "recovered",
			),
		).toBe(true);
	});

	it("leaves exhausted retries as terminal errors without recovery presentation", async () => {
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");

		const mock = createMockModel({
			responses: [{ throw: RETRIABLE_SERVER_ERROR }, { throw: RETRIABLE_SERVER_ERROR }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setDefaultModel(`${model.provider}/${model.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Exhaust retry attempts");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false, attempt: 1 });
		expect(retryEndEvents[0].recoveredErrors).toBeUndefined();

		const terminalError = assistantEntries(sessionManager).at(-1)?.message;
		if (!terminalError) {
			throw new Error("Expected a terminal assistant error entry");
		}
		const terminalErrorText = terminalError.errorMessage;
		if (!terminalErrorText) {
			throw new Error("Expected a terminal assistant errorMessage");
		}
		expect(terminalError).toMatchObject({ role: "assistant", stopReason: "error" });
		expect(terminalError.retryRecovery).toBeUndefined();
		expect(resolveAssistantErrorPresentation(terminalError)).toEqual({
			kind: "full",
			text: terminalErrorText,
			isError: true,
		});
	});

	it("maps assistant error presentation for recovered, unrecovered, and silent abort turns", () => {
		const recoveredCases: Array<{
			name: string;
			recovery: AssistantRetryRecovery["recovery"];
			note: string;
		}> = [
			{ name: "credential", recovery: "credential", note: "rate-limited; switched account; retried" },
			{ name: "model", recovery: "model", note: "rate-limited; switched model; retried" },
			{ name: "wait", recovery: "wait", note: "rate-limited; waited; retried" },
			{ name: "plain", recovery: "plain", note: "error; retried" },
		];

		for (const testCase of recoveredCases) {
			expect(
				resolveAssistantErrorPresentation(
					assistantMessage({
						stopReason: "error",
						errorMessage: `${testCase.name} retry was superseded`,
						retryRecovery: retryRecovery(testCase.recovery, testCase.note),
					}),
				),
			).toEqual({ kind: "compact-recovered", text: testCase.note, isError: false });
		}

		expect(
			resolveAssistantErrorPresentation(
				assistantMessage({ stopReason: "error", errorMessage: "503 service unavailable" }),
			),
		).toEqual({ kind: "full", text: "503 service unavailable", isError: true });
		expect(
			resolveAssistantErrorPresentation(
				assistantMessage({ stopReason: "aborted", errorMessage: SILENT_ABORT_MARKER }),
			),
		).toEqual({ kind: "none" });
	});

	it("keeps recovered markers durable across session reload and still excludes them from model context", async () => {
		const { sessionManager } = await runCredentialRecovery();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected recovery run to persist a session file");
		}

		const reloadedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"), undefined, {
			suppressBreadcrumb: true,
		});
		managers.push(reloadedManager);
		const recoveredEntry = recoveredAssistantEntry(reloadedManager);
		expect(recoveredEntry.message.retryRecovery).toMatchObject({
			kind: "auto-retry",
			status: "recovered",
			recovery: "credential",
			note: "rate-limited; switched account; retried",
		});

		const modelContext = reloadedManager.buildSessionContext();
		// The leading `custom` message is the per-turn session-state line (date and
		// working directory). It became part of the conversation when the working
		// directory left the cached prompt prefix, so the model context of any real
		// turn carries one ahead of the question. What this case is about is the
		// recovered error assistant, which is still absent.
		expect(modelContext.messages.map(message => message.role)).toEqual(["custom", "user", "assistant"]);
		expect(
			modelContext.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(modelContext.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered after credential switch" }],
		});
	});
});
