/**
 * WHY: regression coverage for PR #1114 native host-lane admission findings
 * (`packages/coding-agent/src/task/lane-admission.ts` from `activeNativeAgentLeases` onward
 * and `packages/coding-agent/src/task/executor.ts` admission call):
 * - Nested fail-fast (`waitIfFull: false` when `taskDepth > 0`) throwing
 *   `LaneAdmissionError('nested_host_lane_cap_reached', ...)` while preserving
 *   cancellation and leaving top-level (`taskDepth === 0`) polling unaffected.
 * - Synchronous single-flight entry installation before awaiting so concurrent same-key
 *   acquisitions at one remaining slot share one acquire promise.
 * - Independent waiter cancellation without cancelling sibling waiters, aborting the
 *   underlying acquire only once all waiters cancel, and zero-leak cancellation races.
 * - Durable `release()` checking `driver.release` `result.ok`, owning transient retries,
 *   sharing concurrent release promises, and settling abort compensation without
 *   manual repair or a caller retaining the lease handle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { runSubagentFollowUpTurn, runSubprocess } from "@veyyon/coding-agent/task/executor";
import { IrcBus } from "@veyyon/coding-agent/task/irc-bus";
import * as laneModule from "@veyyon/coding-agent/task/lane-admission";
import {
	acquireLaneAdmission,
	acquireNativeHostLaneWait,
	acquireSubagentHostLane,
	getLaneAdmissionLedgerPath,
	getLaneAdmissionStatus,
	LaneAdmissionError,
	releaseLaneAdmission,
} from "@veyyon/coding-agent/task/lane-admission";
import type { AgentDefinition, SingleResult } from "@veyyon/coding-agent/task/types";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";

const testAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const tempDirs: TempDir[] = [];

function makeArtifactsDir(): string {
	const dir = TempDir.createSync("@veyyon-lane-native-reg-");
	tempDirs.push(dir);
	return dir.path();
}

describe("native host-lane admission regressions", () => {
	let isolated: IsolatedConfigRoot;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		isolated = enterIsolatedConfigRoot("lane-admission-native-regressions", { defaultProfile: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
		isolated.restore();
	});

	it("fails fast on waitIfFull=false while preserving cancellation and top-level polling", async () => {
		const filler = await acquireLaneAdmission({
			owner: "waitiffull-filler",
			kind: "native",
			workerPid: process.pid,
			cap: 1,
		});
		expect(filler.admitted).toBe(true);

		// WHY: capture unspied driver method before spy creation so mock implementations avoid recursive stack overflow.
		const realAcquire = laneModule.laneAdmissionDriver.acquire;
		const acquireSpy = vi.spyOn(laneModule.laneAdmissionDriver, "acquire");

		let caught: unknown;
		try {
			await acquireNativeHostLaneWait({
				owner: "nested-wait-false",
				cap: 1,
				waitIfFull: false,
				pollIntervalMs: 5,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(LaneAdmissionError);
		expect((caught as LaneAdmissionError).code).toBe("nested_host_lane_cap_reached");
		expect((caught as LaneAdmissionError).message).toContain("nested-wait-false");
		expect(acquireSpy).toHaveBeenCalledTimes(1);

		// Pre-aborted signal returns null even when waitIfFull=false and cap is full
		const preAborted = new AbortController();
		preAborted.abort();
		expect(
			await acquireNativeHostLaneWait({
				owner: "nested-preaborted",
				cap: 1,
				waitIfFull: false,
				signal: preAborted.signal,
			}),
		).toBeNull();
		expect(
			await acquireSubagentHostLane({
				agentId: "NestedPreAbortedSub",
				owner: "NestedPreAbortedSub",
				cap: 1,
				waitIfFull: false,
				signal: preAborted.signal,
			}),
		).toBeNull();

		// Abort firing during acquire on full cap returns null rather than nested_host_lane_cap_reached
		const midAbort = new AbortController();
		acquireSpy.mockImplementationOnce(async opts => {
			const res = await realAcquire(opts);
			midAbort.abort();
			return res;
		});
		expect(
			await acquireNativeHostLaneWait({
				owner: "nested-midabort",
				cap: 1,
				waitIfFull: false,
				signal: midAbort.signal,
			}),
		).toBeNull();

		// Top-level default waitIfFull=true continues polling until slot frees
		const topDenied = Promise.withResolvers<void>();
		acquireSpy.mockImplementation(async opts => {
			const res = await realAcquire(opts);
			if (opts.owner === "top-wait-true" && !res.admitted && res.reason === "host_lane_cap_reached") {
				topDenied.resolve();
			}
			return res;
		});
		const topPromise = acquireNativeHostLaneWait({
			owner: "top-wait-true",
			cap: 1,
			pollIntervalMs: 5,
		});
		await topDenied.promise;
		await releaseLaneAdmission({ slotId: filler.slot_id!, leaseToken: filler.lease_token! });
		const topLease = await topPromise;
		expect(topLease).not.toBeNull();
		await topLease!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("rejects saturated nested runSubprocess (taskDepth > 0) as startup-failed while top-level waits and cancellation works", async () => {
		// Persist cap=2 via one held filler slot so 1 slot remains for the parent run
		const filler = await acquireLaneAdmission({
			owner: "nested-sat-filler",
			kind: "native",
			workerPid: process.pid,
			cap: 2,
		});
		expect(filler.admitted).toBe(true);

		let nestedResult: SingleResult | undefined;
		let nestedCancelledResult: SingleResult | undefined;
		let topWaitingPrompted = false;
		const topWaitingGate = Promise.withResolvers<void>();

		const parentSession = createMockSession(
			async ({ emit }) => {
				// Parent now holds slot 2 of 2 (cap saturated: 2/2 active).
				expect((await getLaneAdmissionStatus()).active_lanes).toBe(2);

				// 1) Nested runSubprocess (taskDepth=1) MUST fail fast as startup-failed instead of deadlocking
				nestedResult = await runSubprocess({
					cwd: "/repo",
					agent: testAgent,
					task: "nested child while saturated",
					index: 0,
					id: "NestedSaturatedChild",
					taskDepth: 1,
					settings: Settings.isolated(),
					modelRegistry: { refresh: async () => {}, getAvailable: () => [], getApiKey: async () => "k" } as never,
					enableLsp: false,
					eventBus: new EventBus(),
					artifactsDir: makeArtifactsDir(),
				});

				// 2) Pre-cancelled nested runSubprocess MUST still classify as cancelled
				const cancelledCtrl = new AbortController();
				cancelledCtrl.abort();
				nestedCancelledResult = await runSubprocess({
					cwd: "/repo",
					agent: testAgent,
					task: "cancelled nested child",
					index: 1,
					id: "NestedCancelledChild",
					taskDepth: 1,
					signal: cancelledCtrl.signal,
					settings: Settings.isolated(),
					modelRegistry: { refresh: async () => {}, getAvailable: () => [], getApiKey: async () => "k" } as never,
					enableLsp: false,
					eventBus: new EventBus(),
					artifactsDir: makeArtifactsDir(),
				});

				emit(yieldSuccessEvent({ parent: true }));
			},
			{ activeToolNames: ["yield"] },
		);

		const topWaitingSession = createMockSession(
			async ({ emit }) => {
				topWaitingPrompted = true;
				topWaitingGate.resolve();
				emit(yieldSuccessEvent({ top: true }));
			},
			{ activeToolNames: ["yield"] },
		);

		const createSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createSessionResult(parentSession))
			.mockResolvedValueOnce(createSessionResult(topWaitingSession));

		const parentResult = await runSubprocess({
			cwd: "/repo",
			agent: testAgent,
			task: "parent holding last slot",
			index: 0,
			id: "HeldParent",
			taskDepth: 0,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {}, getAvailable: () => [], getApiKey: async () => "k" } as never,
			enableLsp: false,
			eventBus: new EventBus(),
			artifactsDir: makeArtifactsDir(),
		});

		expect(parentResult.exitCode).toBe(0);
		expect(nestedResult).toBeDefined();
		expect(nestedResult!.exitCode).toBe(1);
		expect(nestedResult!.terminalOutcome).toBe("startup-failed");
		expect(nestedResult!.error).toContain("nested");
		expect(nestedCancelledResult).toBeDefined();
		expect(nestedCancelledResult!.terminalOutcome).toBe("cancelled");
		expect(nestedCancelledResult!.aborted).toBe(true);

		// Re-fill the parent's slot to prove a top-level runSubprocess (taskDepth=0) waits rather than failing fast
		const filler2 = await acquireLaneAdmission({
			owner: "nested-sat-filler-2",
			kind: "native",
			workerPid: process.pid,
			cap: 2,
		});
		expect(filler2.admitted).toBe(true);

		const topWaitDenied = Promise.withResolvers<void>();
		const realAcquire = laneModule.laneAdmissionDriver.acquire;
		vi.spyOn(laneModule.laneAdmissionDriver, "acquire").mockImplementation(async opts => {
			const res = await realAcquire(opts);
			if (opts.owner.includes("TopWaitingChild") && !res.admitted && res.reason === "host_lane_cap_reached") {
				topWaitDenied.resolve();
			}
			return res;
		});

		const topWaitingPromise = runSubprocess({
			cwd: "/repo",
			agent: testAgent,
			task: "top-level waits for slot",
			index: 0,
			id: "TopWaitingChild",
			taskDepth: 0,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {}, getAvailable: () => [], getApiKey: async () => "k" } as never,
			enableLsp: false,
			eventBus: new EventBus(),
			artifactsDir: makeArtifactsDir(),
		});

		await topWaitDenied.promise;
		expect(topWaitingPrompted).toBe(false);

		await releaseLaneAdmission({ slotId: filler2.slot_id!, leaseToken: filler2.lease_token! });
		await topWaitingGate.promise;
		const topWaitingResult = await topWaitingPromise;
		expect(topWaitingResult.exitCode).toBe(0);
		expect(topWaitingResult.terminalOutcome).toBe("completed");
		expect(createSessionSpy).toHaveBeenCalledTimes(2);

		await releaseLaneAdmission({ slotId: filler.slot_id!, leaseToken: filler.lease_token! });
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("surfaces persistent ledger faults from initial and follow-up executor finalization", async () => {
		for (const followUp of [false, true]) {
			const ledgerPath = getLaneAdmissionLedgerPath();
			let original = "";
			const session = createMockSession(
				async ({ emit }) => {
					original = fs.readFileSync(ledgerPath, "utf8");
					fs.writeFileSync(ledgerPath, "{");
					emit(yieldSuccessEvent({ ok: true }));
				},
				{ activeToolNames: ["yield"] },
			);
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
			vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(session);
			try {
				const result = followUp
					? runSubagentFollowUpTurn({
							id: "PersistentFollowUp",
							agent: testAgent,
							message: "continue",
							eventBus: new EventBus(),
							artifactsDir: makeArtifactsDir(),
						})
					: runSubprocess({
							cwd: "/repo",
							agent: testAgent,
							task: "finish",
							index: 0,
							id: "PersistentInitial",
							settings: Settings.isolated(),
							modelRegistry: {
								refresh: async () => {},
								getAvailable: () => [],
								getApiKey: async () => "k",
							} as never,
							enableLsp: false,
							eventBus: new EventBus(),
							artifactsDir: makeArtifactsDir(),
						});
				await expect(result).rejects.toMatchObject({ code: "lane_release_reconciliation_required" });
			} finally {
				if (original) fs.writeFileSync(ledgerPath, original);
			}
			const held = (await getLaneAdmissionStatus()).reservations;
			expect(held).toHaveLength(1);
			const release = await releaseLaneAdmission({ slotId: held[0]!.slotId, leaseToken: held[0]!.leaseToken });
			expect(release.released).toBe(true);
		}
	});

	it("settles transient release failure without handing retry ownership to the caller", async () => {
		const lease = await acquireSubagentHostLane({
			agentId: "ReleaseRecovery",
			owner: "session/ReleaseRecovery.jsonl",
			cap: 1,
		});
		const realRelease = laneModule.laneAdmissionDriver.release;
		vi.spyOn(laneModule.laneAdmissionDriver, "release")
			.mockImplementationOnce(async options => ({
				ok: false,
				released: false,
				slot_id: options.slotId,
				reason: "transient_release_error",
			}))
			.mockImplementation(options => realRelease(options));
		await lease!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("does not let a fail-fast caller join an existing waiting flight", async () => {
		const filler = await acquireLaneAdmission({
			owner: "mixed-flight-filler",
			kind: "native",
			workerPid: process.pid,
			cap: 1,
		});
		const waitingController = new AbortController();
		const nestedController = new AbortController();
		const waiting = acquireSubagentHostLane({
			agentId: "MixedFlight",
			owner: "session/MixedFlight.jsonl",
			cap: 1,
			signal: waitingController.signal,
			pollIntervalMs: 5,
		});
		let outcome: unknown;
		const nested = acquireSubagentHostLane({
			agentId: "MixedFlight",
			owner: "session/MixedFlight.jsonl",
			cap: 1,
			signal: nestedController.signal,
			waitIfFull: false,
		}).then(
			value => {
				outcome = value;
			},
			error => {
				outcome = error;
			},
		);
		try {
			// Pending-flight rejection must not wait for ledger IO or the parent's lease.
			await Promise.resolve();
			expect(outcome).toBeInstanceOf(LaneAdmissionError);
			expect(outcome).toMatchObject({ code: "nested_host_lane_cap_reached" });
		} finally {
			nestedController.abort();
			waitingController.abort();
			await waiting;
			await releaseLaneAdmission({ slotId: filler.slot_id!, leaseToken: filler.lease_token! });
			await nested;
		}
	});

	it("counts same-named agents from independent session owners separately", async () => {
		const [first, second] = await Promise.all([
			acquireSubagentHostLane({ agentId: "Reviewer", owner: "session-one/Reviewer.jsonl", cap: 2 }),
			acquireSubagentHostLane({ agentId: "Reviewer", owner: "session-two/Reviewer.jsonl", cap: 2 }),
		]);
		try {
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
			expect(first!.slotId).not.toBe(second!.slotId);
			expect((await getLaneAdmissionStatus()).active_lanes).toBe(2);
		} finally {
			await first?.release();
			await second?.release();
		}
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("joins concurrent same-key acquisitions into one flight at a single remaining slot", async () => {
		const filler = await acquireLaneAdmission({
			owner: "single-flight-filler",
			kind: "native",
			workerPid: process.pid,
			cap: 2,
		});
		expect(filler.admitted).toBe(true);

		const realAcquire = laneModule.laneAdmissionDriver.acquire;
		const acquireEntered = Promise.withResolvers<void>();
		const releaseAcquire = Promise.withResolvers<void>();
		const acquireSpy = vi.spyOn(laneModule.laneAdmissionDriver, "acquire").mockImplementation(async opts => {
			acquireEntered.resolve();
			await releaseAcquire.promise;
			return realAcquire(opts);
		});

		const p1 = acquireSubagentHostLane({ agentId: "SameKeyAgent", owner: "SameKeyAgent", cap: 2 });
		const p2 = acquireSubagentHostLane({ agentId: "SameKeyAgent", owner: "SameKeyAgent", cap: 2 });

		await acquireEntered.promise;
		expect(acquireSpy).toHaveBeenCalledTimes(1);
		releaseAcquire.resolve();

		const [l1, l2] = await Promise.all([p1, p2]);
		expect(l1).not.toBeNull();
		expect(l2).not.toBeNull();
		expect(l1!.slotId).toBe(l2!.slotId);
		expect(l1!.leaseToken).toBe(l2!.leaseToken);
		expect(acquireSpy).toHaveBeenCalledTimes(1);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(2);

		await l1!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(2);
		await l2!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(1);

		await releaseLaneAdmission({ slotId: filler.slot_id!, leaseToken: filler.lease_token! });
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("preserves sibling waiters when one joining waiter cancels, aborts only when all cancel, and avoids mid-acquire leaks", async () => {
		// 1) Independent cancellation of one joining waiter does not cancel active sibling
		const filler = await acquireLaneAdmission({
			owner: "cancel-join-filler",
			kind: "native",
			workerPid: process.pid,
			cap: 1,
		});
		expect(filler.admitted).toBe(true);

		const realAcquire = laneModule.laneAdmissionDriver.acquire;
		const firstDenied = Promise.withResolvers<void>();
		const acquireSpy = vi.spyOn(laneModule.laneAdmissionDriver, "acquire").mockImplementation(async opts => {
			const res = await realAcquire(opts);
			if (!res.admitted && res.reason === "host_lane_cap_reached") {
				firstDenied.resolve();
			}
			return res;
		});

		const ctrlA = new AbortController();
		const ctrlB = new AbortController();
		const pA = acquireSubagentHostLane({
			agentId: "CancelJoinAgent",
			owner: "CancelJoinAgent",
			cap: 1,
			pollIntervalMs: 10,
			signal: ctrlA.signal,
		});
		const pB = acquireSubagentHostLane({
			agentId: "CancelJoinAgent",
			owner: "CancelJoinAgent",
			cap: 1,
			pollIntervalMs: 10,
			signal: ctrlB.signal,
		});

		await firstDenied.promise;
		ctrlA.abort();
		expect(await pA).toBeNull();

		// Waiter B is still active; freeing filler lets B acquire the single slot
		await releaseLaneAdmission({ slotId: filler.slot_id!, leaseToken: filler.lease_token! });
		const leaseB = await pB;
		expect(leaseB).not.toBeNull();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(1);
		await leaseB!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);

		// 2) Cancelling all waiters aborts the underlying wait so freeing the slot does not acquire
		const filler2 = await acquireLaneAdmission({
			owner: "cancel-all-filler",
			kind: "native",
			workerPid: process.pid,
			cap: 1,
		});
		expect(filler2.admitted).toBe(true);

		const allDenied = Promise.withResolvers<void>();
		acquireSpy.mockImplementation(async opts => {
			const res = await realAcquire(opts);
			if (!res.admitted && res.reason === "host_lane_cap_reached") {
				allDenied.resolve();
			}
			return res;
		});

		const ctrl1 = new AbortController();
		const ctrl2 = new AbortController();
		const w1 = acquireSubagentHostLane({
			agentId: "CancelAllAgent",
			owner: "CancelAllAgent",
			cap: 1,
			pollIntervalMs: 10,
			signal: ctrl1.signal,
		});
		const w2 = acquireSubagentHostLane({
			agentId: "CancelAllAgent",
			owner: "CancelAllAgent",
			cap: 1,
			pollIntervalMs: 10,
			signal: ctrl2.signal,
		});
		await allDenied.promise;
		ctrl1.abort();
		expect(await w1).toBeNull();
		ctrl2.abort();
		expect(await w2).toBeNull();

		const callsAtCancel = acquireSpy.mock.calls.length;
		await releaseLaneAdmission({ slotId: filler2.slot_id!, leaseToken: filler2.lease_token! });
		await Promise.resolve();
		await Promise.resolve();
		expect(acquireSpy.mock.calls.length).toBe(callsAtCancel);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);

		// 3) Sole waiter aborting mid-acquire releases the admitted slot cleanly before returning null
		const raceCtrl = new AbortController();
		acquireSpy.mockImplementationOnce(async opts => {
			const res = await realAcquire(opts);
			raceCtrl.abort();
			return res;
		});
		expect(
			await acquireSubagentHostLane({
				agentId: "MidAcquireRaceAgent",
				owner: "MidAcquireRaceAgent",
				cap: 1,
				signal: raceCtrl.signal,
			}),
		).toBeNull();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("owns concurrent release retries and abort compensation until durable settlement", async () => {
		const lease = await acquireSubagentHostLane({
			agentId: "RetryReleaseAgent",
			owner: "RetryReleaseAgent",
			cap: 2,
		});
		expect(lease).not.toBeNull();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(1);

		const realRelease = laneModule.laneAdmissionDriver.release;
		const releaseStarted = Promise.withResolvers<void>();
		const allowReleaseReturn = Promise.withResolvers<void>();
		const releaseSpy = vi
			.spyOn(laneModule.laneAdmissionDriver, "release")
			.mockImplementationOnce(async opts => {
				releaseStarted.resolve();
				await allowReleaseReturn.promise;
				return { ok: false, released: false, slot_id: opts.slotId, reason: "transient_release_error" };
			})
			.mockImplementation(opts => realRelease(opts));

		// Both handles await the same release and its transient retry.
		const r1 = lease!.release();
		const r2 = lease!.release();
		await releaseStarted.promise;
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		allowReleaseReturn.resolve();

		const [res1, res2] = await Promise.allSettled([r1, r2]);
		expect(res1.status).toBe("fulfilled");
		expect(res2.status).toBe("fulfilled");

		// Repeated calls after settlement do not write the ledger again.
		await lease!.release();
		expect(releaseSpy).toHaveBeenCalledTimes(2);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);

		// Subsequent release after durable success is an idempotent no-op
		await lease!.release();
		expect(releaseSpy).toHaveBeenCalledTimes(2);

		// Aborted acquisition retains compensation ownership without manual repair.
		const realAcquire = laneModule.laneAdmissionDriver.acquire;
		const acquireSpy = vi.spyOn(laneModule.laneAdmissionDriver, "acquire").mockImplementationOnce(async opts => {
			const res = await realAcquire(opts);
			ctrlWait.abort();
			return res;
		});
		const ctrlWait = new AbortController();
		releaseSpy.mockResolvedValueOnce({
			ok: false,
			released: false,
			slot_id: "comp-slot",
			reason: "compensation_failed",
		});
		await expect(
			acquireNativeHostLaneWait({
				owner: "CompFailWait",
				cap: 2,
				signal: ctrlWait.signal,
			}),
		).resolves.toBeNull();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);

		const ctrlSub = new AbortController();
		acquireSpy.mockImplementationOnce(async opts => {
			const res = await realAcquire(opts);
			ctrlSub.abort();
			return res;
		});
		releaseSpy.mockResolvedValueOnce({
			ok: false,
			released: false,
			slot_id: "comp-sub-slot",
			reason: "sub_compensation_failed",
		});
		await expect(
			acquireSubagentHostLane({
				agentId: "CompFailSub",
				owner: "CompFailSub",
				cap: 2,
				signal: ctrlSub.signal,
			}),
		).resolves.toBeNull();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("decrements each borrowed reference once and retains the final reference until durable release succeeds", async () => {
		const acquireSpy = vi.spyOn(laneModule.laneAdmissionDriver, "acquire");
		const realRelease = laneModule.laneAdmissionDriver.release;
		const releaseSpy = vi.spyOn(laneModule.laneAdmissionDriver, "release");

		const outer = await acquireSubagentHostLane({ agentId: "RefOrderAgent", owner: "RefOrderAgent", cap: 2 });
		const wake = await acquireSubagentHostLane({ agentId: "RefOrderAgent", owner: "RefOrderAgent", cap: 2 });
		expect(outer).not.toBeNull();
		expect(wake).not.toBeNull();
		expect(outer!.slotId).toBe(wake!.slotId);
		expect(acquireSpy).toHaveBeenCalledTimes(1);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(1);

		// Calling outer.release() twice decrements only outer's single reference, never wake's
		await outer!.release();
		await outer!.release();
		expect(releaseSpy).toHaveBeenCalledTimes(0);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(1);

		// A transient failure retains ownership until the retry settles.
		releaseSpy.mockResolvedValueOnce({
			ok: false,
			released: false,
			slot_id: wake!.slotId,
			reason: "final_release_failed",
		});
		releaseSpy.mockImplementation(opts => realRelease(opts));
		await wake!.release();
		expect(releaseSpy).toHaveBeenCalledTimes(2);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);

		// Map entry was deleted on durable release, so next acquire obtains a fresh slot
		const fresh = await acquireSubagentHostLane({ agentId: "RefOrderAgent", owner: "RefOrderAgent:fresh", cap: 2 });
		expect(fresh).not.toBeNull();
		expect(fresh!.slotId).not.toBe(outer!.slotId);
		expect(acquireSpy).toHaveBeenCalledTimes(2);
		await fresh!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});
});
