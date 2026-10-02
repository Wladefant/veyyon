import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { create } from "@bufbuild/protobuf";
import type { AgentEvent, AnyAgentTool } from "@veyyon/agent-core";
import { GrepArgsSchema, ReadArgsSchema, ShellArgsSchema } from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CursorExecHandlers } from "@veyyon/coding-agent/cursor";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import {
	createBridgeEditTool,
	cursorMcpPrefersReplaceEdit,
	normalizeCursorReplaceArgs,
} from "@veyyon/coding-agent/cursor-bridge-tools";
import { EditTool } from "@veyyon/coding-agent/edit";
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

describe("Cursor MCP StrReplace fallback", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-strreplace-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("projects CLI and replacement fields onto replace kwargs", () => {
		expect(normalizeCursorReplaceArgs({ path: "/tmp/n.txt", old_text: "a", new_text: "b", replaceAll: true })).toEqual({
			path: "/tmp/n.txt", old_string: "a", new_string: "b", replace_all: true,
		});
		expect(normalizeCursorReplaceArgs({ path: "/tmp/n.txt", input: "[n]" })).toEqual({ path: "/tmp/n.txt", input: "[n]" });
	});

	it("routes injected CLI names and replace-shaped edit onto the bridge", () => {
		expect(cursorMcpPrefersReplaceEdit("StrReplace", { path: "a", old_string: "x", new_string: "y" })).toBe(true);
		expect(cursorMcpPrefersReplaceEdit("Edit", { path: "a", old_text: "x", new_text: "y" })).toBe(true);
		expect(cursorMcpPrefersReplaceEdit("edit", { path: "a", old_string: "x", new_string: "y" })).toBe(true);
		expect(cursorMcpPrefersReplaceEdit("edit", { input: "[a#0000]\nPUT 1.=1:\n+x\n" })).toBe(false);
		expect(cursorMcpPrefersReplaceEdit("write", { path: "a", old_string: "x", new_string: "y" })).toBe(false);
	});

	it("edits a file when the server-injected StrReplace name arrives as MCP", async () => {
		const target = path.join(cwd, "note.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const session = createTestSession(cwd);
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, AnyAgentTool>([["edit", new EditTool(session)]]),
			getEditReplaceTool: () => createBridgeEditTool(session),
		});

		const result = await handlers.mcp({
			name: "StrReplace",
			toolName: "StrReplace",
			toolCallId: "sr1",
			args: { path: target, old_string: "beta", new_string: "gamma" },
			rawArgs: {},
		});

		expect(await Bun.file(target).text()).toBe("alpha\ngamma\n");
		expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("")).not.toMatch(
			/not found|not available/i,
		);
	});

	it("runs replace-mode when advertised hashline edit is called with old_string", async () => {
		const target = path.join(cwd, "note.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const session = createTestSession(cwd);
		const hashline = new EditTool(session);
		expect(hashline.mode).not.toBe("replace");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, AnyAgentTool>([["edit", hashline]]),
			getEditReplaceTool: () => createBridgeEditTool(session),
		});

		const result = await handlers.mcp({
			name: "edit",
			toolName: "edit",
			toolCallId: "e-mix",
			args: { path: target, old_text: "beta", new_text: "gamma" },
			rawArgs: {},
		});

		expect(await Bun.file(target).text()).toBe("alpha\ngamma\n");
		expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("")).not.toMatch(
			/not found|not available/i,
		);
	});

	it("does not run replace-mode for a hashline edit payload", async () => {
		const session = createTestSession(cwd);
		let replaceBuilt = 0;
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, AnyAgentTool>([["edit", new EditTool(session)]]),
			getEditReplaceTool: () => {
				replaceBuilt++;
				return createBridgeEditTool(session);
			},
		});

		await handlers.mcp({
			name: "edit",
			toolName: "edit",
			toolCallId: "e-hl",
			args: { input: "[missing.txt]\nPUT 1.=1:\n+x\n" },
			rawArgs: {},
		});

		expect(replaceBuilt).toBe(0);
	});

	it("still 404s StrReplace when edit was not granted", async () => {
		const target = path.join(cwd, "note.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, AnyAgentTool>(),
			getEditReplaceTool: () => undefined,
		});

		const result = await handlers.mcp({
			name: "StrReplace",
			toolName: "StrReplace",
			toolCallId: "sr-deny",
			args: { path: target, old_string: "beta", new_string: "gamma" },
			rawArgs: {},
		});

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("alpha\nbeta\n");
	});
});
