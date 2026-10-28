/**
 * WHY: #685 regressions at the public seams. Discovered tools must follow real tool calls
 * (recent use keeps a tool, LRU evicts the coldest one at the default cap of 40), and a real
 * compaction must unload uncalled discovered tools while keeping the called one in the kept
 * window and in the persisted selection. Repeated threshold passes must not start a second
 * auto-compaction while the guard holds.
 *
 * Seams: tests 1 and 2 drive a real AgentSession with real `session.prompt` turns, so tool calls
 * are recorded in the session's own messages. Test 3 drives CompactionRuntime directly with a
 * `session_before_compact` hook compaction above threshold. No test calls
 * `pruneDiscoveredToolsAfterCompaction`; the prune runs inside `session.compact()`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import {
	CompactionRuntime,
	type CompactionHost,
	type CompactionSession,
} from "@veyyon/coding-agent/session/runtime/compaction-runtime";
import type { CompactionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const ALPHA_REQUEST =
	"ALPHA-REQUEST please refactor the parser module so every tokenizer path shares one entry point and delete the duplicated scanning logic that crept in last quarter";
const ALPHA_REPLY =
	"ALPHA-REPLY the parser now has a single entry point and the duplicate scanning logic is gone from every tokenizer path in the module";
const BRAVO_REQUEST =
	"BRAVO-REQUEST now wire the new parser through the compiler pipeline and make sure every diagnostic still carries the original source span information";

type AutoCompactionEnd = Extract<AgentSessionEvent, { type: "auto_compaction_end" }>;

function createTool(name: string, options?: { loadMode?: "essential" | "discoverable"; mcpServer?: string }): AgentTool {
	return {
		name,
		description: `Tool ${name}`,
		parameters: type({ value: "string" }),
		loadMode: options?.loadMode,
		mcpServer: options?.mcpServer,
		execute: async () => ({ content: [{ type: "text", text: `result from ${name}` }] }),
	};
}

function assistantMessage(model: Model, text: string, input: number, output: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function completedStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const reason = message.stopReason === "toolUse" ? "toolUse" : "stop";
	queueMicrotask(() => {
		stream.push({ type: "done", reason, message });
	});
	return stream;
}

function isAutoCompactionEnd(event: AgentSessionEvent): event is AutoCompactionEnd {
	return event.type === "auto_compaction_end";
}

describe("#685 discovered-tool regressions through a real AgentSession", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-discovery-regressions-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		await tempDir.remove();
	});

	/**
	 * A real session with a scripted provider. `replies` answer each main provider call in order;
	 * `summaries` answer each summarizer call (the local compaction summarizer).
	 */
	async function createSession(agentTools: AgentTool[], registryTools: AgentTool[]) {
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		// Pin the window so catalog regeneration cannot shift the discovery and compaction math.
		const model: Model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const replies: AssistantMessage[] = [];
		const summaries: string[] = [];
		let summarizerCalls = 0;

		const streamFn: StreamFn = () => {
			const reply = replies.shift();
			if (!reply) throw new Error("unexpected extra provider call");
			return completedStream(reply);
		};
		const sideStreamFn: StreamFn = requestModel => {
			const summary = summaries.shift();
			if (!summary) throw new Error("unexpected extra summarizer call");
			summarizerCalls++;
			return completedStream(assistantMessage(requestModel, summary, 100, 50));
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: agentTools, messages: [] },
			convertToLlm,
			streamFn,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				// Manual compact() only: auto-compaction must never fire mid-prompt.
				"compaction.enabled": false,
				"compaction.remote": false,
				// Keep the complete final tool-call turn, but not the oversized earlier reply.
				"compaction.keepRecentTokens": 500,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.eager": "default",
				"todo.reminders": false,
				"tools.discoveryMode": "all",
			}),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
			mcpDiscoveryEnabled: true,
			autoApprove: true,
			sideStreamFn,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);
		return {
			session,
			sessionManager,
			model,
			queueReply: (reply: AssistantMessage) => replies.push(reply),
			queueSummary: (text: string) => summaries.push(text),
			summarizerCalls: () => summarizerCalls,
		};
	}

	it("unloads unused discovered tools after a real compact and keeps the called one in the kept window and persisted selection", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const usedMcp = createTool("mcp__s__used", { mcpServer: "s" });
		const unusedMcp = createTool("mcp__s__unused", { mcpServer: "s" });
		const unusedLocal = createTool("custom_unused", { loadMode: "discoverable" });
		const harness = await createSession([readTool], [readTool, usedMcp, unusedMcp, unusedLocal]);
		const { session, sessionManager, model } = harness;

		await session.activateDiscoveredTools([usedMcp.name, unusedMcp.name, unusedLocal.name]);
		harness.queueReply(assistantMessage(model, ALPHA_REPLY.repeat(1000), 100, 10));
		// The second turn calls the MCP tool, then closes with a short reply, so the call sits in the kept tail.
		harness.queueReply({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_used", name: usedMcp.name, arguments: { value: "call" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: {
				input: 110,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		harness.queueReply(assistantMessage(model, "done", 120, 10));
		// The cut lands inside the BRAVO turn, so compaction summarizes the history (cache-aligned)
		// and the turn prefix in parallel: two summarizer calls, one per span.
		harness.queueSummary("LOCAL-SUMMARY: the alpha turn condensed");
		harness.queueSummary("LOCAL-SUMMARY: the bravo turn prefix condensed");

		await session.prompt(ALPHA_REQUEST);
		await session.prompt(BRAVO_REQUEST);
		expect(sessionManager.getBranch().filter(entry => entry.type === "message")).toHaveLength(6);

		await session.compact();

		expect(harness.summarizerCalls()).toBe(2);
		const compactions = sessionManager
			.getBranch()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(compactions).toHaveLength(1);

		// The kept window carries the called tool's call and result; the discarded span is gone.
		const stateMessages: AgentMessage[] = session.agent.state.messages;
		const callNames = stateMessages.flatMap(message =>
			message.role === "assistant" ? message.content.flatMap(block => (block.type === "toolCall" ? [block.name] : [])) : [],
		);
		expect(callNames).toEqual([usedMcp.name]);
		const resultNames = stateMessages.flatMap(message => (message.role === "toolResult" ? [message.toolName] : []));
		expect(resultNames).toEqual([usedMcp.name]);
		expect(JSON.stringify(stateMessages)).not.toContain("ALPHA-REQUEST");

		// Uncalled discovered tools, MCP and local, leave the active set.
		const active = session.getActiveToolNames();
		expect(active).toContain(readTool.name);
		expect(active).toContain(usedMcp.name);
		expect(active).not.toContain(unusedMcp.name);
		expect(active).not.toContain(unusedLocal.name);

		// The persisted selection in the session journal matches the live set.
		const persisted = sessionManager.buildSessionContext().selectedMCPToolNames;
		expect(persisted).toContain(usedMcp.name);
		expect(persisted).not.toContain(unusedMcp.name);
		expect(persisted).not.toContain(unusedLocal.name);
	});

	it("evicts the least-recently-called discovery at the default cap of 40 once tool calls mark recent use", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const mcpTools = Array.from({ length: 41 }, (_, index) => createTool(`mcp__s__t${index}`, { mcpServer: "s" }));
		const harness = await createSession([readTool], [readTool, ...mcpTools]);
		const { session, sessionManager, model } = harness;

		const firstForty = mcpTools.slice(0, 40).map(tool => tool.name);
		const [recentlyCalled, coldest] = firstForty;
		const newcomer = mcpTools[40]!.name;
		await session.activateDiscoveredTools(firstForty);
		expect(session.getActiveToolNames()).toHaveLength(41);

		// A real tool call on the first discovery marks it as the most recently used.
		harness.queueReply({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_recent", name: recentlyCalled!, arguments: { value: "call" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: {
				input: 110,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		harness.queueReply(assistantMessage(model, "done", 120, 10));
		await session.prompt(BRAVO_REQUEST);
		const calledNames = session.agent.state.messages.flatMap(message =>
			message.role === "assistant" ? message.content.flatMap(block => (block.type === "toolCall" ? [block.name] : [])) : [],
		);
		expect(calledNames).toEqual([recentlyCalled]);

		// The cap is full, so the 41st activation evicts the least-recently-called discovery.
		await session.activateDiscoveredTools([newcomer]);

		const active = session.getActiveToolNames();
		expect(active).toContain(recentlyCalled);
		expect(active).not.toContain(coldest);
		expect(active).toContain(newcomer);
		expect(session.getSelectedDiscoveredToolNames()).not.toContain(coldest);

		const persisted = sessionManager.buildSessionContext().selectedMCPToolNames;
		expect(persisted).toContain(recentlyCalled);
		expect(persisted).toContain(newcomer);
		expect(persisted).not.toContain(coldest);
	});
});

describe("#685 repeated threshold passes through CompactionRuntime", () => {
	it("starts one auto-compaction across repeated threshold passes after a hook compaction", async () => {
		const model = buildModel({
			id: "mock-model",
			name: "Mock Model",
			provider: "openai-responses",
			contextWindow: 128000,
		});
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "Investigate repository history", timestamp: 1000 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "history payload\n".repeat(6000) }],
			timestamp: 2000,
		});
		sessionManager.appendMessage({ role: "user", content: "next step", timestamp: 3000 });

		const events: AgentSessionEvent[] = [];
		const currentTokens = 115000;
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.threshold": "100000",
			"compaction.keepRecentTokens": 10000,
		});
		// The hook compaction is the extension boundary: it supplies the summary and the cut.
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_compact",
			emit: async (event: { type: string; preparation?: { firstKeptEntryId?: string } }) => {
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
			agent: new Agent({
				initialState: { model, systemPrompt: ["test system prompt"], messages: [], tools: [] },
			}),
			sessionManager,
			settings,
			sessionId: "test-session-1",
			model,
			modelRegistry: {
				getAvailable: () => [model],
				find: () => model,
			} as never,
			thinkingLevel: undefined,
			extensionRunner: extensionRunner as never,
			dedupeRedundantToolResults: async () => ({ toolResultsDropped: 0, tokensFreed: 0 }),
			buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
			abort: async () => {},
			emitNotice: () => {},
			getContextUsage: () => ({
				tokens: currentTokens,
				contextWindow: model.contextWindow ?? 128000,
				percent: currentTokens / (model.contextWindow ?? 128000),
			}),
		};
		const host: CompactionHost = {
			emitSessionEvent: async event => {
				events.push(event);
			},
			promptGeneration: () => 1,
			nonMessageTokens: () => 5000,
			nonMessageBreakdown: () => ({
				systemPromptTokens: 3000,
				systemContextTokens: 1000,
				skillsTokens: 500,
				toolsTokens: 500,
			}),
			estimateStoredContextTokens: () => Math.max(0, currentTokens - 5000),
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
			withPlanProtection: config => config,
			promptCompaction: async () => undefined,
			offloadAndApplyShakeRegions: async () => {},
			rebasePendingContextSnapshotAfterHistoryRewrite: () => {},
		};
		const runtime = new CompactionRuntime(session, host);

		// The first pass compacts through the hook; the context stays above threshold, so the guard holds.
		await runtime.runAutoCompaction("threshold", false);
		// The second pass hits the held guard and must not start a second compaction.
		await runtime.runAutoCompaction("threshold", false);

		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		const ends = events.filter(isAutoCompactionEnd);
		expect(ends).toHaveLength(2);
		expect(ends[0]!.result).toBeDefined();
		expect(ends[1]!.result).toBeUndefined();
	});
});
