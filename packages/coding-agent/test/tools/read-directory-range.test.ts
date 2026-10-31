import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { toolResultText } from "../helpers/tool-result-text";
import { makeWorkspaceToolSession } from "../helpers/tool-session";

describe("read tool directory listings honor line selectors (regression: was silently dropping offset)", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-range-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		for (let i = 1; i <= 60; i++) {
			fs.writeFileSync(path.join(testDir, `file-${String(i).padStart(3, "0")}.txt`), "");
		}
		tool = new ReadTool(makeWorkspaceToolSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("returns the full listing when no selector is given", async () => {
		const result = await tool.execute("call-bare", { path: testDir });
		const output = toolResultText(result);

		expect(result.details?.isDirectory).toBe(true);
		expect(output).toContain("file-001.txt");
		expect(output).toContain("file-060.txt");
	});

	it("returns a slice of the listing for `:start-end`", async () => {
		const result = await tool.execute("call-range", { path: `${testDir}:30-40` });
		const output = toolResultText(result);
		const lines = output.split("\n").filter(line => line.includes("file-"));

		// 11-line window (30..40 inclusive) — every line in the slice must be a file row.
		expect(lines.length).toBeLessThanOrEqual(11);
		// "Use :N to continue" pagination hint when more entries remain.
		expect(output).toContain("more lines in listing");
		expect(output).toContain("Use :41 to continue");
	});

	it("returns from offset to end for `:start`", async () => {
		const result = await tool.execute("call-offset", { path: `${testDir}:30` });
		const output = toolResultText(result);
		const lines = output.split("\n").filter(line => line.includes("file-"));

		// 60 files + a header line; offset 30 leaves roughly 31 trailing lines.
		expect(lines.length).toBeGreaterThan(10);
		// No "continue" footer when we reach EOF.
		expect(output).not.toContain("Use :");
	});

	it("emits a clear `beyond end` notice instead of returning an empty body", async () => {
		const result = await tool.execute("call-beyond", { path: `${testDir}:9999` });
		const output = toolResultText(result);

		expect(output).toMatch(/Line 9999 is beyond end of listing/);
		expect(output).toMatch(/lines total/);
	});
});
