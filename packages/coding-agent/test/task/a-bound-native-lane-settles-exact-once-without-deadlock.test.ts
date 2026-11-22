/**
 * WHY: Native topic replenishment had four lifecycle ordering defects across `TopicReplenishmentEngine`,
 * `SpawnScheduler`, `runSpawn`, and `AsyncJobManager`:
 * 1. Inline completions (`async.enabled=false` or `blocking: true`) awaited `engine.onWorkerComplete` ->
 *    `engine.replenish` while the outer `withReplenishmentLease` was still held, deadlocking against itself.
 * 2. Bound detached jobs cancelled before semaphore admission or refused before `recordSpawn` (or rejected
 *    at registration after `recordNativeDispatch`) bypassed `onWorkerStartFailed`, leaving `native_claim`
 *    active and reservations leaked.
 * 3. Detached completions triggered `engine.replenish` inside `onSubagentComplete` before `AsyncJobManager`
 *    transitioned the job out of `running`, causing `maxRunningJobs=1` capacity rejections with no later refill.
 * 4. `recordSpawn` and `onSubagentComplete` ran before `writeSuccessorCheckpoint`, allowing canonical ledger
 *    advancement when checkpoint persistence failed.
 *
 * This suite exercises the real `createAgentSession` -> `TaskTool` -> `SpawnScheduler` -> `AsyncJobManager`
 * -> `runSpawn` -> `TopicReplenishmentEngine` -> `native-ledger-bridge.py` boundaries. It mocks only
 * `runSubprocess`, `discoverAgents`, and `atomicWriteJson` (for the disk-failure case); it does not test
 * live model providers or multi-process OS crashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import {
	type ClaimedTicket,
	type LedgerFileShape,
	TopicReplenishmentEngine,
} from "@veyyon/coding-agent/task/topic-replenishment";
import type { AgentDefinition, SingleResult, TaskParams } from "@veyyon/coding-agent/task/types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import * as atomicWriter from "@veyyon/utils/atomic-write";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

const writeAtomicJson = atomicWriter.atomicWriteJson;

const AUTHORIZATION = {
	status: "authorized",
	timestamp: "2026-09-06T10:00:00Z",
	scope: "staging",
	authorized_by: "operator",
} as const;

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General task worker",
	systemPrompt: "Execute the assigned ticket.",
	source: "bundled",
};

const blockingTaskAgent: AgentDefinition = {
	...taskAgent,
	blocking: true,
};

function makePassResult(options: executorModule.ExecutorOptions, stage = "review"): SingleResult {
	const structured = {
		stage,
		verdict: "pass",
		checks: [{ name: "verify", command: ["bun", "test"], exit_code: 0, observed: "ok", purpose: "verification" }],
	};
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		exitCode: 0,
		output: JSON.stringify(structured),
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		cancellationAcknowledged: true,
	};
}

async function pollUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) {
			throw new Error("pollUntil timed out");
		}
		await Bun.sleep(10);
	}
}

describe("native replenishment lifecycle contracts", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let previousWorkflowsDir: string | undefined;

	beforeEach(() => {
		previousWorkflowsDir = process.env.VEYYON_WORKFLOWS_DIR;
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) {
			const cleanup = cleanups.pop();
			await cleanup?.();
		}
		if (previousWorkflowsDir === undefined) {
			delete process.env.VEYYON_WORKFLOWS_DIR;
		} else {
			process.env.VEYYON_WORKFLOWS_DIR = previousWorkflowsDir;
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	async function setupHarness(options?: {
		settings?: Record<string, unknown>;
		initialRequests?: LedgerFileShape["requests"];
		targetCount?: number;
	}): Promise<{
		root: string;
		workCwd: string;
		ledgerPath: string;
		session: AgentSession;
		sessionManager: SessionManager;
		engine: TopicReplenishmentEngine;
		readLedger: () => Promise<LedgerFileShape>;
		writeLedger: (requests: LedgerFileShape["requests"]) => Promise<void>;
	}> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-native-lifecycle-"));
		const workCwd = path.join(root, "repo");
		const agentDir = path.join(root, "agent");
		const sessionsDir = path.join(agentDir, "sessions");
		await fs.mkdir(workCwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		// Keep bridge independent of external WorkerBackend scripts in ~/.veyyon/workflows.
		process.env.VEYYON_WORKFLOWS_DIR = path.join(root, "no-worker-backend");

		const ledgerPath = path.join(root, "ledger.json");
		const writeLedger = async (requests: LedgerFileShape["requests"]) => {
			await fs.writeFile(ledgerPath, JSON.stringify({ version: 2, requests }, null, 2), "utf8");
		};
		const readLedger = async (): Promise<LedgerFileShape> =>
			JSON.parse(await fs.readFile(ledgerPath, "utf8")) as LedgerFileShape;

		await writeLedger({});

		const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(workCwd, sessionsDir);

		const engine = new TopicReplenishmentEngine({
			ledgerPath,
			minFloor: 0,
			targetCount: options?.targetCount ?? 1,
			maxCeiling: options?.targetCount ?? 1,
			maxRamPct: 100,
		});

		const recovery = vi.spyOn(engine, "onSessionRecovery");
		const created = await createAgentSession({
			cwd: workCwd,
			agentDir,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"advisor.enabled": false,
				...(options?.settings ?? {}),
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: workCwd,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			replenishmentEngine: engine,
		});

		cleanups.push(async () => {
			await created.session.dispose();
			await sessionManager.close();
			authStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		});

		// Recovery takes a separate ledger lock before entering replenishment.
		expect(recovery).toHaveBeenCalledTimes(1);
		await recovery.mock.results[0]!.value;
		recovery.mockRestore();
		if (options?.initialRequests) {
			await writeLedger(options.initialRequests);
		}

		return {
			root,
			workCwd,
			ledgerPath,
			session: created.session,
			sessionManager,
			engine,
			readLedger,
			writeLedger,
		};
	}

	it("avoids lease re-entry deadlock and runs post-settlement replenishment for inline async=false workers", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const executedIds: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			executedIds.push(options.id);
			return makePassResult(options, "review");
		});

		const harness = await setupHarness({
			settings: { "async.enabled": false },
			targetCount: 1,
			initialRequests: {
				"ticket-inline-1": {
					prompt: "Complete first inline review ticket",
					state: "review",
					authorization: AUTHORIZATION,
				},
				"ticket-inline-2": {
					prompt: "Complete second inline review ticket",
					state: "review",
					authorization: AUTHORIZATION,
				},
			},
		});

		const firstOutcome = await harness.engine.replenish([]);
		expect(firstOutcome.status).toBe("replenished");
		expect(firstOutcome.dispatchedCount).toBe(1);

		await harness.engine.waitForPendingReplenishment();

		expect(executedIds).toHaveLength(2);
		const ledger = await harness.readLedger();
		expect(ledger.requests["ticket-inline-1"].state).toBe("awaiting authorization");
		expect(ledger.requests["ticket-inline-2"].state).toBe("awaiting authorization");
	}, 15_000);

	it("avoids lease re-entry deadlock and replenishes when a blocking=true agent runs inline under async.enabled=true", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [blockingTaskAgent],
			projectAgentsDir: null,
		});
		const executedIds: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			executedIds.push(options.id);
			return makePassResult(options, "review");
		});

		const harness = await setupHarness({
			settings: { "async.enabled": true },
			targetCount: 1,
			initialRequests: {
				"ticket-blocking-1": {
					prompt: "Run first blocking ticket",
					state: "review",
					authorization: AUTHORIZATION,
				},
				"ticket-blocking-2": {
					prompt: "Run second blocking ticket",
					state: "review",
					authorization: AUTHORIZATION,
				},
			},
		});

		const firstOutcome = await harness.engine.replenish([]);
		expect(firstOutcome.status).toBe("replenished");
		await harness.engine.waitForPendingReplenishment();

		expect(executedIds).toHaveLength(2);
		const ledger = await harness.readLedger();
		expect(ledger.requests["ticket-blocking-1"].state).toBe("awaiting authorization");
		expect(ledger.requests["ticket-blocking-2"].state).toBe("awaiting authorization");
	}, 15_000);

	it("rolls back a bound detached job cancelled before semaphore admission and protects newer claims", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const blockerGate = Promise.withResolvers<void>();
		const blockerEntered = Promise.withResolvers<void>();
		let nativeCalls = 0;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (options.id === "BlockerJob") {
				blockerEntered.resolve();
				await blockerGate.promise;
				return makePassResult(options);
			}
			nativeCalls++;
			return makePassResult(options, "review");
		});
		cleanups.push(() => blockerGate.resolve());

		const harness = await setupHarness({
			settings: { "async.enabled": true, "agent.maxConcurrency": 1, "async.maxJobs": 5 },
			targetCount: 1,
		});
		const manager = harness.session.asyncJobManager!;
		const taskTool = harness.session.getToolByName("task")!;

		// Occupy the single semaphore permit with a non-native job.
		const blockerRes = await taskTool.execute("tc-blocker", {
			agent: "task",
			name: "BlockerJob",
			task: "Hold the spawn semaphore.",
		} as TaskParams);
		expect(blockerRes.isError).not.toBe(true);
		await blockerEntered.promise;

		await harness.writeLedger({
			"ticket-queued-cancel": {
				prompt: "Cancelled while waiting on semaphore",
				state: "pending",
				authorization: AUTHORIZATION,
			},
		});

		const outcome = await harness.engine.replenish([]);
		expect(outcome.status).toBe("replenished");
		const oldRunId = outcome.dispatchedTickets[0]!.runId;

		const boundLedger = await harness.readLedger();
		const boundClaim = boundLedger.requests["ticket-queued-cancel"].native_claim!;
		expect(boundClaim.state).toBe("active");
		expect(boundClaim.run_id).toBe(oldRunId);
		expect(boundClaim.task_handle).toMatch(/^agent:\/\//);
		const boundJobId = boundClaim.worker_id!;
		const boundTaskHandle = boundClaim.task_handle!;

		// Cancel the bound job while it is still queued behind BlockerJob's semaphore permit.
		const queuedJob = manager.getJob(boundJobId);
		expect(queuedJob?.queued).toBe(true);
		expect(manager.cancel(boundJobId)).toBe(true);
		await queuedJob!.promise;
		expect(nativeCalls).toBe(0);

		const afterCancel = await harness.readLedger();
		expect(afterCancel.requests["ticket-queued-cancel"].state).toBe("pending");
		expect(afterCancel.requests["ticket-queued-cancel"].blocker).toBeNull();
		expect(afterCancel.requests["ticket-queued-cancel"].native_claim).toEqual({
			version: 1,
			state: "retryable",
			worker_id: null,
			run_id: null,
			task_handle: null,
		});

		// Reservation was cleared, so a new replenishment cycle can re-claim and run the ticket.
		const secondGate = Promise.withResolvers<void>();
		cleanups.push(() => secondGate.resolve());
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await secondGate.promise;
			return makePassResult(options, "build");
		});
		const reclaimed = await harness.engine.replenish([]);
		expect(reclaimed.status).toBe("replenished");
		const newRunId = reclaimed.dispatchedTickets[0]!.runId;
		expect(newRunId).not.toBe(oldRunId);

		// A late/stale start-failure for the old run cannot roll back the new claim or its reservation.
		const staleRollback = await harness.engine.onWorkerStartFailed({
			agentId: boundJobId,
			agentName: "task",
			ticketId: "ticket-queued-cancel",
			runId: oldRunId,
			taskHandle: boundTaskHandle,
			reason: "stale cancellation",
		});
		expect(staleRollback.rolledBack).toBe(false);
		expect((await harness.engine.replenish([])).status).toBe("floor_satisfied");

		const activeReclaim = await harness.readLedger();
		expect(activeReclaim.requests["ticket-queued-cancel"].native_claim?.run_id).toBe(newRunId);

		blockerGate.resolve();
		secondGate.resolve();
		await manager.waitForAll();
	}, 15_000);

	it("rolls back a bound detached job on preflight refusal before recordSpawn with exact-once hooks", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makePassResult(options, "build"));

		const harness = await setupHarness({
			settings: { "async.enabled": true, "async.maxJobs": 2 },
			targetCount: 1,
		});
		await harness.writeLedger({
			"ticket-preflight": {
				prompt: "Preflight refusal test ticket",
				state: "pending",
				authorization: AUTHORIZATION,
			},
		});

		// Force a real resolveSpawnCwd refusal inside runPreparedSpawn after registration.
		await fs.rm(harness.workCwd, { recursive: true, force: true });

		let startFailedCount = 0;
		let completeCount = 0;
		const origComplete = harness.engine.onWorkerComplete.bind(harness.engine);
		const origStartFailed = harness.engine.onWorkerStartFailed.bind(harness.engine);
		vi.spyOn(harness.engine, "onWorkerComplete").mockImplementation(async (...args) => {
			completeCount++;
			return origComplete(...args);
		});
		vi.spyOn(harness.engine, "onWorkerStartFailed").mockImplementation(async (...args) => {
			startFailedCount++;
			return origStartFailed(...args);
		});

		const outcome = await harness.engine.replenish([]);
		expect(outcome.status).toBe("replenished");

		await harness.session.asyncJobManager!.waitForAll();

		expect(runSpy).not.toHaveBeenCalled();
		expect(startFailedCount).toBe(1);
		expect(completeCount).toBe(0);

		const afterRefusal = await harness.readLedger();
		expect(afterRefusal.requests["ticket-preflight"].state).toBe("pending");
		expect(afterRefusal.requests["ticket-preflight"].blocker).toBeNull();
		expect(afterRefusal.requests["ticket-preflight"].native_claim).toEqual({
			version: 1,
			state: "retryable",
			worker_id: null,
			run_id: null,
			task_handle: null,
		});

		// Restore cwd and confirm reservation was freed so replenishment succeeds.
		await fs.mkdir(harness.workCwd, { recursive: true });
		const retryOutcome = await harness.engine.replenish([]);
		expect(retryOutcome.status).toBe("replenished");
		await harness.session.asyncJobManager!.waitForAll();
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(completeCount).toBe(1);
	}, 15_000);

	it("rolls back a bound claim when AsyncJobManager.register rejects at capacity after recordNativeDispatch", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		cleanups.push(() => gate.resolve());
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (options.id === "SlotHolder") {
				entered.resolve();
				await gate.promise;
			}
			return makePassResult(options, "review");
		});

		const harness = await setupHarness({
			settings: { "async.enabled": true, "async.maxJobs": 1 },
			targetCount: 1,
		});
		const manager = harness.session.asyncJobManager!;
		const taskTool = harness.session.getToolByName("task")!;

		await taskTool.execute("tc-holder", {
			agent: "task",
			name: "SlotHolder",
			task: "Occupy the single async job slot.",
		} as TaskParams);
		await entered.promise;

		await harness.writeLedger({
			"ticket-capacity-reject": {
				prompt: "Should roll back when register rejects",
				state: "review",
				authorization: AUTHORIZATION,
			},
		});

		const failedReplenish = await harness.engine.replenish([]);
		expect(failedReplenish.status).toBe("error");

		const afterReject = await harness.readLedger();
		expect(afterReject.requests["ticket-capacity-reject"].state).toBe("review");
		expect(afterReject.requests["ticket-capacity-reject"].native_claim).toEqual({
			version: 1,
			state: "retryable",
			worker_id: null,
			run_id: null,
			task_handle: null,
		});

		// Settling the holder opens the slot and may trigger replenishment itself.
		gate.resolve();
		await manager.waitForAll();
		await harness.engine.replenish([]);
		await manager.waitForAll();
		const finalLedger = await harness.readLedger();
		expect(finalLedger.requests["ticket-capacity-reject"].state).toBe("awaiting authorization");
	}, 15_000);

	it("defers background replenishment until AsyncJobManager transitions out of running at maxRunningJobs=1", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const firstGate = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		cleanups.push(() => firstGate.resolve());

		let callCount = 0;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			callCount++;
			if (callCount === 1) {
				firstEntered.resolve();
				await firstGate.promise;
			} else if (callCount === 2) {
				secondEntered.resolve();
			}
			return makePassResult(options, "review");
		});

		const harness = await setupHarness({
			settings: { "async.enabled": true, "async.maxJobs": 1 },
			targetCount: 1,
			initialRequests: {
				"ticket-cap-1": {
					prompt: "First ticket under maxRunningJobs=1",
					state: "review",
					authorization: AUTHORIZATION,
				},
				"ticket-cap-2": {
					prompt: "Second ticket refilled after slot release",
					state: "review",
					authorization: AUTHORIZATION,
				},
			},
		});

		const manager = harness.session.asyncJobManager!;
		const outcome = await harness.engine.replenish([]);
		expect(outcome.status).toBe("replenished");
		expect(outcome.dispatchedCount).toBe(1);

		await firstEntered.promise;
		expect(manager.atCapacity).toBe(true);

		firstGate.resolve();
		await secondEntered.promise;
		await pollUntil(async () => {
			const l = await harness.readLedger();
			return (
				l.requests["ticket-cap-1"].state === "awaiting authorization" &&
				l.requests["ticket-cap-2"].state === "awaiting authorization"
			);
		});
		await manager.waitForAll();

		expect(callCount).toBe(2);
	}, 15_000);

	it("persists successor checkpoint before recordSpawn and prevents canonical ledger advancement on checkpoint failure", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makePassResult(options, "review"));

		const harness = await setupHarness({
			settings: { "async.enabled": false },
			targetCount: 1,
		});

		// Case A: on a successful run, the checkpoint file is already durable when onWorkerComplete runs.
		await harness.writeLedger({
			"ticket-cp-ok": {
				prompt: "Verify checkpoint precedes canonical completion",
				state: "review",
				authorization: AUTHORIZATION,
			},
		});
		let checkpointExistedAtCompletion = false;
		const origComplete = harness.engine.onWorkerComplete.bind(harness.engine);
		const completeSpy = vi
			.spyOn(harness.engine, "onWorkerComplete")
			.mockImplementation(async (event, roster, opts) => {
				const sessionDir = harness.sessionManager.getSessionFile()!.slice(0, -6);
				const cpHash = createHash("sha256").update(event.agentId).digest("hex");
				const cpPath = path.join(sessionDir, `${cpHash}.checkpoint.json`);
				checkpointExistedAtCompletion = await fs
					.stat(cpPath)
					.then(() => true)
					.catch(() => false);
				return origComplete(event, roster, opts);
			});

		await harness.engine.replenish([]);
		await harness.engine.waitForPendingReplenishment();
		expect(checkpointExistedAtCompletion).toBe(true);
		expect((await harness.readLedger()).requests["ticket-cp-ok"].state).toBe("awaiting authorization");
		completeSpy.mockRestore();

		// Case B: if checkpoint persistence fails, both the spawn record and the ledger stay failed/unadvanced.
		await harness.writeLedger({
			"ticket-cp-fail": {
				prompt: "Do not advance ledger if checkpoint write fails",
				state: "review",
				authorization: AUTHORIZATION,
			},
		});
		vi.spyOn(atomicWriter, "atomicWriteJson").mockImplementation(async (file, value, opts) => {
			if (String(file).endsWith(".checkpoint.json")) {
				throw new Error("checkpoint disk failure");
			}
			return writeAtomicJson(file, value, opts);
		});

		const dispatched: ClaimedTicket[] = [];
		const origExec = harness.engine.executor!;
		harness.engine.setNativeExecutor(async ticket => {
			dispatched.push(ticket);
			return origExec(ticket);
		});

		await harness.engine.replenish([]);
		await harness.engine.waitForPendingReplenishment();

		expect(dispatched).toHaveLength(1);
		const ledgerAfterFail = await harness.readLedger();
		const ticketAfterFail = ledgerAfterFail.requests["ticket-cp-fail"];
		expect(ticketAfterFail.state).toBe("review");
		expect(ticketAfterFail.blocker).toContain("successor-checkpoint-write-failed");
		expect(ticketAfterFail.blocker).toContain("checkpoint disk failure");
		expect(ticketAfterFail.native_claim?.state).toBe("retryable");

		const cpFailRecord = harness.sessionManager
			.getEntries()
			.filter(entry => entry.type === "subagent_spawn")
			.find(entry => entry.ticketId === "ticket-cp-fail");
		expect(cpFailRecord).toBeDefined();
		expect(cpFailRecord?.status).toBe("failed");
		expect(cpFailRecord?.error).toContain("successor-checkpoint-write-failed");
	}, 15_000);
});
