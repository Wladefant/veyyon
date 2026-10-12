// WHY: A blocked verifier used to have no direct way to stop producer dispatch. These tests cover
// the pressure transition, preservation of existing work, the single allowed deficit, and stale
// concurrent transitions. The session boundary suite separately checks the SDK setter bridge.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "bun:test";
import { TopicReplenishmentEngine, type NativeActorSnapshot } from "../../src/task/topic-replenishment";

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

test("verification pressure preserves started workers and claimed tickets", async () => {
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
				verificationBlocked: true,
				executor: async () => {
					dispatched++;
				},
			});
			const worker: NativeActorSnapshot = { id: "active-worker", status: "running", role: "sub" };
			const blocked = await engine.replenish([worker]);
			expect(blocked.status).toBe("verification_blocked");
			expect(blocked.dispatchedCount).toBe(0);
			expect(blocked.reconciliation.activeUsefulCount).toBe(1);
			expect(dispatched).toBe(0);

			const beforeClear = JSON.parse(await readFile(ledgerPath, "utf8")) as {
				requests: Record<string, { state: string; owner?: string }>;
			};
			expect(beforeClear.requests.claimed).toMatchObject({ state: "implementation", owner: "active-worker" });

			await engine.setVerificationBlocked(false);
			expect(dispatched).toBe(0);
			expect(await engine.setVerificationBlocked(false)).toBeUndefined();
			const afterClear = JSON.parse(await readFile(ledgerPath, "utf8")) as {
				requests: Record<string, { state: string; owner?: string }>;
			};
			expect(afterClear.requests.claimed).toMatchObject({ state: "implementation", owner: "active-worker" });
		},
	);
});

test("clearing pressure dispatches one permitted deficit and ignores stale clears", async () => {
	await withLedger(
		{
			first: { prompt: "Implement the first task", state: "pending", authorization },
			second: { prompt: "Implement the second task", state: "pending", authorization },
		},
		async ledgerPath => {
			let dispatched = 0;
			const engine = new TopicReplenishmentEngine({
				ledgerPath,
				targetCount: 1,
				maxCeiling: 1,
				maxRamPct: 100,
				verificationBlocked: true,
				executor: async () => {
					dispatched++;
				},
			});
			await engine.replenish([]);
			const resumed = await engine.setVerificationBlocked(false);
			expect(resumed?.dispatchedCount).toBe(1);
			expect(await engine.setVerificationBlocked(false)).toBeUndefined();
			expect(dispatched).toBe(1);

			await engine.setVerificationBlocked(true);
			await Promise.all([engine.setVerificationBlocked(false), engine.setVerificationBlocked(true)]);
			expect((await engine.replenish([])).status).toBe("verification_blocked");
			expect(dispatched).toBe(1);

			const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
				requests: Record<string, { state: string }>;
			};
			expect(Object.values(ledger.requests).filter(request => request.state === "implementation")).toHaveLength(1);
			expect(Object.values(ledger.requests).filter(request => request.state === "pending")).toHaveLength(1);
		},
	);
});
