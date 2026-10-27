/**
 * WHY THIS SUITE EXISTS. A kernel whose runner exited during startup (a missing runner script, an
 * interpreter that crashes on import) reached the cell as a cancellation: the start threw an
 * `AbortError`, the executor maps every abort to a cancelled result, and the cell came back empty with
 * no exit code and nothing stating that the kernel never started.
 *
 * THE CLASS THIS CLOSES: a start that ended for any reason other than its own abort is reported as a
 * cancellation. Only the caller's signal and the startup budget cancel a start; every other ending is
 * a failure that states why. These arms drive `launchKernelSubprocess`, the one start path Python,
 * Ruby and Julia share, with a real subprocess, so they need no interpreter.
 *
 * WHAT THIS DOES NOT CATCH: the runner's stderr is logged, not carried in the error, so the message
 * states the exit code and not the interpreter's own explanation.
 */
import { describe, expect, it } from "bun:test";
import {
	BaseKernel,
	type KernelSubprocessRuntime,
	launchKernelSubprocess,
} from "@veyyon/coding-agent/eval/kernel-base";
import { TempDir } from "@veyyon/utils";

class TestKernel extends BaseKernel {}

/** Start a kernel whose runner is `bun -e <runner>`, and return how the start ended. */
async function startWith(runner: string, options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<Error> {
	using tempDir = TempDir.createSync("@kernel-start-");
	const runtime: KernelSubprocessRuntime = { env: {} };
	try {
		const kernel = await launchKernelSubprocess<TestKernel>({
			languageName: "Test",
			options: { cwd: tempDir.path(), ...options },
			checkAvailability: async () => ({ ok: true, runtime }),
			resolveRuntimeFallback: () => runtime,
			ensureRunnerScript: async () => runner,
			createKernel: id =>
				new TestKernel(id, { languageName: "Test", interruptEscalationMs: 200, shutdownGraceMs: 200 }),
			getExecutableCommand: (_runtime, script) => [process.execPath, "-e", script],
			getSpawnEnv: () => ({ PATH: process.env.PATH ?? "" }),
			initScript: "init",
			preludeScript: "prelude",
			releaseReason: "test-kernel-startup-failed",
		});
		await kernel.shutdown();
		throw new Error("the kernel started");
	} catch (error) {
		return error as Error;
	}
}

/** A runner that reads requests and never answers one, so only an abort or the budget ends the start. */
const SILENT_RUNNER = "process.stdin.resume(); setInterval(() => {}, 1_000);";

describe("a kernel start", () => {
	it("fails with the runner's exit code when the runner exits before it answers", async () => {
		const error = await startWith("process.exit(3)");

		expect(error.name).toBe("Error");
		expect(error.message).toBe("Test kernel init failed: Test kernel exited with code 3");
	});

	it("is cancelled, not failed, when the caller aborts it", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);

		const error = await startWith(SILENT_RUNNER, { signal: controller.signal });

		expect(error.name).toBe("AbortError");
	});

	it("times out, not fails, when the runner outlasts the startup budget", async () => {
		const error = await startWith(SILENT_RUNNER, { deadlineMs: Date.now() + 200 });

		expect(error.name).toBe("TimeoutError");
	});
});
