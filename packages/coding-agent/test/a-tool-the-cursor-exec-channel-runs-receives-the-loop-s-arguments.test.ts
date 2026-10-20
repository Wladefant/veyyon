/**
 * Contract: a tool Cursor runs through its exec channel receives the arguments the agent loop would hand it.
 *
 * WHY THIS SUITE EXISTS. Cursor runs tool calls itself, during the stream, through `CursorExecHandlers`; the agent
 * loop never dispatches them. The bridge called `tool.execute` with the model's arguments as they arrived, so it
 * skipped every step the loop applies first: the `i` intent field was never stripped, `repairToolCallArguments`
 * never ran, the schema was never checked, and `transformToolCallArguments` (codec handles, secret placeholders)
 * never expanded anything. The reported failure was `search` rejecting every MCP-channel call with `Search type
 * "text" does not accept: i`, because the wire schema carried `i` and nothing removed it.
 *
 * THE CLASS. Any handler on the bridge that runs a registry tool without `prepareToolCall`. The sweep enumerates
 * `CursorExecHandlers.prototype` at run time, so a new handler turns the suite red until it is given a call here
 * or is added to the opt-out, which is pinned by exact equality. `delete` is the one opt-out: it runs no registry
 * tool.
 *
 * WHAT IT DOES NOT CATCH. It drives the bridge, not the Cursor provider's decoding of the exec frames, and it does
 * not prove which hooks `sdk.ts` installs on the agent; the loop's own suites own that.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { create } from "@bufbuild/protobuf";
import { Agent, type AgentEvent, type AnyAgentTool } from "@veyyon/agent-core";
import type { ToolCallPreparation } from "@veyyon/agent-core/tool-call-preparation";
import type { ToolResultMessage } from "@veyyon/ai";
import {
	DeleteArgsSchema,
	DiagnosticsArgsSchema,
	GrepArgsSchema,
	LsArgsSchema,
	ReadArgsSchema,
	ShellArgsSchema,
	WriteArgsSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CursorExecHandlers } from "@veyyon/coding-agent/cursor";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import { isRecord, removeWithRetries } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { type } from "arktype";

type Received = Map<string, Record<string, unknown>>;

function recordingTool(name: string, received: Received): AnyAgentTool {
	return {
		name,
		label: name,
		description: `records the arguments ${name} runs with`,
		parameters: type({ "[string]": "unknown" }),
		execute: async (_toolCallId, args) => {
			received.set(name, args as Record<string, unknown>);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

const MCP_TOOL = "mcp__srv__lookup";
const MCP_INTENT = "Looking up the record";

/** One call per handler that runs a registry tool, and the registry tool it runs. */
const CALLS: Record<string, { tool: string; run: (handlers: CursorExecHandlers) => Promise<ToolResultMessage> }> = {
	read: { tool: "read", run: h => h.read(create(ReadArgsSchema, { toolCallId: "call-read", path: "a.txt" })) },
	ls: { tool: "read", run: h => h.ls(create(LsArgsSchema, { toolCallId: "call-ls", path: "." })) },
	grep: {
		tool: "search",
		run: h => h.grep(create(GrepArgsSchema, { toolCallId: "call-grep", pattern: "needle", path: "." })),
	},
	write: {
		tool: "write",
		run: h => h.write(create(WriteArgsSchema, { toolCallId: "call-write", path: "a.txt", fileText: "body" })),
	},
	shell: { tool: "bash", run: h => h.shell(create(ShellArgsSchema, { toolCallId: "call-shell", command: "true" })) },
	shellStream: {
		tool: "bash",
		run: h =>
			h.shellStream(create(ShellArgsSchema, { toolCallId: "call-shellStream", command: "true" }), {
				onStdout: () => {},
				onStderr: () => {},
			}),
	},
	diagnostics: {
		tool: "lsp",
		run: h => h.diagnostics(create(DiagnosticsArgsSchema, { toolCallId: "call-diagnostics", path: "a.ts" })),
	},
	mcp: {
		tool: MCP_TOOL,
		run: h =>
			h.mcp({
				name: "lookup",
				providerIdentifier: "srv",
				toolName: MCP_TOOL,
				toolCallId: "call-mcp",
				args: { query: "x", [INTENT_FIELD]: MCP_INTENT },
				rawArgs: {},
			}),
	},
};

/** An agent configured the way the session configures one, with hooks that mark what they touched. */
function markingAgent(overrides: Partial<ToolCallPreparation> = {}): Agent {
	return new Agent({
		intentTracing: true,
		repairToolCallArguments: (tool, toolCall) => ({
			status: "repaired",
			arguments: { ...toolCall.arguments, repairedFor: tool.name },
			hints: [],
		}),
		transformToolCallArguments: (args, toolName) => ({
			execution: { ...args, expandedFor: toolName },
			display: { ...args, shownFor: toolName },
		}),
		...overrides,
	});
}

function bridge(agent: Agent, tools: AnyAgentTool[], events: AgentEvent[], cwd = "."): CursorExecHandlers {
	return new CursorExecHandlers({
		cwd,
		tools: new Map(tools.map(tool => [tool.name, tool])),
		prepareToolCall: (tool, toolCall) => agent.prepareExternalToolCall(tool, toolCall),
		emitEvent: event => events.push(event),
	});
}

function startOf(events: AgentEvent[], toolCallId: string) {
	return events.find(
		(event): event is Extract<AgentEvent, { type: "tool_execution_start" }> =>
			event.type === "tool_execution_start" && event.toolCallId === toolCallId,
	);
}

describe("every Cursor exec handler prepares its call", () => {
	const handlerNames = Object.getOwnPropertyNames(CursorExecHandlers.prototype).filter(name => name !== "constructor");

	it("gives each handler a call here, except the one that runs no registry tool", () => {
		expect(handlerNames.filter(name => !(name in CALLS)).sort()).toEqual(["delete"]);
		expect(Object.keys(CALLS).filter(name => !handlerNames.includes(name))).toEqual([]);
	});

	for (const [handler, call] of Object.entries(CALLS)) {
		it(`${handler} runs ${call.tool} with repaired, validated, transformed arguments and shows the display form`, async () => {
			const received: Received = new Map();
			const events: AgentEvent[] = [];
			const tools = [...new Set(Object.values(CALLS).map(c => c.tool))].map(name => recordingTool(name, received));
			const result = await call.run(bridge(markingAgent(), tools, events));

			expect(result.isError).toBe(false);
			const args = received.get(call.tool);
			expect(args).toMatchObject({ repairedFor: call.tool, expandedFor: call.tool });
			expect(args).not.toHaveProperty("shownFor");
			expect(args).not.toHaveProperty(INTENT_FIELD);

			const start = startOf(events, result.toolCallId);
			expect(start?.args).toMatchObject({ shownFor: call.tool });
			expect(start?.args).not.toHaveProperty("expandedFor");
		});
	}

	it("strips the intent field from an MCP call and carries it as the call's intent", async () => {
		const received: Received = new Map();
		const events: AgentEvent[] = [];
		const result = await CALLS.mcp.run(bridge(markingAgent(), [recordingTool(MCP_TOOL, received)], events));

		expect(received.get(MCP_TOOL)).not.toHaveProperty(INTENT_FIELD);
		expect(startOf(events, result.toolCallId)?.intent).toBe(MCP_INTENT);
	});

	it("runs delete without any registry tool", async () => {
		const received: Received = new Map();
		const events: AgentEvent[] = [];
		const tools = [...new Set(Object.values(CALLS).map(c => c.tool))].map(name => recordingTool(name, received));
		const result = await bridge(markingAgent(), tools, events).delete(
			create(DeleteArgsSchema, { toolCallId: "call-delete", path: "missing-file.txt" }),
		);

		expect(result.isError).toBe(true);
		expect(received.size).toBe(0);
	});
});

describe("a Cursor call the preparation rejects never reaches the tool", () => {
	it("answers an argument the schema rejects with the validation error", async () => {
		let ran = false;
		const strict: AnyAgentTool = {
			name: "read",
			label: "read",
			description: "takes a numeric limit",
			parameters: type({ path: "number" }),
			execute: async () => {
				ran = true;
				return { content: [{ type: "text", text: "ran" }], details: {} };
			},
		};
		const events: AgentEvent[] = [];
		const result = await bridge(new Agent({ intentTracing: true }), [strict], events).read(
			create(ReadArgsSchema, { toolCallId: "call-strict", path: "not-a-number" }),
		);

		expect(ran).toBe(false);
		expect(result.isError).toBe(true);
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain('Validation failed for tool "read"');
		expect(events.map(event => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
		const end = events[1];
		expect(end.type === "tool_execution_end" && end.isError).toBe(true);
	});

	it("answers arguments the repair hook cannot repair with its reason and hints", async () => {
		const received: Received = new Map();
		const events: AgentEvent[] = [];
		const agent = markingAgent({
			repairToolCallArguments: (_tool, toolCall) => ({
				status: "unrepairable",
				arguments: toolCall.arguments,
				hints: ["send the path as a string"],
				reason: "The path is not repairable.",
			}),
		});
		const result = await bridge(agent, [recordingTool("bash", received)], events).shellStream(
			create(ShellArgsSchema, { toolCallId: "call-unrepairable", command: "true" }),
			{ onStdout: () => {}, onStderr: () => {} },
		);

		expect(received.size).toBe(0);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "The path is not repairable.\n\n[Tool argument repair]\n- send the path as a string",
			},
		]);
		expect(events.map(event => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
	});
});

describe("the reported failure: search through the MCP channel", () => {
	it("runs a search whose arguments carry the intent field", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-search-"));
		try {
			await fs.writeFile(path.join(cwd, "sample.txt"), "hello world\nHello World\n");
			const search = new SearchTool({
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
			});
			const events: AgentEvent[] = [];
			const result = await bridge(new Agent({ intentTracing: true }), [search], events, cwd).mcp({
				name: "search",
				providerIdentifier: "pi-agent",
				toolName: "search",
				toolCallId: "call-search",
				args: { type: "text", input: "hello", path: cwd, [INTENT_FIELD]: "Finding the greeting" },
				rawArgs: {},
			});

			expect(result.isError).toBe(false);
			const details = result.details;
			expect(isRecord(details) && isRecord(details.result) ? details.result.matchCount : undefined).toBe(1);
			expect(startOf(events, "call-search")?.intent).toBe("Finding the greeting");
		} finally {
			await removeWithRetries(cwd);
		}
	});
});
