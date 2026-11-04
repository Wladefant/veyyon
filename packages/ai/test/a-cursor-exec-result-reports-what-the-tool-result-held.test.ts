/**
 * WHY: Cursor reads a finished native exec from the result the client sends back, not from the tool
 * output the model saw. A read sent without its truncation flag tells Cursor the file ended where the
 * output stopped; a failed read or shell sent with a canned message hides the tool's own error; a
 * grep whose client-side cap is dropped claims it listed every file. The class closed: a mapped exec
 * result losing a fact the tool result held. Not caught: fields Cursor never reads back
 * (`executionTime`, `signal`), which the mapping sends as fixed values.
 */

import { describe, expect, it } from "bun:test";
import {
	buildGrepResultFromToolResult,
	buildReadResultFromToolResult,
	buildShellResultFromToolResult,
} from "@veyyon/ai/providers/cursor-exec-results";
import type { ToolResultMessage } from "@veyyon/ai/types";

function toolResult(text: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "tool",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		...extra,
	};
}

describe("a Cursor read result", () => {
	it("is truncated exactly when the tool result recorded a truncation", () => {
		const cut = buildReadResultFromToolResult(
			"src/a.ts",
			toolResult("one\ntwo", { details: { truncation: { truncated: true } } }),
		);
		const whole = buildReadResultFromToolResult("src/a.ts", toolResult("one\ntwo", { details: {} }));
		expect(cut.result.case === "success" && cut.result.value.truncated).toBe(true);
		expect(whole.result.case === "success" && whole.result.value.truncated).toBe(false);
		expect(whole.result.case === "success" && whole.result.value.totalLines).toBe(2);
	});

	it("carries the tool's own error text, and a fallback only when the tool gave none", () => {
		const failed = buildReadResultFromToolResult(
			"src/a.ts",
			toolResult("EACCES: permission denied", { isError: true }),
		);
		const silent = buildReadResultFromToolResult("src/a.ts", toolResult("", { isError: true }));
		expect(failed.result).toMatchObject({
			case: "error",
			value: { path: "src/a.ts", error: "EACCES: permission denied" },
		});
		expect(silent.result).toMatchObject({ case: "error", value: { path: "src/a.ts", error: "Read failed" } });
	});
});

describe("a Cursor shell result", () => {
	it("is a failure carrying the tool's error text when the tool failed", () => {
		const failed = buildShellResultFromToolResult(
			{ command: "make", workingDirectory: "/repo" },
			toolResult("make: *** No rule to make target", { isError: true }),
		);
		expect(failed.result).toMatchObject({
			case: "failure",
			value: { command: "make", workingDirectory: "/repo", stderr: "make: *** No rule to make target" },
		});
	});
});

describe("a Cursor grep result", () => {
	it("is client-truncated exactly when the tool result's `truncated` detail is true", () => {
		const files = (details: Record<string, unknown>) => {
			const grep = buildGrepResultFromToolResult(
				{ pattern: "x", outputMode: "files_with_matches" },
				toolResult("a.ts\nb.ts", { details }),
			);
			if (grep.result.case !== "success") throw new Error(`expected success, got ${grep.result.case}`);
			const union = grep.result.value.workspaceResults["."];
			if (union?.result.case !== "files") throw new Error("expected a files result");
			return union.result.value;
		};
		expect(files({ truncated: true })).toMatchObject({ files: ["a.ts", "b.ts"], clientTruncated: true });
		expect(files({ truncated: "yes" }).clientTruncated).toBe(false);
		expect(files({}).clientTruncated).toBe(false);
	});
});
