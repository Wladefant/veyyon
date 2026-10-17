/**
 * WHY: CI runs each bucket's chunks one at a time, and the runner used to throw on the first failing chunk. Every
 * chunk after it never ran, so a run reported one broken chunk and hid the rest until that one was fixed, one CI round
 * per failure. The contract: every chunk runs, the process exit code is non-zero when any failed, and the closing
 * report counts and names each failed chunk.
 *
 * Not caught: a chunk that wedges until the per-chunk watchdog kills it; the watchdog bound is not exercised here.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runTestCommandsInSequence, type TestCommand } from "./ci-test-ts";

const exitWith = (label: string, code: number): TestCommand => ({
	label,
	cwd: ".",
	command: [process.execPath, "-e", `process.exit(${code})`],
});

describe("the sequential test runner", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	it("runs every chunk after a failing one and reports each failure", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-test-sequence-"));
		const marker = path.join(dir, "ran");
		const printed: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
			printed.push(stripVTControlCharacters(parts.join(" ")));
		});
		try {
			await runTestCommandsInSequence([
				exitWith("first chunk", 3),
				{
					label: "middle chunk",
					cwd: ".",
					command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
				},
				exitWith("last chunk", 4),
			]);
			const exitCode = process.exitCode;
			expect(await fs.readFile(marker, "utf8")).toBe("ran");
			expect(exitCode).toBe(1);
			const report = printed.join("\n");
			expect(report).toContain("2 of 3 test chunk(s) FAILED");
			expect(report).toContain("first chunk failed with exit code 3");
			expect(report).toContain("last chunk failed with exit code 4");
			expect(report).not.toContain("middle chunk failed");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("leaves the exit code alone when every chunk passes", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		process.exitCode = 0;
		await runTestCommandsInSequence([exitWith("one", 0), exitWith("two", 0)]);
		expect(process.exitCode).toBe(0);
	});
});
