/**
 * WHY: a settle with background work outstanding is a pause, not a stop. `OwnedAsyncJobs` reports
 * whether a job the session owns will wake the loop again (`hasPendingWake`), and the quiescence
 * wait sleeps on `nextWakeChange` until that answer can change. The defects at that boundary share
 * one shape: the answer counts a job that will never wake the loop, so a run waits on it (another
 * agent's job, a delivery the agent acknowledged or watches, a launched process under
 * `endingJobsOnly`), or the wait outlives the event that ended it (a settled job, a new turn, an
 * abort) or leaves its event subscription behind.
 *
 * The class this closes is a wake held by a job that cannot deliver to this session's loop, and a
 * wait that does not end on the first event that changes the answer. Every job kind in
 * `JOB_ENDS_ON_ITS_OWN` is swept, so a new kind is covered by whatever it records there.
 *
 * What it does not catch: the delivery path (`a-late-job-result-completes-its-interrupted-call`),
 * descendant cancellation (`agent-teardown-cascade`) and the ACP drain (`agent-session-concurrent`),
 * which drive those through a real session; and a finished job whose delivery is still queued, which
 * the manager reports through `hasPendingDeliveries` and the todo reminder suite drives end to end.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager, type AsyncJobType, JOB_ENDS_ON_ITS_OWN } from "@veyyon/coding-agent/async/job-manager";
import {
	type AgentSessionEvent,
	type AgentSessionEventListener,
	QUIESCENCE_RECHECK_MS,
} from "@veyyon/coding-agent/session/agent-session-types";
import { OwnedAsyncJobs } from "@veyyon/coding-agent/session/runtime/owned-async-jobs";

const SELF = "Self";
const OTHER = "Other";

interface Harness {
	readonly jobs: OwnedAsyncJobs;
	readonly manager: AsyncJobManager;
	readonly listeners: Set<AgentSessionEventListener>;
	/** Register a job that runs until {@link finish} names it. */
	start(type: AsyncJobType, ownerId: string, options?: { endsOnItsOwn?: boolean }): string;
	finish(jobId: string): void;
	emit(event: AgentSessionEvent): void;
}

const managers: AsyncJobManager[] = [];
const gates: PromiseWithResolvers<string>[] = [];

afterEach(async () => {
	for (const gate of gates.splice(0)) gate.resolve("done");
	await Promise.all(managers.splice(0).map(manager => manager.dispose({ timeoutMs: 1_000 })));
});

function harness(agentId: string | undefined = SELF, withManager = true): Harness {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.push(manager);
	const listeners = new Set<AgentSessionEventListener>();
	const gatesById = new Map<string, PromiseWithResolvers<string>>();
	const jobs = new OwnedAsyncJobs(
		{
			messages: () => [],
			appendLateToolResult: () => {},
			enqueueAsyncResult: () => {},
			subscribe: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			allowingAgentInitiatedTurns: run => run(),
		},
		withManager ? manager : undefined,
		agentId,
	);
	return {
		jobs,
		manager,
		listeners,
		start(type, ownerId, options) {
			const gate = Promise.withResolvers<string>();
			gates.push(gate);
			const id = manager.register(type, `${type} for ${ownerId}`, () => gate.promise, {
				ownerId,
				endsOnItsOwn: options?.endsOnItsOwn,
			});
			gatesById.set(id, gate);
			return id;
		},
		finish(jobId) {
			gatesById.get(jobId)?.resolve("done");
		},
		emit(event) {
			for (const listener of listeners) listener(event);
		},
	};
}

/** Milliseconds `nextWakeChange` took to resolve, after `trigger` runs. */
async function wakeAfter(h: Harness, trigger: () => void, signal?: AbortSignal): Promise<number> {
	const started = performance.now();
	const waiting = h.jobs.nextWakeChange(signal);
	trigger();
	await waiting;
	return performance.now() - started;
}

describe("a settle waits only for background jobs that will wake the loop", () => {
	it("counts this agent's running job and never another agent's", () => {
		const h = harness();
		const other = h.start("bash", OTHER);
		expect(h.jobs.hasPendingWake()).toBe(false);
		expect(h.jobs.snapshot()?.running.map(job => job.id)).toEqual([]);

		const own = h.start("bash", SELF);
		expect(h.jobs.hasPendingWake()).toBe(true);
		expect(h.jobs.snapshot()?.running.map(job => job.id)).toEqual([own]);
		expect(h.manager.getRunningJobs().map(job => job.id)).toEqual([other, own]);
	});

	it("reads nothing for a session that runs on no manager", () => {
		const h = harness(SELF, false);
		h.start("bash", SELF);
		expect(h.jobs.hasPendingWake()).toBe(false);
		expect(h.jobs.snapshot()).toBeNull();
	});

	it("counts no job whose delivery the agent acknowledged or watches", () => {
		const h = harness();
		const acknowledged = h.start("bash", SELF);
		h.manager.acknowledgeDeliveries([acknowledged]);
		expect(h.jobs.hasPendingWake()).toBe(false);

		const watched = h.start("task", SELF);
		h.manager.watchJobs([watched]);
		expect(h.jobs.hasPendingWake()).toBe(false);

		h.start("bash", SELF);
		expect(h.jobs.hasPendingWake()).toBe(true);
	});

	it("leaves out a job that runs until stopped only when asked to, for every job kind", () => {
		const kinds = Object.keys(JOB_ENDS_ON_ITS_OWN) as AsyncJobType[];
		const seen: Record<string, [boolean, boolean]> = {};
		for (const kind of kinds) {
			const h = harness();
			h.start(kind, SELF);
			seen[kind] = [h.jobs.hasPendingWake(), h.jobs.hasPendingWake(true)];
		}
		expect(seen).toEqual(Object.fromEntries(kinds.map(kind => [kind, [true, JOB_ENDS_ON_ITS_OWN[kind]]])));

		const unbounded = harness();
		unbounded.start("bash", SELF, { endsOnItsOwn: false });
		expect([unbounded.jobs.hasPendingWake(), unbounded.jobs.hasPendingWake(true)]).toEqual([true, false]);
	});

	it("ends the wait when this agent's job settles, and unsubscribes", async () => {
		const h = harness();
		const own = h.start("bash", SELF);
		const elapsed = await wakeAfter(h, () => h.finish(own));
		expect(elapsed).toBeLessThan(QUIESCENCE_RECHECK_MS / 2);
		expect(h.listeners.size).toBe(0);
		expect(h.jobs.hasPendingWake()).toBe(false);
	});

	it("ends the wait when a turn starts, and unsubscribes", async () => {
		const h = harness();
		h.start("bash", SELF);
		const elapsed = await wakeAfter(h, () => h.emit({ type: "agent_start" }));
		expect(elapsed).toBeLessThan(QUIESCENCE_RECHECK_MS / 2);
		expect(h.listeners.size).toBe(0);
	});

	it("ends the wait when its signal aborts, and unsubscribes", async () => {
		const h = harness();
		h.start("bash", SELF);
		const controller = new AbortController();
		const elapsed = await wakeAfter(h, () => controller.abort(), controller.signal);
		expect(elapsed).toBeLessThan(QUIESCENCE_RECHECK_MS / 2);
		expect(h.listeners.size).toBe(0);
	});

	it("does not end the wait for another agent's job, and still ends it at the recheck", async () => {
		const h = harness();
		h.start("bash", SELF);
		const other = h.start("bash", OTHER);
		const elapsed = await wakeAfter(h, () => h.finish(other));
		expect(elapsed).toBeGreaterThanOrEqual(QUIESCENCE_RECHECK_MS - 50);
		expect(elapsed).toBeLessThan(QUIESCENCE_RECHECK_MS * 3);
		expect(h.listeners.size).toBe(0);
	});
});
