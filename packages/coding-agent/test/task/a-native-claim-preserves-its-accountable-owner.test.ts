import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

// Run the real Python CLI against scratch ledgers. Python's suite covers every
// transition, malformed persisted claims and stale completions; no live data is read.
test("native claims preserve accountable ownership across their lifecycle", () => {
	const suite = path.join(import.meta.dirname, "test_native_claim_preserves_owner.py");
	const result = spawnSync(process.platform === "win32" ? "python" : "python3", [suite], {
		cwd: import.meta.dirname,
		encoding: "utf8",
		timeout: 120_000,
		windowsHide: true,
	});
	expect(result.error, result.stderr).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
}, 125_000);
