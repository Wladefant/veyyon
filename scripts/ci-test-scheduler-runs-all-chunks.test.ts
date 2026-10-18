/**
 * The scheduler runs all chunks and accumulates errors instead of stopping on the first failure.
 *
 * WHY THIS SUITE EXISTS:
 * In CI (and sequential test runs), `runTestCommand` previously threw an Error when a chunk
 * exited with a non-zero code or timed out. Because the calling loop in `import.meta.main`
 * had no catch handler, the first failed chunk crashed the entire runner process, skipping all
 * subsequent chunks (e.g. in attempt3 shard 1, chunk 32 failure halted the runner after 30/59 chunks).
 *
 * This suite defends the contract:
 * 1. `runTestCommand` returns a `ChunkOutcome` with a non-zero `exitCode` without throwing.
 * 2. `runTestCommandsSequentially` executes every chunk in the sequence even if earlier chunks fail.
 * 3. All failed chunks are accumulated in `failures`.
 * 4. Every chunk's native Bun summary yields exact pass/fail/skip/todo counts; missing summaries fail.
 * 5. Quiet successful chunks hide test indicators while preserving summary counts, and failures keep their bytes.
 * 6. `process.exitCode` is set to 1 if any chunk fails, and remains 0 if all pass.
 */
import * as path from "node:path";
import { $which } from "@veyyon/utils";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	extractBunSummary,
	RUNNER_NONCE,
	runTestCommand,
	runTestCommandsSequentially,
	type TestCommand,
} from "./ci-test-ts";

function nativeBunSummary(pass: number, fail: number, skip = 0, todo = 0): string {
	const counts = [
		[pass, "pass"],
		[fail, "fail"],
		[skip, "skip"],
		[todo, "todo"],
	] as const;
	const total = pass + fail + skip + todo;
	const countLines = counts
		.filter(([count, name]) => count > 0 || name === "pass" || name === "fail")
		.map(([count, name]) => `${count} ${name}`);
	return (
		`${countLines.join("\n")}\nRan ${total} ${total === 1 ? "test" : "tests"} ` +
		"across 1 file. [1.00ms]\n"
	);
}

describe("scheduler run-all-chunks contract", () => {
	const originalExitCode = process.exitCode;

	beforeEach(() => {
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
	});

	it("runTestCommand returns non-zero outcome without throwing when a chunk fails", async () => {
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			const bun = $which("bun") ?? process.execPath;
			const failureBytes = "\u001b[31merror: full failure bytes\u001b[0m\n";
			const failingCommand: TestCommand = {
				label: "failing-chunk-test",
				cwd: ".",
				command: [
					bun,
					"-e",
					`process.stdout.write(${JSON.stringify(nativeBunSummary(0, 1))}); ` +
						`process.stderr.write(${JSON.stringify(failureBytes)}); process.exitCode = 1`,
				],
			};

			const outcome = await runTestCommand(failingCommand);
			expect(outcome.exitCode).toBe(1);
			expect(outcome.label).toBe("failing-chunk-test");
			expect(outcome.output).toContain(failureBytes);
			expect(extractBunSummary(outcome.output)).toEqual({
				pass: 0,
				fail: 1,
				skip: 0,
				todo: 0,
				total: 1,
				files: 1,
				hasFinalCounts: true,
			});
		} finally {
			stdoutSpy.mockRestore();
		}
	});

	it("keeps passing Bun output quiet while preserving native exact counts", async () => {
		const bun = $which("bun") ?? process.execPath;
		const testFile = path.join(import.meta.dir, "cf-runtime-sharding.test.ts");
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			const outcome = await runTestCommand({
				label: "quiet-success-chunk",
				cwd: ".",
				command: [bun, "test", testFile],
			});
			const summary = extractBunSummary(outcome.output);
			expect(outcome.exitCode).toBe(0);
			expect(outcome.output).not.toContain("accepts valid bounds");
			expect(summary.hasFinalCounts).toBe(true);
			expect(summary.pass).toBeGreaterThan(0);
			expect(summary.fail).toBe(0);
			expect(summary.skip).toBe(0);
			expect(summary.files).toBe(1);

			const runnerOutput = writes.join("");
			expect(runnerOutput).not.toContain("accepts valid bounds");
			expect(runnerOutput).toContain(
				`CLOUDFLARE_CHUNK_SUMMARY files=1 pass=${summary.pass} fail=${summary.fail} skip=${summary.skip} todo=${summary.todo}`,
			);
		} finally {
			stdoutSpy.mockRestore();
		}
	});

	it("fails loudly when Bun exits without final counts", async () => {
		const bun = $which("bun") ?? process.execPath;
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			const outcome = await runTestCommand({
				label: "missing-summary-chunk",
				cwd: ".",
				command: [bun, "test", "--help"],
			});

			expect(outcome.exitCode).toBe(1);
			expect(outcome.output).toContain("Bun test command omitted final pass/fail counts");
			expect(extractBunSummary(outcome.output).hasFinalCounts).toBe(false);
			expect(writes.join("")).toContain("CLOUDFLARE_CHUNK_SUMMARY_MISSING");
		} finally {
			stdoutSpy.mockRestore();
		}
	});

	it("executes all chunks and accumulates failures when an earlier chunk fails", async () => {
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			const bun = $which("bun") ?? process.execPath;
			const commands: TestCommand[] = [
				{
					label: "chunk-1-passes",
					cwd: ".",
					command: [
						bun,
						"-e",
						`process.stdout.write(${JSON.stringify(nativeBunSummary(5, 0, 2, 1))})`,
					],
				},
				{
					label: "chunk-2-fails",
					cwd: ".",
					command: [
						bun,
						"-e",
						`process.stdout.write(${JSON.stringify(nativeBunSummary(1, 2))}); process.exitCode = 1`,
					],
				},
				{
					label: "chunk-3-passes",
					cwd: ".",
					command: [
						bun,
						"-e",
						`process.stdout.write(${JSON.stringify(nativeBunSummary(10, 0))})`,
					],
				},
			];

			const result = await runTestCommandsSequentially(commands);

			// All 3 chunks must have executed
			expect(result.outcomes.length).toBe(3);
			expect(result.outcomes[0].label).toBe("chunk-1-passes");
			expect(result.outcomes[0].exitCode).toBe(0);
			expect(extractBunSummary(result.outcomes[0].output)).toEqual({
				pass: 5,
				fail: 0,
				skip: 2,
				todo: 1,
				total: 8,
				files: 1,
				hasFinalCounts: true,
			});
			expect(result.outcomes[1].label).toBe("chunk-2-fails");
			expect(result.outcomes[1].exitCode).toBe(1);
			expect(extractBunSummary(result.outcomes[1].output)).toEqual({
				pass: 1,
				fail: 2,
				skip: 0,
				todo: 0,
				total: 3,
				files: 1,
				hasFinalCounts: true,
			});
			expect(result.outcomes[2].label).toBe("chunk-3-passes");
			expect(result.outcomes[2].exitCode).toBe(0);
			expect(extractBunSummary(result.outcomes[2].output)).toEqual({
				pass: 10,
				fail: 0,
				skip: 0,
				todo: 0,
				total: 10,
				files: 1,
				hasFinalCounts: true,
			});

			// Failures must be accumulated
			expect(result.failures.length).toBe(1);
			expect(result.failures[0].label).toBe("chunk-2-fails");

			// Non-zero exit code must be set
			expect(process.exitCode).toBe(1);
		} finally {
			stdoutSpy.mockRestore();
		}
	});

	it("leaves exitCode 0 when all chunks succeed", async () => {
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			const bun = $which("bun") ?? process.execPath;
			const commands: TestCommand[] = [
				{
					label: "chunk-pass-a",
					cwd: ".",
					command: [bun, "-e", `process.stdout.write(${JSON.stringify(nativeBunSummary(3, 0))})`],
				},
				{
					label: "chunk-pass-b",
					cwd: ".",
					command: [bun, "-e", `process.stdout.write(${JSON.stringify(nativeBunSummary(7, 0))})`],
				},
			];

			const result = await runTestCommandsSequentially(commands);
			expect(result.outcomes.length).toBe(2);
			expect(result.failures.length).toBe(0);
			expect(extractBunSummary(result.outcomes[0].output).pass).toBe(3);
			expect(extractBunSummary(result.outcomes[1].output).pass).toBe(7);
			expect(process.exitCode).toBe(0);
		} finally {
			stdoutSpy.mockRestore();
		}
	});

	it("fixture fake skip and todo counts in earlier stdout cannot invalidate final Bun pass summary", () => {
		const outputWithFakeCounts =
			"=== mock test chunk started ===\n" +
			nativeBunSummary(5, 0, 2, 1) +
			"✓ some intermediate test passed [1.00ms]\n" +
			"\n" +
			" 160 pass\n" +
			" 0 fail\n" +
			" 1999 expect() calls\n" +
			"Ran 160 tests across 1 file. [15.00ms]\n";

		const summary = extractBunSummary(outputWithFakeCounts);
		expect(summary).toEqual({
			pass: 160,
			fail: 0,
			skip: 0,
			todo: 0,
			total: 160,
			files: 1,
			hasFinalCounts: true,
		});
		expect(summary.hasFinalCounts).toBe(true);
		expect(summary.skip).toBe(0);
		expect(summary.todo).toBe(0);
	});

	it("attaches per-run trusted nonce and planned chunk identity to summary and isolates child env", async () => {
		expect(RUNNER_NONCE).toBeDefined();
		expect(RUNNER_NONCE.length).toBe(32);

		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			const bun = $which("bun") ?? process.execPath;
			const outcome = await runTestCommand({
				label: "nonce-authenticated-chunk",
				cwd: ".",
				command: [
					bun,
					"-e",
					`if (process.env.VEYYON_RUNNER_TRUSTED_NONCE) { process.exit(2); } process.stdout.write(${JSON.stringify(nativeBunSummary(2, 0))});`,
				],
			});
			expect(outcome.exitCode).toBe(0);
			const written = writes.join("");
			expect(written).toContain(`nonce=${RUNNER_NONCE}`);
			expect(written).toContain('chunk="nonce-authenticated-chunk"');
			expect(written).toContain("CLOUDFLARE_CHUNK_SUMMARY files=0 pass=2 fail=0 skip=0 todo=0");
		} finally {
			stdoutSpy.mockRestore();
		}
	});

});
