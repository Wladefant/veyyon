import { afterEach, describe, expect, it } from "bun:test";
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
import {
	extractToolLastCallIndices,
	ToolDiscovery,
	type ToolDiscoveryHost,
} from "@veyyon/coding-agent/session/runtime/tool-discovery";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { type } from "arktype";

function createMockModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createTool(name: string, options?: { loadMode?: "essential" | "discoverable"; mcpServer?: string }): AgentTool {
	const schema = type({ value: "string" });
	const tool: AgentTool = {
		name,
		label: options?.mcpServer ? `${options.mcpServer}/${name}` : name,
		description: `Description for ${name}`,
		parameters: schema,
		strict: true,
		loadMode: options?.loadMode,
		async execute() {
			return { content: [{ type: "text", text: `${name} output` }] };
		},
	};
	if (options?.mcpServer) {
		tool.mcpServerName = options.mcpServer;
		tool.mcpToolName = name.replace(/^mcp__[^_]+__/, "");
	}
	return tool;
}

function assistantToolCall(toolName: string, callId: string): AssistantMessage {
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

function toolResult(toolName: string, callId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: "done" }],
		timestamp: Date.now(),
	};
}

function userText(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

describe("ToolDiscovery unit: LRU eviction cap and compaction prune", () => {
	it("extracts tool last call indices from assistant toolCall and toolResult messages", () => {
		const messages: AgentMessage[] = [
			userText("hello"),
			assistantToolCall("tool_a", "call_1"),
			toolResult("tool_a", "call_1"),
			assistantToolCall("tool_b", "call_2"),
			toolResult("tool_b", "call_2"),
			assistantToolCall("tool_a", "call_3"),
			toolResult("tool_a", "call_3"),
		];

		const lastCalls = extractToolLastCallIndices(messages);
		expect(lastCalls.get("tool_a")).toBe(6);
		expect(lastCalls.get("tool_b")).toBe(4);
		expect(lastCalls.has("tool_c")).toBe(false);
	});

	it("evicts least recently used search-activated tools when cap is exceeded", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["mcp__srv__tool_1", createTool("mcp__srv__tool_1", { mcpServer: "srv" })],
			["mcp__srv__tool_2", createTool("mcp__srv__tool_2", { mcpServer: "srv" })],
			["mcp__srv__tool_3", createTool("mcp__srv__tool_3", { mcpServer: "srv" })],
		]);
		let active = ["read"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "mcp-only",
			maxDiscoveredTools: () => 2,
		};
		const discovery = new ToolDiscovery(host, { mcpDiscoveryEnabled: true });

		const plan1 = discovery.planActivation(["mcp__srv__tool_1", "mcp__srv__tool_2"]);
		expect(plan1.changed).toBe(true);
		expect(plan1.activated).toEqual(["mcp__srv__tool_1", "mcp__srv__tool_2"]);
		expect(plan1.evicted).toEqual([]);
		discovery.applyActivation(plan1);
		active = plan1.nextActive;

		const plan2 = discovery.planActivation(["mcp__srv__tool_3"]);
		expect(plan2.changed).toBe(true);
		expect(plan2.activated).toEqual(["mcp__srv__tool_3"]);
		expect(plan2.evicted).toEqual(["mcp__srv__tool_1"]);
		expect(plan2.nextActive).toEqual(["read", "mcp__srv__tool_2", "mcp__srv__tool_3"]);
	});

	it("prioritizes uncalled tools for LRU eviction over called tools", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["mcp__srv__tool_1", createTool("mcp__srv__tool_1", { mcpServer: "srv" })],
			["mcp__srv__tool_2", createTool("mcp__srv__tool_2", { mcpServer: "srv" })],
			["mcp__srv__tool_3", createTool("mcp__srv__tool_3", { mcpServer: "srv" })],
		]);
		let active = ["read"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "mcp-only",
			maxDiscoveredTools: () => 2,
		};
		const discovery = new ToolDiscovery(host, { mcpDiscoveryEnabled: true });

		const plan1 = discovery.planActivation(["mcp__srv__tool_1", "mcp__srv__tool_2"]);
		discovery.applyActivation(plan1);
		active = plan1.nextActive;

		const messages: AgentMessage[] = [
			assistantToolCall("mcp__srv__tool_1", "call_1"),
			toolResult("mcp__srv__tool_1", "call_1"),
		];

		const plan2 = discovery.planActivation(["mcp__srv__tool_3"], { messages });
		expect(plan2.evicted).toEqual(["mcp__srv__tool_2"]);
		expect(plan2.nextActive).toEqual(["read", "mcp__srv__tool_1", "mcp__srv__tool_3"]);
	});

	it("orders eviction by last call index when multiple tools were called", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["mcp__srv__tool_1", createTool("mcp__srv__tool_1", { mcpServer: "srv" })],
			["mcp__srv__tool_2", createTool("mcp__srv__tool_2", { mcpServer: "srv" })],
			["mcp__srv__tool_3", createTool("mcp__srv__tool_3", { mcpServer: "srv" })],
		]);
		let active = ["read"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "mcp-only",
			maxDiscoveredTools: () => 2,
		};
		const discovery = new ToolDiscovery(host, { mcpDiscoveryEnabled: true });

		const plan1 = discovery.planActivation(["mcp__srv__tool_1", "mcp__srv__tool_2"]);
		discovery.applyActivation(plan1);
		active = plan1.nextActive;

		const messages: AgentMessage[] = [
			assistantToolCall("mcp__srv__tool_2", "call_1"),
			assistantToolCall("mcp__srv__tool_1", "call_2"),
		];

		const plan2 = discovery.planActivation(["mcp__srv__tool_3"], { messages });
		expect(plan2.evicted).toEqual(["mcp__srv__tool_2"]);
		expect(plan2.nextActive).toEqual(["read", "mcp__srv__tool_1", "mcp__srv__tool_3"]);
	});

	it("never evicts protected, built-in essential, or configured default tools", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["mcp__srv__default_tool", createTool("mcp__srv__default_tool", { mcpServer: "srv" })],
			["mcp__srv__search_tool", createTool("mcp__srv__search_tool", { mcpServer: "srv" })],
			["mcp__srv__new_tool", createTool("mcp__srv__new_tool", { mcpServer: "srv" })],
		]);
		let active = ["read", "mcp__srv__default_tool"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "mcp-only",
			maxDiscoveredTools: () => 1,
		};
		const discovery = new ToolDiscovery(host, {
			mcpDiscoveryEnabled: true,
			builtInToolNames: ["read"],
			defaultSelectedMCPToolNames: ["mcp__srv__default_tool"],
		});

		expect(discovery.isProtected("read")).toBe(true);
		expect(discovery.isProtected("mcp__srv__default_tool")).toBe(true);

		const plan1 = discovery.planActivation(["mcp__srv__search_tool"]);
		discovery.applyActivation(plan1);
		active = plan1.nextActive;
		expect(discovery.isProtected("mcp__srv__search_tool")).toBe(false);

		const plan2 = discovery.planActivation(["mcp__srv__new_tool"]);
		expect(plan2.evicted).toEqual(["mcp__srv__search_tool"]);
		expect(plan2.nextActive).toEqual(["read", "mcp__srv__default_tool", "mcp__srv__new_tool"]);
	});

	it("prunes unused search-activated tools after compaction and keeps called ones", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["mcp__srv__used", createTool("mcp__srv__used", { mcpServer: "srv" })],
			["mcp__srv__unused", createTool("mcp__srv__unused", { mcpServer: "srv" })],
			["local_discoverable", createTool("local_discoverable", { loadMode: "discoverable" })],
		]);
		let active = ["read"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "all",
			maxDiscoveredTools: () => 10,
		};
		const discovery = new ToolDiscovery(host, { mcpDiscoveryEnabled: true, builtInToolNames: ["read"] });

		const activation = discovery.planActivation(["mcp__srv__used", "mcp__srv__unused", "local_discoverable"]);
		discovery.applyActivation(activation);
		active = activation.nextActive;

		const retainedMessages: AgentMessage[] = [
			userText("summary message"),
			assistantToolCall("mcp__srv__used", "c1"),
			toolResult("mcp__srv__used", "c1"),
		];

		const prunePlan = discovery.planCompactionPrune(retainedMessages);
		expect(prunePlan.changed).toBe(true);
		expect(prunePlan.dropped).toEqual(["mcp__srv__unused", "local_discoverable"]);
		expect(prunePlan.nextActive).toEqual(["read", "mcp__srv__used"]);

		discovery.applyPrune(prunePlan);
		active = prunePlan.nextActive;

		expect(discovery.searchActivatedTools()).toEqual(["mcp__srv__used"]);
	});
});

describe("AgentSession integration: cap, prune, persistence, and reload", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("enforces tools.maxDiscoveredTools cap and evicts LRU search tools on activateDiscoveredTools", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const mcp1 = createTool("mcp__s__t1", { mcpServer: "s" });
		const mcp2 = createTool("mcp__s__t2", { mcpServer: "s" });
		const mcp3 = createTool("mcp__s__t3", { mcpServer: "s" });
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[mcp1.name, mcp1],
			[mcp2.name, mcp2],
			[mcp3.name, mcp3],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"tools.maxDiscoveredTools": 2,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__s__t1", "mcp__s__t2"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__s__t1", "mcp__s__t2"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__s__t1", "mcp__s__t2"]);

		// Activate third tool -> should evict LRU tool (mcp__s__t1)
		await session.activateDiscoveredTools(["mcp__s__t3"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__s__t2", "mcp__s__t3"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__s__t2", "mcp__s__t3"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__s__t2", "mcp__s__t3"]);
	});

	it("pruneDiscoveredToolsAfterCompaction drops uncalled tools and persists both MCP and local tools", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const mcpUsed = createTool("mcp__s__used", { mcpServer: "s" });
		const mcpUnused = createTool("mcp__s__unused", { mcpServer: "s" });
		const localDiscoverable = createTool("custom_local", { loadMode: "discoverable" });
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[mcpUsed.name, mcpUsed],
			[mcpUnused.name, mcpUnused],
			[localDiscoverable.name, localDiscoverable],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"mcp.discoveryMode": true,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__s__used", "mcp__s__unused", "custom_local"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__s__used", "mcp__s__unused", "custom_local"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__s__used", "mcp__s__unused", "custom_local"]);

		const retainedMessages: AgentMessage[] = [
			userText("compaction summary"),
			assistantToolCall("mcp__s__used", "call_1"),
			toolResult("mcp__s__used", "call_1"),
		];

		await session.pruneDiscoveredToolsAfterCompaction(retainedMessages);

		expect(session.getActiveToolNames()).toEqual(["read", "mcp__s__used"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__s__used"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__s__used"]);
	});

	it("pruneDiscoveredToolsAfterCompaction retains called local tools and persists them", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const mcpTool = createTool("mcp__s__tool", { mcpServer: "s" });
		const localTool = createTool("custom_local", { loadMode: "discoverable" });
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[mcpTool.name, mcpTool],
			[localTool.name, localTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"mcp.discoveryMode": true,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__s__tool", "custom_local"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__s__tool", "custom_local"]);

		// Retain messages that called custom_local but not mcp__s__tool
		const retainedMessages: AgentMessage[] = [
			userText("compaction summary"),
			assistantToolCall("custom_local", "call_local_1"),
			toolResult("custom_local", "call_local_1"),
		];

		await session.pruneDiscoveredToolsAfterCompaction(retainedMessages);

		expect(session.getActiveToolNames()).toEqual(["read", "custom_local"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["custom_local"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["custom_local"]);
	});

	it("preserves default MCP and built-in essential tools across prune", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const defaultMcp = createTool("mcp__s__default", { mcpServer: "s" });
		const searchMcp = createTool("mcp__s__search", { mcpServer: "s" });
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[defaultMcp.name, defaultMcp],
			[searchMcp.name, searchMcp],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: [readTool, defaultMcp],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPToolNames: ["mcp__s__default"],
			initialSelectedMCPToolNames: ["mcp__s__default"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__s__search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__s__default", "mcp__s__search"]);

		// Neither read nor defaultMcp was called in retained messages
		const retainedMessages: AgentMessage[] = [userText("empty retained context")];

		await session.pruneDiscoveredToolsAfterCompaction(retainedMessages);

		expect(session.getActiveToolNames()).toEqual(["read", "mcp__s__default"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__s__default"]);
	});

	it("restores persisted selection on reload", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const mcpTool = createTool("mcp__s__t1", { mcpServer: "s" });
		const localTool = createTool("custom_local", { loadMode: "discoverable" });
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[mcpTool.name, mcpTool],
			[localTool.name, localTool],
		]);
		const sessionManager = SessionManager.inMemory();

		// Session 1 activates tools
		const agent1 = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session1 = new AgentSession({
			agent: agent1,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"mcp.discoveryMode": true,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session1);

		await session1.activateDiscoveredTools(["mcp__s__t1", "custom_local"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__s__t1", "custom_local"]);

		// Session 2 resumes from the same sessionManager
		const persistedSelection = sessionManager.buildSessionContext().selectedMCPToolNames;
		const agent2 = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session2 = new AgentSession({
			agent: agent2,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"mcp.discoveryMode": true,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: persistedSelection,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session2);

		expect(session2.getSelectedDiscoveredToolNames()).toEqual(["mcp__s__t1", "custom_local"]);
	});
});
