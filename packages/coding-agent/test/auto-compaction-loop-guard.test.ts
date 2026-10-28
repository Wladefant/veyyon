import { describe, expect, it } from "bun:test";
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type AssistantMessage,
	type ToolResultMessage,
	type UserMessage,
} from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent, ContextUsageBreakdown } from "@veyyon/coding-agent/session/agent-session-types";
import {
	CompactionRuntime,
	type CompactionHost,
	type CompactionSession,
} from "@veyyon/coding-agent/session/runtime/compaction-runtime";
import { COMPACTION_CHECK_NONE } from "@veyyon/kernel/session/agent-session-compaction-policy";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { type } from "arktype";

function createMockModel(overrides?: Partial<Model<"openai-responses">>): Model<"openai-responses"> {
	return buildModel({
		id: "mock-model",
		name: "Mock Model",
		provider: "openai-responses",
		contextWindow: 128000,
		...overrides,
	});
}

function createTool(name: string, options?: { loadMode?: "essential" | "discoverable"; mcpServer?: string }): AgentTool {
	const schema = type({ value: "string" });
	return {
		name,
		description: `Tool ${name}`,
		parameters: schema,
		loadMode: options?.loadMode,
		mcpServer: options?.mcpServer,
		execute: async () => ({ content: [{ type: "text", text: `result from ${name}` }] }),
	};
}

function userText(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function assistantWithToolCall(toolName: string, callId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: callId,
				name: toolName,
				arguments: { value: "test" },
			},
		],
		timestamp: Date.now(),
	};
}

function toolResult(callId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details: undefined,
		isError: false,
		timestamp: Date.now(),
	};
}

interface TestHarnessState {
	model: Model;
	sessionId: string;
	branchLength: number;
	currentTokens: number;
	breakdown: ContextUsageBreakdown | undefined;
	notices: Array<{ level: string; message: string; category?: string }>;
	emittedEvents: AgentSessionEvent[];
	pruneCallCount: number;
	prunedMessages: readonly AgentMessage[] | undefined;
	promptGeneration: number;
}

function createCompactionRuntimeHarness(
	initialTokens = 115000,
	contextWindow = 128000,
	options: {
		seedBranch?: boolean;
		failCompaction?: boolean;
		pruneBreakdown?: ContextUsageBreakdown;
	} = {},
) {
	const state: TestHarnessState = {
		model: createMockModel({ contextWindow }),
		sessionId: "test-session-1",
		branchLength: 10,
		currentTokens: initialTokens,
		breakdown: undefined,
		notices: [],
		emittedEvents: [],
		pruneCallCount: 0,
		prunedMessages: undefined,
		promptGeneration: 1,
	};

	const sessionManager = SessionManager.inMemory();
	if (options.seedBranch !== false) {
		sessionManager.appendMessage({
			role: "user",
			content: "Investigate repository history",
			timestamp: 1000,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "history payload\n".repeat(6000) }],
			timestamp: 2000,
		});
		sessionManager.appendMessage({
			role: "user",
			content: "next step",
			timestamp: 3000,
		});
	}
	const agent = new Agent({
		initialState: {
			model: state.model,
			systemPrompt: ["test system prompt"],
			messages: [],
			tools: [],
		},
	});

	const settings = Settings.isolated({
		"compaction.enabled": true,
		"compaction.threshold": "100000",
		"compaction.keepRecentTokens": 10000,
	});
	const extensionRunner = {
		hasHandlers: (event: string) => event === "session_before_compact",
		emit: async (event: { type: string; preparation?: { firstKeptEntryId?: string } }) => {
			if (options.failCompaction) {
				throw new Error("Compaction LLM summarization failed");
			}
			if (event.type === "session_before_compact" && event.preparation) {
				return {
					compaction: {
						summary: "test auto-compaction summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: 25000,
					},
				};
			}
			return undefined;
		},
	};

	const session: CompactionSession = {
		agent,
		sessionManager,
		settings,
		sessionId: state.sessionId,
		model: state.model,
		modelRegistry: {
			getAvailable: () => [state.model],
			find: () => state.model,
		} as never,
		thinkingLevel: undefined,
		extensionRunner: options.seedBranch === false ? undefined : (extensionRunner as never),
		dedupeRedundantToolResults: async () => ({ toolResultsDropped: 0, tokensFreed: 0 }),
		buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
		abort: async () => {},
		emitNotice: (level, message, category) => {
			state.notices.push({ level, message, category });
		},
		getContextUsage: () => ({
			tokens: state.currentTokens,
			contextWindow: state.model.contextWindow ?? 128000,
			percent: state.currentTokens / (state.model.contextWindow ?? 128000),
		}),
		pruneDiscoveredToolsAfterCompaction: async messages => {
			state.pruneCallCount++;
			state.prunedMessages = messages;
			if (options.pruneBreakdown) state.breakdown = options.pruneBreakdown;
		},
	};

	const host: CompactionHost = {
		emitSessionEvent: async event => {
			state.emittedEvents.push(event);
		},
		promptGeneration: () => state.promptGeneration,
		nonMessageTokens: () => 5000,
		nonMessageBreakdown: () => ({
			systemPromptTokens: 3000,
			systemContextTokens: 1000,
			skillsTokens: 500,
			toolsTokens: 500,
		}),
		estimateStoredContextTokens: () => Math.max(0, state.currentTokens - 5000),
		resetAllAdvisorRuntimes: () => {},
		afterHistoryCompacted: () => {},
		closeCodexProviderSessionsForHistoryRewrite: () => {},
		whileDisconnectedFromAgent: async run => run(),
		phaseChanged: () => {},
		scheduleAgentContinue: () => {},
		scheduleAutoContinuePrompt: () => {},
		secrets: () => ({} as never),
		convertToLlmForSideRequest: () => [],
		providerSessionState: () => ({} as never),
		effectiveServiceTier: () => undefined,
		baseSystemPrompt: () => "base",
		memoryBackendContext: async () => "",
		withPlanProtection: async (_c, fn) => fn(),
		promptCompaction: async () => undefined,
		offloadAndApplyShakeRegions: async () => {},
		rebasePendingContextSnapshotAfterHistoryRewrite: () => {},
	};

	const runtime = new CompactionRuntime(session, host);

	return { runtime, session, host, state, settings };
}

describe("CompactionRuntime auto-compaction loop guard (#685)", () => {
	it("arms loop guard when auto-compaction leaves context >= threshold and names dominant split", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000, {
			pruneBreakdown: {
				contextWindow: 128000,
				anchored: false,
				usedTokens: 105000,
				systemPromptTokens: 65000,
				systemContextTokens: 5000,
				skillsTokens: 2000,
				systemToolsTokens: 18000,
				messagesTokens: 15000,
			},
		});

		// The pre-prune snapshot makes history dominant; the prune callback replaces it
		// with a snapshot where the system prompt is dominant.
		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 10000,
			systemContextTokens: 5000,
			skillsTokens: 2000,
			systemToolsTokens: 18000,
			messagesTokens: 70000,
		};
		state.currentTokens = 105000;

		// Trigger an auto-compaction pass that completes successfully and evaluates the guard
		const outcome = await runtime.runAutoCompaction("threshold", false);
		expect(outcome).toBe(COMPACTION_CHECK_NONE);

		// Guard should now be armed and suppressing auto-compaction
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		// Exactly one warning notice was emitted naming "system prompt"
		const compactionWarnings = state.notices.filter(n => n.category === "compaction" && n.level === "warning");
		expect(compactionWarnings.length).toBe(1);
		expect(compactionWarnings[0].message).toContain("system prompt");
		expect(compactionWarnings[0].message).toContain("105,000");
		expect(compactionWarnings[0].message).toContain("100,000");
		expect(compactionWarnings[0].message).toContain("10,000");
	});

	it("arms the loop guard after a successful idle compaction", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000);
		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 65000,
			systemContextTokens: 5000,
			skillsTokens: 2000,
			systemToolsTokens: 18000,
			messagesTokens: 15000,
		};
		state.currentTokens = 105000;

		await runtime.runAutoCompaction("idle", false);

		expect(state.pruneCallCount).toBe(1);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);
		expect(state.notices.some(notice => notice.message.includes("system prompt"))).toBe(true);
	});

	it("identifies tool definitions as dominant split when tool tokens are largest", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(108000, 128000);

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 108000,
			systemPromptTokens: 10000,
			systemContextTokens: 2000,
			skillsTokens: 1000,
			systemToolsTokens: 80000,
			messagesTokens: 15000,
		};
		state.currentTokens = 108000;

		await runtime.runAutoCompaction("threshold", false);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		const compactionWarnings = state.notices.filter(n => n.category === "compaction" && n.level === "warning");
		expect(compactionWarnings.length).toBe(1);
		expect(compactionWarnings[0].message).toContain("tool definitions");
	});

	it("identifies history as dominant split when message tokens are largest", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(106000, 128000);

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 106000,
			systemPromptTokens: 10000,
			systemContextTokens: 2000,
			skillsTokens: 1000,
			systemToolsTokens: 15000,
			messagesTokens: 78000,
		};
		state.currentTokens = 106000;

		await runtime.runAutoCompaction("threshold", false);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		const compactionWarnings = state.notices.filter(n => n.category === "compaction" && n.level === "warning");
		expect(compactionWarnings.length).toBe(1);
		expect(compactionWarnings[0].message).toContain("history");
	});

	it("suppresses the second auto-compaction pass and emits no duplicate warning", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000);

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 70000,
			systemContextTokens: 0,
			skillsTokens: 0,
			systemToolsTokens: 15000,
			messagesTokens: 20000,
		};
		state.currentTokens = 105000;

		// First pass: arms the guard
		await runtime.runAutoCompaction("threshold", false);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);
		expect(state.notices.length).toBe(1);

		state.emittedEvents.length = 0;

		// Second pass: must be skipped early
		const secondOutcome = await runtime.runAutoCompaction("threshold", false);
		expect(secondOutcome).toBe(COMPACTION_CHECK_NONE);

		// Emitted skipped auto_compaction_end event
		const skippedEndEvents = state.emittedEvents.filter(
			e =>
				e.type === "auto_compaction_end" &&
				(("outcome" in e && e.outcome === "skipped") || ("skipped" in e && e.skipped === true)),
		);
		expect(skippedEndEvents.length).toBe(1);

		// No second warning notice emitted
		expect(state.notices.length).toBe(1);
	});

	it("remains suppressed while context grows below keepRecentTokens boundary and resumes at boundary", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000);

		// Post compaction size = 105,000, keepRecentTokens = 10,000 -> resume boundary = 115,000
		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 70000,
			systemContextTokens: 0,
			skillsTokens: 0,
			systemToolsTokens: 15000,
			messagesTokens: 20000,
		};
		state.currentTokens = 105000;

		await runtime.runAutoCompaction("threshold", false);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		// Context grows to 114,999 (strictly below boundary)
		state.breakdown = {
			...state.breakdown,
			usedTokens: 114999,
			messagesTokens: 29999,
		};
		state.currentTokens = 114999;
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		// Context reaches 115,000 (at or above boundary)
		state.breakdown = {
			...state.breakdown,
			usedTokens: 115000,
			messagesTokens: 30000,
		};
		state.currentTokens = 115000;

		// Suppression must be lifted
		expect(runtime.isAutoCompactionSuppressed()).toBe(false);
	});

	it("resets guard when model changes", async () => {
		const { runtime, state, session } = createCompactionRuntimeHarness(105000, 128000);

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 70000,
			systemContextTokens: 0,
			skillsTokens: 0,
			systemToolsTokens: 15000,
			messagesTokens: 20000,
		};
		state.currentTokens = 105000;

		await runtime.runAutoCompaction("threshold", false);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		// Switch model to a different model ID
		const newModel = createMockModel({ id: "mock-model-larger", contextWindow: 200000 });
		state.model = newModel;
		Object.defineProperty(session, "model", { value: newModel, writable: true });

		// Guard should immediately recognize model change and reset
		expect(runtime.isAutoCompactionSuppressed()).toBe(false);
	});

	it("resets guard when session switches", async () => {
		const { runtime, state, session } = createCompactionRuntimeHarness(105000, 128000);

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 70000,
			systemContextTokens: 0,
			skillsTokens: 0,
			systemToolsTokens: 15000,
			messagesTokens: 20000,
		};
		state.currentTokens = 105000;

		await runtime.runAutoCompaction("threshold", false);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		// Switch session id
		state.sessionId = "test-session-2";
		Object.defineProperty(session, "sessionId", { value: "test-session-2", writable: true });

		// Guard should reset on session switch
		expect(runtime.isAutoCompactionSuppressed()).toBe(false);
	});

	it("manual compact clears the auto-compaction guard", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000);

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 70000,
			systemContextTokens: 0,
			skillsTokens: 0,
			systemToolsTokens: 15000,
			messagesTokens: 20000,
		};
		state.currentTokens = 105000;

		await runtime.runAutoCompaction("threshold", false);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		// Explicit reset via manual compact call
		runtime.resetAutoCompactionGuard("manual_compact");
		expect(runtime.isAutoCompactionSuppressed()).toBe(false);
	});

	it("does not arm guard when post-compaction context falls below threshold", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(85000, 128000);

		// Post-compaction context is 85,000, which is strictly below the 100,000 threshold
		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 85000,
			systemPromptTokens: 30000,
			systemContextTokens: 0,
			skillsTokens: 0,
			systemToolsTokens: 15000,
			messagesTokens: 40000,
		};
		state.currentTokens = 85000;

		await runtime.runAutoCompaction("threshold", false);

		// Guard must not be armed
		expect(runtime.isAutoCompactionSuppressed()).toBe(false);
		expect(state.notices.length).toBe(0);
	});
	it("does not arm guard and produces no false completion warning when auto-compaction fails", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000, { failCompaction: true });

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 65000,
			systemContextTokens: 5000,
			skillsTokens: 2000,
			systemToolsTokens: 18000,
			messagesTokens: 15000,
		};
		state.currentTokens = 105000;

		const outcome = await runtime.runAutoCompaction("threshold", false);
		expect(outcome).toBe(COMPACTION_CHECK_NONE);

		// Failure path must NOT arm the guard
		expect(runtime.isAutoCompactionSuppressed()).toBe(false);

		// Failure path must NOT emit the "after compaction" warning notice
		const compactionWarnings = state.notices.filter(n => n.category === "compaction" && n.level === "warning");
		expect(compactionWarnings.length).toBe(0);

		// Emitted event reports failure, not successful compaction
		const failedEndEvents = state.emittedEvents.filter(
			e => e.type === "auto_compaction_end" && "errorMessage" in e && Boolean(e.errorMessage),
		);
		expect(failedEndEvents.length).toBe(1);
	});

	it("arms guard after successful compaction with post-compaction tool pruning when context remains >= threshold", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000);

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 65000,
			systemContextTokens: 5000,
			skillsTokens: 2000,
			systemToolsTokens: 18000,
			messagesTokens: 15000,
		};
		state.currentTokens = 105000;

		const outcome = await runtime.runAutoCompaction("threshold", false);
		expect(outcome).toBe(COMPACTION_CHECK_NONE);

		// Post-compaction tool pruning was called during #applyCompaction
		expect(state.pruneCallCount).toBeGreaterThan(0);

		// Guard is armed after successful compaction and post-pruning
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		// Warning notice is emitted
		const compactionWarnings = state.notices.filter(n => n.category === "compaction" && n.level === "warning");
		expect(compactionWarnings.length).toBe(1);
		expect(compactionWarnings[0].message).toContain("Automatic compaction is paused");
	});

	it("does not arm guard on no-op run when there is nothing to summarize", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000, { seedBranch: false });

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 65000,
			systemContextTokens: 5000,
			skillsTokens: 2000,
			systemToolsTokens: 18000,
			messagesTokens: 15000,
		};
		state.currentTokens = 105000;

		// No messages in branch -> prepareCompaction returns undefined (nothing to summarize)
		const outcome = await runtime.runAutoCompaction("threshold", false);
		expect(outcome).toBe(COMPACTION_CHECK_NONE);

		// No-op run must NOT arm the guard
		expect(runtime.isAutoCompactionSuppressed()).toBe(false);

		// No-op run must NOT emit the "after compaction" warning notice
		const compactionWarnings = state.notices.filter(n => n.category === "compaction" && n.level === "warning");
		expect(compactionWarnings.length).toBe(0);
	});

	it("retains existing armed guard when a subsequent pass has nothing to summarize", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000);

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 65000,
			systemContextTokens: 5000,
			skillsTokens: 2000,
			systemToolsTokens: 18000,
			messagesTokens: 15000,
		};
		state.currentTokens = 105000;

		// Successful compaction arms the guard
		await runtime.runAutoCompaction("threshold", false);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		// Subsequent pass is skipped due to guard
		const outcome = await runtime.runAutoCompaction("threshold", false);
		expect(outcome).toBe(COMPACTION_CHECK_NONE);
		// Guard remains armed and did not escape
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);
	});

	it("guard suppresses all automatic compaction reasons while armed", async () => {
		const { runtime, state } = createCompactionRuntimeHarness(105000, 128000);

		state.breakdown = {
			contextWindow: 128000,
			anchored: false,
			usedTokens: 105000,
			systemPromptTokens: 65000,
			systemContextTokens: 5000,
			skillsTokens: 2000,
			systemToolsTokens: 18000,
			messagesTokens: 15000,
		};
		state.currentTokens = 105000;

		await runtime.runAutoCompaction("threshold", false);
		expect(runtime.isAutoCompactionSuppressed()).toBe(true);

		// "overflow" reason must also be suppressed while guard is armed
		state.emittedEvents.length = 0;
		const overflowOutcome = await runtime.runAutoCompaction("overflow", false);
		expect(overflowOutcome).toBe(COMPACTION_CHECK_NONE);

		// "incomplete" reason must also be suppressed while guard is armed
		const incompleteOutcome = await runtime.runAutoCompaction("incomplete", false);
		expect(incompleteOutcome).toBe(COMPACTION_CHECK_NONE);
	});
});

describe("AgentSession tool pruning after compaction (#685)", () => {
	it("prunes uncalled discovered MCP tools and persists selection across compaction", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const mcpActive = createTool("mcp__s__active", { mcpServer: "s" });
		const mcpIdle = createTool("mcp__s__idle", { mcpServer: "s" });
		const localTool = createTool("custom_local", { loadMode: "discoverable" });

		const toolRegistry = new Map<string, AgentTool>([
			["read", readTool],
			["mcp__s__active", mcpActive],
			["mcp__s__idle", mcpIdle],
			["custom_local", localTool],
		]);

		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["test system prompt"],
				messages: [],
				tools: [readTool],
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"tools.maxDiscoveredTools": 10,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: () => "system prompt",
		});

		// Activate all three discovered tools
		await session.activateDiscoveredTools(["mcp__s__active", "mcp__s__idle", "custom_local"]);
		expect(session.getActiveToolNames()).toContain("mcp__s__active");
		expect(session.getActiveToolNames()).toContain("mcp__s__idle");
		expect(session.getActiveToolNames()).toContain("custom_local");

		// Simulate retained messages after a compaction: only mcp__s__active was called
		const retainedMessages: AgentMessage[] = [
			userText("do work"),
			assistantWithToolCall("mcp__s__active", "call_1"),
			toolResult("call_1", "mcp__s__active"),
		];

		// Compaction runtime calls pruneDiscoveredToolsAfterCompaction with retained messages
		await session.pruneDiscoveredToolsAfterCompaction(retainedMessages);

		// Uncalled tools dropped, called tool kept
		expect(session.getActiveToolNames()).toContain("read");
		expect(session.getActiveToolNames()).toContain("mcp__s__active");
		expect(session.getActiveToolNames()).not.toContain("mcp__s__idle");
		expect(session.getActiveToolNames()).not.toContain("custom_local");

		// Updated selection is persisted in session manager
		const persistedSelection = sessionManager.buildSessionContext().selectedMCPToolNames;
		expect(persistedSelection).toContain("mcp__s__active");
		expect(persistedSelection).not.toContain("mcp__s__idle");
	});
});
