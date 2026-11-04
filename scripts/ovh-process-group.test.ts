import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const TEST = path.join(import.meta.dirname, "ovh-process-group.test.py");
// Let the Linux lifecycle fixture finish or reach its 60-second child deadline before Bun stops this test.
const LIFECYCLE_TEST_TIMEOUT_MS = 75_000;

describe("OVH process-group lifecycle", () => {
	it.skipIf(process.platform !== "linux")(
		"cleans the real Linux step process group",
		() => {
			// Process-group cleanup depends on Linux sessions, signals, and /proc state.
			const output = execFileSync("python3", [TEST], { encoding: "utf8", timeout: 60_000 });
			expect(output).toContain("ovh-process-group: 13 passed, 0 failed");
		},
		LIFECYCLE_TEST_TIMEOUT_MS,
	);
});
