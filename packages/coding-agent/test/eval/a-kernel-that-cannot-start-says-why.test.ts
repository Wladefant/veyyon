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
 * The race arms stand a stub in for the subprocess, because the ordering they pin cannot be forced
 * with a real one: the init write breaks on the closed pipe before the exit is observed. That
 * ordering reported `EPIPE: broken pipe, write` in place of the exit code. A write that breaks
 * waits for the exit within the shutdown grace, and a runner that never exits still ends the start
 * inside that grace.
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
import type { Subprocess } from "bun";

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

const GRACE_MS = 200;

/** A subprocess whose stdin is already closed: every write throws EPIPE, and it exits when told to. */
function closedPipeProcess(): { proc: Subprocess<"pipe", "pipe", "pipe">; exit: (code: number) => void } {
	const { promise: exited, resolve: exit } = Promise.withResolvers<number>();
	const closedOnExit = () =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				void exited.then(() => controller.close());
			},
		});
	const stub = {
		pid: 0,
		exited,
		stdin: {
			write(): number {
				throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
			},
			flush(): void {},
			end(): void {},
		},
		stdout: closedOnExit(),
		stderr: closedOnExit(),
		kill(): void {},
	};
	return { proc: stub as unknown as Subprocess<"pipe", "pipe", "pipe">, exit };
}

/** Run the init step against `proc` and return how it ended and how long it took. */
async function initAgainst(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<{ error: Error; elapsedMs: number }> {
	const kernel = new TestKernel("race", {
		languageName: "Test",
		interruptEscalationMs: GRACE_MS,
		shutdownGraceMs: GRACE_MS,
	});
	kernel.setProcess(proc);
	const started = performance.now();
	try {
		await kernel.executeWithBudget("init", undefined, 10_000, "Test kernel init");
		throw new Error("the init step succeeded");
	} catch (error) {
		return { error: error as Error, elapsedMs: performance.now() - started };
	}
}

describe("a kernel start", () => {
	it("fails with the runner's exit code when the runner exits before it answers", async () => {
		const error = await startWith("process.exit(3)");

		expect(error.name).toBe("Error");
		expect(error.message).toBe("Test kernel init failed: Test kernel exited with code 3");
	});

	it("names the exit code, not the broken pipe, when the write loses the race to the exit", async () => {
		const { proc, exit } = closedPipeProcess();
		setTimeout(() => exit(3), 20);

		const { error } = await initAgainst(proc);

		expect(error.message).toBe("Test kernel init failed: Test kernel exited with code 3");
	});

	it("ends inside the shutdown grace, naming the broken pipe, when the runner never exits", async () => {
		const { proc } = closedPipeProcess();

		const { error, elapsedMs } = await initAgainst(proc);

		expect(error.message).toBe("Test kernel init failed: EPIPE: broken pipe, write");
		expect(elapsedMs).toBeGreaterThanOrEqual(GRACE_MS - 5);
		expect(elapsedMs).toBeLessThan(GRACE_MS + 1_000);
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
