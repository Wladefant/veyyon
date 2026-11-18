// Rejected dispatch must retain its original stage and cannot clear a newer run.
// This exercises the real Python rollback bridge, not WorkerBackend completion.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TopicReplenishmentEngine } from "../../src/task/topic-replenishment";

for (const previousState of ["pending", "implementation", "qa", "review"]) {
	test(`a rejected ${previousState} dispatch restores its stage and refuses an older run`, async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "native-rollback-"));
		const ledgerPath = path.join(root, "ledger.json");
		try {
			const current = {
				state: previousState === "pending" ? "implementation" : previousState,
				stage: previousState === "qa" || previousState === "review" ? previousState : "build",
				native_claim: { version: 1, state: "active", worker_id: "worker-b", run_id: "run-b", task_handle: null },
			};
			await writeFile(ledgerPath, JSON.stringify({ version: 2, requests: { ticket: current } }));
			const engine = new TopicReplenishmentEngine({ ledgerPath });
			const stale = await engine.rollbackClaimedTicket("ticket", "old binding rejected", "run-a", previousState);
			expect(stale.rolled_back).toBe(false);
			expect(JSON.parse(await readFile(ledgerPath, "utf8")).requests.ticket).toEqual(current);

			const result = await engine.rollbackClaimedTicket("ticket", "binding rejected", "run-b", previousState);
			expect(result.rolled_back).toBe(true);
			const ticket = JSON.parse(await readFile(ledgerPath, "utf8")).requests.ticket;
			expect(ticket.state).toBe(previousState);
			expect(ticket.stage).toBe(current.stage);
			expect(ticket.native_claim).toEqual({
				version: 1, state: "retryable", worker_id: null, run_id: null, task_handle: null,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);
}
