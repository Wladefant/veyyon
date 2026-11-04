import { expect, test } from "bun:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
	KernelExecutionCancelledError,
	type KernelExecutorBaseOptions,
	KernelSessionPool,
} from "../executor-base";
import {
	BaseKernel,
	initializeKernelSubprocess,
	type KernelExecuteResult,
} from "../kernel-base";

// WHY: Exercise two review-reported transition boundaries through the real pool.
// Only kernel I/O is controlled. These private cases do not prove interpreter or OS teardown.
class ControlledKernel extends BaseKernel {
	alive = true;

	constructor(id: string) {
		super(id, { languageName: "Test", traceIpc: false, shutdownGraceMs: 20 });
	}

	override isAlive(): boolean {
		return this.alive;
	}

	override async execute(): Promise<KernelExecuteResult> {
		if (!this.alive) throw new Error("retired kernel");
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
	}

	override async shutdown(): Promise<{ confirmed: boolean }> {
		this.alive = false;
		return { confirmed: true };
	}
}

class FailedKernel extends ControlledKernel {
	confirmExit = false;
	retirementGate?: Promise<void>;
	onRetirement?: () => void;

	override async executeWithBudget(): Promise<void> {
		throw new Error("prelude failed");
	}

	override async shutdown(): Promise<{ confirmed: boolean }> {
		if (this.retirementGate) {
			this.onRetirement?.();
			await this.retirementGate;
		}
		if (this.confirmExit) this.alive = false;
		return { confirmed: this.confirmExit };
	}
}

const KEY = "private-review-key";
const CWD = process.cwd();

test("two replacements behind failed-startup acquisition retirement retain one fresh runner", async () => {
	const retirementEntered = Promise.withResolvers<void>();
	const retirementGate = Promise.withResolvers<void>();
	const startupGate = Promise.withResolvers<void>();
	const original = new ControlledKernel("original");
	const failed = new FailedKernel("failed-initializer");
	const owned: ControlledKernel[] = [original, failed];
	const order: string[] = [];
	let starts = 0;
	const pending: Promise<unknown>[] = [];
	const pool = new KernelSessionPool<KernelExecutorBaseOptions, BaseKernel>({
		languageName: "Test",
		logLabel: "private-review-transition-fanout",
		startKernel: async () => {
			starts += 1;
			if (starts === 1) return original;
			if (starts === 2) {
				return await initializeKernelSubprocess(failed, {
					initScript: "init",
					preludeScript: "prelude",
					languageName: "Test",
					releaseReason: "private-prelude-failure",
				});
			}
			const kernel = new ControlledKernel(`fresh-${starts - 2}`);
			owned.push(kernel);
			order.push(`${kernel.id}-requested`);
			await startupGate.promise;
			return kernel;
		},
	});
	try {
		const session = await pool.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-a" });
		await expect(pool.replaceSessionKernel(session, CWD, {})).rejects.toThrow("prelude failed");
		expect(session.kernel).toBe(original);
		failed.confirmExit = true;
		failed.retirementGate = retirementGate.promise;
		failed.onRetirement = () => {
			order.push("failed-retirement-entered");
			retirementEntered.resolve();
		};
		const recovering = pool.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-a" });
		pending.push(recovering);
		await retirementEntered.promise;
		order.push("queue-replacement-b");
		const replacementB = pool.replaceSessionKernel(session, CWD, {});
		pending.push(replacementB);
		order.push("queue-replacement-c");
		const replacementC = pool.replaceSessionKernel(session, CWD, {});
		pending.push(replacementC);
		order.push("release-failed-retirement");
		retirementGate.resolve();
		// One event-loop turn drains cancellation/transition reactions without a wall-clock delay.
		await nextTurn();
		const freshRequestsBeforeRelease = starts - 2;
		order.push("release-fresh-readiness");
		startupGate.resolve();
		await Promise.all([recovering, replacementB, replacementC]);
		await pool.disposeAll();
		const untrackedAfterPoolDisposal = owned.filter(kernel => kernel.isAlive()).map(kernel => kernel.id);
		process.stdout.write(`[Startup770-novel] ${JSON.stringify({
			case: "retirement-fanout", starts, freshRequestsBeforeRelease, untrackedAfterPoolDisposal, order,
		})}\n`);
		expect({ freshRequestsBeforeRelease, untrackedAfterPoolDisposal }).toEqual({
			freshRequestsBeforeRelease: 1,
			untrackedAfterPoolDisposal: [],
		});
	} finally {
		failed.confirmExit = true;
		retirementGate.resolve();
		startupGate.resolve();
		await Promise.allSettled(pending);
		await pool.disposeAll();
		await Promise.all(owned.map(kernel => kernel.shutdown()));
		expect(owned.filter(kernel => kernel.isAlive()).map(kernel => kernel.id)).toEqual([]);
		process.stdout.write("[Startup770-novel] retirement-fanout finally: all fixture kernels retired\n");
	}
}, 2_000);

for (const cancellation of ["abort", "expired-deadline"] as const) {
	test(`a joining acquire honors its ${cancellation} while another owner's replacement is pending`, async () => {
		const readiness = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const original = new ControlledKernel("owner-original");
		const replacement = new ControlledKernel("owner-replacement");
		const owned = [original, replacement];
		const pending: Promise<unknown>[] = [];
		let starts = 0;
		const abort = new AbortController();
		const pool = new KernelSessionPool<KernelExecutorBaseOptions, BaseKernel>({
			languageName: "Test",
			logLabel: "private-review-transition-cancellation",
			startKernel: async () => {
				starts += 1;
				if (starts === 1) return original;
				entered.resolve();
				await readiness.promise;
				return replacement;
			},
		});
		try {
			const session = await pool.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-a" });
			const replacing = pool.replaceSessionKernel(session, CWD, {});
			pending.push(replacing);
			await entered.promise;
			let settled = false;
			const joining = pool.acquireSession(KEY, "session", CWD, {
				kernelOwnerId: "owner-b",
				...(cancellation === "abort" ? { signal: abort.signal } : { deadlineMs: Date.now() - 1 }),
			}).then(
				() => { settled = true; return { rejected: false, cancellationError: false }; },
				(error: unknown) => { settled = true; return {
					rejected: true, cancellationError: error instanceof KernelExecutionCancelledError,
				}; },
			);
			pending.push(joining);
			if (cancellation === "abort") abort.abort(new Error("joining owner cancelled"));
			await nextTurn();
			const settledBeforeReadiness = settled;
			readiness.resolve();
			await replacing;
			const outcome = await joining;
			const remaining = await pool.acquireSession(KEY, "session", CWD, { kernelOwnerId: "owner-a" });
			const ownerAUsable = remaining.kernel.isAlive() && (await remaining.kernel.execute("1 + 1")).status === "ok";
			const result = { settledBeforeReadiness, ...outcome, ownerAUsable, ownerBJoined: remaining.ownerIds.has("owner-b") };
			process.stdout.write(`[Startup770-novel] ${JSON.stringify({ case: cancellation, ...result })}\n`);
			expect(result).toEqual({
				settledBeforeReadiness: true,
				rejected: true,
				cancellationError: true,
				ownerAUsable: true,
				ownerBJoined: false,
			});
		} finally {
			readiness.resolve();
			await Promise.allSettled(pending);
			await pool.disposeAll();
			await Promise.all(owned.map(kernel => kernel.shutdown()));
			expect(owned.filter(kernel => kernel.isAlive()).map(kernel => kernel.id)).toEqual([]);
			process.stdout.write(`[Startup770-novel] ${cancellation} finally: all fixture kernels retired\n`);
		}
	}, 2_000);
}
