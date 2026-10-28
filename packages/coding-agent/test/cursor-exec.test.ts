import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { create } from "@bufbuild/protobuf";
import type { AgentEvent, AnyAgentTool } from "@veyyon/agent-core";
import { prepareToolCall } from "@veyyon/agent-core/tool-call-preparation";
import { GrepArgsSchema, ReadArgsSchema, ShellArgsSchema } from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CursorExecHandlers } from "@veyyon/coding-agent/cursor";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import { isRecord, removeWithRetries } from "@veyyon/utils";
import { type } from "arktype";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function textMatchCount(details: unknown): number | undefined {
	if (!isRecord(details) || details.type !== "text" || !isRecord(details.result)) return undefined;
	return typeof details.result.matchCount === "number" ? details.result.matchCount : undefined;
}

describe("CursorExecHandlers.grep bridge", () => {
	let cwd: string;
	let searchTool: SearchTool;
	let handlers: CursorExecHandlers;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-exec-test-"));
		await Bun.write(path.join(cwd, "sample.txt"), "Hello World\nhello world\n");
		searchTool = new SearchTool(createTestSession(cwd));
		handlers = new CursorExecHandlers({
			cwd,
			prepareToolCall: (tool, toolCall) => prepareToolCall(tool, toolCall, {}),
			tools: new Map<string, AnyAgentTool>([["search", searchTool]]),
		});
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("maps caseInsensitive parameter correctly through the grep bridge", async () => {
		// 1. By default/omitted caseInsensitive, should be case-sensitive (match count 1 for "hello")
		const defaultResult = await handlers.grep(
			create(GrepArgsSchema, {
				toolCallId: "call-1",
				path: cwd,
				pattern: "hello",
			}),
		);
		expect(textMatchCount(defaultResult.details)).toBe(1);

		// 2. If caseInsensitive: true, should be case-insensitive (match count 2 for "hello")
		const insensitiveResult = await handlers.grep(
			create(GrepArgsSchema, {
				toolCallId: "call-2",
				path: cwd,
				pattern: "hello",
				caseInsensitive: true,
			}),
		);
		expect(textMatchCount(insensitiveResult.details)).toBe(2);

		// 3. If caseInsensitive: false, should be case-sensitive (match count 1 for "hello")
		const sensitiveResult = await handlers.grep(
			create(GrepArgsSchema, {
				toolCallId: "call-3",
				path: cwd,
				pattern: "hello",
				caseInsensitive: false,
			}),
		);
		expect(textMatchCount(sensitiveResult.details)).toBe(1);
	});
});

describe("CursorExecHandlers error results", () => {
	const rewrittenErrorTool = (name: string): AnyAgentTool => ({
		name,
		label: name,
		description: "returns a rewritten tool failure",
		parameters: type({}),
		execute: async () => ({
			content: [{ type: "text", text: "Enriched recovery guidance" }],
			details: { enriched: true },
			isError: true,
		}),
	});

	it("propagates returned isError through the standard exec bridge", async () => {
		const events: AgentEvent[] = [];
		const handlers = new CursorExecHandlers({
			cwd: ".",
			prepareToolCall: (tool, toolCall) => prepareToolCall(tool, toolCall, {}),
			tools: new Map([["read", rewrittenErrorTool("read")]]),
			emitEvent: event => events.push(event),
		});

		const result = await handlers.read(create(ReadArgsSchema, { toolCallId: "call-read", path: "ignored" }));
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Enriched recovery guidance" }]);
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.isError).toBe(true);
	});

	it("propagates returned isError through the shell stream bridge", async () => {
		const events: AgentEvent[] = [];
		const stdout: string[] = [];
		const handlers = new CursorExecHandlers({
			cwd: ".",
			prepareToolCall: (tool, toolCall) => prepareToolCall(tool, toolCall, {}),
			tools: new Map([["bash", rewrittenErrorTool("bash")]]),
			emitEvent: event => events.push(event),
		});

		const result = await handlers.shellStream(
			create(ShellArgsSchema, { toolCallId: "call-shell", command: "ignored" }),
			{
				onStdout: data => stdout.push(data),
				onStderr: () => {},
			},
		);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Enriched recovery guidance" }]);
		expect(stdout).toEqual(["Enriched recovery guidance"]);
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.isError).toBe(true);
	});
});

describe("the shell stream bridge streams every text block of a result", () => {
	const multiBlockTool: AnyAgentTool = {
		name: "bash",
		label: "bash",
		description: "streams output split across several content blocks",
		parameters: type({}),
		execute: async (_id, _params, _signal, onUpdate) => {
			onUpdate?.({
				content: [
					{ type: "text", text: "one " },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: "two" },
				],
				details: {},
			});
			return {
				content: [
					{ type: "text", text: "one " },
					{ type: "text", text: "two" },
					{ type: "text", text: " three" },
				],
				details: {},
			};
		},
	};

	it("concatenates the text blocks of each update and of the final result, dropping images", async () => {
		const events: AgentEvent[] = [];
		const stdout: string[] = [];
		const handlers = new CursorExecHandlers({
			cwd: ".",
			prepareToolCall: (tool, toolCall) => prepareToolCall(tool, toolCall, {}),
			tools: new Map([["bash", multiBlockTool]]),
			emitEvent: event => events.push(event),
		});

		await handlers.shellStream(create(ShellArgsSchema, { toolCallId: "call-multi", command: "ignored" }), {
			onStdout: data => stdout.push(data),
			onStderr: () => {},
		});
		expect(stdout).toEqual(["one two", " three"]);
		const update = events.find(event => event.type === "tool_execution_update");
		expect(update?.type === "tool_execution_update" && update.partialResult.content).toEqual([
			{ type: "text", text: "one two" },
		]);
	});
});
