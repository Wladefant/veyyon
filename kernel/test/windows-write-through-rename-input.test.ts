import { describe, expect, it } from "bun:test";
import { windowsWriteThroughRenameSync } from "../src/session/windows-write-through-rename";

/**
 * The write-through rename checks both paths before it loads kernel32. A NUL byte is refused at that
 * point, so these cases run on every host and touch no file. The MoveFileExW call and its error-code
 * mapping are covered through the session journal in task/task-launch-grant.test.ts.
 */
describe("windowsWriteThroughRenameSync path refusal", () => {
	it("refuses a NUL byte in the source path with a TypeError", () => {
		expect(() => windowsWriteThroughRenameSync("journal\0.jsonl", "journal.jsonl")).toThrow(TypeError);
	});

	it("refuses a NUL byte in the target path with the journal message", () => {
		expect(() => windowsWriteThroughRenameSync("journal.jsonl.tmp", "journal\0.jsonl")).toThrow(
			"A journal path cannot contain a NUL character",
		);
	});
});
