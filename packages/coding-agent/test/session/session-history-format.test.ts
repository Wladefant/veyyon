/**
 * Contracts: history:// transcript serializer (rework-contracts.md §5).
 *
 * - `## user` / `## assistant` headers carry full text.
 * - Thinking blocks are elided entirely.
 * - Each toolCall collapses with its toolResult into ONE `→ name(…) ⇒ …`
 *   line (ok and error variants); result bodies are never dumped.
 * - Custom messages render as one-liners (`[irc] from → me: …`).
 * - No system prompt / tool catalog sections.
 */
import { describe, expect, it } from "bun:test";
import { formatSessionHistoryMarkdown, formatSessionHistoryMarkdownAsync } from "@veyyon/coding-agent/session/session-history-format";
import { INTENT_FIELD } from "@veyyon/wire";

function buildMessages(): unknown[] {
	return [
		{ role: "user", content: "Please read the config.", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SECRET-THOUGHT about the approach" },
				{ type: "text", text: "Reading it now." },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "src/config.ts" } },
				{ type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "bun test" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "tc-2",
			toolName: "bash",
			content: [{ type: "text", text: "FAIL: 1 test failed" }],
			isError: true,
			timestamp: 4,
		},
		{
			role: "custom",
			customType: "irc:incoming",
			content: "full rendered irc prompt that must not appear",
			details: { from: "Main", message: "status update please" },
			timestamp: 5,
		},
	];
}

describe("formatSessionHistoryMarkdown", () => {
	it("renders role headers, collapses tool pairs to one line, and elides thinking", () => {
		const output = formatSessionHistoryMarkdown(buildMessages());

		expect(output).toContain("## user");
		expect(output).toContain("Please read the config.");
		expect(output).toContain("## assistant");
		expect(output).toContain("Reading it now.");

		// Thinking is elided entirely.
		expect(output).not.toContain("SECRET-THOUGHT");

		// Tool call + result collapse to one line each; bodies are not dumped.
		expect(output).toContain("→ read(src/config.ts) ⇒ ok · 3 lines");
		expect(output).not.toContain("const a = 1;");

		// Error variant carries the first line of the error output.
		expect(output).toContain("→ bash(bun test) ⇒ error · 1 line — FAIL: 1 test failed");

		// Consumed toolResults do not render a second orphan line.
		const toolLines = output.split("\n").filter(line => line.startsWith("→ "));
		expect(toolLines).toHaveLength(2);

		// Custom messages are one-liners; the rendered prompt body is dropped.
		expect(output).toContain("[irc] Main → me: status update please");
		expect(output).not.toContain("full rendered irc prompt");

		// Concise transcript: no prompt/tool-catalog sections.
		expect(output).not.toContain("System Prompt");
		expect(output).not.toContain("Available Tools");
	});

	it("prefixes an H1 title when requested", () => {
		const output = formatSessionHistoryMarkdown(buildMessages(), { title: "Spawnling (idle)" });
		expect(output.startsWith("# Spawnling (idle)\n")).toBe(true);
	});

	it("renders watched roles using bold text rather than level-2 headers when watchedRoles is true", () => {
		const output = formatSessionHistoryMarkdown(buildMessages(), { watchedRoles: true });
		expect(output).toContain("**user**:");
		expect(output).toContain("**agent**:");
		expect(output).not.toContain("## user");
		expect(output).not.toContain("## assistant");
	});

	it("renders an orphan toolResult (truncated history) as its own line", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "toolResult",
				toolCallId: "tc-orphan",
				toolName: "custom_lookup",
				content: [{ type: "text", text: "one match" }],
				isError: false,
				timestamp: 1,
			},
		]);
		expect(output).toContain("→ custom_lookup() ⇒ ok · 1 line");
	});

	it("renders search files without falling back to JSON arguments", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-search-files",
						name: "search",
						arguments: { type: "files", input: "packages/coding-agent/src/**/*.ts" },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-search-files",
				toolName: "search",
				content: [{ type: "text", text: "session-history-format.ts" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(output).toContain("→ search(files: packages/coding-agent/src/**/*.ts) ⇒ ok · 1 line");
		expect(output).not.toContain('{"paths"');
	});

	it("renders search text path scope alongside the input", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-search-text",
						name: "search",
						arguments: { type: "text", input: "PRIMARY_ARG_KEYS", path: "packages/coding-agent/src/session" },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-search-text",
				toolName: "search",
				content: [{ type: "text", text: "timed out" }],
				isError: true,
				timestamp: 2,
			},
		]);

		expect(output).toContain(
			"→ search(text: PRIMARY_ARG_KEYS @ packages/coding-agent/src/session) ⇒ error · 1 line — timed out",
		);
	});

	it("renders structure search with type, input, and path scope", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-search-struct",
						name: "search",
						arguments: {
							type: "structure",
							input: "console.log($$$)",
							path: "packages/coding-agent/src/**/*.ts",
						},
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-search-struct",
				toolName: "search",
				content: [{ type: "text", text: "match" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(output).toContain(
			"→ search(structure: console.log($$$) @ packages/coding-agent/src/**/*.ts) ⇒ ok · 1 line",
		);
	});

	it("keeps the ast_edit op pattern visible instead of only its paths scope", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-astedit",
						name: "ast_edit",
						arguments: {
							ops: [{ pat: "oldApi($$$A)", out: "newApi($$$A)" }],
							paths: ["packages/coding-agent/src/**/*.ts"],
						},
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-astedit",
				toolName: "ast_edit",
				content: [{ type: "text", text: "1 change" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(output).toContain("oldApi($$$A)");
		expect(output).not.toContain("→ ast_edit(packages/coding-agent/src/**/*.ts)");
	});

	it("renders tool intent comments immediately before tool call lines when includeToolIntent is true", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-intent",
						name: "read",
						arguments: { path: "src/config.ts", [INTENT_FIELD]: "reading config file" },
					},
					{
						type: "toolCall",
						id: "tc-long-intent",
						name: "read",
						arguments: {
							path: "src/config.ts",
							[INTENT_FIELD]:
								"reading config file with a very very long and descriptive intent that will exceed the maximum length limit of eighty characters",
						},
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "tc-intent",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
			{
				role: "toolResult",
				toolCallId: "tc-long-intent",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		];

		const outputWithIntent = formatSessionHistoryMarkdown(messages, { includeToolIntent: true });
		expect(outputWithIntent).toContain("// reading config file\n→ read(src/config.ts) ⇒ ok · 1 line");
		// The long intent should be flattened to one line and truncated to 80 characters (including ellipsis).
		expect(outputWithIntent).toContain(
			"// reading config file with a very very long and descriptive intent that will exce…\n→ read(src/config.ts) ⇒ ok · 1 line",
		);

		const outputWithoutIntent = formatSessionHistoryMarkdown(messages);
		expect(outputWithoutIntent).not.toContain("// reading config file");
		expect(outputWithoutIntent).toContain("→ read(src/config.ts) ⇒ ok · 1 line");
	});
	it("summarizes advise tool calls by their note and severity", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-advise-1",
						name: "advise",
						// Severity is intentionally placed before note so the test proves
						// PRIMARY_ARG_KEYS / the special-case picks the note, not insertion order.
						arguments: { severity: "concern", note: "Avoid shadowing the outer variable." },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-advise-1",
				toolName: "advise",
				content: [{ type: "text", text: "Recorded." }],
				isError: false,
				timestamp: 2,
			},
		];

		const output = formatSessionHistoryMarkdown(messages);
		expect(output).toContain("→ advise(concern: Avoid shadowing the outer variable.) ⇒ ok · 1 line");
		expect(output).not.toContain("Recorded.");
	});

	it("summarizes huge tool results without splitting text into line arrays", () => {
		const hugeContent = "line\n".repeat(100_000);
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-huge", name: "bash", arguments: { command: "generate" } }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-huge",
				toolName: "bash",
				content: hugeContent,
				isError: false,
				timestamp: 2,
			},
		];

		let hugeSplitCalled = false;
		const origSplit = String.prototype.split;
		String.prototype.split = (function (this: unknown, ...args: Parameters<typeof origSplit>) {
			if (this === hugeContent || (typeof this === "string" && this.length >= 500_000)) {
				hugeSplitCalled = true;
			}
			return (origSplit as Function).apply(this, args);
		}) as typeof origSplit;

		try {
			const output = formatSessionHistoryMarkdown(messages);
			expect(output).toContain("→ bash(generate) ⇒ ok · 100001 lines");
			expect(hugeSplitCalled).toBe(false);
		} finally {
			String.prototype.split = origSplit;
		}
	});

	it("summarizes massive newline-free tool errors without traversing entire string for first line", () => {
		const hugeError = "error_header " + "x".repeat(2_000_000);
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-err", name: "bash", arguments: { command: "failing" } }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-err",
				toolName: "bash",
				content: hugeError,
				isError: true,
				timestamp: 2,
			},
		];

		const output = formatSessionHistoryMarkdown(messages);
		expect(output).toContain("→ bash(failing) ⇒ error · 1 line — error_header xxxx");
	});

	it("bounds primaryArg without unbounded scanning or string allocations on giant inputs", () => {
		const giantCommand = "echo " + "y".repeat(1_000_000);
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-giant", name: "bash", arguments: { command: giantCommand } }],
				timestamp: 1,
			},
		];

		const output = formatSessionHistoryMarkdown(messages);
		expect(output).toContain("→ bash(echo yyyy");
		expect(output.length).toBeLessThan(1000);
	});

	it("aborts formatSessionHistoryMarkdownAsync during preflight of huge content arrays", async () => {
		// Array with 5,000 text parts
		const parts = Array.from({ length: 5000 }, (_, i) => ({ type: "text", text: `part ${i}` }));
		const messages = [
			{ role: "user", content: parts, timestamp: 1 },
		];

		const controller = new AbortController();
		const callerReason = new Error("aborted during preflight");
		queueMicrotask(() => {
			controller.abort(callerReason);
		});

		let error: unknown;
		try {
			await formatSessionHistoryMarkdownAsync(messages, undefined, controller.signal);
		} catch (err) {
			error = err;
		}
		expect(error).toBe(callerReason);
	});

	describe("sync/async line-count parity for block content variants", () => {
		it("maintains line-count parity for two text blocks (2 lines)", async () => {
			const messages = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-line-1", name: "read", arguments: { path: "sample.txt" } }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "tc-line-1",
					toolName: "read",
					content: [
						{ type: "text", text: "first text block" },
						{ type: "text", text: "second text block" },
					],
					isError: false,
					timestamp: 2,
				},
			];

			const syncOutput = formatSessionHistoryMarkdown(messages);
			const asyncOutput = await formatSessionHistoryMarkdownAsync(messages);

			expect(syncOutput).toBe(asyncOutput);
			expect(syncOutput).toContain("→ read(sample.txt) ⇒ ok · 2 lines");
		});

		it("maintains line-count parity for text/image/text blocks (3 lines)", async () => {
			const messages = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-line-2", name: "read", arguments: { path: "sample.txt" } }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "tc-line-2",
					toolName: "read",
					content: [
						{ type: "text", text: "header block" },
						{ type: "image", data: "fakeImageData", mimeType: "image/png" },
						{ type: "text", text: "footer block" },
					],
					isError: false,
					timestamp: 2,
				},
			];

			const syncOutput = formatSessionHistoryMarkdown(messages);
			const asyncOutput = await formatSessionHistoryMarkdownAsync(messages);

			expect(syncOutput).toBe(asyncOutput);
			expect(syncOutput).toContain("→ read(sample.txt) ⇒ ok · 3 lines");
		});

		it("maintains line-count parity for empty content array (0 lines)", async () => {
			const messages = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-line-3", name: "read", arguments: { path: "sample.txt" } }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "tc-line-3",
					toolName: "read",
					content: [],
					isError: false,
					timestamp: 2,
				},
			];

			const syncOutput = formatSessionHistoryMarkdown(messages);
			const asyncOutput = await formatSessionHistoryMarkdownAsync(messages);

			expect(syncOutput).toBe(asyncOutput);
			expect(syncOutput).toContain("→ read(sample.txt) ⇒ ok · 0 lines");
		});

		it("maintains line-count parity for single empty text block (0 lines)", async () => {
			const messages = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-line-4", name: "read", arguments: { path: "sample.txt" } }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "tc-line-4",
					toolName: "read",
					content: [{ type: "text", text: "" }],
					isError: false,
					timestamp: 2,
				},
			];

			const syncOutput = formatSessionHistoryMarkdown(messages);
			const asyncOutput = await formatSessionHistoryMarkdownAsync(messages);

			expect(syncOutput).toBe(asyncOutput);
			expect(syncOutput).toContain("→ read(sample.txt) ⇒ ok · 0 lines");
		});

		it("maintains line-count parity for two empty text blocks (2 lines from joined newline)", async () => {
			const messages = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-line-5", name: "read", arguments: { path: "sample.txt" } }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "tc-line-5",
					toolName: "read",
					content: [
						{ type: "text", text: "" },
						{ type: "text", text: "" },
					],
					isError: false,
					timestamp: 2,
				},
			];

			const syncOutput = formatSessionHistoryMarkdown(messages);
			const asyncOutput = await formatSessionHistoryMarkdownAsync(messages);

			expect(syncOutput).toBe(asyncOutput);
			expect(syncOutput).toContain("→ read(sample.txt) ⇒ ok · 2 lines");
		});
	});

	it("bounds sync nested preview of million-element ops array without traversing distant accessor", () => {
		const ops: unknown[] = new Array(1_000_000);
		ops[0] = { pat: "bounded_pattern($$$A)", out: "replacement($$$A)" };
		let traversedIndex1000 = false;
		Object.defineProperty(ops, 1000, {
			get() {
				traversedIndex1000 = true;
				throw new Error("traversed beyond bounded limit at index 1000");
			},
			configurable: true,
			enumerable: true,
		});

		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-ast-huge",
						name: "ast_edit",
						arguments: {
							ops,
							paths: ["src/file.ts"],
						},
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-ast-huge",
				toolName: "ast_edit",
				content: [{ type: "text", text: "1 change" }],
				isError: false,
				timestamp: 2,
			},
		];

		const syncOutput = formatSessionHistoryMarkdown(messages);

		expect(traversedIndex1000).toBe(false);
		expect(syncOutput).toContain("bounded_pattern($$$A)");
		expect(syncOutput.length).toBeLessThan(1000);
	});

	it("rejects async nested preview above the argument complexity cap", async () => {
		const ops: unknown[] = new Array(1_000_000);
		ops[0] = { pat: "bounded_pattern($$$A)", out: "replacement($$$A)" };
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-ast-huge-async",
						name: "ast_edit",
						arguments: { ops, paths: ["src/file.ts"] },
					},
				],
				timestamp: 1,
			},
		];

		await expect(formatSessionHistoryMarkdownAsync(messages)).rejects.toThrow(
			"Session history formatting exceeded the tool argument complexity cap",
		);
	});

	it("bounds sync primary-arg preview on large array of empty strings without traversing guarded distant accessor", () => {
		const emptyStringsArray: unknown[] = new Array(2000).fill("");
		let traversedDistantAccessor = false;
		Object.defineProperty(emptyStringsArray, 1000, {
			get() {
				traversedDistantAccessor = true;
				throw new Error("index 1000 reached in unbounded iteration");
			},
			configurable: true,
			enumerable: true,
		});

		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-empty-strings",
						name: "read",
						arguments: {
							path: emptyStringsArray,
						},
					},
				],
				timestamp: 1,
			},
		];

		const syncOutput = formatSessionHistoryMarkdown(messages);

		expect(traversedDistantAccessor).toBe(false);
		expect(syncOutput.length).toBeLessThan(1000);
	});

	it("rejects async primary-arg preview above the argument complexity cap", async () => {
		const emptyStringsArray: unknown[] = new Array(70_000).fill("");
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-empty-strings-async",
						name: "read",
						arguments: { path: emptyStringsArray },
					},
				],
				timestamp: 1,
			},
		];

		await expect(formatSessionHistoryMarkdownAsync(messages)).rejects.toThrow(
			"Session history formatting exceeded the tool argument complexity cap",
		);
	});

	it("aborts formatSessionHistoryMarkdownAsync during preflight of million-ops nested argument", async () => {
		const ops: unknown[] = new Array(1_000_000);
		ops[0] = { pat: "bounded_pattern($$$A)", out: "replacement($$$A)" };
		const controller = new AbortController();
		const callerReason = new Error("aborted during nested argument preflight");

		// Schedule abort after preflight starts via accessor near first element
		Object.defineProperty(ops, 1, {
			get() {
				setImmediate(() => {
					controller.abort(callerReason);
				});
				return { pat: "next_pattern($$$B)", out: "replacement($$$B)" };
			},
			configurable: true,
			enumerable: true,
		});

		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-nested-abort",
						name: "ast_edit",
						arguments: { ops, paths: ["src/file.ts"] },
					},
				],
				timestamp: 1,
			},
		];

		let error: unknown;
		try {
			await formatSessionHistoryMarkdownAsync(messages, undefined, controller.signal);
		} catch (err) {
			error = err;
		}
		expect(error).toBe(callerReason);
	});

	it("rejects nested oversized string exceeding the tool argument byte cap (>8MiB)", async () => {
		// 8MiB + 1024 bytes string inside nested arguments
		const oversizedString = "x".repeat(8 * 1024 * 1024 + 1024);
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-nested-oversized-string",
						name: "write",
						arguments: {
							path: "file.txt",
							content: oversizedString,
						},
					},
				],
				timestamp: 1,
			},
		];

		await expect(formatSessionHistoryMarkdownAsync(messages)).rejects.toThrow(
			"Session history formatting exceeded the 8388608 byte output cap",
		);
	});

	it("rejects nested structure exceeding depth cap (depth > 64)", async () => {
		// Build deeply nested object exceeding depth 64
		let current: Record<string, unknown> = { leaf: "val" };
		for (let d = 0; d < 70; d++) {
			current = { nested: current };
		}

		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-deep-nesting",
						name: "custom_tool",
						arguments: current,
					},
				],
				timestamp: 1,
			},
		];

		await expect(formatSessionHistoryMarkdownAsync(messages)).rejects.toThrow(
			"Session history formatting exceeded the tool argument complexity cap",
		);
	});

});
