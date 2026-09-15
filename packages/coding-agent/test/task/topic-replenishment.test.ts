/**
 * packages/coding-agent/test/task/topic-replenishment.test.ts
 *
 * Unit tests for generic topic replenishment and capacity reconciliation.
 */

import { describe, expect, it } from "bun:test";
import {
	reconcileRunningTopics,
	TopicReplenishmentEngine,
	type ClaimedTicket,
	type ClaimTicketResult,
	type NativeActorSnapshot,
	type TicketProvider,
} from "../../src/task/topic-replenishment";

describe("reconcileRunningTopics", () => {
	it("reconciles active, idle, parked, and inactive workers", () => {
		const roster: NativeActorSnapshot[] = [
			{ id: "Main", status: "running", role: "main" },
			{ id: "worker-1", status: "running", role: "sub", topic: "auth" },
			{ id: "worker-2", status: "running", role: "sub", topic: "database" },
			{ id: "worker-3", status: "idle", role: "sub", topic: "auth" },
			{ id: "worker-4", status: "parked", role: "sub", topic: "network" },
			{ id: "worker-5", status: "completed", role: "sub", topic: "ui" },
			{ id: "worker-6", status: "cancelled", role: "sub", topic: "ui" },
		];

		const result = reconcileRunningTopics(roster, {
			targetCount: 4,
			eligibleTopics: ["auth", "database", "network", "ui"],
		});

		expect(result.activeUsefulCount).toBe(2);
		expect(result.activeWorkers.map(w => w.id)).toEqual(["worker-1", "worker-2"]);
		expect(result.idleWorkers.map(w => w.id)).toEqual(["worker-3"]);
		expect(result.parkedWorkers.map(w => w.id)).toEqual(["worker-4"]);
		expect(result.otherInactiveWorkers.map(w => w.id)).toEqual(["worker-5", "worker-6"]);
		expect(result.coveredTopics).toEqual(["auth", "database"]);
		expect(result.uncoveredTopics).toEqual(["network", "ui"]);
		expect(result.targetDeficit).toBe(2);
	});

	it("computes zero deficit when active workers meet or exceed target", () => {
		const roster: NativeActorSnapshot[] = [
			{ id: "worker-1", status: "running", role: "sub", topic: "t1" },
			{ id: "worker-2", status: "running", role: "sub", topic: "t2" },
			{ id: "worker-3", status: "running", role: "sub", topic: "t3" },
		];

		const result = reconcileRunningTopics(roster, { targetCount: 2 });
		expect(result.activeUsefulCount).toBe(3);
		expect(result.targetDeficit).toBe(0);
	});

	it("excludes main orchestrator variants from active count", () => {
		const roster: NativeActorSnapshot[] = [
			{ id: "Main", status: "running", role: "main" },
			{ id: "main:orchestrator", status: "running", role: "orchestrator" },
			{ id: "worker-1", status: "running", role: "sub" },
		];

		const result = reconcileRunningTopics(roster, { targetCount: 2 });
		expect(result.activeUsefulCount).toBe(1);
		expect(result.activeWorkers.map(w => w.id)).toEqual(["worker-1"]);
		expect(result.targetDeficit).toBe(1);
	});
});

describe("TopicReplenishmentEngine", () => {
	it("returns target_satisfied when target capacity is already met", async () => {
		const engine = new TopicReplenishmentEngine({ targetCount: 1 });
		const roster: NativeActorSnapshot[] = [
			{ id: "w-1", status: "running", role: "sub", topic: "t1" },
		];

		const outcome = await engine.replenish(roster);
		expect(outcome.status).toBe("target_satisfied");
		expect(outcome.dispatchedCount).toBe(0);
		expect(outcome.dispatchedTickets).toHaveLength(0);
	});

	it("returns no_eligible_work when no provider or executor is configured", async () => {
		const engine = new TopicReplenishmentEngine({ targetCount: 2 });
		const outcome = await engine.replenish([]);
		expect(outcome.status).toBe("no_eligible_work");
		expect(outcome.dispatchedCount).toBe(0);
	});

	it("dispatches tickets until target deficit is satisfied", async () => {
		const availableTickets: ClaimedTicket[] = [
			{ id: "ticket-1", topic: "auth", prompt: "Implement auth token refresh" },
			{ id: "ticket-2", topic: "database", prompt: "Run database migration" },
			{ id: "ticket-3", topic: "ui", prompt: "Build settings drawer" },
		];

		const provider: TicketProvider = {
			claimNext: (covered: string[]): ClaimTicketResult => {
				const next = availableTickets.find(t => !covered.includes(t.topic));
				if (!next) return { claimed: false };
				return { claimed: true, ticket: next };
			},
		};

		const executed: ClaimedTicket[] = [];
		const engine = new TopicReplenishmentEngine({
			targetCount: 2,
			maxCeiling: 5,
			eligibleTopics: ["auth", "database", "ui"],
			provider,
			executor: async ticket => {
				executed.push(ticket);
			},
		});

		const outcome = await engine.replenish([]);
		expect(outcome.status).toBe("replenished");
		expect(outcome.dispatchedCount).toBe(2);
		expect(outcome.dispatchedTickets.map(t => t.id)).toEqual(["ticket-1", "ticket-2"]);
		expect(executed.map(t => t.id)).toEqual(["ticket-1", "ticket-2"]);
	});

	it("triggers provider rollback when dispatch executor throws", async () => {
		const rollbacks: Array<{ ticketId: string; reason: string }> = [];
		const provider: TicketProvider = {
			claimNext: (): ClaimTicketResult => ({
				claimed: true,
				ticket: { id: "faulty-ticket", topic: "crash", prompt: "fail" },
			}),
			rollback: (ticketId, reason) => {
				rollbacks.push({ ticketId, reason });
			},
		};

		const engine = new TopicReplenishmentEngine({
			targetCount: 1,
			provider,
			executor: async () => {
				throw new Error("Execution spawn failed");
			},
		});

		const outcome = await engine.replenish([]);
		expect(outcome.dispatchedCount).toBe(0);
		expect(rollbacks).toHaveLength(1);
		expect(rollbacks[0].ticketId).toBe("faulty-ticket");
		expect(rollbacks[0].reason).toContain("Execution spawn failed");
	});

	it("calls provider.complete and replenishes on onWorkerComplete", async () => {
		const completed: Array<{ ticketId: string; result?: Record<string, unknown> }> = [];
		const provider: TicketProvider = {
			claimNext: (): ClaimTicketResult => ({ claimed: false }),
			complete: (ticketId, result) => {
				completed.push({ ticketId, result });
			},
		};

		const engine = new TopicReplenishmentEngine({
			targetCount: 0,
			provider,
		});

		const outcome = await engine.onWorkerComplete(
			{
				agentId: "agent-1",
				agentName: "worker-1",
				task: "do-work",
				status: "completed",
				ticketId: "ticket-42",
				structuredResult: { status: "ok" },
			},
			[],
		);

		expect(completed).toHaveLength(1);
		expect(completed[0].ticketId).toBe("ticket-42");
		expect(completed[0].result).toEqual({ status: "ok" });
		expect(outcome.status).toBe("target_satisfied");
	});
});
