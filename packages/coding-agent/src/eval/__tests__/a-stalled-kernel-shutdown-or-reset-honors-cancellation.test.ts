import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Process } from "@veyyon/natives";
import type { Subprocess } from "bun";
import { useIsolatedAgentDir } from "../../../test/helpers/isolated-agent-dir";
import {
	createKernelExecutionDriver,
	KernelExecutionCancelledError,
	type KernelExecutorBaseOptions,
	KernelSessionPool,
} from "../executor-base";
import {
	BaseKernel,
	type KernelExecuteResult,
	type KernelShutdownResult,
	UnconfirmedKernelStartupError,
} from "../kernel-base";

// WHY THIS SUITE EXISTS (2026-11-15 child stall incident)
// -------------------------------------------------------
// 1. BaseKernel.#shutdown awaited native `owned.waitForExit({ timeoutMs })` with no JS-side
//    deadline, so an unreapable Windows handle or wedged native wait stalled #transitions
//    forever and prevented `eval kernel subprocess shutdown` from ever settling.
// 2. executeOnSession awaited `resetPromise` and `pool.resettingSessions` (`await inFlight`)
//    without caller cancellation (`waitForPromiseWithCancellation`), and `acquireSession` /
//    `replaceSessionKernel` awaited `#retireFailedStartup`, `#retireSession`, and `#transitions`
//    without honoring caller `signal` / `deadlineMs`.
// 3. `replaceSessionKernel` callers awaited an in-flight replacement transition directly, even
//    when their own signal or deadline expired; a second caller must cancel its wait without
//    cancelling the shared replacement used by other session owners.
//
// Gap: uses fake OS subprocess/Process handles instead of spawning a real hung Windows native
// handle; does not exercise native Rust `Process.waitForExit` itself.

useIsolatedAgentDir({ globalSettings: true });

const CWD = process.cwd();
const KEY = "stalled-eval-key";
const EXIT_PAYLOAD = JSON.stringify({ type: "exit" });

async function flushMicrotasks(turns = 4): Promise<void> {
	for (let i = 0; i < turns; i += 1) {
		await Promise.resolve();
	}
}

function createFakeSubprocess(options?: {
	exitOnExitPayload?: boolean;
	exitOnSignals?: readonly string[];
}): {
	proc: Subprocess<"pipe", "pipe", "pipe">;
	finish: (code: number | null) => void;
} {
	const encoder = new TextEncoder();
	const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number | null>();
	let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	const stdout = new ReadableStream<Uint8Array>({
		start: controller => {
			stdoutController = controller;
		},
	});
	const finish = (code: number | null): void => {
		resolveExit(code);
		try {
			stdoutController.close();
		} catch {
			/* already closed */
		}
	};
	const proc = {
		pid: 424242,
		stdin: {
			write: (chunk: string): number => {
				const msg = JSON.parse(chunk) as { type?: string; id?: string };
				if (msg.type === "exec" && msg.id) {
					const done = { type: "done", id: msg.id, status: "ok", executionCount: 1 };
					stdoutController.enqueue(encoder.encode(`${JSON.stringify(done)}\n`));
				} else if (msg.type === "exit" && (options?.exitOnExitPayload ?? true)) {
					finish(0);
				}
				return chunk.length;
			},
			flush: () => Promise.resolve(),
			end: () => Promise.resolve(),
		},
		stdout,
		stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
		exited,
		kill: (signal?: string | number) => {
			const name = typeof signal === "string" ? signal : "SIGTERM";
			if (options?.exitOnSignals?.includes(name)) {
				finish(null);
			}
		},
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
	return { proc, finish };
}

class TestKernel extends BaseKernel {
	constructor(id = "test-kernel", shutdownGraceMs = 20) {
		super(id, {
			languageName: "Python",
			traceIpc: false,
			exitPayload: EXIT_PAYLOAD,
			interruptEscalationMs: 20,
			shutdownGraceMs,
			buildPayload: (code, msgId) => JSON.stringify({ type: "exec", id: msgId, code }),
		});
	}
}

class GatedKernel extends TestKernel {
	alive = true;
	shutdownCalls = 0;
	shutdownGate?: Promise<KernelShutdownResult>;
	onShutdownStart?: () => void;

	override isAlive(): boolean {
		return this.alive;
	}

	override async execute(): Promise<KernelExecuteResult> {
		if (!this.alive) throw new Error("Python kernel exited during execution");
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
	}

	override async shutdown(): Promise<KernelShutdownResult> {
		this.shutdownCalls += 1;
		this.onShutdownStart?.();
		if (this.shutdownGate) {
			const result = await this.shutdownGate;
			if (result.confirmed) this.alive = false;
			return result;
		}
		this.alive = false;
		return { confirmed: true };
	}
}

describe("stalled kernel shutdown, reset, and transition cancellation", () => {
	const disposers: Array<() => Promise<void>> = [];

	afterEach(async () => {
		vi.useRealTimers();
		while (disposers.length > 0) {
			const dispose = disposers.pop();
			if (dispose) await dispose().catch(() => {});
		}
	});

	it("bounds BaseKernel.shutdown with a JS-side deadline and deduplicates native waitForExit per PID across retries", async () => {
		vi.useFakeTimers();
		const pendingWait = Promise.withResolvers<boolean>();
		let waitForExitCalls = 0;
		const ownedProcess = {
			pid: 424242,
			children: () => [],
			killTree: () => {},
			waitForExit: () => {
				waitForExitCalls += 1;
				return pendingWait.promise;
			},
		} as unknown as Process;

		const kernel = new TestKernel("native-hang", 20);
		const { proc } = createFakeSubprocess({ exitOnExitPayload: true });
		kernel.setProcess(proc, ownedProcess);

		let firstResult: KernelShutdownResult | undefined;
		const first = kernel.shutdown({ timeoutMs: 20 }).then(res => {
			firstResult = res;
			return res;
		});
		await flushMicrotasks();
		vi.advanceTimersByTime(100);
		await flushMicrotasks();
		expect(firstResult).toEqual({ confirmed: false });
		expect(await first).toEqual({ confirmed: false });
		expect(kernel.isAlive()).toBe(false);
		expect(waitForExitCalls).toBe(1);

		let secondResult: KernelShutdownResult | undefined;
		const second = kernel.shutdown({ timeoutMs: 20 }).then(res => {
			secondResult = res;
			return res;
		});
		await flushMicrotasks();
		vi.advanceTimersByTime(100);
		await flushMicrotasks();
		expect(secondResult).toEqual({ confirmed: false });
		expect(await second).toEqual({ confirmed: false });
		expect(waitForExitCalls).toBe(1);

		pendingWait.resolve(true);
		const recovered = await kernel.shutdown({ timeoutMs: 20 });
		expect(recovered).toEqual({ confirmed: true });
	});

	it("cancels reset=true initiators and waiting resettingSessions callers on abort or timeout, then recovers", async () => {
		vi.useFakeTimers();
		const shutdownGate = Promise.withResolvers<KernelShutdownResult>();
		const shutdownStarted = Promise.withResolvers<void>();
		const firstKernel = new GatedKernel("k-1");
		const secondKernel = new GatedKernel("k-2");
		let starts = 0;

		const driver = createKernelExecutionDriver<KernelExecutorBaseOptions, GatedKernel>({
			languageName: "Python",
			logLabel: "reset-cancel-test",
			runIdPrefix: "py",
			disposerName: `reset-cancel-test-${crypto.randomUUID()}`,
			checkKernelAvailability: async () => ({ ok: true }),
			resolveInterpreterPath: interpreter => interpreter,
			startKernel: async () => (++starts === 1 ? firstKernel : secondKernel),
		});
		disposers.push(async () => {
			shutdownGate.resolve({ confirmed: true });
			await driver.disposeAll();
		});

		const sessionId = `reset-cancel:${crypto.randomUUID()}`;
		const warm = await driver.execute("x = 1", { cwd: CWD, sessionId, kernelOwnerId: "owner-a" });
		expect(warm.exitCode).toBe(0);

		firstKernel.shutdownGate = shutdownGate.promise;
		firstKernel.onShutdownStart = () => shutdownStarted.resolve();

		const abortA = new AbortController();
		const initiator = driver.execute("x = 2", {
			cwd: CWD,
			sessionId,
			kernelOwnerId: "owner-a",
			reset: true,
			signal: abortA.signal,
		});
		await shutdownStarted.promise;

		const abortB = new AbortController();
		const waitingNonResetAbort = driver.execute("x = 3", {
			cwd: CWD,
			sessionId,
			kernelOwnerId: "owner-b",
			signal: abortB.signal,
		});
		const waitingNonResetTimeout = driver.execute("x = 4", {
			cwd: CWD,
			sessionId,
			kernelOwnerId: "owner-c",
			timeoutMs: 25,
		});
		const abortD = new AbortController();
		const waitingResetAbort = driver.execute("x = 5", {
			cwd: CWD,
			sessionId,
			kernelOwnerId: "owner-d",
			reset: true,
			signal: abortD.signal,
		});

		let settledCount = 0;
		for (const p of [initiator, waitingNonResetAbort, waitingNonResetTimeout, waitingResetAbort]) {
			void p.then(() => {
				settledCount += 1;
			});
		}

		await flushMicrotasks();
		abortA.abort(new Error("owner-a cancelled"));
		abortB.abort(new Error("owner-b cancelled"));
		abortD.abort(new Error("owner-d cancelled"));
		vi.advanceTimersByTime(30);
		await flushMicrotasks(8);

		expect(settledCount).toBe(4);
		const [resA, resB, resC, resD] = await Promise.all([
			initiator,
			waitingNonResetAbort,
			waitingNonResetTimeout,
			waitingResetAbort,
		]);
		expect(resA.cancelled).toBe(true);
		expect(resB.cancelled).toBe(true);
		expect(resC.cancelled).toBe(true);
		expect(resC.output).toContain("timed out");
		expect(resD.cancelled).toBe(true);
		expect(driver.pool.resettingSessions.size).toBe(1);

		shutdownGate.resolve({ confirmed: true });
		await flushMicrotasks(8);
		expect(driver.pool.resettingSessions.size).toBe(0);

		const afterReset = await driver.execute("x = 6", { cwd: CWD, sessionId, kernelOwnerId: "owner-e" });
		expect(afterReset.exitCode).toBe(0);
		expect(afterReset.cancelled).toBe(false);
		expect(starts).toBe(2);
	});

	it("honors caller signal and deadline when acquireSession waits on #retireFailedStartup or #retireSession", async () => {
		vi.useFakeTimers();
		const failedGate = Promise.withResolvers<KernelShutdownResult>();
		const retireGate = Promise.withResolvers<KernelShutdownResult>();
		const deadKernel = new GatedKernel("dead");
		deadKernel.alive = false;
		deadKernel.shutdownGate = Promise.resolve({ confirmed: false });
		const freshKernel = new GatedKernel("fresh");

		let starts = 0;
		const pool = new KernelSessionPool<KernelExecutorBaseOptions, GatedKernel>({
			languageName: "Python",
			logLabel: "acquire-retire-cancel",
			startKernel: async () => {
				starts += 1;
				return starts === 1 ? deadKernel : freshKernel;
			},
		});
		disposers.push(async () => {
			failedGate.resolve({ confirmed: true });
			retireGate.resolve({ confirmed: true });
			deadKernel.shutdownGate = Promise.resolve({ confirmed: true });
			await pool.disposeAll();
		});

		const session = await pool.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-a" });
		await expect(pool.resetSession(KEY)).rejects.toThrow(/shutdown was not confirmed/);
		expect(pool.hasSession(KEY, session)).toBe(true);

		deadKernel.shutdownGate = retireGate.promise;
		let timeoutOutcome: "pending" | "rejected" | "resolved" = "pending";
		const acquireTimeout = pool.acquireSession(KEY, "session", CWD, {
			kernelOwnerId: "owner-b",
			deadlineMs: Date.now() + 25,
		});
		void acquireTimeout.then(
			() => {
				timeoutOutcome = "resolved";
			},
			() => {
				timeoutOutcome = "rejected";
			},
		);
		await flushMicrotasks();
		vi.advanceTimersByTime(30);
		await flushMicrotasks();
		expect(timeoutOutcome).toBe("rejected");
		await expect(acquireTimeout).rejects.toThrow(KernelExecutionCancelledError);

		retireGate.resolve({ confirmed: true });
		await flushMicrotasks(8);

		const poolFailed = new KernelSessionPool<KernelExecutorBaseOptions, GatedKernel>({
			languageName: "Python",
			logLabel: "acquire-failed-startup-cancel",
			startKernel: async () => {
				const k = new GatedKernel("init-fail");
				k.shutdownGate = failedGate.promise;
				throw new UnconfirmedKernelStartupError(k, new Error("prelude boom"));
			},
		});
		disposers.push(async () => {
			failedGate.resolve({ confirmed: true });
			await poolFailed.disposeAll();
		});
		await expect(poolFailed.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-a" })).rejects.toThrow(
			"prelude boom",
		);
		const abortWaiter = new AbortController();
		let failedOutcome: "pending" | "rejected" | "resolved" = "pending";
		const waitingFailed = poolFailed.acquireSession(KEY, "session", CWD, {
			kernelOwnerId: "owner-b",
			signal: abortWaiter.signal,
		});
		void waitingFailed.then(
			() => {
				failedOutcome = "resolved";
			},
			() => {
				failedOutcome = "rejected";
			},
		);
		await flushMicrotasks();
		abortWaiter.abort(new Error("caller gave up"));
		await flushMicrotasks();
		expect(failedOutcome).toBe("rejected");
		await expect(waitingFailed).rejects.toThrow(KernelExecutionCancelledError);
	});

	it("honors cancellation in replaceSessionKernel while keeping shared sessions usable and not abandoning kernels", async () => {
		const shutdownGate = Promise.withResolvers<KernelShutdownResult>();
		const shutdownStarted = Promise.withResolvers<void>();
		const original = new GatedKernel("orig");
		original.alive = false;
		original.shutdownGate = shutdownGate.promise;
		original.onShutdownStart = () => shutdownStarted.resolve();

		const replacement = new GatedKernel("replacement");
		let starts = 0;
		const pool = new KernelSessionPool<KernelExecutorBaseOptions, GatedKernel>({
			languageName: "Python",
			logLabel: "replace-cancel-test",
			startKernel: async () => {
				starts += 1;
				return starts === 1 ? original : replacement;
			},
		});
		disposers.push(async () => {
			shutdownGate.resolve({ confirmed: true });
			await pool.disposeAll();
		});

		const session = await pool.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-a" });
		const replaceA = pool.replaceSessionKernel(session, CWD, { kernelOwnerId: "owner-a" });
		await shutdownStarted.promise;

		const joinB = pool.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-b" });
		const abortC = new AbortController();
		const replaceC = pool.replaceSessionKernel(session, CWD, {
			kernelOwnerId: "owner-c",
			signal: abortC.signal,
		});

		let cRejected = false;
		void replaceC.catch(() => {
			cRejected = true;
		});

		abortC.abort(new Error("owner-c cancelled"));
		await flushMicrotasks(6);

		expect(cRejected).toBe(true);
		await expect(replaceC).rejects.toThrow(KernelExecutionCancelledError);

		shutdownGate.resolve({ confirmed: true });
		const joinedSession = await joinB;
		await replaceA;
		expect(joinedSession).toBe(session);
		expect(joinedSession.kernel).toBe(replacement);
		expect(original.isAlive()).toBe(false);
		expect([...session.ownerIds]).toEqual(["owner-a", "owner-b"]);
	});

	it("allows initiating replacement caller to abort during shutdown or startup without failing other active owners", async () => {
		const shutdownGate = Promise.withResolvers<KernelShutdownResult>();
		const shutdownStarted = Promise.withResolvers<void>();
		const startGate = Promise.withResolvers<void>();
		const startEntered = Promise.withResolvers<void>();
		const original = new GatedKernel("orig-initiator");
		original.alive = false;
		original.shutdownGate = shutdownGate.promise;
		original.onShutdownStart = () => shutdownStarted.resolve();

		const replacement = new GatedKernel("replacement-initiator");
		let starts = 0;
		const receivedStartOptions: Array<{ signal?: AbortSignal; deadlineMs?: number }> = [];
		const pool = new KernelSessionPool<KernelExecutorBaseOptions, GatedKernel>({
			languageName: "Python",
			logLabel: "replace-initiator-cancel-test",
			startKernel: async (_cwd, opts) => {
				starts += 1;
				if (starts === 1) return original;
				receivedStartOptions.push({ signal: opts.signal, deadlineMs: opts.deadlineMs });
				startEntered.resolve();
				await startGate.promise;
				return replacement;
			},
		});
		disposers.push(async () => {
			shutdownGate.resolve({ confirmed: true });
			startGate.resolve();
			await pool.disposeAll();
		});

		const session = await pool.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-a" });
		const abortA = new AbortController();
		const replaceA = pool.replaceSessionKernel(session, CWD, {
			kernelOwnerId: "owner-a",
			signal: abortA.signal,
			deadlineMs: Date.now() + 50,
		});
		await shutdownStarted.promise;

		const joinB = pool.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-b" });
		abortA.abort(new Error("initiator-a cancelled during shutdown"));
		await expect(replaceA).rejects.toThrow(KernelExecutionCancelledError);

		shutdownGate.resolve({ confirmed: true });
		await startEntered.promise;
		expect(receivedStartOptions).toEqual([{ signal: undefined, deadlineMs: undefined }]);

		startGate.resolve();
		const joinedSession = await joinB;
		expect(joinedSession).toBe(session);
		expect(joinedSession.kernel).toBe(replacement);
		expect([...session.ownerIds]).toEqual(["owner-a", "owner-b"]);
	});


});
