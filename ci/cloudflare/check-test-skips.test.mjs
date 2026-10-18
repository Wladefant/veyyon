import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs the real CLI against real JUnit XML and a real allowlist file, so the tests pin the exit code and the
// printed identities the Cloudflare lane reads. They do not cover the lane shell wiring in lane-tests.sh.
const SCRIPT = fileURLToPath(new URL("./check-test-skips.py", import.meta.url));

function junitCase({ file, name, suite = "suite", skipped = false }) {
	const body = skipped ? "<skipped/>" : "";
	return `<testcase name="${name}" classname="${suite}" file="${file}">${body}</testcase>`;
}

function allowEntry({ file, name, suite = "suite", shard = "2/3", cls = "E2E" }) {
	return JSON.stringify({
		file,
		test: `${suite} > ${name}`,
		class: cls,
		reason: "requires live service",
		shard,
	});
}

// Writes one root JUnit report plus an allowlist into a fresh temp directory, runs the CLI there, and cleans up.
function runCheck({ cases = [], allowlist = [], args = [], rawReport }) {
	const dir = mkdtempSync(join(tmpdir(), "check-test-skips-"));
	try {
		const reports = join(dir, "reports");
		mkdirSync(reports);
		const xml =
			rawReport ?? `<?xml version="1.0"?><testsuites><testsuite name="s">${cases.map(junitCase).join("")}</testsuite></testsuites>`;
		writeFileSync(join(reports, "root.xml"), xml);
		const allowlistPath = join(dir, "expected-skips.txt");
		writeFileSync(allowlistPath, allowlist.map((line) => `${line}\n`).join(""));
		const result = spawnSync("python3", [SCRIPT, "check", reports, allowlistPath, ...args], {
			cwd: dir,
			encoding: "utf8",
			windowsHide: true,
		});
		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("12-shard partition passes when every executed skip is allowlisted, ignoring the stored 3-shard label", () => {
	const run = runCheck({
		cases: [
			{ file: "plugins/a.test.ts", name: "passes" },
			{ file: "plugins/a.test.ts", name: "live", skipped: true },
		],
		// The label says 3/3, but a 12-shard check must still expect this identity from the executed file.
		allowlist: [allowEntry({ file: "plugins/a.test.ts", name: "live", shard: "3/3" })],
		args: ["--shard", "2/12"],
	});
	assert.equal(run.status, 0, run.output);
	assert.match(run.output, /CLOUDFLARE_TEST_SKIP_ALLOWLISTED file="plugins\/a.test.ts" test="suite > live"/);
});

test("12-shard partition fails an unexpected skip while the other cases pass", () => {
	const run = runCheck({
		cases: [
			{ file: "plugins/a.test.ts", name: "passes" },
			{ file: "plugins/a.test.ts", name: "surprise", skipped: true },
		],
		allowlist: [],
		args: ["--shard", "1/12"],
	});
	assert.equal(run.status, 1, run.output);
	assert.match(run.output, /CLOUDFLARE_TEST_SKIP_UNLISTED file="plugins\/a.test.ts" test="suite > surprise" count=1/);
});

test("12-shard partition fails an expected skip that now runs and passes", () => {
	const run = runCheck({
		cases: [
			{ file: "plugins/a.test.ts", name: "re-enabled" },
			{ file: "plugins/a.test.ts", name: "still-skipped", skipped: true },
		],
		allowlist: [
			allowEntry({ file: "plugins/a.test.ts", name: "re-enabled" }),
			allowEntry({ file: "plugins/a.test.ts", name: "still-skipped" }),
		],
		args: ["--shard", "1/12"],
	});
	assert.equal(run.status, 1, run.output);
	assert.match(run.output, /CLOUDFLARE_TEST_SKIP_STALE file="plugins\/a.test.ts" test="suite > re-enabled" count=1/);
});

test("12-shard partition ignores an allowlist entry for a file this partition never executed", () => {
	const run = runCheck({
		cases: [{ file: "plugins/a.test.ts", name: "passes" }],
		allowlist: [allowEntry({ file: "plugins/other.test.ts", name: "elsewhere" })],
		args: ["--shard", "3/12"],
	});
	assert.equal(run.status, 0, run.output);
	assert.doesNotMatch(run.output, /CLOUDFLARE_TEST_SKIP_STALE/);
});

test("12-shard partition rejects a repeated skip beyond its one expected identity", () => {
	const run = runCheck({
		cases: [
			{ file: "plugins/a.test.ts", name: "live", skipped: true },
			{ file: "plugins/a.test.ts", name: "live", skipped: true },
		],
		allowlist: [allowEntry({ file: "plugins/a.test.ts", name: "live" })],
		args: ["--shard", "1/12"],
	});
	assert.equal(run.status, 1, run.output);
	assert.match(run.output, /CLOUDFLARE_TEST_SKIP_UNLISTED file="plugins\/a.test.ts" test="suite > live" count=1/);
});

test("12-shard partition fails closed when two allowlist entries name one identity in an executed file", () => {
	const run = runCheck({
		cases: [{ file: "plugins/a.test.ts", name: "passes" }],
		allowlist: [
			allowEntry({ file: "plugins/a.test.ts", name: "live", shard: "1/3" }),
			allowEntry({ file: "plugins/a.test.ts", name: "live", shard: "2/3" }),
		],
		args: ["--shard", "1/12"],
	});
	assert.equal(run.status, 2, run.output);
	assert.match(run.output, /CLOUDFLARE_SKIP_REPORT_ERROR duplicate expected skip/);
});

test("12-shard partition fails closed when the reports executed no test cases", () => {
	const run = runCheck({ cases: [], allowlist: [], args: ["--shard", "1/12"] });
	assert.equal(run.status, 2, run.output);
	assert.match(run.output, /CLOUDFLARE_SKIP_REPORT_ERROR 12-shard partition executed no test files/);
});

test("12-shard partition fails closed on a malformed JUnit report", () => {
	const run = runCheck({ rawReport: "<testsuites><testsuite", args: ["--shard", "1/12"] });
	assert.equal(run.status, 2, run.output);
	assert.match(run.output, /CLOUDFLARE_SKIP_REPORT_ERROR/);
});

test("12-shard partition fails closed on an expected-total count mismatch", () => {
	const run = runCheck({
		cases: [{ file: "plugins/a.test.ts", name: "live", skipped: true }],
		allowlist: [allowEntry({ file: "plugins/a.test.ts", name: "live" })],
		args: ["--shard", "1/12", "--expected-total", "2"],
	});
	assert.equal(run.status, 2, run.output);
	assert.match(run.output, /CLOUDFLARE_SKIP_COUNT_MISMATCH expected=2 actual=1/);
});

test("3-shard check still allows a repeated allowlisted identity under its own label", () => {
	const run = runCheck({
		cases: [
			{ file: "plugins/a.test.ts", name: "live", skipped: true },
			{ file: "plugins/a.test.ts", name: "live", skipped: true },
		],
		allowlist: [allowEntry({ file: "plugins/a.test.ts", name: "live", shard: "1/3" })],
		args: ["--shard", "1/3"],
	});
	assert.equal(run.status, 0, run.output);
});

test("3-shard check ignores allowlist entries labelled for another shard", () => {
	const run = runCheck({
		cases: [{ file: "plugins/a.test.ts", name: "live", skipped: true }],
		allowlist: [allowEntry({ file: "plugins/a.test.ts", name: "live", shard: "2/3" })],
		args: ["--shard", "1/3"],
	});
	assert.equal(run.status, 1, run.output);
	assert.match(run.output, /CLOUDFLARE_TEST_SKIP_UNLISTED/);
});

test("shard selector rejects an index outside its partition count", () => {
	const run = runCheck({ cases: [], allowlist: [], args: ["--shard", "13/12"] });
	assert.equal(run.status, 2, run.output);
	assert.match(run.output, /unsupported shard '13\/12'/);
});
