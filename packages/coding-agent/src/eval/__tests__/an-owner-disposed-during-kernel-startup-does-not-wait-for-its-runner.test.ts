import { describe, expect, it, vi } from "bun:test";
import type { Process } from "@veyyon/natives";
import type { Subprocess } from "bun";
import { KernelExecutionCancelledError, type KernelExecutorBaseOptions, KernelSessionPool } from "../executor-base";
import { BaseKernel, initializeKernelSubprocess } from "../kernel-base";

// WHY THIS SUITE EXISTS (issue 639: eval runners outlive their session)
// --------------------------------------------------------------------
// `KernelSessionPool.disposeByOwner` used to await the startup promise of a kernel
// whose only owner was leaving. A runner that had not finished its startup handshake
// therefore held session disposal open for as long as the interpreter took to start,
// or forever when it never did. The owner now leaves at once and the startup releases
// its own kernel. A second defect: a waiter whose owner was disposed mid-startup
// received the kernel anyway. It now rejects.
//
// The pool and `BaseKernel` are real. Only the OS process is faked, through the same
// stdin/stdout/exited/kill seam `kernel-shutdown-confirm.test.ts` uses. A `{type:"exec"}`
// line is answered with a `done` frame, so `execute` completes through the production
// frame reader. The suite asserts which exit request and signals the runner received.
// A regression that blocks disposal hangs the test until the runner's own bun timeout
// fails it; no test timer bounds the wait.
//
// Gap: this suite does not spawn a real interpreter, and it does not test the python,
// ruby or julia startup handshakes themselves.

const EXIT_PAYLOAD = JSON.stringify({ type: "exit" });
const KEY = "shared-key";

type PipeOutcome = "settle" | "hang" | "reject";

interface RunnerBehaviour {
	/** Whether the runner exits when it receives the graceful exit request. */
	exitOnPayload: boolean;
	/** Signals that end the runner's process. */
	exitOnSignals: readonly string[];
	/** Outcome of the stdin flush that follows each write. */
	flush?: PipeOutcome;
	/** Outcome of closing stdin during shutdown. */
	end?: PipeOutcome;
}

interface FakeRunner {
	kernel: BaseKernel;
	/** Every line written to the runner's stdin, newline included. */
	writes: string[];
	/** Every signal the kernel sent to the process. */
	signals: string[];
	finish(code: number | null): void;
}

const BROKEN_PIPE = Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE", syscall: "write" });

function pipeOutcome(outcome: PipeOutcome): Promise<void> {
	switch (outcome) {
		case "settle":
			return Promise.resolve();
		case "hang":
			return new Promise<void>(() => {});
		case "reject":
			return Promise.reject(BROKEN_PIPE);
	}
}

class TestKernel extends BaseKernel {}

class FailedStartupKernel extends TestKernel {
	exitConfirmed = false;
	shutdownCalls = 0;

	constructor(readonly failAt: string, readonly shutdownThrows: boolean) {
		super("failed-startup", {
			languageName: "Test",
			traceIpc: false,
			exitPayload: EXIT_PAYLOAD,
			shutdownGraceMs: 20,
		});
	}

	override async executeWithBudget(code: string): Promise<void> {
		if (code === this.failAt) throw new Error("startup failed");
	}

	override async shutdown(): Promise<{ confirmed: boolean }> {
		this.shutdownCalls += 1;
		if (this.shutdownThrows && !this.exitConfirmed) throw new Error("shutdown failed");
		return { confirmed: this.exitConfirmed };
	}
}

function createRunner(behaviour: RunnerBehaviour, ownedProcess?: Process): FakeRunner {
	const writes: string[] = [];
	const signals: string[] = [];
	const encoder = new TextEncoder();
	const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number | null>();
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	const stdoutStream = new ReadableStream<Uint8Array>({
		start: controller => {
			stdout = controller;
		},
	});
	const finish = (code: number | null): void => {
		resolveExit(code);
		try {
			stdout.close();
		} catch {
			/* already closed */
		}
	};
	const proc = {
		stdin: {
			write: (chunk: string): number => {
				writes.push(chunk);
				const message = JSON.parse(chunk) as { type: string; id?: string };
				if (message.type === "exec") {
					const done = { type: "done", id: message.id, status: "ok", executionCount: 1 };
					stdout.enqueue(encoder.encode(`${JSON.stringify(done)}\n`));
				} else if (message.type === "exit" && behaviour.exitOnPayload) {
					finish(0);
				}
				return chunk.length;
			},
			flush: () => pipeOutcome(behaviour.flush ?? "settle"),
			end: () => pipeOutcome(behaviour.end ?? "settle"),
		},
		stdout: stdoutStream,
		stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
		exited,
		kill: (signal?: string | number) => {
			const name = typeof signal === "string" ? signal : "SIGTERM";
			signals.push(name);
			if (behaviour.exitOnSignals.includes(name)) finish(null);
		},
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
	const kernel = new TestKernel("runner", {
		languageName: "Test",
		traceIpc: false,
		exitPayload: EXIT_PAYLOAD,
		interruptEscalationMs: 20,
		shutdownGraceMs: 20,
		buildPayload: (code, msgId) => JSON.stringify({ type: "exec", id: msgId, code }),
	});
	kernel.setProcess(proc, ownedProcess);
	return { kernel, writes, signals, finish };
}

function exitRequested(writes: readonly string[]): boolean {
	return writes.some(line => line.trim() === EXIT_PAYLOAD);
}

function createPool(startKernel: () => Promise<BaseKernel>): KernelSessionPool<KernelExecutorBaseOptions, BaseKernel> {
	return new KernelSessionPool<KernelExecutorBaseOptions, BaseKernel>({
		languageName: "Test",
		logLabel: "owner-startup-test",
		startKernel: () => startKernel(),
	});
}

function acquire(pool: KernelSessionPool<KernelExecutorBaseOptions, BaseKernel>, owner: string) {
	return pool.acquireSession(KEY, "session", process.cwd(), { kernelOwnerId: owner });
}

describe("an owner disposed during kernel startup", () => {
	it("returns before the runner finishes startup, then shuts that runner down when startup completes", async () => {
		const ready = Promise.withResolvers<BaseKernel>();
		const runner = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		const pool = createPool(() => ready.promise);
		const acquiring = acquire(pool, "lane");

		await pool.disposeByOwner("lane");
		expect(pool.startingSessions.has(KEY)).toBe(true);

		ready.resolve(runner.kernel);
		await expect(acquiring).rejects.toThrow(KernelExecutionCancelledError);
		expect(exitRequested(runner.writes)).toBe(true);
		expect(runner.signals).toEqual([]);
		expect(runner.kernel.isAlive()).toBe(false);
		expect(pool.sessions.size).toBe(0);
	});

	it("a startup shared with a second owner survives the first owner's disposal and executes for the second", async () => {
		const ready = Promise.withResolvers<BaseKernel>();
		const runner = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		const pool = createPool(() => ready.promise);
		const laneA = acquire(pool, "owner-a");
		laneA.catch(() => {});
		const laneB = acquire(pool, "owner-b");

		await pool.disposeByOwner("owner-a");
		expect(pool.startingSessions.has(KEY)).toBe(true);

		ready.resolve(runner.kernel);
		const session = await laneB;
		expect(session.kernel).toBe(runner.kernel);
		expect(pool.sessions.get(KEY)).toBe(session);

		const result = await session.kernel.execute("1 + 1");
		expect(result.status).toBe("ok");
		expect(runner.kernel.isAlive()).toBe(true);
		expect(exitRequested(runner.writes)).toBe(false);
	});

	it("rejects the disposed owner's pending acquisition instead of handing it a kernel it no longer owns", async () => {
		const ready = Promise.withResolvers<BaseKernel>();
		const runner = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		const pool = createPool(() => ready.promise);
		const laneA = acquire(pool, "owner-a");
		const laneB = acquire(pool, "owner-b");
		laneB.catch(() => {});

		await pool.disposeByOwner("owner-a");

		ready.resolve(runner.kernel);
		await expect(laneA).rejects.toThrow(KernelExecutionCancelledError);
		const session = await laneB;
		expect([...session.ownerIds]).toEqual(["owner-b"]);
	});

	it("disposing an unrelated owner leaves a pending startup and its acquisition untouched", async () => {
		const ready = Promise.withResolvers<BaseKernel>();
		const runner = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		const pool = createPool(() => ready.promise);
		const laneA = acquire(pool, "owner-a");

		await pool.disposeByOwner("unrelated-owner");
		expect(pool.startingSessions.has(KEY)).toBe(true);

		ready.resolve(runner.kernel);
		const session = await laneA;
		expect(session.kernel).toBe(runner.kernel);
		expect(runner.kernel.isAlive()).toBe(true);
		expect(exitRequested(runner.writes)).toBe(false);
	});

	it("an aborted startup waiter rejects before startup completes, and its runner shuts down once startup completes", async () => {
		const ready = Promise.withResolvers<BaseKernel>();
		const runner = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		const pool = createPool(() => ready.promise);
		const abort = new AbortController();
		const acquiring = pool.acquireSession(KEY, "session", process.cwd(), {
			kernelOwnerId: "lane",
			signal: abort.signal,
		});
		const starting = pool.startingSessions.get(KEY)?.promise;

		abort.abort(new Error("lane cancelled"));
		await expect(acquiring).rejects.toThrow(KernelExecutionCancelledError);

		ready.resolve(runner.kernel);
		await starting;
		expect(exitRequested(runner.writes)).toBe(true);
		expect(runner.kernel.isAlive()).toBe(false);
		expect(pool.startingSessions.size).toBe(0);
		expect(pool.sessions.size).toBe(0);
	});

	it("replacing a live kernel whose graceful exit pipe never settles escalates to SIGTERM and runs the replacement", async () => {
		const old = createRunner({ exitOnPayload: false, exitOnSignals: ["SIGTERM"], end: "hang" });
		const replacement = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		let starts = 0;
		const pool = createPool(() => Promise.resolve(++starts === 1 ? old.kernel : replacement.kernel));
		const session = await acquire(pool, "lane");

		await pool.replaceSessionKernel(session, process.cwd(), { kernelOwnerId: "lane" });

		expect(old.signals).toEqual(["SIGTERM"]);
		expect(old.kernel.isAlive()).toBe(false);
		expect(session.kernel).toBe(replacement.kernel);
		expect(starts).toBe(2);
	});

	it("a fallback-owner startup that a real owner joins completes for both, and the real owner's disposal closes the runner", async () => {
		const ready = Promise.withResolvers<BaseKernel>();
		const runner = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		const pool = createPool(() => ready.promise);
		const fallback = pool.acquireSession(KEY, "session", process.cwd(), {});
		const real = acquire(pool, "lane");

		ready.resolve(runner.kernel);
		const [fallbackSession, realSession] = await Promise.all([fallback, real]);
		expect(realSession).toBe(fallbackSession);
		expect([...realSession.ownerIds]).toEqual(["lane"]);
		expect(realSession.hasFallbackOwner).toBe(false);

		await pool.disposeByOwner("lane");
		expect(exitRequested(runner.writes)).toBe(true);
		expect(runner.kernel.isAlive()).toBe(false);
		expect(pool.sessions.size).toBe(0);
	});

	it("does not start another runner while an owned runner's disposal awaits exit", async () => {
		const old = createRunner({ exitOnPayload: false, exitOnSignals: [] });
		const next = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		let starts = 0;
		const pool = createPool(async () => ++starts === 1 ? old.kernel : next.kernel);
		const original = await acquire(pool, "old-owner");
		const disposing = pool.disposeByOwner("old-owner");
		const acquiring = acquire(pool, "next-owner");
		expect(starts).toBe(1);
		expect(pool.sessions.get(KEY)).toBe(original);
		expect([...original.ownerIds]).toEqual(["old-owner"]);

		old.finish(0);
		await disposing;
		const replacement = await acquiring;
		expect(starts).toBe(2);
		expect(replacement.kernel).toBe(next.kernel);
		expect([...replacement.ownerIds]).toEqual(["next-owner"]);
		await pool.disposeByOwner("next-owner");
	});

	it("coalesces concurrent replacements behind the old runner's exit", async () => {
		const old = createRunner({ exitOnPayload: false, exitOnSignals: [] });
		const next = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		let starts = 0;
		const pool = createPool(async () => ++starts === 1 ? old.kernel : next.kernel);
		const session = await acquire(pool, "lane");
		const first = pool.replaceSessionKernel(session, process.cwd(), { kernelOwnerId: "lane" });
		const second = pool.replaceSessionKernel(session, process.cwd(), { kernelOwnerId: "lane" });
		expect(starts).toBe(1);
		old.finish(0);
		await Promise.all([first, second]);
		expect(starts).toBe(2);
		expect(session.kernel).toBe(next.kernel);
		await pool.disposeByOwner("lane");
	});

	it("does not confirm a root exit until its owned descendants also exit", async () => {
		let descendantExited = false;
		const bounds: number[] = [];
		const child = {
			pid: 900002,
			children: () => [],
			waitForExit: async (options: { timeoutMs: number }) => {
				bounds.push(options.timeoutMs);
				return descendantExited;
			},
		};
		const root = {
			pid: 900001,
			children: () => [child],
			waitForExit: async () => true,
		} as unknown as Process;
		const runner = createRunner({ exitOnPayload: true, exitOnSignals: [] }, root);
		const first = runner.kernel.shutdown({ timeoutMs: 20 });
		const duplicate = runner.kernel.shutdown({ timeoutMs: 20 });
		expect(first).toBe(duplicate);
		expect(await first).toEqual({ confirmed: false });
		expect(bounds).toEqual([20]);
		descendantExited = true;
		expect(await runner.kernel.shutdown({ timeoutMs: 20 })).toEqual({ confirmed: true });
		expect(bounds).toEqual([20, 20]);
	});

	it("keeps a shared startup usable when its first caller aborts", async () => {
		const ready = Promise.withResolvers<BaseKernel>();
		const runner = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		let startupDeadline: number | undefined;
		const pool = new KernelSessionPool<KernelExecutorBaseOptions, BaseKernel>({
			languageName: "Test",
			logLabel: "shared-startup-cancellation",
			startKernel: async (_cwd, options) => {
				// Model the external startup's real abort-to-process-exit boundary.
				startupDeadline = options.deadlineMs;
				options.signal?.addEventListener("abort", () => runner.finish(null), { once: true });
				return await ready.promise;
			},
		});
		const abort = new AbortController();
		const first = pool.acquireSession(KEY, "session", process.cwd(), {
			kernelOwnerId: "first",
			signal: abort.signal,
			deadlineMs: Date.now() + 60_000,
		});
		const shared = acquire(pool, "shared");
		abort.abort(new Error("first owner left"));
		await expect(first).rejects.toThrow(KernelExecutionCancelledError);
		ready.resolve(runner.kernel);
		const session = await shared;
		expect([...session.ownerIds]).toEqual(["shared"]);
		expect(startupDeadline).toBeUndefined();
		expect(session.kernel.isAlive()).toBe(true);
		expect((await session.kernel.execute("1 + 1")).status).toBe("ok");
		await pool.disposeByOwner("shared");
	});
	it("keeps shared startup alive when the first waiter's deadline expires", async () => {
		vi.useFakeTimers();
		try {
			const ready = Promise.withResolvers<BaseKernel>();
			const runner = createRunner({ exitOnPayload: true, exitOnSignals: [] });
			const pool = new KernelSessionPool<KernelExecutorBaseOptions, BaseKernel>({
				languageName: "Test",
				logLabel: "shared-startup-deadline",
				startKernel: async (_cwd, options) => {
					if (options.deadlineMs !== undefined) {
						setTimeout(
							() => runner.finish(null),
							Math.max(0, options.deadlineMs - Date.now()),
						);
					}
					options.signal?.addEventListener("abort", () => runner.finish(null), { once: true });
					return await ready.promise;
				},
			});
			const first = pool.acquireSession(KEY, "session", process.cwd(), {
				kernelOwnerId: "first",
				deadlineMs: Date.now() + 30,
			});
			const shared = acquire(pool, "shared");
			vi.advanceTimersByTime(30);
			await expect(first).rejects.toThrow(KernelExecutionCancelledError);
			ready.resolve(runner.kernel);
			const session = await shared;
			expect([...session.ownerIds]).toEqual(["shared"]);
			expect(session.kernel.isAlive()).toBe(true);
			expect((await session.kernel.execute("1 + 1")).status).toBe("ok");
			await pool.disposeByOwner("shared");
		} finally {
			vi.useRealTimers();
		}
	});
	for (const failAt of ["init", "prelude"]) {
		for (const shutdownThrows of [false, true]) {
			it(`fences ${failAt} failure when shutdown ${shutdownThrows ? "throws" : "is unconfirmed"}`, async () => {
				const failed = new FailedStartupKernel(failAt, shutdownThrows);
				const replacement = createRunner({ exitOnPayload: true, exitOnSignals: [] });
				let starts = 0;
				const pool = new KernelSessionPool<KernelExecutorBaseOptions, BaseKernel>({
					languageName: "Test",
					logLabel: "failed-startup-exit-fence",
					startKernel: async () => {
						starts += 1;
						return starts === 1
							? await initializeKernelSubprocess(failed, {
									initScript: "init",
									preludeScript: "prelude",
									languageName: "Test",
									releaseReason: "startup-failed",
								})
							: replacement.kernel;
					},
				});
				await expect(acquire(pool, "owner")).rejects.toThrow("startup failed");
				expect(failed.shutdownCalls).toBe(1);
				await expect(acquire(pool, "owner")).rejects.toThrow(/shutdown/);
				expect(starts).toBe(1);
				expect(failed.shutdownCalls).toBe(2);
				await pool.disposeByOwner("owner");
				expect(failed.shutdownCalls).toBe(3);
				await pool.disposeAll();
				expect(failed.shutdownCalls).toBe(4);
				await expect(pool.resetSession(KEY)).rejects.toThrow(/shutdown/);
				expect(failed.shutdownCalls).toBe(5);
				expect(starts).toBe(1);
				failed.exitConfirmed = true;
				const session = await acquire(pool, "owner");
				expect(failed.shutdownCalls).toBe(6);
				expect(starts).toBe(2);
				expect(session.kernel).toBe(replacement.kernel);
				await pool.disposeByOwner("owner");
			}, 1_000);
		}
	}

	it("fences a failed replacement before another replacement or acquisition can start", async () => {
		const original = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		const failed = new FailedStartupKernel("prelude", false);
		const replacement = createRunner({ exitOnPayload: true, exitOnSignals: [] });
		let starts = 0;
		const pool = new KernelSessionPool<KernelExecutorBaseOptions, BaseKernel>({
			languageName: "Test",
			logLabel: "failed-replacement-exit-fence",
			startKernel: async () => {
				starts += 1;
				if (starts === 1) return original.kernel;
				if (starts === 2) {
					return await initializeKernelSubprocess(failed, {
						initScript: "init",
						preludeScript: "prelude",
						languageName: "Test",
						releaseReason: "replacement-failed",
					});
				}
				return replacement.kernel;
			},
		});
		const session = await acquire(pool, "owner");
		await expect(pool.replaceSessionKernel(session, process.cwd(), {})).rejects.toThrow("startup failed");
		await expect(pool.replaceSessionKernel(session, process.cwd(), {})).rejects.toThrow(/shutdown/);
		await expect(acquire(pool, "owner")).rejects.toThrow(/shutdown/);
		expect(starts).toBe(2);
		failed.exitConfirmed = true;
		await Promise.all([
			pool.replaceSessionKernel(session, process.cwd(), {}),
			pool.replaceSessionKernel(session, process.cwd(), {}),
		]);
		expect(starts).toBe(3);
		expect(session.kernel).toBe(replacement.kernel);
		await pool.disposeByOwner("owner");
	}, 1_000);
});
