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
 * 4. Summary totals are accumulated across all chunks.
 * 5. `process.exitCode` is set to 1 if any chunk fails, and remains 0 if all pass.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	extractBunSummary,
	runTestCommand,
	runTestCommandsSequentially,
	type TestCommand,
} from "./ci-test-ts";

describe("scheduler run-all-chunks contract", () => {
	const originalExitCode = process.exitCode;

	beforeEach(() => {
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
	});

	it("runTestCommand returns non-zero outcome without throwing when a chunk fails", async () => {
		const bun = Bun.which("bun") ?? "bun";
		const failingCommand: TestCommand = {
			label: "failing-chunk-test",
			cwd: ".",
			command: [bun, "-e", 'console.log("CLOUDFLARE_CHUNK_SUMMARY files=1 pass=0 fail=1 skip=0 todo=0"); process.exit(1)'],
		};

		const outcome = await runTestCommand(failingCommand);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.label).toBe("failing-chunk-test");
		const summary = extractBunSummary(outcome.output);
		expect(summary.fail).toBe(1);
	});

	it("executes all chunks and accumulates failures when an earlier chunk fails", async () => {
		const bun = Bun.which("bun") ?? "bun";
		const commands: TestCommand[] = [
			{
				label: "chunk-1-passes",
				cwd: ".",
				command: [bun, "-e", 'console.log("CLOUDFLARE_CHUNK_SUMMARY files=1 pass=5 fail=0 skip=0 todo=0"); process.exit(0)'],
			},
			{
				label: "chunk-2-fails",
				cwd: ".",
				command: [bun, "-e", 'console.log("CLOUDFLARE_CHUNK_SUMMARY files=1 pass=1 fail=2 skip=0 todo=0"); process.exit(1)'],
			},
			{
				label: "chunk-3-passes",
				cwd: ".",
				command: [bun, "-e", 'console.log("CLOUDFLARE_CHUNK_SUMMARY files=1 pass=10 fail=0 skip=0 todo=0"); process.exit(0)'],
			},
		];

		const result = await runTestCommandsSequentially(commands);

		// All 3 chunks must have executed
		expect(result.outcomes.length).toBe(3);
		expect(result.outcomes[0].label).toBe("chunk-1-passes");
		expect(result.outcomes[0].exitCode).toBe(0);
		expect(result.outcomes[1].label).toBe("chunk-2-fails");
		expect(result.outcomes[1].exitCode).toBe(1);
		expect(result.outcomes[2].label).toBe("chunk-3-passes");
		expect(result.outcomes[2].exitCode).toBe(0);

		// Failures must be accumulated
		expect(result.failures.length).toBe(1);
		expect(result.failures[0].label).toBe("chunk-2-fails");

		// Non-zero exit code must be set
		expect(process.exitCode).toBe(1);
	});

	it("leaves exitCode 0 when all chunks succeed", async () => {
		const bun = Bun.which("bun") ?? "bun";
		const commands: TestCommand[] = [
			{
				label: "chunk-pass-a",
				cwd: ".",
				command: [bun, "-e", 'console.log("CLOUDFLARE_CHUNK_SUMMARY files=1 pass=3 fail=0 skip=0 todo=0"); process.exit(0)'],
			},
			{
				label: "chunk-pass-b",
				cwd: ".",
				command: [bun, "-e", 'console.log("CLOUDFLARE_CHUNK_SUMMARY files=1 pass=7 fail=0 skip=0 todo=0"); process.exit(0)'],
			},
		];

		const result = await runTestCommandsSequentially(commands);
		expect(result.outcomes.length).toBe(2);
		expect(result.failures.length).toBe(0);
		expect(process.exitCode).toBe(0);
	});
});
