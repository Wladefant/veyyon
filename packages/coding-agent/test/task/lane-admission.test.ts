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
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { runSubagentFollowUpTurn, runSubprocess } from "@veyyon/coding-agent/task/executor";
import {
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
	const dir = TempDir.createSync("@veyyon-lane-admission-artifacts-");
	tempDirs.push(dir);
	return dir.path();
}

describe("host-wide shared lane admission", () => {
	let isolated: IsolatedConfigRoot;

	beforeEach(() => {
		isolated = enterIsolatedConfigRoot("lane-admission", { defaultProfile: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
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
			getStartIdentity: () => null,
			isPidAlive: () => false,
			isInstanceAlive: (_pid, expected) => expected === null,
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
				emit(yieldSuccessEvent(undefined));
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
				emit(yieldSuccessEvent(undefined));
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
});
