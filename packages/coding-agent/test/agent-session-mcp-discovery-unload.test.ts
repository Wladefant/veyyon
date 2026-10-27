import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { type } from "arktype";

function createModel(): Model<"openai-responses"> {
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

function createBasicTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpTool(name: string, serverName: string): AgentTool {
	return {
		name,
		label: `${serverName}/${name}`,
		description: `${name} from ${serverName}`,
		parameters: type({ query: "string" }),
		strict: true,
		mcpServerName: serverName,
		mcpToolName: name,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as AgentTool;
}

function assistantCalling(toolName: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${toolName}`, name: toolName, arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("MCP discovery unload and cap", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function createSession(mcpToolNames: string[], settings: Record<string, unknown> = {}) {
		const readTool = createBasicTool("read");
		const toolRegistry = new Map<string, AgentTool>([[readTool.name, readTool]]);
		for (const name of mcpToolNames) toolRegistry.set(name, createMcpTool(name, name.split("_")[2] ?? "srv"));
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true, ...settings }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);
		return { session, sessionManager, agent };
	}

	it("unloads an unused discovery-activated tool, keeps a called one and every base tool, and persists the reduced selection", async () => {
		const { session, sessionManager, agent } = createSession(["mcp__docs_search", "mcp__slack_send"]);
		await session.activateDiscoveredMCPTools(["mcp__docs_search", "mcp__slack_send"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send"]);

		agent.replaceMessages([assistantCalling("mcp__docs_search")]);
		const unloaded = await session.unloadIdleDiscoveredMCPTools();

		expect(unloaded).toEqual(["mcp__slack_send"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);
	});

	it("finds and re-activates a tool that an unload took off", async () => {
		const { session, agent } = createSession(["mcp__docs_search", "mcp__slack_send"]);
		await session.activateDiscoveredMCPTools(["mcp__slack_send"]);
		agent.replaceMessages([]);
		expect(await session.unloadIdleDiscoveredMCPTools()).toEqual(["mcp__slack_send"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);

		expect(session.getDiscoverableTools({ source: "mcp" }).map(tool => tool.name)).toContain("mcp__slack_send");
		expect(await session.activateDiscoveredMCPTools(["mcp__slack_send"])).toEqual(["mcp__slack_send"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__slack_send"]);
	});

	it("evicts the least recently used discovery-activated tool when activation exceeds the cap", async () => {
		const { session, sessionManager, agent } = createSession(["mcp__a_one", "mcp__b_two", "mcp__c_three"], {
			"mcp.discoveryActiveLimit": 2,
		});
		await session.activateDiscoveredMCPTools(["mcp__a_one"]);
		await session.activateDiscoveredMCPTools(["mcp__b_two"]);
		// The older tool is called, so the other one is now the least recently used.
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "mcp__a_one",
			args: {},
		});

		await session.activateDiscoveredMCPTools(["mcp__c_three"]);

		expect(session.getActiveToolNames()).toEqual(["read", "mcp__a_one", "mcp__c_three"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__a_one", "mcp__c_three"]);
	});
});
