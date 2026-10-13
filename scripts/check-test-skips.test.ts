import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { REPO_ROOT } from "./workspace-layout";

describe("Cloudflare JUnit skip reporting", () => {
	it("names skipped cases from suite metadata and safely reports cases without an identity", () => {
		const directory = mkdtempSync(join(tmpdir(), "cloudflare-junit-skips-"));
		const reportDirectory = join(directory, "reports");
		mkdirSync(reportDirectory);
		try {
			writeFileSync(
				join(reportDirectory, "packages__utils--packages_utils.xml"),
				`<testsuites>
					<testsuite name="utils platform gate" classname="packages/utils/test.ts" file="packages/utils/test.ts">
						<testcase file="packages/utils/test.ts" time="0"><skipped message="private fixture text" /></testcase>
					</testsuite>
					<testsuite file="packages/utils/test.ts">
						<testcase file="packages/utils/test.ts" time="0"><skipped message="private fixture text" /></testcase>
					</testsuite>
				</testsuites>
				`,
			);

			const result = spawnSync(
				"python3",
				[join(REPO_ROOT, "ci/cloudflare/check-test-skips.py"), "report", reportDirectory],
				{ cwd: REPO_ROOT, encoding: "utf8" },
			);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			const fallbackLine = result.stdout
				.split("\n")
				.find(line => line.startsWith("CLOUDFLARE_TEST_SKIP_SUITE_FALLBACK "));
			expect(fallbackLine).toBeDefined();
			const fallback = JSON.parse(
				fallbackLine!.slice("CLOUDFLARE_TEST_SKIP_SUITE_FALLBACK ".length),
			);
			expect(fallback).toMatchObject({
				file: "packages/utils/test.ts",
				test: "packages/utils/test.ts > utils platform gate",
			});
			const unidentifiedLine = result.stdout
				.split("\n")
				.find(line => line.startsWith("CLOUDFLARE_TEST_SKIP_UNIDENTIFIED "));
			expect(unidentifiedLine).toBeDefined();
			const unidentified = JSON.parse(
				unidentifiedLine!.slice("CLOUDFLARE_TEST_SKIP_UNIDENTIFIED ".length),
			);
			expect(unidentified.junit_case).toBe(
				'<testcase file="packages/utils/test.ts" time="0"><skipped /></testcase>',
			);
			expect(result.stdout).not.toContain("private fixture text");
			const allowlist = join(directory, "allowlist.txt");
			writeFileSync(allowlist, "");
			const check = spawnSync(
				"python3",
				[
					join(REPO_ROOT, "ci/cloudflare/check-test-skips.py"),
					"check",
					reportDirectory,
					allowlist,
					"--shard",
					"1/3",
					"--expected-total",
					"99",
				],
				{ cwd: REPO_ROOT, encoding: "utf8" },
			);
			expect(check.error).toBeUndefined();
			expect(check.status).toBe(2);
			expect(check.stdout).toContain("CLOUDFLARE_TEST_SKIP_UNIDENTIFIED");
			expect(check.stdout).toContain("CLOUDFLARE_SKIP_COUNT_MISMATCH expected=99 actual=2");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("checks only this shard's named skips and reports stale entries for that shard", () => {
		const directory = mkdtempSync(join(tmpdir(), "cloudflare-junit-shard-skips-"));
		const reportDirectory = join(directory, "reports");
		mkdirSync(reportDirectory);
		try {
			writeFileSync(
				join(reportDirectory, "root.xml"),
				`<testsuite name="suite" classname="suite" file="pkg/test.ts">
					<testcase name="allowed" classname="suite" file="pkg/test.ts"><skipped /></testcase>
				</testsuite>`,
			);
			const allowlist = join(directory, "allowlist.txt");
			writeFileSync(
				allowlist,
				[
					{
						file: "pkg/test.ts",
						test: "suite > allowed",
						class: "WINDOWS",
						reason: "Windows-only platform test",
						shard: "1/3",
					},
					{
						file: "pkg/old.test.ts",
						test: "suite > removed",
						class: "E2E",
						reason: "Credential-gated external call",
						shard: "2/3",
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n"),
			);
			const runCheck = (shard: string) =>
				spawnSync(
					"python3",
					[
						join(REPO_ROOT, "ci/cloudflare/check-test-skips.py"),
						"check",
						reportDirectory,
						allowlist,
						"--shard",
						shard,
					],
					{ cwd: REPO_ROOT, encoding: "utf8" },
				);
			const matching = runCheck("1/3");
			expect(matching.error).toBeUndefined();
			expect(matching.status).toBe(0);
			expect(matching.stdout).toContain("allowlisted=1");
			const stale = runCheck("2/3");
			expect(stale.error).toBeUndefined();
			expect(stale.status).toBe(1);
			expect(stale.stdout).toContain("CLOUDFLARE_TEST_SKIP_STALE");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
