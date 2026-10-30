/**
 * WHY: A cell's bridge intent must not leak into SearchTool's strict schema, while real
 * cross-type fields still fail validation. It also preserves a registered tool's own i.
 * Unknown-key coercion belongs to the separate validation contract, not this regression.
 */
import { describe, expect, it, vi } from "bun:test";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { callSessionTool } from "@veyyon/coding-agent/eval/js/tool-bridge";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TempDir } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { type } from "arktype";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { SEARCH_TYPES, SearchTool, type SearchType } from "@veyyon/coding-agent/tools/search/search";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

function createTool(
	name: string,
	execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<AgentToolResult>,
	parameters: AgentTool["parameters"] = type({}),
): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters,
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function createSession(tools: AgentTool[]): ToolSession {
	const registry = new Map(tools.map(tool => [tool.name, tool]));
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: name => registry.get(name),
	};
}

describe("callSessionTool", () => {
	it("keeps normalized js intent out of tools that do not declare it", async () => {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "hello" }],
		});
		const session = createSession([createTool("read", execute)]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"read",
			{ path: "/tmp/demo.txt" },
			{
				session,
				emitStatus: event => {
					statuses.push(event);
				},
			},
		);

		expect(result).toBe("hello");
		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-read-/),
			{ path: "/tmp/demo.txt" },
			undefined,
			undefined,
			undefined,
		);
		expect(statuses).toEqual([expect.objectContaining({ op: "read", path: "/tmp/demo.txt", chars: 5 })]);
	});

	it("executes a registered tool with its schema-owned intent field", async () => {
		const session = createSession([
			createTool(
				"custom",
				async (_id, args) => {
					if (!args || typeof args !== "object" || !("i" in args) || !("value" in args)) {
						throw new Error("Missing declared tool arguments");
					}
					return { content: [{ type: "text", text: `${args.i}:${args.value}` }] };
				},
				type({ i: "'tool-owned'", value: "string" }),
			),
		]);

		expect(await callSessionTool("custom", { value: "x", [INTENT_FIELD]: "tool-owned" }, { session })).toBe(
			"tool-owned:x",
		);
		await expect(callSessionTool("custom", { value: "x", [INTENT_FIELD]: "invalid" }, { session })).rejects.toThrow();
	});

	it("validates SearchTool arguments and runs every registered search type", async () => {
		using tempDir = TempDir.createSync("@js-tool-bridge-search-");
		const fixture = path.join(tempDir.path(), "fixture.ts");
		await writeFile(fixture, "function needle() { return 1; }\n");
		const base = createSession([]);
		const search = new SearchTool({ ...base, cwd: tempDir.path() } as ToolSession);
		const session = { ...base, cwd: tempDir.path(), getToolByName: (name: string) => (name === "search" ? search : undefined) };

		const inputs: Record<SearchType, string> = {
			files: "*.ts",
			text: "needle",
			structure: "function needle() { $$$BODY }",
		};
		for (const intent of [undefined, "explicit search intent"]) {
			for (const searchType of SEARCH_TYPES) {
				const args = {
					type: searchType,
					input: inputs[searchType],
					...(intent ? { [INTENT_FIELD]: intent } : {}),
				};
				const result = await callSessionTool("search", args, { session });
				expect(JSON.stringify(result)).toContain(searchType === "files" ? "fixture.ts" : "needle");
			}
		}

		const invalidFields = [
			{ type: "files", input: "*.ts", skip: 1, message: 'Search type "files" does not accept: skip.' },
			{ type: "text", input: "needle", hidden: true, message: 'Search type "text" does not accept: hidden.' },
			{ type: "structure", input: "function needle() { $$$BODY }", case: false, message: 'Search type "structure" does not accept: case.' },
		] as const;
		for (const { message, ...args } of invalidFields) {
			await expect(callSessionTool("search", args, { session })).rejects.toThrow(message);
		}
	});

	it("returns structured tool results when details or images are present", async () => {
		const session = createSession([
			createTool("custom", async () => ({
				content: [
					{ type: "text", text: "done" },
					{ type: "image", mimeType: "image/png", data: "abc123" },
				],
				details: { ok: true },
			})),
		]);

		const result = await callSessionTool("custom", {}, { session });

		expect(result).toEqual({
			text: "done",
			details: { ok: true },
			images: [{ mimeType: "image/png", data: "abc123" }],
		});
	});

	it("marks structured results when the underlying tool reports an error", async () => {
		const session = createSession([
			createTool("mcp__demo_fail", async () => ({
				content: [{ type: "text", text: "Error: bad input" }],
				details: { serverName: "demo", mcpToolName: "fail", isError: true },
			})),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"mcp__demo_fail",
			{},
			{ session, emitStatus: event => statuses.push(event) },
		);

		expect(result).toEqual({
			text: "Error: bad input",
			details: { serverName: "demo", mcpToolName: "fail", isError: true },
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "mcp__demo_fail",
				chars: 16,
				hasError: true,
				error: "Error: bad input",
			}),
		]);
	});

	it("marks results with top-level isError", async () => {
		const session = createSession([
			createTool(
				"custom",
				async () =>
					({
						content: [{ type: "text", text: "preview mismatch" }],
						isError: true,
					}) as AgentToolResult,
			),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool("custom", {}, { session, emitStatus: event => statuses.push(event) });

		expect(result).toEqual({
			text: "preview mismatch",
			details: undefined,
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "custom",
				chars: 16,
				hasError: true,
				error: "preview mismatch",
			}),
		]);
	});

	it("redacts status previews before truncating without changing the explicit result", async () => {
		const token = "credential-sentinel-123456789";
		const text = `${"x".repeat(460)} Authorization: Bearer ${token}`;
		for (const name of ["read", "bash"]) {
			const tool = createTool(name, async () => ({
				content: [{ type: "text", text }],
				details: { isError: true },
			}));
			const events: unknown[] = [];
			const result = await callSessionTool(
				name,
				{},
				{
					session: createSession([tool]),
					emitStatus: event => events.push(event),
				},
			);
			expect(JSON.stringify(events)).not.toContain("credential-sentinel");
			expect(JSON.stringify(events)).toContain("<redacted");
			expect(result).toMatchObject({ text });
		}
	});

	it("throws when the requested tool is not available in the session registry", async () => {
		const session = createSession([]);

		await expect(callSessionTool("missing", {}, { session })).rejects.toThrow("Unknown tool from js runtime");
	});
});
