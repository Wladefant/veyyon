import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const TEST = path.join(import.meta.dirname, "ovh-process-group.test.py");

describe("OVH process-group lifecycle", () => {
	it.skipIf(process.platform !== "linux")("cleans the real Linux step process group", () => {
		// Process-group cleanup depends on Linux sessions, signals, and /proc state.
		const output = execFileSync("python3", [TEST], { encoding: "utf8", timeout: 20_000 });
		expect(output).toContain("ovh-process-group: 8 passed, 0 failed");
	});
});
