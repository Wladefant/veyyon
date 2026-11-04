import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env } from "@veyyon/utils/env";
import { withLogRedaction } from "@veyyon/utils/logger";
import { logCursorDiagnostic } from "../src/providers/cursor";

it("withholds Cursor console and file diagnostics inside gateway privacy scope only", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-private-diagnostic-"));
	const file = path.join(dir, "cursor.log");
	const previousDebug = $env.DEBUG_CURSOR;
	const previousFile = $env.DEBUG_CURSOR_LOG;
	const lines: string[] = [];
	const consoleSpy = spyOn(console, "error").mockImplementation((...args) => { lines.push(args.join(" ")); });
	try {
		$env.DEBUG_CURSOR = "verbose";
		$env.DEBUG_CURSOR_LOG = file;
		await withLogRedaction(() => '{"message":"private diagnostics withheld"}\n', async () => {
			await logCursorDiagnostic("serverMessage", "synthetic", { token: "synthetic-provider-secret" });
		});
		const scopedFile = await fs.readFile(file, "utf8");
		expect(lines.join("\n")).toContain("private diagnostics withheld");
		expect(scopedFile).toContain("private diagnostics withheld");
		expect(lines.join("\n")).not.toContain("synthetic-provider-secret");
		expect(scopedFile).not.toContain("synthetic-provider-secret");
		await logCursorDiagnostic("serverMessage", "unscoped", { text: "ordinary diagnostic" });
		expect(lines.at(-1)).toContain("ordinary diagnostic");
		expect(await fs.readFile(file, "utf8")).toContain("ordinary diagnostic");
	} finally {
		if (previousDebug === undefined) delete $env.DEBUG_CURSOR; else $env.DEBUG_CURSOR = previousDebug;
		if (previousFile === undefined) delete $env.DEBUG_CURSOR_LOG; else $env.DEBUG_CURSOR_LOG = previousFile;
		consoleSpy.mockRestore();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
