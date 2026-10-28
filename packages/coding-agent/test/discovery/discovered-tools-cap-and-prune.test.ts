import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CustomTool } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	extractToolLastCallIndices,
	ToolDiscovery,
	type ToolDiscoveryHost,
} from "@veyyon/coding-agent/session/runtime/tool-discovery";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

let tempDir: TempDir | undefined;

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

function createTool(
	name: string,
	options?: { loadMode?: "essential" | "discoverable"; mcpServer?: string },
): AgentTool {
	const schema = type({ value: "string" });
	const tool: AgentTool & { mcpServerName?: string; mcpToolName?: string } = {
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
function createCustomMcpTool(name: string): CustomTool {
	const schema = type({ value: "string" });
	return {
		name,
		label: name,
		description: `Description for ${name}`,
		parameters: schema,
		mcpServerName: "s",
		mcpToolName: name.replace(/^mcp__s__/, ""),
		async execute() {
			return { content: [{ type: "text", text: `${name} output` }] };
		},
	};
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
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(toolName: string, callId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: "done" }],
		isError: false,
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

	it("tracks fresh search activations while config and default tools are never tracked", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["mcp__srv__default", createTool("mcp__srv__default", { mcpServer: "srv" })],
			["mcp__srv__search", createTool("mcp__srv__search", { mcpServer: "srv" })],
			["local_discoverable", createTool("local_discoverable", { loadMode: "discoverable" })],
		]);
		let active = ["read", "mcp__srv__default"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "all",
			maxDiscoveredTools: () => 5,
		};
		const discovery = new ToolDiscovery(host, {
			mcpDiscoveryEnabled: true,
			builtInToolNames: ["read"],
			defaultSelectedMCPToolNames: ["mcp__srv__default"],
		});

		expect(discovery.isProtected("read")).toBe(true);
		expect(discovery.isProtected("mcp__srv__default")).toBe(true);
		expect(discovery.searchActivatedTools()).toEqual([]);

		const plan = discovery.planActivation(["mcp__srv__search", "local_discoverable"]);
		expect(plan.activated).toEqual(["mcp__srv__search", "local_discoverable"]);
		discovery.applyActivation(plan);
		active = plan.nextActive;

		expect(discovery.isProtected("mcp__srv__search")).toBe(false);
		expect(discovery.isProtected("local_discoverable")).toBe(false);
		expect(discovery.searchActivatedTools().sort()).toEqual(["local_discoverable", "mcp__srv__search"]);
		expect(discovery.isProtected("read")).toBe(true);
		expect(discovery.isProtected("mcp__srv__default")).toBe(true);
	});

	it("caps oversized batch activation deterministically and reports only active tools in activated", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["t1", createTool("t1", { loadMode: "discoverable" })],
			["t2", createTool("t2", { loadMode: "discoverable" })],
			["t3", createTool("t3", { loadMode: "discoverable" })],
			["t4", createTool("t4", { loadMode: "discoverable" })],
			["t5", createTool("t5", { loadMode: "discoverable" })],
		]);
		let active = ["read"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "all",
			maxDiscoveredTools: () => 2,
		};
		const discovery = new ToolDiscovery(host, { builtInToolNames: ["read"] });

		const plan = discovery.planActivation(["t1", "t2", "t3", "t4", "t5"]);
		expect(plan.changed).toBe(true);
		expect(plan.activated).toEqual(["t4", "t5"]);
		expect(plan.evicted).toEqual([]);
		expect(plan.nextActive).toEqual(["read", "t4", "t5"]);

		discovery.applyActivation(plan);
		active = plan.nextActive;
		expect(discovery.searchActivatedTools()).toEqual(["t4", "t5"]);
	});

	it("caps oversized batch by evicting LRU existing search tools first then oldest in batch", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["e1", createTool("e1", { loadMode: "discoverable" })],
			["e2", createTool("e2", { loadMode: "discoverable" })],
			["t1", createTool("t1", { loadMode: "discoverable" })],
			["t2", createTool("t2", { loadMode: "discoverable" })],
			["t3", createTool("t3", { loadMode: "discoverable" })],
		]);
		let active = ["read"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "all",
			maxDiscoveredTools: () => 2,
		};
		const discovery = new ToolDiscovery(host, { builtInToolNames: ["read"] });

		const initialPlan = discovery.planActivation(["e1", "e2"]);
		discovery.applyActivation(initialPlan);
		active = initialPlan.nextActive;

		const messages: AgentMessage[] = [assistantToolCall("e1", "call_e1"), toolResult("e1", "call_e1")];

		const plan = discovery.planActivation(["t1", "t2", "t3"], { messages });
		expect(plan.changed).toBe(true);
		expect(plan.evicted).toEqual(["e2", "e1"]);
		expect(plan.activated).toEqual(["t2", "t3"]);
		expect(plan.nextActive).toEqual(["read", "t2", "t3"]);

		discovery.applyActivation(plan);
		active = plan.nextActive;
		expect(discovery.searchActivatedTools()).toEqual(["t2", "t3"]);
	});

	it("protects explicitly configured local tools in protectedToolNames from eviction and pruning", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["custom_configured", createTool("custom_configured", { loadMode: "discoverable" })],
			["search_tool_1", createTool("search_tool_1", { loadMode: "discoverable" })],
			["search_tool_2", createTool("search_tool_2", { loadMode: "discoverable" })],
		]);
		let active = ["read", "custom_configured"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "all",
			maxDiscoveredTools: () => 1,
		};
		const discovery = new ToolDiscovery(host, {
			builtInToolNames: ["read"],
			protectedToolNames: ["custom_configured"],
		});

		expect(discovery.isProtected("custom_configured")).toBe(true);

		const plan1 = discovery.planActivation(["search_tool_1"]);
		discovery.applyActivation(plan1);
		active = plan1.nextActive;

		expect(active).toEqual(["read", "custom_configured", "search_tool_1"]);
		expect(discovery.isProtected("custom_configured")).toBe(true);
		expect(discovery.isProtected("search_tool_1")).toBe(false);

		const plan2 = discovery.planActivation(["search_tool_2"]);
		expect(plan2.evicted).toEqual(["search_tool_1"]);
		expect(plan2.nextActive).toEqual(["read", "custom_configured", "search_tool_2"]);

		discovery.applyActivation(plan2);
		active = plan2.nextActive;

		const prunePlan = discovery.planCompactionPrune([]);
		expect(prunePlan.dropped).toEqual(["search_tool_2"]);
		expect(prunePlan.nextActive).toEqual(["read", "custom_configured"]);
	});

	it("bounds restored search selections to maxDiscoveredTools on reload while protecting defaults", () => {
		const registry = new Map<string, AgentTool>([
			["read", createTool("read", { loadMode: "essential" })],
			["mcp__s__default", createTool("mcp__s__default", { mcpServer: "s" })],
			["mcp__s__1", createTool("mcp__s__1", { mcpServer: "s" })],
			["mcp__s__2", createTool("mcp__s__2", { mcpServer: "s" })],
			["mcp__s__3", createTool("mcp__s__3", { mcpServer: "s" })],
		]);
		const active = ["read", "mcp__s__default", "mcp__s__2", "mcp__s__3"];
		const host: ToolDiscoveryHost = {
			registry,
			activeToolNames: () => active,
			discoveryModeFor: () => "mcp-only",
			maxDiscoveredTools: () => 2,
		};
		const discovery = new ToolDiscovery(host, {
			mcpDiscoveryEnabled: true,
			builtInToolNames: ["read"],
			defaultSelectedMCPToolNames: ["mcp__s__default"],
			initialSelectedMCPToolNames: ["mcp__s__default", "mcp__s__1", "mcp__s__2", "mcp__s__3"],
		});

		expect(discovery.isProtected("mcp__s__default")).toBe(true);
		expect(discovery.searchActivatedTools().sort()).toEqual(["mcp__s__2", "mcp__s__3"]);
		expect(discovery.selectedDiscovered().sort()).toEqual(["mcp__s__2", "mcp__s__3", "mcp__s__default"]);
	});
});

describe("AgentSession integration: cap, prune, persistence, and reload", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		await tempDir?.remove();
		tempDir = undefined;
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

		await session1.activateDiscoveredTools(["custom_local", "mcp__s__t1"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["custom_local", "mcp__s__t1"]);

		// Session 2 resumes from the same sessionManager
		const persistedSelection = sessionManager.buildSessionContext().selectedMCPToolNames;
		const agent2 = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				// The SDK starts a resumed session with the restored selection already active.
				tools: [readTool, localTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session2 = new AgentSession({
			agent: agent2,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"mcp.discoveryMode": true,
				"tools.maxDiscoveredTools": 2,
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
		expect(session2.getSelectedDiscoveredToolNames()).toEqual(["custom_local", "mcp__s__t1"]);
	});

	it("enforces cap on oversized activateDiscoveredTools batch and returns only active tools", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const mcp1 = createTool("mcp__s__t1", { mcpServer: "s" });
		const mcp2 = createTool("mcp__s__t2", { mcpServer: "s" });
		const mcp3 = createTool("mcp__s__t3", { mcpServer: "s" });
		const mcp4 = createTool("mcp__s__t4", { mcpServer: "s" });
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[mcp1.name, mcp1],
			[mcp2.name, mcp2],
			[mcp3.name, mcp3],
			[mcp4.name, mcp4],
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

		// Activate batch of 4 when cap is 2 -> returns only tools active at completion ([mcp3, mcp4])
		const activated = await session.activateDiscoveredTools(["mcp__s__t1", "mcp__s__t2", "mcp__s__t3", "mcp__s__t4"]);
		expect(activated).toEqual(["mcp__s__t3", "mcp__s__t4"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__s__t3", "mcp__s__t4"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__s__t3", "mcp__s__t4"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__s__t3", "mcp__s__t4"]);
	});

	it("wires protectedToolNames from explicitly configured local tools and protects them across cap and prune", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const customLocal = createTool("custom_local", { loadMode: "discoverable" });
		const mcp1 = createTool("mcp__s__t1", { mcpServer: "s" });
		const mcp2 = createTool("mcp__s__t2", { mcpServer: "s" });
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[customLocal.name, customLocal],
			[mcp1.name, mcp1],
			[mcp2.name, mcp2],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: [readTool, customLocal],
				messages: [],
			},
		});
		// No protectedToolNames passed in config -> wired from agent.state.tools!
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"mcp.discoveryMode": true,
				"tools.maxDiscoveredTools": 1,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getActiveToolNames()).toEqual(["read", "custom_local"]);

		// Activate mcp1 -> cap is 1 for search-activated tools
		await session.activateDiscoveredTools(["mcp__s__t1"]);
		expect(session.getActiveToolNames()).toEqual(["read", "custom_local", "mcp__s__t1"]);

		// Activate mcp2 -> evicts mcp1, but customLocal is protected and never evicted
		await session.activateDiscoveredTools(["mcp__s__t2"]);
		expect(session.getActiveToolNames()).toEqual(["read", "custom_local", "mcp__s__t2"]);

		// Compaction prune without calls: customLocal survives, mcp2 pruned
		await session.pruneDiscoveredToolsAfterCompaction([]);
		expect(session.getActiveToolNames()).toEqual(["read", "custom_local"]);
	});

	it("bounds restored search selections on session reload to maxDiscoveredTools while preserving defaults", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const defaultMcp = createTool("mcp__s__default", { mcpServer: "s" });
		const mcp1 = createTool("mcp__s__t1", { mcpServer: "s" });
		const mcp2 = createTool("mcp__s__t2", { mcpServer: "s" });
		const mcp3 = createTool("mcp__s__t3", { mcpServer: "s" });
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[defaultMcp.name, defaultMcp],
			[mcp1.name, mcp1],
			[mcp2.name, mcp2],
			[mcp3.name, mcp3],
		]);
		const sessionManager = SessionManager.inMemory();

		// Session 1 activates 3 tools with cap 5
		const agent1 = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: [readTool, defaultMcp],
				messages: [],
			},
		});
		const session1 = new AgentSession({
			agent: agent1,
			sessionManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"tools.maxDiscoveredTools": 5,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPToolNames: ["mcp__s__default"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session1);

		await session1.activateDiscoveredTools(["mcp__s__t1", "mcp__s__t2", "mcp__s__t3"]);
		const persisted = sessionManager.buildSessionContext().selectedMCPToolNames;
		expect(persisted).toEqual(["mcp__s__default", "mcp__s__t1", "mcp__s__t2", "mcp__s__t3"]);

		// Session 2 resumes with tools.maxDiscoveredTools: 2
		const agent2 = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: [readTool, defaultMcp],
				messages: [],
			},
		});
		const session2 = new AgentSession({
			agent: agent2,
			sessionManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"tools.maxDiscoveredTools": 2,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPToolNames: ["mcp__s__default"],
			initialSelectedMCPToolNames: persisted,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session2);

		// Default tool is kept, and the 2 most recent search tools (mcp__s__t2, mcp__s__t3) are kept; mcp__s__t1 is bounded/dropped
		expect(session2.getSelectedDiscoveredToolNames()).toEqual(["mcp__s__default", "mcp__s__t2", "mcp__s__t3"]);
	});
	it("shrinks persisted resumed schemas to the cap and persists the reduced selection", async () => {
		const readTool = createTool("read", { loadMode: "essential" });
		const mcpTools = ["mcp__s__t1", "mcp__s__t2", "mcp__s__t3"].map(name => createCustomMcpTool(name));
		const toolRegistry = new Map<string, AgentTool>([[readTool.name, readTool]]);
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
				"tools.maxDiscoveredTools": 3,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);
		await session.refreshMCPTools(mcpTools);
		await session.activateDiscoveredTools(mcpTools.map(tool => tool.name));
		const persisted = sessionManager.buildSessionContext().selectedMCPToolNames;
		expect(persisted).toEqual(["mcp__s__t1", "mcp__s__t2", "mcp__s__t3"]);
		const restoredTools = [readTool, ...mcpTools.map(tool => toolRegistry.get(tool.name)!)];
		const resumedAgent = new Agent({
			initialState: {
				model: createMockModel(),
				systemPrompt: ["initial"],
				tools: restoredTools,
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const resumedSession = new AgentSession({
			agent: resumedAgent,
			sessionManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"tools.maxDiscoveredTools": 1,
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: persisted,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(resumedSession);

		expect(resumedAgent.state.tools.map(tool => tool.name)).toEqual(["read", "mcp__s__t3"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__s__t3"]);
	});

	it("shrinks active schemas and persists selection when a hot reload lowers the cap", async () => {
		tempDir = TempDir.createSync("@discovered-tools-cap-reload-");
		const file = path.join(tempDir.path(), "config.yml");
		await fs.writeFile(file, "mcp:\n  discoveryMode: true\ntools:\n  maxDiscoveredTools: 3\n");
		const settings = await Settings.loadReadOnly({ agentDir: tempDir.path() });
		const readTool = createTool("read", { loadMode: "essential" });
		const mcpTools = ["mcp__s__t1", "mcp__s__t2", "mcp__s__t3"].map(name => createCustomMcpTool(name));
		const toolRegistry = new Map<string, AgentTool>([[readTool.name, readTool]]);
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
			settings,
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);
		await session.refreshMCPTools(mcpTools);
		await session.activateDiscoveredTools(mcpTools.map(tool => tool.name));
		expect(agent.state.tools.map(tool => tool.name)).toEqual(["read", "mcp__s__t1", "mcp__s__t2", "mcp__s__t3"]);

		await fs.writeFile(file, "mcp:\n  discoveryMode: true\ntools:\n  maxDiscoveredTools: 1\n");
		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			session,
			sessionManager,
			settings,
			output: text => {
				output.push(text);
			},
			cwd: tempDir.path(),
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		expect(await executeAcpBuiltinSlashCommand("/reload-config", runtime)).toEqual({ consumed: true });

		expect(agent.state.tools.map(tool => tool.name)).toEqual(["read", "mcp__s__t3"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__s__t3"]);
	});
});
