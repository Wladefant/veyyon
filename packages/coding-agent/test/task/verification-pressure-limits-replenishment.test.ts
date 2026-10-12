// WHY: Verification agents used to share no runtime pressure state with the producer scheduler. These
// tests cover real spawn/completion identities, preserve active work, and prove one deficit resumes only
// after the last verifier finishes. They do not validate task wording or the verifier's quality.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "bun:test";
import {
	claimNextAuthorizedTicket,
	rollbackClaimedTicket,
	TopicReplenishmentEngine,
	type MemoryMeasurement,
	type NativeActorSnapshot,
} from "../../src/task/topic-replenishment";


const authorization = {
	status: "authorized",
	timestamp: "2026-09-06T10:00:00Z",
	scope: "staging",
	authorized_by: "operator",
};

async function withLedger<T>(requests: Record<string, Record<string, unknown>>, run: (path: string) => Promise<T>) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "veyyon-verification-pressure-"));
	const ledgerPath = path.join(directory, "ledger.json");
	for (const request of Object.values(requests)) {
		request.head = "0".repeat(40);
		request.repo_root = process.cwd();
	}
	await writeFile(ledgerPath, JSON.stringify({ version: 2, requests }), "utf8");
	try {
		return await run(ledgerPath);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("verification spawns pause producers without disturbing started work", async () => {
	await withLedger(
		{
			pending: { prompt: "Implement a task", state: "pending", authorization },
			claimed: {
				prompt: "Continue an active task",
				state: "implementation",
				owner: "active-worker",
				authorization,
			},
		},
		async ledgerPath => {
			let dispatched = 0;
			const engine = new TopicReplenishmentEngine({
				ledgerPath,
				targetCount: 1,
				maxCeiling: 1,
				maxRamPct: 100,
				executor: async () => {
					dispatched++;
				},
			});
			const worker: NativeActorSnapshot = { id: "active-worker", status: "running", role: "sub" };
			engine.onWorkerStart({ agentId: "verifier", agentName: "qa-verifier", runId: "run-verifier" });
			const blocked = await engine.replenish([worker]);
			expect(blocked.status).toBe("verification_blocked");
			expect(blocked.dispatchedCount).toBe(0);
			expect(blocked.reconciliation.activeUsefulCount).toBe(1);
			expect(dispatched).toBe(0);

			const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
				requests: Record<string, { state: string; owner?: string }>;
			};
			expect(ledger.requests.claimed).toMatchObject({ state: "implementation", owner: "active-worker" });
			expect(ledger.requests.pending.state).toBe("pending");
		},
	);
});

test("only the last verifier completion resumes one producer deficit", async () => {
	await withLedger(
		{
			first: { prompt: "Implement the first task", state: "pending", authorization },
			second: { prompt: "Implement the second task", state: "pending", authorization },
		},
		async ledgerPath => {
			let dispatched = 0;
			let dispatchedWithCycleOptions = 0;
			const engine = new TopicReplenishmentEngine({
				ledgerPath,
				targetCount: 1,
				maxCeiling: 1,
				maxRamPct: 100,
				executor: async () => {
					dispatched++;
				},
			});
			engine.onWorkerStart({ agentId: "verifier-a", agentName: "qa-verifier", ticketId: "ticket-a", runId: "run-a" });
			engine.onWorkerStart({ agentId: "verifier-b", agentName: "reviewer", ticketId: "ticket-b", runId: "run-b" });
			const blocked = await engine.replenish([], {
				dispatchWorker: async () => {
					dispatchedWithCycleOptions++;
				},
			});
			expect(blocked.status).toBe("verification_blocked");

			const verifierB: NativeActorSnapshot = {
				id: "verifier-b",
				status: "running",
				agentName: "reviewer",
			};
			const completedA = { agentId: "verifier-a", agentName: "qa-verifier", status: "completed" } as const;
			expect((await engine.onWorkerComplete(completedA, [verifierB])).status).toBe("verification_blocked");
			expect((await engine.onWorkerComplete(completedA, [verifierB])).status).toBe("verification_blocked");
			expect(
				(await engine.onWorkerComplete({ agentId: "untracked", agentName: "task", status: "completed" }, [verifierB]))
					.status,
			).toBe("verification_blocked");
			expect(dispatched).toBe(0);

			const resumed = await engine.onWorkerComplete(
				{ agentId: "verifier-b", agentName: "reviewer", status: "completed" },
				[],
			);
			expect(resumed.dispatchedCount).toBe(1);
			expect((await engine.replenish([])).status).toBe("floor_satisfied");
			expect(dispatchedWithCycleOptions).toBe(1);
			expect(dispatched).toBe(0);

			const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
				requests: Record<string, { state: string }>;
			};
			expect(Object.values(ledger.requests).filter(request => request.state === "implementation")).toHaveLength(1);
			expect(Object.values(ledger.requests).filter(request => request.state === "pending")).toHaveLength(1);
		},
	);
});
test("a blocked pre-dispatch rollback restores the ticket's QA stage", async () => {
	await withLedger(
		{ qa: { prompt: "Verify the fix", state: "qa", authorization } },
		async ledgerPath => {
			const previousWorkflowsDir = process.env.VEYYON_WORKFLOWS_DIR;
			process.env.VEYYON_WORKFLOWS_DIR = path.join(path.dirname(ledgerPath), "no-worker-backend");
			try {
				const claim = await claimNextAuthorizedTicket(ledgerPath, { workerId: "replenisher" });
				expect(claim.claimed).toBe(true);
				expect(claim.ticket?.previousState).toBe("qa");
				if (!claim.ticket?.runId) throw new Error("QA ticket was not claimed with a native run ID");
				const ticket = claim.ticket;
				const rollback = await rollbackClaimedTicket(ledgerPath, "qa", "Verification became blocked", {
					runId: ticket.runId,
					previousState: ticket.previousState,
				});
				expect(rollback.rolled_back).toBe(true);

				const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
					requests: Record<string, { state: string; history: Array<{ from_state: string; to_state: string }> }>;
				};
				expect(ledger.requests.qa.state).toBe("qa");
				expect(ledger.requests.qa.history.at(-1)).toMatchObject({
					from_state: "qa",
					to_state: "qa",
				});
			} finally {
				if (previousWorkflowsDir === undefined) delete process.env.VEYYON_WORKFLOWS_DIR;
				else process.env.VEYYON_WORKFLOWS_DIR = previousWorkflowsDir;
			}
		},
	);
});
test("a verifier spawn during asynchronous admission prevents a later producer claim", async () => {
	await withLedger(
		{ pending: { prompt: "Implement a task", state: "pending", authorization } },
		async ledgerPath => {
			const admissionReached = Promise.withResolvers<void>();
			const nextAdmission = Promise.withResolvers<MemoryMeasurement>();
			let admissionCount = 0;
			let dispatched = 0;
			const engine = new TopicReplenishmentEngine({
				ledgerPath,
				targetCount: 1,
				maxCeiling: 1,
				maxRamPct: 100,
				executor: async () => {
					dispatched++;
				},
				memoryProvider: () => {
					if (++admissionCount === 1) return { total: 100, free: 90 };
					admissionReached.resolve();
					return nextAdmission.promise;
				},
			});

			const pendingReplenishment = engine.replenish([]);
			await admissionReached.promise;
			engine.onWorkerStart({ agentId: "verifier", agentName: "codex-reviewer", runId: "verification-run" });
			nextAdmission.resolve({ total: 100, free: 90 });
			const result = await pendingReplenishment;

			expect(result.status).toBe("verification_blocked");
			expect(dispatched).toBe(0);
			const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
				requests: Record<string, { state: string }>;
			};
			expect(ledger.requests.pending.state).toBe("pending");
		},
	);
});
test("session recovery reconciles exact verifier identities and resumes only to the worker cap", async () => {
	await withLedger(
		{ first: { prompt: "Implement the first task", state: "pending", authorization } },
		async ledgerPath => {
			let dispatched = 0;
			const engine = new TopicReplenishmentEngine({
				ledgerPath,
				targetCount: 1,
				maxCeiling: 1,
				maxRamPct: 100,
				executor: async () => {
					dispatched++;
				},
			});
			const options = {
				dispatchWorker: async () => {
					dispatched++;
				},
			};
			const producer: NativeActorSnapshot = {
				id: "producer",
				status: "running",
				role: "sub",
				agentName: "task",
				task: "mentions qa-verifier reviewer and codex-reviewer",
			};
			expect((await engine.onSessionRecovery([producer], options)).status).toBe("floor_satisfied");
			expect(dispatched).toBe(0);

			const verifier: NativeActorSnapshot = {
				id: "review-lane",
				status: "running",
				role: "sub",
				agentName: "qa-verifier",
			};
			expect((await engine.onSessionRecovery([producer, verifier], options)).status).toBe("verification_blocked");
			expect(dispatched).toBe(0);

			const resumed = await engine.onSessionRecovery([], options);
			expect(resumed.dispatchedCount).toBe(1);
			expect(dispatched).toBe(1);
			expect((await engine.replenish([], options)).status).toBe("floor_satisfied");
			expect(dispatched).toBe(1);
		},
	);
});
