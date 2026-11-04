import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// WHY: superseded tmp/* runs must free the runner without cancelling unrelated or exact-SHA dispatches.
// The workflow validator exercises the real YAML expressions; this test runs it on the Linux CI host.
test("OVH workflow cancels only superseded tmp runs", () => {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const output = execFileSync(process.execPath, ["scripts/validate-ovh-pr-workflow.ts"], {
		cwd: root,
		encoding: "utf8",
		timeout: 30_000,
	});
	expect(output).toContain("PASS only superseded tmp runs cancel on the same source ref");
	expect(output).toMatch(/OVH_WORKFLOW_VALIDATION cases=\d+ pass=\d+ fail=0 assertions=\d+/);
});
