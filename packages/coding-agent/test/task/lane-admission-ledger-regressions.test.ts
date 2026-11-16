/**
 * WHY: regression coverage for PR #1114 review findings on the host-wide admission ledger
 * (`packages/coding-agent/src/task/lane-admission.ts` lines 1-720):
 * - P1 atomic replacement (`requireAtomicReplace: true`) so failed Windows renames never
 *   displace canonical `lane-admission.json` or reset active reservations.
 * - P1 immediate `workerPid` prebind validation (live PID + verifiable start identity +
 *   live instance), failing closed rather than committing uncollectable active slots.
 * - P2 durable `--cap` ceiling across subsequent acquisitions, status reclaims, and releases.
 * - P2 fail-closed external admission and `discovery_state: "unknown"` / `all_host_enforced: false`
 *   when terminal registration files or directories are malformed or unreadable.
 * - Genuine multi-process barrier races for cap enforcement and stale-token fencing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	acquireLaneAdmission,
	adoptLaneAdmission,
	getLaneAdmissionLedgerPath,
	getLaneAdmissionStatus,
	inspectTerminalOwnerEnforcement,
	LANE_ADMISSION_CAPABILITY,
	type LaneAdmissionLedger,
	type LaneLivenessProbe,
	releaseLaneAdmission,
} from "@veyyon/coding-agent/task/lane-admission";
import { TempDir } from "@veyyon/utils";
import { getGlobalConfigRootDir } from "@veyyon/utils/config-root";
import { applyOwnerOnlyWindowsAcl } from "@veyyon/utils/windows-acl";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

// Exception to the static-import rule: spawned child processes receive the module URL via
// `LANE_ADMISSION_MODULE` inside their `-e` script string and must load it at runtime.
const LANE_ADMISSION_MODULE_URL = new URL("../../src/task/lane-admission.ts", import.meta.url).href;

interface RaceWorkerOutcome {
	index: number;
	admitted: boolean;
	reason?: string;
	slotId?: string;
	leaseToken?: string;
	released?: boolean;
	cap: number;
}

interface FenceProbeOutcome {
	staleSameSlotAlreadyAbsent?: boolean;
	foreignSlotMismatch?: boolean;
	foreignSlotReason?: string;
}

interface LiveHolderRecord {
	slotId: string;
	leaseToken: string;
}

interface ReleaseOutcome {
	released?: boolean;
}

const tempDirs: TempDir[] = [];
const activeChildren: Array<{ kill(): void }> = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

function readLedgerSnapshot(ledgerPath: string): LaneAdmissionLedger {
	return JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as LaneAdmissionLedger;
}

async function writeTerminalRecord(
	terminalsDir: string,
	filename: string,
	content: string,
	ownerOnly = true,
): Promise<string> {
	fs.mkdirSync(terminalsDir, { recursive: true, mode: 0o700 });
	if (process.platform === "win32") await applyOwnerOnlyWindowsAcl(terminalsDir);
	else fs.chmodSync(terminalsDir, 0o700);
	const filePath = path.join(terminalsDir, filename);
	fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
	if (ownerOnly) {
		if (process.platform === "win32") await applyOwnerOnlyWindowsAcl(filePath);
		else fs.chmodSync(filePath, 0o600);
	}
	return filePath;
}

async function waitForDirectoryCondition(dir: string, predicate: () => boolean): Promise<void> {
	if (predicate()) return;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const watcher = fs.watch(dir, () => {
		try {
			if (predicate()) {
				watcher.close();
				resolve();
			}
		} catch (error) {
			watcher.close();
			reject(error);
		}
	});
	if (predicate()) {
		watcher.close();
		resolve();
	}
	await promise;
}

describe("lane-admission ledger safety regressions", () => {
	let isolated: IsolatedConfigRoot;

	beforeEach(() => {
		isolated = enterIsolatedConfigRoot("lane-admission-ledger-regressions", { defaultProfile: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const child of activeChildren.splice(0)) {
			try {
				child.kill();
			} catch {}
		}
		for (const dir of tempDirs.splice(0)) {
			dir.removeSync();
		}
		isolated.restore();
	});

	it("requires atomic replace without backup displacement so failed Windows replacement preserves canonical reservations", async () => {
		const fakeLive = new Map<string, boolean>([
			["101", true],
			["101:test:101:1", true],
			["202", true],
			["202:test:202:1", true],
		]);
		const probe: LaneLivenessProbe = {
			getStartIdentity: pid => (fakeLive.has(String(pid)) ? `test:${pid}:1` : null),
			isPidAlive: pid => fakeLive.has(String(pid)),
			isInstanceAlive: (pid, expectedIdentity) =>
				expectedIdentity === null ? true : fakeLive.get(`${pid}:${expectedIdentity}`) === true,
		};

		const slot1 = await acquireLaneAdmission({
			owner: "canon-1",
			kind: "native",
			workerPid: 101,
			cap: 2,
			liveness: probe,
		});
		const slot2 = await acquireLaneAdmission({
			owner: "canon-2",
			kind: "native",
			workerPid: 202,
			cap: 2,
			liveness: probe,
		});
		expect(slot1.admitted).toBe(true);
		expect(slot2.admitted).toBe(true);

		// Kill pid 202 so the next acquire attempts to rewrite the ledger after reclaiming slot2.
		fakeLive.delete("202");
		fakeLive.delete("202:test:202:1");

		const ledgerPath = getLaneAdmissionLedgerPath();
		const beforeRaw = fs.readFileSync(ledgerPath, "utf8");
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		const realRename = fsp.rename;
		let displacedToBackup = false;
		let failedReplacementAttempts = 0;

		vi.spyOn(fsp, "rename").mockImplementation(async (oldPath, newPath) => {
			if (String(oldPath) === ledgerPath || String(newPath).includes(".previous.")) {
				displacedToBackup = true;
			}
			if (String(newPath) === ledgerPath && String(oldPath).endsWith(".tmp")) {
				failedReplacementAttempts += 1;
				const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			return realRename(oldPath, newPath);
		});

		try {
			await expect(
				acquireLaneAdmission({
					owner: "canon-3",
					kind: "native",
					workerPid: 101,
					cap: 2,
					liveness: probe,
				}),
			).rejects.toThrow("permission denied");
		} finally {
			vi.restoreAllMocks();
			Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
		}

		expect(failedReplacementAttempts).toBe(1);
		expect(displacedToBackup).toBe(false);
		expect(fs.existsSync(ledgerPath)).toBe(true);
		expect(fs.readFileSync(ledgerPath, "utf8")).toBe(beforeRaw);

		const runSiblings = fs.readdirSync(path.dirname(ledgerPath));
		expect(runSiblings.some(name => name.includes(".previous.") || name.endsWith(".tmp"))).toBe(false);

		// Restore pid 202 to confirm both original reservations survive intact and cap=2 still blocks a 3rd slot.
		fakeLive.set("202", true);
		fakeLive.set("202:test:202:1", true);
		const afterFailure = await acquireLaneAdmission({
			owner: "canon-excess",
			kind: "native",
			workerPid: 101,
			cap: 2,
			liveness: probe,
		});
		expect(afterFailure.admitted).toBe(false);
		expect(afterFailure.reason).toBe("host_lane_cap_reached");
		expect(afterFailure.active_lanes).toBe(2);
	});

	it("fails closed on dead, unverifiable, or zombie workerPid during immediate bind without leaking uncollectable active slots", async () => {
		// 1) Real exited child process PID passed to acquire --worker-pid
		const exitedChild = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await exitedChild.exited;

		const deadReal = await acquireLaneAdmission({
			owner: "dead-real-worker",
			kind: "external",
			callerPid: process.pid,
			workerPid: exitedChild.pid,
			cap: 2,
		});
		expect(deadReal.ok).toBe(false);
		expect(deadReal.admitted).toBe(false);
		expect(deadReal.reason).toBe("worker_pid_not_alive");

		// 2) Live PID whose start identity cannot be verified (getStartIdentity returns null)
		const unverifiableProbe: LaneLivenessProbe = {
			getStartIdentity: () => null,
			isPidAlive: pid => pid === 444,
			isInstanceAlive: () => true,
		};
		const unverifiable = await acquireLaneAdmission({
			owner: "unverifiable-worker",
			kind: "external",
			callerPid: process.pid,
			workerPid: 444,
			cap: 2,
			liveness: unverifiableProbe,
		});
		expect(unverifiable.ok).toBe(false);
		expect(unverifiable.admitted).toBe(false);
		expect(unverifiable.reason).toBe("worker_identity_unverifiable");

		// 3) PID alive during initial check but zombie / exited during instance liveness check
		const zombieProbe: LaneLivenessProbe = {
			getStartIdentity: pid => `test:${pid}:1`,
			isPidAlive: pid => pid === 555,
			isInstanceAlive: () => false,
		};
		const zombie = await acquireLaneAdmission({
			owner: "zombie-worker",
			kind: "external",
			callerPid: process.pid,
			workerPid: 555,
			cap: 2,
			liveness: zombieProbe,
		});
		expect(zombie.ok).toBe(false);
		expect(zombie.admitted).toBe(false);
		expect(zombie.reason).toBe("worker_pid_not_alive");

		// Zero slots committed by any of the three rejected prebinds
		const statusEmpty = await getLaneAdmissionStatus({ cap: 2 });
		expect(statusEmpty.active_lanes).toBe(0);
		expect(statusEmpty.reservations).toEqual([]);

		// 4) Live verifiable worker binds immediately as identityVerified: true and reclaims on exit
		const liveWorker = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "ignore",
		});
		activeChildren.push(liveWorker);

		const liveBind = await acquireLaneAdmission({
			owner: "live-prebind",
			kind: "external",
			callerPid: process.pid,
			workerPid: liveWorker.pid,
			cap: 1,
		});
		expect(liveBind.ok).toBe(true);
		expect(liveBind.admitted).toBe(true);
		expect(liveBind.state).toBe("active");

		const statusLive = await getLaneAdmissionStatus();
		expect(statusLive.active_lanes).toBe(1);
		expect(statusLive.reservations[0]?.identityVerified).toBe(true);
		expect(statusLive.reservations[0]?.processIdentity).not.toBeNull();

		liveWorker.kill();
		await liveWorker.exited;

		const reclaimedStatus = await getLaneAdmissionStatus();
		expect(reclaimedStatus.reclaimed_count).toBe(1);
		expect(reclaimedStatus.active_lanes).toBe(0);

		// 5) launching -> adopt protocol remains intact for unbound workers
		const launching = await acquireLaneAdmission({
			owner: "launching-then-adopt",
			kind: "external",
			callerPid: process.pid,
			cap: 1,
		});
		expect(launching.admitted).toBe(true);
		expect(launching.state).toBe("launching");

		const badAdopt = await adoptLaneAdmission({
			slotId: launching.slot_id!,
			leaseToken: launching.lease_token!,
			pid: exitedChild.pid,
		});
		expect(badAdopt.ok).toBe(false);
		expect(badAdopt.adopted).toBe(false);
		expect(badAdopt.reason).toBe("worker_pid_not_alive");

		const goodAdopt = await adoptLaneAdmission({
			slotId: launching.slot_id!,
			leaseToken: launching.lease_token!,
			pid: process.pid,
		});
		expect(goodAdopt.ok).toBe(true);
		expect(goodAdopt.adopted).toBe(true);
	});

	it("does not persist lower caps from status reclamation or absent release", async () => {
		let alive = true;
		const liveness: LaneLivenessProbe = {
			getStartIdentity: pid => `test:${pid}:1`,
			isPidAlive: () => alive,
			isInstanceAlive: () => alive,
		};
		const acquired = await acquireLaneAdmission({
			owner: "cap-policy-owner",
			kind: "native",
			workerPid: 101,
			cap: 4,
			liveness,
		});
		expect(acquired.admitted).toBe(true);

		await releaseLaneAdmission({ slotId: "missing", leaseToken: "invalid", cap: 1 });
		expect(readLedgerSnapshot(getLaneAdmissionLedgerPath()).cap).toBe(4);

		alive = false;
		const status = await getLaneAdmissionStatus({ cap: 1, liveness });
		expect(status.reclaimed_count).toBe(1);
		expect(readLedgerSnapshot(getLaneAdmissionLedgerPath()).cap).toBe(4);
	});

	it("enforces persisted cap as a durable ceiling and never silently raises it on later acquires, status, or releases", async () => {
		const fakeLive = new Map<string, boolean>([
			["101", true],
			["101:test:101:1", true],
			["202", true],
			["202:test:202:1", true],
		]);
		const probe: LaneLivenessProbe = {
			getStartIdentity: pid => `test:${pid}:1`,
			isPidAlive: pid => fakeLive.has(String(pid)),
			isInstanceAlive: (pid, expectedIdentity) =>
				expectedIdentity === null ? true : fakeLive.get(`${pid}:${expectedIdentity}`) === true,
		};

		// First acquire sets durable cap=1
		const first = await acquireLaneAdmission({
			owner: "cap-one-first",
			kind: "native",
			workerPid: 101,
			cap: 1,
			liveness: probe,
		});
		expect(first.admitted).toBe(true);
		expect(first.cap).toBe(1);

		// Later acquire omitting cap MUST respect persisted cap=1 (never silently reset to 100)
		const omittedCap = await acquireLaneAdmission({
			owner: "cap-one-second-omitted",
			kind: "native",
			workerPid: 202,
			liveness: probe,
		});
		expect(omittedCap.admitted).toBe(false);
		expect(omittedCap.reason).toBe("host_lane_cap_reached");
		expect(omittedCap.cap).toBe(1);
		expect(readLedgerSnapshot(getLaneAdmissionLedgerPath()).cap).toBe(1);

		// Later acquire requesting higher cap=100 MUST still enforce persisted cap=1
		const higherCap = await acquireLaneAdmission({
			owner: "cap-one-second-higher",
			kind: "native",
			workerPid: 202,
			cap: 100,
			liveness: probe,
		});
		expect(higherCap.admitted).toBe(false);
		expect(higherCap.reason).toBe("host_lane_cap_reached");
		expect(higherCap.cap).toBe(1);
		expect(readLedgerSnapshot(getLaneAdmissionLedgerPath()).cap).toBe(1);

		// Reclaiming dead slot with status({ cap: 100 }) or releasing with cap: 100 must NOT raise persisted cap
		fakeLive.delete("101");
		fakeLive.delete("101:test:101:1");
		const statusHigh = await getLaneAdmissionStatus({ cap: 100, liveness: probe });
		expect(statusHigh.cap).toBe(1);
		expect(statusHigh.reclaimed_count).toBe(1);
		expect(readLedgerSnapshot(getLaneAdmissionLedgerPath()).cap).toBe(1);

		// New acquire requesting cap=100 still sees persisted cap=1
		const secondAdmitted = await acquireLaneAdmission({
			owner: "cap-one-after-reclaim",
			kind: "native",
			workerPid: 202,
			cap: 100,
			liveness: probe,
		});
		expect(secondAdmitted.admitted).toBe(true);
		expect(secondAdmitted.cap).toBe(1);
		expect(secondAdmitted.n_free).toBe(0);

		const releaseHigh = await releaseLaneAdmission({
			slotId: secondAdmitted.slot_id!,
			leaseToken: secondAdmitted.lease_token!,
			cap: 100,
		});
		expect(releaseHigh.ok).toBe(true);
		expect(releaseHigh.n_free).toBe(1);
		expect(readLedgerSnapshot(getLaneAdmissionLedgerPath()).cap).toBe(1);

		// Explicit lower cap reduces the durable ceiling from 5 down to 2
		const freshRoot = makeTempDir("@veyyon-cap-reduce-");
		const start5 = await acquireLaneAdmission({
			owner: "cap-five-1",
			kind: "native",
			workerPid: 202,
			cap: 5,
			globalConfigRoot: freshRoot,
			liveness: probe,
		});
		expect(start5.admitted).toBe(true);
		expect(start5.cap).toBe(5);

		const reduceTo2 = await acquireLaneAdmission({
			owner: "cap-reduce-2",
			kind: "native",
			workerPid: 202,
			cap: 2,
			globalConfigRoot: freshRoot,
			liveness: probe,
		});
		expect(reduceTo2.admitted).toBe(true);
		expect(reduceTo2.cap).toBe(2);
		expect(reduceTo2.n_free).toBe(0);
		expect(readLedgerSnapshot(getLaneAdmissionLedgerPath(freshRoot)).cap).toBe(2);

		const thirdBlocked = await acquireLaneAdmission({
			owner: "cap-reduce-3",
			kind: "native",
			workerPid: 202,
			cap: 10,
			globalConfigRoot: freshRoot,
			liveness: probe,
		});
		expect(thirdBlocked.admitted).toBe(false);
		expect(thirdBlocked.reason).toBe("host_lane_cap_reached");
		expect(thirdBlocked.cap).toBe(2);
	});

	it("reports unknown discovery state and fails external acquire closed on malformed or unreadable terminal registrations", async () => {
		const terminalsDir = path.join(getGlobalConfigRootDir(), "profiles", "default", "run", "terminals");

		// 1) Malformed JSON terminal record
		const malformedFile = await writeTerminalRecord(terminalsDir, "broken.json", "{not-json");
		const malformedDiscovery = inspectTerminalOwnerEnforcement();
		expect(malformedDiscovery.state).toBe("unknown");
		expect(malformedDiscovery.all_host_enforced).toBe(false);
		expect(malformedDiscovery.unknown_terminal_records.length).toBe(1);

		const statusMalformed = await getLaneAdmissionStatus();
		expect(statusMalformed.all_host_enforced).toBe(false);
		expect(statusMalformed.discovery_state).toBe("unknown");

		const extMalformed = await acquireLaneAdmission({ owner: "ext-malformed", kind: "external", cap: 4 });
		expect(extMalformed.ok).toBe(false);
		expect(extMalformed.admitted).toBe(false);
		expect(extMalformed.all_host_enforced).toBe(false);
		expect(extMalformed.discovery_state).toBe("unknown");
		expect(extMalformed.reason).toBe("terminal_discovery_unknown");

		// Native acquire still proceeds while surfacing all_host_enforced: false
		const natWhileUnknown = await acquireLaneAdmission({
			owner: "nat-during-unknown",
			kind: "native",
			workerPid: process.pid,
			cap: 4,
		});
		expect(natWhileUnknown.admitted).toBe(true);
		expect(natWhileUnknown.all_host_enforced).toBe(false);
		expect(natWhileUnknown.discovery_state).toBe("unknown");
		await releaseLaneAdmission({ slotId: natWhileUnknown.slot_id!, leaseToken: natWhileUnknown.lease_token! });

		fs.rmSync(malformedFile, { force: true });

		// 2) Live record with invalid capabilities shape -> unknown discovery & fail closed
		const badCapsFile = await writeTerminalRecord(
			terminalsDir,
			"bad-caps.json",
			JSON.stringify({
				version: 1,
				sessionId: "bad-caps-session",
				pid: process.pid,
				capabilities: "corrupt",
			}),
		);
		const badCapsExt = await acquireLaneAdmission({ owner: "ext-bad-caps", kind: "external", cap: 4 });
		expect(badCapsExt.admitted).toBe(false);
		expect(badCapsExt.all_host_enforced).toBe(false);
		expect(badCapsExt.discovery_state).toBe("unknown");
		fs.rmSync(badCapsFile, { force: true });

		// 3) Valid JSON for a DEAD PID is ignored as stale -> enforced
		const deadChild = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await deadChild.exited;
		const staleDeadFile = await writeTerminalRecord(
			terminalsDir,
			"dead-owner.json",
			JSON.stringify({
				version: 1,
				sessionId: "dead-owner",
				pid: deadChild.pid,
				capabilities: [],
			}),
		);
		expect((await getLaneAdmissionStatus()).all_host_enforced).toBe(true);
		fs.rmSync(staleDeadFile, { force: true });

		// 4) Unreadable / permission-refused terminal registration file (EACCES / non-owner-only)
		const permFile = await writeTerminalRecord(
			terminalsDir,
			"unreadable.json",
			JSON.stringify({
				version: 1,
				sessionId: "valid-inside-unreadable",
				pid: process.pid,
				capabilities: [LANE_ADMISSION_CAPABILITY],
			}),
			false,
		);
		if (process.platform === "win32") {
			// On Windows without owner-only ACL, readOwnerOnlyFileSync fails closed, and simulate EACCES on readdir/open too.
			const permStatus = await getLaneAdmissionStatus();
			expect(permStatus.all_host_enforced).toBe(false);
			expect(permStatus.discovery_state).toBe("unknown");
		} else {
			fs.chmodSync(permFile, 0o000);
		}
		const realReaddirSync = fs.readdirSync;
		const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation((target, options) => {
			if (String(target) === terminalsDir) {
				const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			return realReaddirSync(target as fs.PathLike, options as never);
		});
		try {
			const eaccesStatus = await getLaneAdmissionStatus();
			expect(eaccesStatus.all_host_enforced).toBe(false);
			expect(eaccesStatus.discovery_state).toBe("unknown");

			const eaccesExt = await acquireLaneAdmission({ owner: "ext-eacces", kind: "external", cap: 4 });
			expect(eaccesExt.ok).toBe(false);
			expect(eaccesExt.admitted).toBe(false);
			expect(eaccesExt.all_host_enforced).toBe(false);
			expect(eaccesExt.discovery_state).toBe("unknown");
		} finally {
			readdirSpy.mockRestore();
			if (process.platform !== "win32") {
				fs.chmodSync(permFile, 0o600);
			}
			fs.rmSync(permFile, { force: true });
		}

		// Recovery once unknown record is removed
		const recoveredExt = await acquireLaneAdmission({ owner: "ext-recovered", kind: "external", cap: 4 });
		expect(recoveredExt.admitted).toBe(true);
		expect(recoveredExt.all_host_enforced).toBe(true);
		expect(recoveredExt.discovery_state).toBe("enforced");
	});

	it("enforces host cap and stale-token fencing under simultaneous multi-process acquire/release races", async () => {
		const barrierDir = makeTempDir("@veyyon-lane-race-barrier-");
		const workerCount = 10;
		const cap = 3;

		const raceWorkerScript = `
// Exception to the static-import rule: spawned child script loads target module from env URL.
import * as fs from "node:fs";
import * as path from "node:path";
const mod = await import(process.env.LANE_ADMISSION_MODULE);
const barrierDir = process.env.RACE_BARRIER_DIR;
const idx = Number(process.env.RACE_INDEX);
const cap = Number(process.env.RACE_CAP);
const nextLine = (() => {
	const queue = [];
	const waiters = [];
	let buf = "";
	let ended = false;
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", chunk => {
		buf += chunk;
		for (;;) {
			const nl = buf.indexOf("\\n");
			if (nl === -1) break;
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			const waiter = waiters.shift();
			if (waiter) waiter(line);
			else queue.push(line);
		}
	});
	process.stdin.on("end", () => {
		ended = true;
		while (waiters.length > 0) waiters.shift()(null);
	});
	return () => {
		if (queue.length > 0) return Promise.resolve(queue.shift());
		if (ended) return Promise.resolve(null);
		const { promise, resolve } = Promise.withResolvers();
		waiters.push(resolve);
		return promise;
	};
})();
fs.writeFileSync(path.join(barrierDir, "ready-" + idx), "1");
await nextLine();
const acq = await mod.acquireLaneAdmission({
	owner: "mp-race-" + idx,
	kind: "native",
	workerPid: process.pid,
	cap,
});
let released;
if (acq.admitted) {
	fs.writeFileSync(path.join(barrierDir, "admitted-" + idx), JSON.stringify({ slotId: acq.slot_id, pid: process.pid }));
}
fs.writeFileSync(path.join(barrierDir, "attempted-" + idx), JSON.stringify({ admitted: acq.admitted, slotId: acq.slot_id }));
if (acq.admitted) {
	await nextLine();
	const rel = await mod.releaseLaneAdmission({
		slotId: acq.slot_id,
		leaseToken: acq.lease_token,
	});
	released = rel.released;
}
process.stdout.write(JSON.stringify({
	index: idx,
	admitted: acq.admitted,
	reason: acq.reason,
	slotId: acq.slot_id,
	leaseToken: acq.lease_token,
	released,
	cap: acq.cap,
}) + "\\n");
`;

		const children = Array.from({ length: workerCount }, (_, index) => {
			const proc = Bun.spawn([process.execPath, "-e", raceWorkerScript], {
				env: {
					...process.env,
					VEYYON_CONFIG_DIR: isolated.envValue,
					LANE_ADMISSION_MODULE: LANE_ADMISSION_MODULE_URL,
					RACE_BARRIER_DIR: barrierDir,
					RACE_INDEX: String(index),
					RACE_CAP: String(cap),
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			activeChildren.push(proc);
			return proc;
		});

		// Wait until all 10 processes have started and reached the barrier
		await waitForDirectoryCondition(barrierDir, () =>
			Array.from({ length: workerCount }, (_, i) => fs.existsSync(path.join(barrierDir, `ready-${i}`))).every(Boolean),
		);

		// Release all 10 simultaneously through the stdin barrier
		for (const child of children) {
			child.stdin.write("go\n");
			child.stdin.flush();
		}

		// WHY: wait until all contenders attempt admission before releasing winners so late arrivals cannot fill freed slots.
		await waitForDirectoryCondition(barrierDir, () =>
			Array.from({ length: workerCount }, (_, i) => fs.existsSync(path.join(barrierDir, `attempted-${i}`))).every(Boolean),
		);

		const liveStatus = await getLaneAdmissionStatus();
		expect(liveStatus.cap).toBe(cap);
		expect(liveStatus.active_lanes).toBe(cap);
		expect(liveStatus.n_free).toBe(0);

		// Allow the admitted processes to release
		for (const child of children) {
			try {
				child.stdin.write("release\n");
				child.stdin.end();
			} catch {
				// Child may have already exited after admission rejection.
			}
		}

		const outcomes: RaceWorkerOutcome[] = [];
		for (const child of children) {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, `worker stderr: ${stderr}`).toBe(0);
			outcomes.push(JSON.parse(stdout.trim()) as RaceWorkerOutcome);
		}

		const admitted = outcomes.filter(item => item.admitted);
		const rejected = outcomes.filter(item => !item.admitted);
		expect(admitted.length).toBe(cap);
		expect(admitted.every(item => item.released === true)).toBe(true);
		expect(rejected.length).toBe(workerCount - cap);
		expect(rejected.every(item => item.reason === "host_lane_cap_reached" && item.cap === cap)).toBe(true);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);

		// Stale-token fencing race across two independent processes
		const holder = await acquireLaneAdmission({
			owner: "stale-fence-old",
			kind: "native",
			workerPid: process.pid,
			cap: 2,
		});
		expect(holder.admitted).toBe(true);
		const relOld = await releaseLaneAdmission({
			slotId: holder.slot_id!,
			leaseToken: holder.lease_token!,
		});
		expect(relOld.released).toBe(true);

		const holderBarrier = makeTempDir("@veyyon-fence-barrier-");
		const holderScript = `
// Exception to the static-import rule: spawned child script loads target module from env URL.
import * as fs from "node:fs";
import * as path from "node:path";
const mod = await import(process.env.LANE_ADMISSION_MODULE);
const dir = process.env.FENCE_BARRIER_DIR;
const acq = await mod.acquireLaneAdmission({
	owner: "live-new-holder",
	kind: "native",
	workerPid: process.pid,
	cap: 2,
});
fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify({ slotId: acq.slot_id, leaseToken: acq.lease_token }));
const stdinEnded = Promise.withResolvers();
process.stdin.resume();
process.stdin.once("end", () => stdinEnded.resolve());
await stdinEnded.promise;
const rel = await mod.releaseLaneAdmission({ slotId: acq.slot_id, leaseToken: acq.lease_token });
process.stdout.write(JSON.stringify({ released: rel.released }) + "\\n");
`;
		const holderProc = Bun.spawn([process.execPath, "-e", holderScript], {
			env: {
				...process.env,
				VEYYON_CONFIG_DIR: isolated.envValue,
				LANE_ADMISSION_MODULE: LANE_ADMISSION_MODULE_URL,
				FENCE_BARRIER_DIR: holderBarrier,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		activeChildren.push(holderProc);

		await waitForDirectoryCondition(holderBarrier, () => fs.existsSync(path.join(holderBarrier, "live.json")));
		const liveHolder = JSON.parse(fs.readFileSync(path.join(holderBarrier, "live.json"), "utf8")) as LiveHolderRecord;

		const staleAttackerScript = `
// Exception to the static-import rule: spawned child script loads target module from env URL.
const mod = await import(process.env.LANE_ADMISSION_MODULE);
const sameSlot = await mod.releaseLaneAdmission({
	slotId: process.env.STALE_SLOT_ID,
	leaseToken: process.env.STALE_TOKEN,
});
const foreignSlot = await mod.releaseLaneAdmission({
	slotId: process.env.LIVE_SLOT_ID,
	leaseToken: process.env.STALE_TOKEN,
});
process.stdout.write(JSON.stringify({
	staleSameSlotAlreadyAbsent: sameSlot.already_absent,
	foreignSlotMismatch: !foreignSlot.ok && !foreignSlot.released,
	foreignSlotReason: foreignSlot.reason,
}) + "\\n");
`;
		const attackerProc = Bun.spawn([process.execPath, "-e", staleAttackerScript], {
			env: {
				...process.env,
				VEYYON_CONFIG_DIR: isolated.envValue,
				LANE_ADMISSION_MODULE: LANE_ADMISSION_MODULE_URL,
				STALE_SLOT_ID: holder.slot_id!,
				STALE_TOKEN: holder.lease_token!,
				LIVE_SLOT_ID: liveHolder.slotId,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		activeChildren.push(attackerProc);

		const [attStdout, attStderr, attCode] = await Promise.all([
			new Response(attackerProc.stdout).text(),
			new Response(attackerProc.stderr).text(),
			attackerProc.exited,
		]);
		expect(attCode, `attacker stderr: ${attStderr}`).toBe(0);
		const attackerOutcome = JSON.parse(attStdout.trim()) as FenceProbeOutcome;
		expect(attackerOutcome.staleSameSlotAlreadyAbsent).toBe(true);
		expect(attackerOutcome.foreignSlotMismatch).toBe(true);
		expect(attackerOutcome.foreignSlotReason).toBe("lease_token_mismatch");

		// Live holder's slot MUST still exist
		const duringLive = await getLaneAdmissionStatus();
		expect(duringLive.active_lanes).toBe(1);
		expect(duringLive.reservations[0]?.slotId).toBe(liveHolder.slotId);

		holderProc.stdin.end();
		const [hStdout, hStderr, hCode] = await Promise.all([
			new Response(holderProc.stdout).text(),
			new Response(holderProc.stderr).text(),
			holderProc.exited,
		]);
		expect(hCode, `holder stderr: ${hStderr}`).toBe(0);
		const holderRelease = JSON.parse(hStdout.trim()) as ReleaseOutcome;
		expect(holderRelease.released).toBe(true);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	}, 30_000);
});
