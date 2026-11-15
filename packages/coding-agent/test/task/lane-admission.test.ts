/**
 * WHY: native subagent spawns and external Python `WorkerBackend` runs share one
 * host-wide concurrency budget (default cap 40) via `<globalConfigRoot>/run/lane-admission.json`.
 * An in-memory semaphore per process cannot see other Veyyon processes or external
 * launchers, and a naive timer-based reaper drops live slow workers or gets fooled by
 * caller death while a detached worker lives.
 *
 * Class closed here:
 * - Atomic acquire / adopt / heartbeat / fenced release / status on `run/lane-admission.json`
 * - Cap enforcement across concurrent contenders and processes
 * - Reclaim ONLY on proven dead bound process instance (non-null identity + dead/reused PID);
 *   never on elapsed time alone, never for uncertain `launching` slots or unknown liveness
 * - External reservation surviving caller exit after `adopt` binds the live worker PID
 * - Conservative upgrade fail-closed when live `run/terminals/*.json` owners lack `"lane-admission"`
 * - Corrupt / wrong-version ledger fail-closed without resetting active reservations
 * - Native `runSubprocess` and `runSubagentFollowUpTurn` acquiring before provider start and
 *   releasing on verified child end (including failure and abort)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { IrcBus } from "@veyyon/coding-agent/task/irc-bus";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import * as laneModule from "@veyyon/coding-agent/task/lane-admission";
import { runSubagentFollowUpTurn, runSubprocess } from "@veyyon/coding-agent/task/executor";
import {
	acquireNativeHostLaneWait,
	acquireLaneAdmission,
	adoptLaneAdmission,
	DEFAULT_HOST_LANE_CAP,
	getLaneAdmissionLedgerPath,
	getLaneAdmissionStatus,
	heartbeatLaneAdmission,
	LANE_ADMISSION_CAPABILITY,
	LANE_ADMISSION_VERSION,
	type LaneLivenessProbe,
	releaseLaneAdmission,
} from "@veyyon/coding-agent/task/lane-admission";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";
import { getGlobalConfigRootDir } from "@veyyon/utils/config-root";
import { applyOwnerOnlyWindowsAcl } from "@veyyon/utils/windows-acl";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";

const testAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const tempDirs: TempDir[] = [];
const createdSessions: AgentSession[] = [];
function makeRealAgentSession(opts: { agentId?: string; agentKind?: "main" | "sub" } = {}): AgentSession {
	const sessionManager = SessionManager.inMemory("/repo");
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				systemPrompt: ["system prompt"],
				messages: [],
				tools: [],
			},
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
		agentId: opts.agentId,
		agentKind: opts.agentKind,
	});
	createdSessions.push(session);
	return session;
}
function makeArtifactsDir(): string {
	const dir = TempDir.createSync("@veyyon-lane-admission-artifacts-");
	tempDirs.push(dir);
	return dir.path();
}

describe("host-wide shared lane admission", () => {
	let isolated: IsolatedConfigRoot;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		isolated = enterIsolatedConfigRoot("lane-admission", { defaultProfile: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of createdSessions.splice(0)) {
			await session.dispose();
		}
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
		isolated.restore();
	});

	it("stores the ledger under <globalConfigRoot>/run/lane-admission.json with default cap 40", async () => {
		expect(DEFAULT_HOST_LANE_CAP).toBe(40);
		expect(getLaneAdmissionLedgerPath()).toBe(path.join(getGlobalConfigRootDir(), "run", "lane-admission.json"));

		const status = await getLaneAdmissionStatus();
		expect(status.ok).toBe(true);
		expect(status.cap).toBe(40);
		expect(status.active_lanes).toBe(0);
		expect(status.n_free).toBe(40);
		expect(status.all_host_enforced).toBe(true);
	});

	it("enforces atomic acquire, adopt, heartbeat, fenced release, and idempotent double release", async () => {
		const a1 = await acquireLaneAdmission({ owner: "disp-1", kind: "external", callerPid: process.pid, cap: 2 });
		expect(a1.admitted).toBe(true);
		expect(a1.state).toBe("launching");
		expect(a1.active_lanes).toBe(1);
		expect(a1.n_free).toBe(1);
		expect(typeof a1.slot_id).toBe("string");
		expect(typeof a1.lease_token).toBe("string");

		const a2 = await acquireLaneAdmission({ owner: "disp-2", kind: "external", callerPid: process.pid, cap: 2 });
		expect(a2.admitted).toBe(true);
		expect(a2.active_lanes).toBe(2);
		expect(a2.n_free).toBe(0);

		const a3 = await acquireLaneAdmission({ owner: "disp-3", kind: "external", callerPid: process.pid, cap: 2 });
		expect(a3.admitted).toBe(false);
		expect(a3.reason).toBe("host_lane_cap_reached");
		expect(a3.active_lanes).toBe(2);
		expect(a3.n_free).toBe(0);

		// Wrong lease token cannot adopt, heartbeat, or release
		const badAdopt = await adoptLaneAdmission({
			slotId: a1.slot_id!,
			leaseToken: "wrong-token",
			pid: process.pid,
		});
		expect(badAdopt.ok).toBe(false);
		expect(badAdopt.adopted).toBe(false);
		expect(badAdopt.reason).toBe("lease_token_mismatch");

		const badBeat = await heartbeatLaneAdmission({
			slotId: a1.slot_id!,
			leaseToken: "wrong-token",
		});
		expect(badBeat.ok).toBe(false);
		expect(badBeat.reason).toBe("lease_token_mismatch");

		const badRelease = await releaseLaneAdmission({
			slotId: a1.slot_id!,
			leaseToken: "wrong-token",
		});
		expect(badRelease.ok).toBe(false);
		expect(badRelease.released).toBe(false);
		expect(badRelease.reason).toBe("lease_token_mismatch");

		// Valid adopt binds worker PID and transitions launching -> active
		const adopted = await adoptLaneAdmission({
			slotId: a1.slot_id!,
			leaseToken: a1.lease_token!,
			pid: process.pid,
		});
		expect(adopted.ok).toBe(true);
		expect(adopted.adopted).toBe(true);
		expect(adopted.state).toBe("active");
		expect(adopted.pid).toBe(process.pid);
		expect(adopted.pid_alive).toBe(true);

		const beat = await heartbeatLaneAdmission({
			slotId: a1.slot_id!,
			leaseToken: a1.lease_token!,
		});
		expect(beat.ok).toBe(true);
		expect(typeof beat.last_heartbeat_at).toBe("number");

		// Valid fenced release frees the slot so a3 can acquire
		const rel1 = await releaseLaneAdmission({
			slotId: a1.slot_id!,
			leaseToken: a1.lease_token!,
		});
		expect(rel1.ok).toBe(true);
		expect(rel1.released).toBe(true);
		expect(rel1.active_lanes).toBe(1);
		expect(rel1.n_free).toBe(1);

		const relAgain = await releaseLaneAdmission({
			slotId: a1.slot_id!,
			leaseToken: a1.lease_token!,
		});
		expect(relAgain.ok).toBe(true);
		expect(relAgain.released).toBe(false);
		expect(relAgain.already_absent).toBe(true);

		const a3Retry = await acquireLaneAdmission({ owner: "disp-3", kind: "external", callerPid: process.pid, cap: 2 });
		expect(a3Retry.admitted).toBe(true);
	});

	it("reclaims ONLY proven dead process instances, never by elapsed time or unknown liveness", async () => {
		const fakeLive = new Map<string, boolean>();
		const probe: LaneLivenessProbe = {
			getStartIdentity: pid => `test:${pid}:1`,
			isPidAlive: pid => fakeLive.has(String(pid)),
			isInstanceAlive: (pid, expectedIdentity) => {
				if (expectedIdentity === null) return true;
				return fakeLive.get(`${pid}:${expectedIdentity}`) === true;
			},
		};
		fakeLive.set("101", true);
		fakeLive.set("101:test:101:1", true);
		fakeLive.set("202", true);
		fakeLive.set("202:test:202:1", true);

		// 1) Active live process with very old timestamp -> NEVER reclaimed on elapsed time
		const liveSlot = await acquireLaneAdmission({
			owner: "live-old",
			kind: "native",
			workerPid: 101,
			cap: 4,
			liveness: probe,
		});
		expect(liveSlot.admitted).toBe(true);

		// 2) Active slot whose process will die (proven dead instance)
		const deadSlot = await acquireLaneAdmission({
			owner: "will-die",
			kind: "native",
			workerPid: 202,
			cap: 4,
			liveness: probe,
		});
		expect(deadSlot.admitted).toBe(true);

		// 3) Launching slot where caller died before adopt -> uncertain launch slot -> retained
		const launchingSlot = await acquireLaneAdmission({
			owner: "uncertain-launch",
			kind: "external",
			callerPid: 999999,
			cap: 4,
			liveness: probe,
		});
		expect(launchingSlot.admitted).toBe(true);
		expect(launchingSlot.state).toBe("launching");

		// 4) Active slot with null processIdentity (unknown liveness) -> retained
		const unknownProbe: LaneLivenessProbe = {
			...probe,
			getStartIdentity: () => null,
		};
		const unknownSlot = await acquireLaneAdmission({
			owner: "unknown-liveness",
			kind: "external",
			callerPid: 303,
			workerPid: 303,
			cap: 4,
			liveness: unknownProbe,
		});
		expect(unknownSlot.admitted).toBe(true);

		// Age all timestamps by 24 hours on disk to verify elapsed time alone never reclaims
		const ledgerPath = getLaneAdmissionLedgerPath();
		const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
			version: number;
			cap: number;
			reservations: Array<Record<string, unknown>>;
		};
		const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
		for (const item of ledger.reservations) {
			item.acquiredAt = dayAgo;
			item.lastHeartbeatAt = dayAgo;
		}
		fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

		// Kill only pid 202 (leaving 101 live, launchingSlot unbound, unknownSlot unverified)
		fakeLive.delete("202");
		fakeLive.delete("202:test:202:1");

		const status = await getLaneAdmissionStatus({ cap: 4, liveness: probe });
		expect(status.reclaimed_count).toBe(1);
		expect(status.active_lanes).toBe(3);
		expect(status.n_free).toBe(1);
		expect(status.reservations.map(r => r.owner).sort()).toEqual(["live-old", "uncertain-launch", "unknown-liveness"]);
	});

	it("external reservation survives caller death while spawned worker process lives, then reclaims when worker exits", async () => {
		const caller = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const worker = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "ignore",
		});

		try {
			const acq = await acquireLaneAdmission({
				owner: "ext-survival",
				kind: "external",
				callerPid: caller.pid,
				cap: 1,
			});
			expect(acq.admitted).toBe(true);

			const adopted = await adoptLaneAdmission({
				slotId: acq.slot_id!,
				leaseToken: acq.lease_token!,
				pid: worker.pid,
			});
			expect(adopted.ok).toBe(true);
			expect(adopted.identity_verified).toBe(true);

			// Caller exits; worker stays alive -> reservation MUST survive
			await caller.exited;

			const whileWorkerLives = await acquireLaneAdmission({
				owner: "contender",
				kind: "external",
				callerPid: process.pid,
				cap: 1,
			});
			expect(whileWorkerLives.admitted).toBe(false);
			expect(whileWorkerLives.reason).toBe("host_lane_cap_reached");

			// Kill worker and await exit -> slot must be reclaimed automatically
			worker.kill();
			await worker.exited;

			const afterWorkerExit = await acquireLaneAdmission({
				owner: "contender-after",
				kind: "external",
				callerPid: process.pid,
				cap: 1,
			});
			expect(afterWorkerExit.admitted).toBe(true);
			expect(afterWorkerExit.reclaimed_count).toBe(1);
		} finally {
			try {
				caller.kill();
			} catch {}
			try {
				worker.kill();
			} catch {}
		}
	});

	it("fails closed on corrupt or unsupported-version ledger without resetting state", async () => {
		const ledgerPath = getLaneAdmissionLedgerPath();
		fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
		fs.writeFileSync(ledgerPath, "{not valid json", "utf8");

		const onCorrupt = await acquireLaneAdmission({ owner: "disp-corrupt", kind: "external", cap: 40 });
		expect(onCorrupt.ok).toBe(false);
		expect(onCorrupt.admitted).toBe(false);
		expect(onCorrupt.reason).toBe("corrupt_admission_ledger");
		expect(fs.readFileSync(ledgerPath, "utf8")).toBe("{not valid json");

		fs.writeFileSync(
			ledgerPath,
			JSON.stringify({ version: LANE_ADMISSION_VERSION + 99, cap: 40, reservations: [] }),
			"utf8",
		);
		const onBadVersion = await acquireLaneAdmission({ owner: "disp-ver", kind: "external", cap: 40 });
		expect(onBadVersion.ok).toBe(false);
		expect(onBadVersion.admitted).toBe(false);
		expect(onBadVersion.reason).toBe("unsupported_ledger_version");
	});

	it("fails closed for external callers when live terminal owners lack lane-admission capability", async () => {
		const terminalsDir = path.join(getGlobalConfigRootDir(), "profiles", "default", "run", "terminals");
		const ownerFile = path.join(terminalsDir, "legacy-session.json");
		fs.mkdirSync(terminalsDir, { recursive: true, mode: 0o700 });
		if (process.platform === "win32") await applyOwnerOnlyWindowsAcl(terminalsDir);
		else fs.chmodSync(terminalsDir, 0o700);
		const writeOwnerRecord = async (capabilities: readonly string[]) => {
			fs.writeFileSync(
				ownerFile,
				JSON.stringify({
					version: 1,
					sessionId: "legacy-session",
					pid: process.pid,
					capabilities,
				}),
				{ encoding: "utf8", mode: 0o600 },
			);
			if (process.platform === "win32") await applyOwnerOnlyWindowsAcl(ownerFile);
			else fs.chmodSync(ownerFile, 0o600);
		};
		await writeOwnerRecord(["deliver-ack", "session-notices"]);

		const status = await getLaneAdmissionStatus();
		expect(status.all_host_enforced).toBe(false);
		expect(status.unregistered_live_owners.length).toBe(1);
		expect(status.unregistered_live_owners[0]?.sessionId).toBe("legacy-session");

		const ext = await acquireLaneAdmission({ owner: "ext-upgrade-guard", kind: "external", cap: 40 });
		expect(ext.ok).toBe(false);
		expect(ext.admitted).toBe(false);
		expect(ext.all_host_enforced).toBe(false);
		expect(ext.reason).toBe("older_unregistered_veyyon_processes_live");

		// Native acquires still register so mixed hosts track upgraded processes
		const nat = await acquireLaneAdmission({ owner: "nat-upgrade-ok", kind: "native", workerPid: process.pid, cap: 40 });
		expect(nat.ok).toBe(true);
		expect(nat.admitted).toBe(true);
		expect(nat.all_host_enforced).toBe(false);
		await releaseLaneAdmission({ slotId: nat.slot_id!, leaseToken: nat.lease_token! });

		// Once live terminals advertise lane-admission, external callers are admitted
		await writeOwnerRecord(["deliver-ack", "session-notices", LANE_ADMISSION_CAPABILITY]);
		const extOk = await acquireLaneAdmission({ owner: "ext-upgrade-ok", kind: "external", cap: 40 });
		expect(extOk.ok).toBe(true);
		expect(extOk.admitted).toBe(true);
		expect(extOk.all_host_enforced).toBe(true);
	});

	it("exposes narrow JSON CLI `veyyon lane-admission` usable by external callers across processes", async () => {
		const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
		const runCli = (args: string[]) => {
			const res = Bun.spawnSync([process.execPath, "run", cliEntry, "lane-admission", ...args], {
				env: { ...process.env, VEYYON_CONFIG_DIR: isolated.envValue },
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				exitCode: res.exitCode,
				stdout: res.stdout.toString().trim(),
				stderr: res.stderr.toString().trim(),
			};
		};

		const worker = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "ignore",
		});

		try {
			const acq = runCli(["acquire", "--owner", "cli-disp-1", "--kind", "external", "--cap", "1", "--json"]);
			expect(acq.exitCode).toBe(0);
			const acqJson = JSON.parse(acq.stdout);
			expect(acqJson.admitted).toBe(true);
			expect(acqJson.active_lanes).toBe(1);
			expect(acqJson.n_free).toBe(0);

			const denied = runCli(["acquire", "--owner", "cli-disp-2", "--kind", "external", "--cap", "1", "--json"]);
			expect(denied.exitCode).toBe(1);
			const deniedJson = JSON.parse(denied.stdout);
			expect(deniedJson.admitted).toBe(false);
			expect(deniedJson.reason).toBe("host_lane_cap_reached");

			const adopt = runCli([
				"adopt",
				"--slot-id",
				acqJson.slot_id,
				"--lease-token",
				acqJson.lease_token,
				"--pid",
				String(worker.pid),
				"--json",
			]);
			expect(adopt.exitCode).toBe(0);
			expect(JSON.parse(adopt.stdout).adopted).toBe(true);

			const beat = runCli([
				"heartbeat",
				"--slot-id",
				acqJson.slot_id,
				"--lease-token",
				acqJson.lease_token,
				"--json",
			]);
			expect(beat.exitCode).toBe(0);

			const badRelease = runCli([
				"release",
				"--slot-id",
				acqJson.slot_id,
				"--lease-token",
				"bad-token",
				"--json",
			]);
			expect(badRelease.exitCode).toBe(1);

			const status = runCli(["status", "--cap", "1", "--json"]);
			expect(status.exitCode).toBe(0);
			expect(JSON.parse(status.stdout).active_lanes).toBe(1);

			const release = runCli([
				"release",
				"--slot-id",
				acqJson.slot_id,
				"--lease-token",
				acqJson.lease_token,
				"--json",
			]);
			expect(release.exitCode).toBe(0);
			expect(JSON.parse(release.stdout).released).toBe(true);

			const statusAfter = runCli(["status", "--cap", "1", "--json"]);
			expect(statusAfter.exitCode).toBe(0);
			expect(JSON.parse(statusAfter.stdout).n_free).toBe(1);
		} finally {
			try {
				worker.kill();
			} catch {}
		}
	});

	it("acquires a host admission slot before native child provider start and releases on verified child end or failure", async () => {
		let lanesDuringPrompt = -1;
		const session = createMockSession(
			async ({ emit }) => {
				const during = await getLaneAdmissionStatus();
				lanesDuringPrompt = during.active_lanes;
				emit(yieldSuccessEvent({ ok: true }));
			},
			{ activeToolNames: ["yield"] },
		);

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/repo",
			agent: testAgent,
			task: "run test",
			index: 0,
			id: "NativeSlotChild",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {}, getAvailable: () => [], getApiKey: async () => "k" } as never,
			enableLsp: false,
			eventBus: new EventBus(),
			artifactsDir: makeArtifactsDir(),
		});

		expect(result.exitCode).toBe(0);
		expect(lanesDuringPrompt).toBe(1);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);

		// Failure during session creation still releases the acquired slot
		vi.spyOn(sdkModule, "createAgentSession").mockRejectedValueOnce(new Error("boom"));
		const failed = await runSubprocess({
			cwd: "/repo",
			agent: testAgent,
			task: "run fail",
			index: 1,
			id: "NativeSlotFail",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {}, getAvailable: () => [], getApiKey: async () => "k" } as never,
			enableLsp: false,
			eventBus: new EventBus(),
			artifactsDir: makeArtifactsDir(),
		});
		expect(failed.exitCode).not.toBe(0);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("acquires and releases a host admission slot on runSubagentFollowUpTurn", async () => {
		let lanesDuringFollowUp = -1;
		const session = createMockSession(
			async ({ emit }) => {
				lanesDuringFollowUp = (await getLaneAdmissionStatus()).active_lanes;
				emit(yieldSuccessEvent({ ok: true }));
			},
			{ activeToolNames: ["yield"] },
		);

		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(session);

		const follow = await runSubagentFollowUpTurn({
			id: "FollowUpSlotChild",
			agent: testAgent,
			message: "continue",
			eventBus: new EventBus(),
			artifactsDir: makeArtifactsDir(),
		});
		expect(follow.exitCode).toBe(0);
		expect(lanesDuringFollowUp).toBe(1);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("rejects duplicate acquire for the same active/launching owner until released or reclaimed", async () => {
		const fakeLive = new Map<string, boolean>([
			["404", true],
			["404:test:404:1", true],
		]);
		const probe: LaneLivenessProbe = {
			getStartIdentity: pid => `test:${pid}:1`,
			isPidAlive: pid => fakeLive.has(String(pid)),
			isInstanceAlive: (pid, expectedIdentity) =>
				expectedIdentity === null ? true : fakeLive.get(`${pid}:${expectedIdentity}`) === true,
		};

		const first = await acquireLaneAdmission({ owner: "dup-owner", kind: "external", cap: 4, liveness: probe });
		expect(first.admitted).toBe(true);

		// Second concurrent acquire with the same launching owner fails closed (no double start)
		const dupLaunching = await acquireLaneAdmission({ owner: "dup-owner", kind: "external", cap: 4, liveness: probe });
		expect(dupLaunching.ok).toBe(false);
		expect(dupLaunching.admitted).toBe(false);
		expect(dupLaunching.reason).toBe("owner_already_reserved");
		expect(dupLaunching.active_lanes).toBe(1);

		// Adopt to active live pid 404 -> duplicate acquire still refused
		const adopted = await adoptLaneAdmission({
			slotId: first.slot_id!,
			leaseToken: first.lease_token!,
			pid: 404,
			liveness: probe,
		});
		expect(adopted.adopted).toBe(true);

		const dupActive = await acquireLaneAdmission({ owner: "dup-owner", kind: "external", cap: 4, liveness: probe });
		expect(dupActive.admitted).toBe(false);
		expect(dupActive.reason).toBe("owner_already_reserved");

		// Once worker dies, reclaim frees the owner so retry succeeds
		fakeLive.delete("404");
		fakeLive.delete("404:test:404:1");
		const retried = await acquireLaneAdmission({ owner: "dup-owner", kind: "external", cap: 4, liveness: probe });
		expect(retried.admitted).toBe(true);
		expect(retried.reclaimed_count).toBe(1);

		await releaseLaneAdmission({ slotId: retried.slot_id!, leaseToken: retried.lease_token! });
		const afterRelease = await acquireLaneAdmission({ owner: "dup-owner", kind: "external", cap: 4, liveness: probe });
		expect(afterRelease.admitted).toBe(true);
	});

	it("refuses adopt for dead worker PID and refuses re-adopting a slot under a different PID", async () => {
		const fakeLive = new Map<string, boolean>([
			["505", true],
			["505:test:505:1", true],
			["606", true],
			["606:test:606:1", true],
		]);
		const probe: LaneLivenessProbe = {
			getStartIdentity: pid => (fakeLive.has(String(pid)) ? `test:${pid}:1` : null),
			isPidAlive: pid => fakeLive.has(String(pid)),
			isInstanceAlive: (pid, expectedIdentity) =>
				expectedIdentity === null ? true : fakeLive.get(`${pid}:${expectedIdentity}`) === true,
		};

		const acq = await acquireLaneAdmission({ owner: "adopt-guard", kind: "external", cap: 4, liveness: probe });
		expect(acq.admitted).toBe(true);

		// Worker 999 died before adopt ran -> refuse instead of transitioning to unverified active slot
		const deadAdopt = await adoptLaneAdmission({
			slotId: acq.slot_id!,
			leaseToken: acq.lease_token!,
			pid: 999,
			liveness: probe,
		});
		expect(deadAdopt.ok).toBe(false);
		expect(deadAdopt.adopted).toBe(false);
		expect(deadAdopt.pid_alive).toBe(false);
		expect(deadAdopt.reason).toBe("worker_pid_not_alive");
		expect((await getLaneAdmissionStatus({ cap: 4, liveness: probe })).reservations[0]?.state).toBe("launching");

		// Adopt live PID 505 succeeds; repeating same PID is idempotent; switching to 606 is refused
		const okAdopt = await adoptLaneAdmission({
			slotId: acq.slot_id!,
			leaseToken: acq.lease_token!,
			pid: 505,
			liveness: probe,
		});
		expect(okAdopt.ok).toBe(true);
		expect(okAdopt.adopted).toBe(true);

		const sameAdopt = await adoptLaneAdmission({
			slotId: acq.slot_id!,
			leaseToken: acq.lease_token!,
			pid: 505,
			liveness: probe,
		});
		expect(sameAdopt.ok).toBe(true);
		expect(sameAdopt.adopted).toBe(true);

		const otherAdopt = await adoptLaneAdmission({
			slotId: acq.slot_id!,
			leaseToken: acq.lease_token!,
			pid: 606,
			liveness: probe,
		});
		expect(otherAdopt.ok).toBe(false);
		expect(otherAdopt.adopted).toBe(false);
		expect(otherAdopt.reason).toBe("slot_already_adopted");
	});

	it("preserves persisted ledger cap in getLaneAdmissionStatus when cap is omitted", async () => {
		const fakeLive = new Map<string, boolean>([
			["707", true],
			["707:test:707:1", true],
		]);
		const probe: LaneLivenessProbe = {
			getStartIdentity: pid => `test:${pid}:1`,
			isPidAlive: pid => fakeLive.has(String(pid)),
			isInstanceAlive: (pid, expectedIdentity) =>
				expectedIdentity === null ? true : fakeLive.get(`${pid}:${expectedIdentity}`) === true,
		};

		const acq = await acquireLaneAdmission({
			owner: "cap-preserve",
			kind: "native",
			workerPid: 707,
			cap: 3,
			liveness: probe,
		});
		expect(acq.admitted).toBe(true);

		fakeLive.delete("707");
		fakeLive.delete("707:test:707:1");

		const status = await getLaneAdmissionStatus({ liveness: probe });
		expect(status.cap).toBe(3);
		expect(status.reclaimed_count).toBe(1);
		const persisted = JSON.parse(fs.readFileSync(getLaneAdmissionLedgerPath(), "utf8")) as { cap: number };
		expect(persisted.cap).toBe(3);
	});

	it("releases immediately and returns null when acquireNativeHostLaneWait aborts mid-acquire", async () => {
		const controller = new AbortController();
		const realAcquire = laneModule.acquireLaneAdmission;
		vi.spyOn(laneModule, "acquireLaneAdmission").mockImplementationOnce(async opts => {
			const res = await realAcquire(opts);
			controller.abort();
			return res;
		});

		const lease = await acquireNativeHostLaneWait({ owner: "abort-mid-acquire", signal: controller.signal });
		expect(lease).toBeNull();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("acquires a host admission slot for subagent IRC wake turns, prevents double-start at cap, and bypasses for main", async () => {
		const subSession = makeRealAgentSession({ agentId: "WakeSubChild", agentKind: "sub" });
		let activeDuringPrompt = -1;
		let promptCalls = 0;
		let promptStarted = Promise.withResolvers<void>();
		let promptHold = Promise.withResolvers<void>();
		vi.spyOn(subSession.agent, "prompt").mockImplementation(async () => {
			promptCalls += 1;
			activeDuringPrompt = (await getLaneAdmissionStatus()).active_lanes;
			promptStarted.resolve();
			await promptHold.promise;
		});

		const realRelease = laneModule.releaseLaneAdmission;
		let wakeReleased = Promise.withResolvers<void>();
		vi.spyOn(laneModule, "releaseLaneAdmission").mockImplementation(async opts => {
			const res = await realRelease(opts);
			if (opts.slotId === wakeSlotIdToWatch) {
				wakeReleased.resolve();
			}
			return res;
		});
		let wakeSlotIdToWatch: string | undefined;
		const realAcquire = laneModule.acquireLaneAdmission;
		let capDeniedObserved = Promise.withResolvers<void>();
		vi.spyOn(laneModule, "acquireLaneAdmission").mockImplementation(async opts => {
			const res = await realAcquire(opts);
			if (res.admitted && opts.owner === "WakeSubChild:wake") {
				wakeSlotIdToWatch = res.slot_id;
			}
			if (!res.admitted && res.reason === "host_lane_cap_reached" && opts.owner.endsWith(":wake")) {
				capDeniedObserved.resolve();
			}
			return res;
		});

		const outcome = await subSession.deliverIrcMessage({
			id: "wake-1",
			from: "Main",
			to: "WakeSubChild",
			body: "start wake",
			ts: Date.now(),
		});
		expect(outcome).toBe("woken");
		await promptStarted.promise;
		expect(promptCalls).toBe(1);
		expect(activeDuringPrompt).toBe(1);
		promptHold.resolve();
		await wakeReleased.promise;
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);

		// Fill all 40 host slots -> subagent wake must wait without double-starting, while main wakes without child slot
		const fillers: Array<{ slotId: string; leaseToken: string }> = [];
		for (let i = 0; i < DEFAULT_HOST_LANE_CAP; i += 1) {
			const acq = await acquireLaneAdmission({
				owner: `filler-${i}`,
				kind: "native",
				workerPid: process.pid,
			});
			expect(acq.admitted).toBe(true);
			fillers.push({ slotId: acq.slot_id!, leaseToken: acq.lease_token! });
		}

		const mainSession = makeRealAgentSession({ agentId: "Main", agentKind: "main" });
		let mainPrompted = 0;
		const mainDone = Promise.withResolvers<void>();
		vi.spyOn(mainSession.agent, "prompt").mockImplementation(async () => {
			mainPrompted += 1;
			mainDone.resolve();
		});
		const mainOutcome = await mainSession.deliverIrcMessage({
			id: "wake-main",
			from: "WakeSubChild",
			to: "Main",
			body: "question while full",
			ts: Date.now(),
		});
		expect(mainOutcome).toBe("woken");
		await mainDone.promise;
		expect(mainPrompted).toBe(1);

		// Send two concurrent IRC messages to idle subagent while cap 40 is full
		promptCalls = 0;
		activeDuringPrompt = -1;
		promptStarted = Promise.withResolvers<void>();
		promptHold = Promise.withResolvers<void>();
		wakeReleased = Promise.withResolvers<void>();
		capDeniedObserved = Promise.withResolvers<void>();
		wakeSlotIdToWatch = undefined;

		const firstOutcome = await subSession.deliverIrcMessage({
			id: "wake-full-1",
			from: "PeerA",
			to: "WakeSubChild",
			body: "first while full",
			ts: Date.now(),
		});
		expect(firstOutcome).toBe("woken");
		expect(subSession.isStreaming).toBe(true);
		await capDeniedObserved.promise;
		expect(promptCalls).toBe(0);

		// Second arrival while waiting for slot MUST be injected, never double-starting a second prompt
		const secondOutcome = await subSession.deliverIrcMessage({
			id: "wake-full-2",
			from: "PeerB",
			to: "WakeSubChild",
			body: "second while waiting",
			ts: Date.now(),
		});
		expect(secondOutcome).toBe("injected");

		// Free one slot -> queued wake proceeds with active_lanes === 40 and drops to 39 when done
		const freed = fillers.pop()!;
		await releaseLaneAdmission({ slotId: freed.slotId, leaseToken: freed.leaseToken });
		await promptStarted.promise;
		expect(promptCalls).toBe(1);
		expect(activeDuringPrompt).toBe(DEFAULT_HOST_LANE_CAP);
		promptHold.resolve();
		await wakeReleased.promise;
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(DEFAULT_HOST_LANE_CAP - 1);

		// Disposal while waiting for a full cap aborts wake cleanly without leaking a slot or calling prompt
		const refill = await acquireLaneAdmission({
			owner: "filler-refill",
			kind: "native",
			workerPid: process.pid,
		});
		expect(refill.admitted).toBe(true);
		fillers.push({ slotId: refill.slot_id!, leaseToken: refill.lease_token! });

		const disposeSub = makeRealAgentSession({ agentId: "WakeDisposeSub", agentKind: "sub" });
		let disposedPrompted = 0;
		vi.spyOn(disposeSub.agent, "prompt").mockImplementation(async () => {
			disposedPrompted += 1;
		});
		capDeniedObserved = Promise.withResolvers<void>();
		expect(
			await disposeSub.deliverIrcMessage({
				id: "wake-dispose",
				from: "Main",
				to: "WakeDisposeSub",
				body: "cancelled before slot",
				ts: Date.now(),
			}),
		).toBe("woken");
		await capDeniedObserved.promise;
		await disposeSub.dispose();
		const freed2 = fillers.pop()!;
		await releaseLaneAdmission({ slotId: freed2.slotId, leaseToken: freed2.leaseToken });
		expect(disposedPrompted).toBe(0);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(DEFAULT_HOST_LANE_CAP - 1);

		for (const f of fillers) {
			await releaseLaneAdmission({ slotId: f.slotId, leaseToken: f.leaseToken });
		}
	});

	it("reuses the active in-process host lease when a running subagent handles an internal IRC wake", async () => {
		const fillers: Array<{ slotId: string; leaseToken: string }> = [];
		for (let i = 0; i < DEFAULT_HOST_LANE_CAP - 1; i += 1) {
			const acq = await acquireLaneAdmission({
				owner: `reentry-filler-${i}`,
				kind: "native",
				workerPid: process.pid,
			});
			expect(acq.admitted).toBe(true);
			fillers.push({ slotId: acq.slot_id!, leaseToken: acq.lease_token! });
		}

		let wakeOutcome: "injected" | "woken" | undefined;
		const childSession = makeRealAgentSession({ agentId: "InProcessReuseChild", agentKind: "sub" });
		const innerPromptDone = Promise.withResolvers<void>();
		vi.spyOn(childSession.agent, "prompt").mockImplementation(async () => {
			innerPromptDone.resolve();
		});
		const mockSession = createMockSession(
			async ({ emit }) => {
				// All 40 slots are now full (39 fillers + 1 runSubprocess). Borrowing the active lease must not deadlock.
				expect((await getLaneAdmissionStatus()).active_lanes).toBe(DEFAULT_HOST_LANE_CAP);
				wakeOutcome = await childSession.deliverIrcMessage({
					id: "inner-wake",
					from: "Main",
					to: "InProcessReuseChild",
					body: "internal wake",
					ts: Date.now(),
				});
				await innerPromptDone.promise;
				emit(yieldSuccessEvent({ ok: true }));
			},
			{ activeToolNames: ["yield"] },
		);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(mockSession));

		const res = await runSubprocess({
			cwd: "/repo",
			agent: testAgent,
			task: "run with internal wake",
			index: 0,
			id: "InProcessReuseChild",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {}, getAvailable: () => [], getApiKey: async () => "k" } as never,
			enableLsp: false,
			eventBus: new EventBus(),
			artifactsDir: makeArtifactsDir(),
		});
		expect(res.exitCode).toBe(0);
		expect(wakeOutcome).toBe("woken");
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(DEFAULT_HOST_LANE_CAP - 1);

		for (const f of fillers) {
			await releaseLaneAdmission({ slotId: f.slotId, leaseToken: f.leaseToken });
		}
	});
});
