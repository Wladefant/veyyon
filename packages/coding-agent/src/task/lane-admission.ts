import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "@veyyon/utils/atomic-write";
import { getGlobalConfigRootDir, getGlobalRunDir, PROFILES_DIR_NAME } from "@veyyon/utils/config-root";
import { withFileLock } from "@veyyon/utils/file-lock";
import { isEnoent } from "@veyyon/utils/fs-error";
import { readOwnerOnlyFileSync } from "@veyyon/utils/owner-only-read";
import { getProcessStartIdentity, isProcessAlive, isToolCallProcessAlive } from "@veyyon/utils/process-liveness";

export const LANE_ADMISSION_VERSION = 1 as const;
export const DEFAULT_HOST_LANE_CAP = 40;
export const LANE_ADMISSION_CAPABILITY = "lane-admission" as const;

const LEDGER_FILENAME = "lane-admission.json";
const LOCK_OPTIONS = { staleMs: 10_000, retries: 100, retryDelayMs: 50 } as const;
const VALID_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_WAIT_POLL_MS = 100;
const DEFAULT_HEARTBEAT_MS = 30_000;

export type LaneAdmissionKind = "native" | "external";
export type LaneAdmissionState = "launching" | "active";

export interface LaneLivenessProbe {
	getStartIdentity(pid: number): string | null;
	isPidAlive(pid: number): boolean;
	isInstanceAlive(pid: number, expectedIdentity: string | null): boolean;
}

const DEFAULT_LIVENESS_PROBE: LaneLivenessProbe = {
	getStartIdentity: pid => getProcessStartIdentity(pid),
	isPidAlive: pid => isProcessAlive(pid),
	isInstanceAlive: (pid, expectedIdentity) => isToolCallProcessAlive(pid, expectedIdentity),
};

export interface LaneReservation {
	slotId: string;
	leaseToken: string;
	kind: LaneAdmissionKind;
	owner: string;
	state: LaneAdmissionState;
	pid: number | null;
	processIdentity: string | null;
	callerPid: number | null;
	callerProcessIdentity: string | null;
	identityVerified: boolean;
	acquiredAt: number;
	adoptedAt: number | null;
	lastHeartbeatAt: number;
}

export interface LaneAdmissionLedger {
	version: typeof LANE_ADMISSION_VERSION;
	cap: number;
	reservations: LaneReservation[];
}

export type TerminalDiscoveryState = "enforced" | "unregistered" | "unknown";

export interface UnregisteredLiveOwner {
	sessionId: string;
	pid: number;
	profile: string;
}

export interface UnverifiedTerminalRecord {
	path: string;
	profile: string;
	reason: string;
}

export interface TerminalEnforcementDiscovery {
	state: TerminalDiscoveryState;
	all_host_enforced: boolean;
	unregistered_live_owners: UnregisteredLiveOwner[];
	unknown_terminal_records: UnverifiedTerminalRecord[];
}

export interface LaneAdmissionStatus {
	ok: true;
	action: "status";
	ledger_path: string;
	cap: number;
	active_lanes: number;
	launching_lanes: number;
	bound_active_lanes: number;
	n_free: number;
	all_host_enforced: boolean;
	discovery_state?: TerminalDiscoveryState;
	unregistered_live_owners: UnregisteredLiveOwner[];
	unknown_terminal_records?: UnverifiedTerminalRecord[];
	reclaimed_count: number;
	reservations: LaneReservation[];
}

export interface LaneAdmissionFailure {
	ok: false;
	action?: string;
	reason: string;
	ledger_path?: string;
}

export interface LaneAdmissionAcquireOptions {
	owner: string;
	kind?: LaneAdmissionKind;
	callerPid?: number | null;
	workerPid?: number | null;
	cap?: number;
	globalConfigRoot?: string;
	liveness?: LaneLivenessProbe;
}

export interface LaneAdmissionAcquireResult {
	ok: boolean;
	admitted: boolean;
	slot_id?: string;
	lease_token?: string;
	owner?: string;
	kind?: LaneAdmissionKind;
	state?: LaneAdmissionState;
	cap: number;
	active_lanes: number;
	n_free: number;
	all_host_enforced: boolean;
	discovery_state?: TerminalDiscoveryState;
	unregistered_live_owners?: UnregisteredLiveOwner[];
	unknown_terminal_records?: UnverifiedTerminalRecord[];
	reclaimed_count?: number;
	reason?: string;
}

export interface LaneAdmissionAdoptOptions {
	slotId: string;
	leaseToken: string;
	pid: number;
	globalConfigRoot?: string;
	liveness?: LaneLivenessProbe;
}

export interface LaneAdmissionAdoptResult {
	ok: boolean;
	adopted: boolean;
	slot_id: string;
	state?: "active";
	pid?: number;
	identity_verified?: boolean;
	pid_alive?: boolean;
	reason?: string;
}

export interface LaneAdmissionHeartbeatOptions {
	slotId: string;
	leaseToken: string;
	globalConfigRoot?: string;
}

export interface LaneAdmissionHeartbeatResult {
	ok: boolean;
	slot_id: string;
	last_heartbeat_at?: number;
	reason?: string;
}

export interface LaneAdmissionReleaseOptions {
	slotId: string;
	leaseToken: string;
	cap?: number;
	globalConfigRoot?: string;
}

export interface LaneAdmissionReleaseResult {
	ok: boolean;
	released: boolean;
	already_absent?: boolean;
	slot_id: string;
	active_lanes?: number;
	n_free?: number;
	reason?: string;
}

export interface NativeHostLaneLease {
	slotId: string;
	leaseToken: string;
	release(): Promise<void>;
}

export class LaneAdmissionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "LaneAdmissionError";
	}
}

export function getLaneAdmissionLedgerPath(globalConfigRoot?: string): string {
	const runDir = globalConfigRoot ? path.join(globalConfigRoot, "run") : getGlobalRunDir();
	return path.join(runDir, LEDGER_FILENAME);
}

function resolveCap(cap?: number): number {
	if (cap === undefined) return DEFAULT_HOST_LANE_CAP;
	if (!Number.isSafeInteger(cap) || cap < 1 || cap > DEFAULT_HOST_LANE_CAP) {
		throw new LaneAdmissionError(
			"invalid_cap",
			`Host lane cap must be an integer between 1 and ${DEFAULT_HOST_LANE_CAP}; got ${String(cap)}`,
		);
	}
	return cap;
}

function resolveDurableCap(persistedCap: number, requestedCap?: number): number {
	return requestedCap !== undefined ? Math.min(persistedCap, requestedCap) : persistedCap;
}

function isValidPid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
}

function isValidTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidReservation(value: unknown): value is LaneReservation {
	if (!isPlainRecord(value)) return false;
	if (typeof value.slotId !== "string" || value.slotId.length === 0) return false;
	if (typeof value.leaseToken !== "string" || value.leaseToken.length === 0) return false;
	if (value.kind !== "native" && value.kind !== "external") return false;
	if (typeof value.owner !== "string" || value.owner.length === 0) return false;
	if (value.state !== "launching" && value.state !== "active") return false;
	if (value.pid !== null && !isValidPid(value.pid)) return false;
	if (value.processIdentity !== null && typeof value.processIdentity !== "string") return false;
	if (value.callerPid !== null && !isValidPid(value.callerPid)) return false;
	if (value.callerProcessIdentity !== null && typeof value.callerProcessIdentity !== "string") return false;
	if (typeof value.identityVerified !== "boolean") return false;
	if (!isValidTimestamp(value.acquiredAt)) return false;
	if (value.adoptedAt !== null && !isValidTimestamp(value.adoptedAt)) return false;
	if (!isValidTimestamp(value.lastHeartbeatAt)) return false;
	return true;
}

async function readLedgerUnderLock(ledgerPath: string, defaultCap: number): Promise<LaneAdmissionLedger> {
	let raw: string;
	try {
		raw = await fsp.readFile(ledgerPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return { version: LANE_ADMISSION_VERSION, cap: defaultCap, reservations: [] };
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new LaneAdmissionError("corrupt_admission_ledger", `Corrupt JSON in ${ledgerPath}`);
	}

	if (!isPlainRecord(parsed)) {
		throw new LaneAdmissionError("corrupt_admission_ledger", `Admission ledger is not an object: ${ledgerPath}`);
	}
	if (parsed.version !== LANE_ADMISSION_VERSION) {
		throw new LaneAdmissionError(
			"unsupported_ledger_version",
			`Unsupported lane-admission ledger version ${String(parsed.version)} (expected ${LANE_ADMISSION_VERSION})`,
		);
	}
	if (
		typeof parsed.cap !== "number" ||
		!Number.isSafeInteger(parsed.cap) ||
		parsed.cap < 1 ||
		parsed.cap > DEFAULT_HOST_LANE_CAP
	) {
		throw new LaneAdmissionError("corrupt_admission_ledger", `Invalid host lane cap in ${ledgerPath}`);
	}
	if (!Array.isArray(parsed.reservations) || !parsed.reservations.every(isValidReservation)) {
		throw new LaneAdmissionError("corrupt_admission_ledger", `Invalid reservations array in ${ledgerPath}`);
	}
	return {
		version: LANE_ADMISSION_VERSION,
		cap: parsed.cap,
		reservations: parsed.reservations.map(item => ({ ...item })),
	};
}

async function writeLedgerUnderLock(ledgerPath: string, ledger: LaneAdmissionLedger): Promise<void> {
	await atomicWriteFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, {
		mode: 0o600,
		requireAtomicReplace: true,
	});
}

/**
 * Reclaim ONLY slots whose bound child process instance is proven dead or replaced.
 *
 * Never reclaims by elapsed time alone, never reclaims uncertain `launching` slots
 * whose child PID was not yet bound, and never reclaims active slots whose
 * `processIdentity` could not be verified (`null` / `identityVerified === false`).
 */
function reclaimProvenDeadReservations(
	reservations: readonly LaneReservation[],
	liveness: LaneLivenessProbe,
): { retained: LaneReservation[]; reclaimedCount: number } {
	const retained: LaneReservation[] = [];
	let reclaimedCount = 0;
	for (const reservation of reservations) {
		const canProveDead =
			reservation.state === "active" &&
			reservation.pid !== null &&
			reservation.processIdentity !== null &&
			reservation.identityVerified;
		if (canProveDead && !liveness.isInstanceAlive(reservation.pid!, reservation.processIdentity)) {
			reclaimedCount += 1;
			continue;
		}
		retained.push(reservation);
	}
	return { retained, reclaimedCount };
}

function scanTerminalDirectory(
	directory: string,
	profileLabel: string,
	liveness: LaneLivenessProbe,
	out: UnregisteredLiveOwner[],
	unknownOut: UnverifiedTerminalRecord[],
	seen: Set<string>,
): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(directory);
	} catch (error) {
		if (isEnoent(error)) return;
		unknownOut.push({
			path: directory,
			profile: profileLabel,
			reason: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const fullPath = path.join(directory, entry);
		let raw: string;
		try {
			raw = readOwnerOnlyFileSync(fullPath);
		} catch (error) {
			if (isEnoent(error)) continue;
			unknownOut.push({
				path: fullPath,
				profile: profileLabel,
				reason: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			unknownOut.push({ path: fullPath, profile: profileLabel, reason: "malformed_json" });
			continue;
		}
		if (!isPlainRecord(parsed)) {
			unknownOut.push({ path: fullPath, profile: profileLabel, reason: "invalid_record_shape" });
			continue;
		}
		if (parsed.version !== 1) {
			unknownOut.push({
				path: fullPath,
				profile: profileLabel,
				reason: `unsupported_record_version:${String(parsed.version)}`,
			});
			continue;
		}
		if (typeof parsed.sessionId !== "string" || !VALID_SESSION_ID_RE.test(parsed.sessionId)) {
			unknownOut.push({ path: fullPath, profile: profileLabel, reason: "invalid_session_id" });
			continue;
		}
		if (!isValidPid(parsed.pid)) {
			unknownOut.push({ path: fullPath, profile: profileLabel, reason: "invalid_pid" });
			continue;
		}
		if (!liveness.isPidAlive(parsed.pid)) continue;
		if (
			parsed.capabilities !== undefined &&
			(!Array.isArray(parsed.capabilities) || !parsed.capabilities.every(c => typeof c === "string"))
		) {
			unknownOut.push({ path: fullPath, profile: profileLabel, reason: "invalid_capabilities" });
			continue;
		}
		const caps = parsed.capabilities ?? [];
		if (caps.includes(LANE_ADMISSION_CAPABILITY)) continue;
		const dedupKey = `${profileLabel}:${parsed.sessionId}:${parsed.pid}`;
		if (seen.has(dedupKey)) continue;
		seen.add(dedupKey);
		out.push({
			sessionId: parsed.sessionId,
			pid: parsed.pid,
			profile: profileLabel,
		});
	}
}

export function inspectTerminalOwnerEnforcement(
	globalConfigRoot = getGlobalConfigRootDir(),
	liveness: LaneLivenessProbe = DEFAULT_LIVENESS_PROBE,
): TerminalEnforcementDiscovery {
	const owners: UnregisteredLiveOwner[] = [];
	const unknownRecords: UnverifiedTerminalRecord[] = [];
	const seen = new Set<string>();
	scanTerminalDirectory(
		path.join(globalConfigRoot, "run", "terminals"),
		"root",
		liveness,
		owners,
		unknownRecords,
		seen,
	);

	const profilesDir = path.join(globalConfigRoot, PROFILES_DIR_NAME);
	let profileEntries: fs.Dirent[] = [];
	try {
		profileEntries = fs.readdirSync(profilesDir, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) {
			unknownRecords.push({
				path: profilesDir,
				profile: "profiles",
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	for (const entry of profileEntries) {
		if (!entry.isDirectory()) continue;
		scanTerminalDirectory(
			path.join(profilesDir, entry.name, "run", "terminals"),
			entry.name,
			liveness,
			owners,
			unknownRecords,
			seen,
		);
	}
	const state: TerminalDiscoveryState =
		owners.length > 0 ? "unregistered" : unknownRecords.length > 0 ? "unknown" : "enforced";
	return {
		state,
		all_host_enforced: state === "enforced",
		unregistered_live_owners: owners,
		unknown_terminal_records: unknownRecords,
	};
}

export function listUnregisteredLiveTerminalOwners(
	globalConfigRoot = getGlobalConfigRootDir(),
	liveness: LaneLivenessProbe = DEFAULT_LIVENESS_PROBE,
): UnregisteredLiveOwner[] {
	return inspectTerminalOwnerEnforcement(globalConfigRoot, liveness).unregistered_live_owners;
}

async function withLedgerLock<T>(ledgerPath: string, fn: () => Promise<T>): Promise<T> {
	await fsp.mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
	return withFileLock(ledgerPath, fn, LOCK_OPTIONS);
}

export async function getLaneAdmissionStatus(options?: {
	cap?: number;
	globalConfigRoot?: string;
	liveness?: LaneLivenessProbe;
}): Promise<LaneAdmissionStatus> {
	const globalConfigRoot = options?.globalConfigRoot ?? getGlobalConfigRootDir();
	const requestedCap = options?.cap !== undefined ? resolveCap(options.cap) : undefined;
	const liveness = options?.liveness ?? DEFAULT_LIVENESS_PROBE;
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);

	const {
		retained,
		reclaimedCount,
		cap: resolvedCap,
	} = await withLedgerLock(ledgerPath, async () => {
		const ledger = await readLedgerUnderLock(ledgerPath, requestedCap ?? DEFAULT_HOST_LANE_CAP);
		const effectiveCap = resolveDurableCap(ledger.cap, requestedCap);
		const result = reclaimProvenDeadReservations(ledger.reservations, liveness);
		if (result.reclaimedCount > 0) {
			await writeLedgerUnderLock(ledgerPath, {
				version: LANE_ADMISSION_VERSION,
				cap: effectiveCap,
				reservations: result.retained,
			});
		}
		return { ...result, cap: effectiveCap };
	});

	const discovery = inspectTerminalOwnerEnforcement(globalConfigRoot, liveness);
	const launchingLanes = retained.filter(r => r.state === "launching").length;
	const boundActiveLanes = retained.length - launchingLanes;
	return {
		ok: true,
		action: "status",
		ledger_path: ledgerPath,
		cap: resolvedCap,
		active_lanes: retained.length,
		launching_lanes: launchingLanes,
		bound_active_lanes: boundActiveLanes,
		n_free: Math.max(0, resolvedCap - retained.length),
		all_host_enforced: discovery.all_host_enforced,
		discovery_state: discovery.state,
		unregistered_live_owners: discovery.unregistered_live_owners,
		unknown_terminal_records: discovery.unknown_terminal_records,
		reclaimed_count: reclaimedCount,
		reservations: retained,
	};
}

export async function acquireLaneAdmission(options: LaneAdmissionAcquireOptions): Promise<LaneAdmissionAcquireResult> {
	const owner = options.owner.trim();
	if (!owner) {
		throw new LaneAdmissionError("invalid_owner", "Lane admission owner must be non-empty");
	}
	const kind: LaneAdmissionKind = options.kind ?? "external";
	const requestedCap = options.cap !== undefined ? resolveCap(options.cap) : undefined;
	let observedCap = requestedCap ?? DEFAULT_HOST_LANE_CAP;
	let observedActiveLanes = 0;
	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const liveness = options.liveness ?? DEFAULT_LIVENESS_PROBE;
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);

	const discovery = inspectTerminalOwnerEnforcement(globalConfigRoot, liveness);
	const allHostEnforced = discovery.all_host_enforced;
	const unregistered = discovery.unregistered_live_owners;
	const unknownRecordsField =
		discovery.unknown_terminal_records.length > 0
			? { unknown_terminal_records: discovery.unknown_terminal_records }
			: {};
	if (kind === "external" && !allHostEnforced) {
		return {
			ok: false,
			admitted: false,
			reason: unregistered.length > 0 ? "older_unregistered_veyyon_processes_live" : "terminal_discovery_unknown",
			cap: observedCap,
			active_lanes: 0,
			n_free: 0,
			all_host_enforced: false,
			discovery_state: discovery.state,
			unregistered_live_owners: unregistered,
			...unknownRecordsField,
		};
	}

	try {
		return await withLedgerLock(ledgerPath, async () => {
			const ledger = await readLedgerUnderLock(ledgerPath, requestedCap ?? DEFAULT_HOST_LANE_CAP);
			const effectiveCap = resolveDurableCap(ledger.cap, requestedCap);
			observedCap = effectiveCap;
			const capReduced = effectiveCap < ledger.cap;
			const { retained, reclaimedCount } = reclaimProvenDeadReservations(ledger.reservations, liveness);
			observedActiveLanes = retained.length;

			if (retained.some(r => r.owner === owner)) {
				if (reclaimedCount > 0 || capReduced) {
					await writeLedgerUnderLock(ledgerPath, {
						version: LANE_ADMISSION_VERSION,
						cap: effectiveCap,
						reservations: retained,
					});
				}
				return {
					ok: false,
					admitted: false,
					reason: "owner_already_reserved",
					cap: effectiveCap,
					active_lanes: retained.length,
					n_free: Math.max(0, effectiveCap - retained.length),
					all_host_enforced: allHostEnforced,
					discovery_state: discovery.state,
					unregistered_live_owners: unregistered,
					...unknownRecordsField,
					reclaimed_count: reclaimedCount,
				};
			}
			if (retained.length >= effectiveCap) {
				if (reclaimedCount > 0 || capReduced) {
					await writeLedgerUnderLock(ledgerPath, {
						version: LANE_ADMISSION_VERSION,
						cap: effectiveCap,
						reservations: retained,
					});
				}
				return {
					ok: false,
					admitted: false,
					reason: "host_lane_cap_reached",
					cap: effectiveCap,
					active_lanes: retained.length,
					n_free: 0,
					all_host_enforced: allHostEnforced,
					discovery_state: discovery.state,
					unregistered_live_owners: unregistered,
					...unknownRecordsField,
					reclaimed_count: reclaimedCount,
				};
			}

			const callerPid = options.callerPid === undefined ? null : options.callerPid;
			if (callerPid !== null && !isValidPid(callerPid)) {
				if (reclaimedCount > 0 || capReduced) {
					await writeLedgerUnderLock(ledgerPath, {
						version: LANE_ADMISSION_VERSION,
						cap: effectiveCap,
						reservations: retained,
					});
				}
				throw new LaneAdmissionError("invalid_pid", `Invalid caller pid: ${String(callerPid)}`);
			}
			const workerPid = options.workerPid !== undefined ? options.workerPid : kind === "native" ? process.pid : null;
			if (workerPid !== null && !isValidPid(workerPid)) {
				if (reclaimedCount > 0 || capReduced) {
					await writeLedgerUnderLock(ledgerPath, {
						version: LANE_ADMISSION_VERSION,
						cap: effectiveCap,
						reservations: retained,
					});
				}
				throw new LaneAdmissionError("invalid_pid", `Invalid worker pid: ${String(workerPid)}`);
			}

			let workerProcessIdentity: string | null = null;
			if (workerPid !== null) {
				if (!liveness.isPidAlive(workerPid)) {
					if (reclaimedCount > 0 || capReduced) {
						await writeLedgerUnderLock(ledgerPath, {
							version: LANE_ADMISSION_VERSION,
							cap: effectiveCap,
							reservations: retained,
						});
					}
					throw new LaneAdmissionError(
						"worker_pid_not_alive",
						`Worker pid ${workerPid} is not alive for immediate admission bind`,
					);
				}
				workerProcessIdentity = liveness.getStartIdentity(workerPid);
				if (workerProcessIdentity === null) {
					if (reclaimedCount > 0 || capReduced) {
						await writeLedgerUnderLock(ledgerPath, {
							version: LANE_ADMISSION_VERSION,
							cap: effectiveCap,
							reservations: retained,
						});
					}
					throw new LaneAdmissionError(
						"worker_identity_unverifiable",
						`Cannot verify process start identity for worker pid ${workerPid}`,
					);
				}
				if (!liveness.isInstanceAlive(workerPid, workerProcessIdentity)) {
					if (reclaimedCount > 0 || capReduced) {
						await writeLedgerUnderLock(ledgerPath, {
							version: LANE_ADMISSION_VERSION,
							cap: effectiveCap,
							reservations: retained,
						});
					}
					throw new LaneAdmissionError(
						"worker_pid_not_alive",
						`Worker pid ${workerPid} exited or changed incarnation during immediate admission bind`,
					);
				}
			}

			const now = Date.now();
			const callerProcessIdentity = callerPid !== null ? liveness.getStartIdentity(callerPid) : null;
			const state: LaneAdmissionState = workerPid !== null ? "active" : "launching";
			const reservation: LaneReservation = {
				slotId: crypto.randomUUID(),
				leaseToken: crypto.randomUUID(),
				kind,
				owner,
				state,
				pid: workerPid,
				processIdentity: workerProcessIdentity,
				callerPid,
				callerProcessIdentity,
				identityVerified: workerPid !== null,
				acquiredAt: now,
				adoptedAt: workerPid !== null ? now : null,
				lastHeartbeatAt: now,
			};
			const nextReservations = [...retained, reservation];
			await writeLedgerUnderLock(ledgerPath, {
				version: LANE_ADMISSION_VERSION,
				cap: effectiveCap,
				reservations: nextReservations,
			});

			return {
				ok: true,
				admitted: true,
				slot_id: reservation.slotId,
				lease_token: reservation.leaseToken,
				owner: reservation.owner,
				kind: reservation.kind,
				state: reservation.state,
				cap: effectiveCap,
				active_lanes: nextReservations.length,
				n_free: Math.max(0, effectiveCap - nextReservations.length),
				all_host_enforced: allHostEnforced,
				discovery_state: discovery.state,
				unregistered_live_owners: unregistered,
				...unknownRecordsField,
				reclaimed_count: reclaimedCount,
			};
		});
	} catch (error) {
		if (error instanceof LaneAdmissionError) {
			return {
				ok: false,
				admitted: false,
				reason: error.code,
				cap: observedCap,
				active_lanes: observedActiveLanes,
				n_free: Math.max(0, observedCap - observedActiveLanes),
				all_host_enforced: allHostEnforced,
				discovery_state: discovery.state,
				unregistered_live_owners: unregistered,
				...unknownRecordsField,
			};
		}
		throw error;
	}
}

export async function adoptLaneAdmission(options: LaneAdmissionAdoptOptions): Promise<LaneAdmissionAdoptResult> {
	if (!isValidPid(options.pid)) {
		return { ok: false, adopted: false, slot_id: options.slotId, reason: "invalid_pid" };
	}
	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const liveness = options.liveness ?? DEFAULT_LIVENESS_PROBE;
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);

	try {
		return await withLedgerLock(ledgerPath, async () => {
			const ledger = await readLedgerUnderLock(ledgerPath, DEFAULT_HOST_LANE_CAP);
			const index = ledger.reservations.findIndex(r => r.slotId === options.slotId);
			if (index === -1) {
				return { ok: false, adopted: false, slot_id: options.slotId, reason: "slot_not_found" };
			}
			const existing = ledger.reservations[index]!;
			if (existing.leaseToken !== options.leaseToken) {
				return { ok: false, adopted: false, slot_id: options.slotId, reason: "lease_token_mismatch" };
			}
			if (existing.state === "active" && existing.pid !== null && existing.pid !== options.pid) {
				return { ok: false, adopted: false, slot_id: options.slotId, reason: "slot_already_adopted" };
			}

			const pidAlive = liveness.isPidAlive(options.pid);
			if (!pidAlive) {
				return {
					ok: false,
					adopted: false,
					slot_id: options.slotId,
					pid: options.pid,
					identity_verified: false,
					pid_alive: false,
					reason: "worker_pid_not_alive",
				};
			}
			const now = Date.now();
			const identity = liveness.getStartIdentity(options.pid);
			if (identity !== null && !liveness.isInstanceAlive(options.pid, identity)) {
				return {
					ok: false,
					adopted: false,
					slot_id: options.slotId,
					pid: options.pid,
					identity_verified: false,
					pid_alive: false,
					reason: "worker_pid_not_alive",
				};
			}
			const updated: LaneReservation = {
				...existing,
				state: "active",
				pid: options.pid,
				processIdentity: identity,
				identityVerified: identity !== null,
				adoptedAt: existing.adoptedAt ?? now,
				lastHeartbeatAt: now,
			};
			const nextReservations = [...ledger.reservations];
			nextReservations[index] = updated;
			await writeLedgerUnderLock(ledgerPath, { ...ledger, reservations: nextReservations });

			return {
				ok: true,
				adopted: true,
				slot_id: updated.slotId,
				state: "active",
				pid: options.pid,
				identity_verified: updated.identityVerified,
				pid_alive: pidAlive,
			};
		});
	} catch (error) {
		if (error instanceof LaneAdmissionError) {
			return { ok: false, adopted: false, slot_id: options.slotId, reason: error.code };
		}
		throw error;
	}
}

export async function heartbeatLaneAdmission(
	options: LaneAdmissionHeartbeatOptions,
): Promise<LaneAdmissionHeartbeatResult> {
	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);

	try {
		return await withLedgerLock(ledgerPath, async () => {
			const ledger = await readLedgerUnderLock(ledgerPath, DEFAULT_HOST_LANE_CAP);
			const index = ledger.reservations.findIndex(r => r.slotId === options.slotId);
			if (index === -1) {
				return { ok: false, slot_id: options.slotId, reason: "slot_not_found" };
			}
			const existing = ledger.reservations[index]!;
			if (existing.leaseToken !== options.leaseToken) {
				return { ok: false, slot_id: options.slotId, reason: "lease_token_mismatch" };
			}
			const now = Date.now();
			const nextReservations = [...ledger.reservations];
			nextReservations[index] = { ...existing, lastHeartbeatAt: now };
			await writeLedgerUnderLock(ledgerPath, { ...ledger, reservations: nextReservations });
			return { ok: true, slot_id: options.slotId, last_heartbeat_at: now };
		});
	} catch (error) {
		if (error instanceof LaneAdmissionError) {
			return { ok: false, slot_id: options.slotId, reason: error.code };
		}
		throw error;
	}
}

export async function releaseLaneAdmission(options: LaneAdmissionReleaseOptions): Promise<LaneAdmissionReleaseResult> {
	const requestedCap = options.cap !== undefined ? resolveCap(options.cap) : undefined;
	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);

	try {
		return await withLedgerLock(ledgerPath, async () => {
			const ledger = await readLedgerUnderLock(ledgerPath, requestedCap ?? DEFAULT_HOST_LANE_CAP);
			const responseCap = resolveDurableCap(ledger.cap, requestedCap);
			const index = ledger.reservations.findIndex(r => r.slotId === options.slotId);
			if (index === -1) {
				if (responseCap < ledger.cap && fs.existsSync(ledgerPath)) {
					await writeLedgerUnderLock(ledgerPath, { ...ledger, cap: responseCap });
				}
				return {
					ok: true,
					released: false,
					already_absent: true,
					slot_id: options.slotId,
					active_lanes: ledger.reservations.length,
					n_free: Math.max(0, responseCap - ledger.reservations.length),
				};
			}
			const existing = ledger.reservations[index]!;
			if (existing.leaseToken !== options.leaseToken) {
				return { ok: false, released: false, slot_id: options.slotId, reason: "lease_token_mismatch" };
			}
			const nextReservations = ledger.reservations.filter((_, i) => i !== index);
			await writeLedgerUnderLock(ledgerPath, { ...ledger, cap: responseCap, reservations: nextReservations });
			return {
				ok: true,
				released: true,
				slot_id: options.slotId,
				active_lanes: nextReservations.length,
				n_free: Math.max(0, responseCap - nextReservations.length),
			};
		});
	} catch (error) {
		if (error instanceof LaneAdmissionError) {
			return { ok: false, released: false, slot_id: options.slotId, reason: error.code };
		}
		throw error;
	}
}

function waitAbortably(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		cleanup();
		resolve();
	}, ms);
	timer.unref?.();
	const onAbort = () => {
		clearTimeout(timer);
		cleanup();
		resolve();
	};
	const cleanup = () => {
		signal?.removeEventListener("abort", onAbort);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/** Internal indirection enabling deterministic spies on ledger calls inside wait loops. */
export const laneAdmissionDriver = {
	acquire: acquireLaneAdmission,
	heartbeat: heartbeatLaneAdmission,
	release: releaseLaneAdmission,
};

interface ActiveNativeLeaseEntry {
	lease: NativeHostLaneLease;
	count: number;
	inFlightFinalRelease: Promise<void> | null;
}

interface NativeAcquireWaiter {
	signal?: AbortSignal;
	waitIfFull: boolean;
	aborted: boolean;
	resolve: (outcome: NativeJoinOutcome) => void;
	reject: (error: unknown) => void;
	cleanupListener: () => void;
}

type NativeJoinOutcome = { kind: "settled"; lease: NativeHostLaneLease | null } | { kind: "retry" };

interface PendingNativeAcquireEntry {
	controller: AbortController;
	waitIfFull: boolean;
	waiters: Set<NativeAcquireWaiter>;
	aborted: boolean;
	settled: boolean;
	hasTerminalError: boolean;
	terminalError: unknown;
	promise: Promise<void>;
}

const activeNativeAgentLeases = new Map<string, ActiveNativeLeaseEntry>();
const pendingNativeAgentAcquires = new Map<string, PendingNativeAcquireEntry>();

async function releaseSlotDurably(options: {
	slotId: string;
	leaseToken: string;
	cap?: number;
	globalConfigRoot?: string;
}): Promise<void> {
	const res = await laneAdmissionDriver.release(options);
	if (!res.ok) {
		throw new LaneAdmissionError(
			res.reason ?? "release_failed",
			`Failed to release host lane slot ${options.slotId}: ${res.reason ?? "unknown"}`,
		);
	}
}

async function awaitSettleAbortably(promise: Promise<unknown>, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	const settled = promise.then(
		() => {},
		() => {},
	);
	if (!signal) {
		await settled;
		return;
	}
	const { promise: abortPromise, resolve } = Promise.withResolvers<void>();
	const onAbort = () => resolve();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([settled, abortPromise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function createBorrowedLeaseHandle(key: string, entry: ActiveNativeLeaseEntry): NativeHostLaneLease {
	let handleReleased = false;
	let handleReleasePromise: Promise<void> | null = null;
	return {
		slotId: entry.lease.slotId,
		leaseToken: entry.lease.leaseToken,
		release(): Promise<void> {
			if (handleReleased) return Promise.resolve();
			if (handleReleasePromise) return handleReleasePromise;

			const current = activeNativeAgentLeases.get(key);
			if (!current || current !== entry) {
				handleReleased = true;
				return Promise.resolve();
			}

			if (current.count > 1) {
				current.count -= 1;
				handleReleased = true;
				return Promise.resolve();
			}

			// Final reference: retain count === 1 and keep the map entry until durable release succeeds.
			if (entry.inFlightFinalRelease) {
				const joined = entry.inFlightFinalRelease.then(() => {
					handleReleased = true;
				});
				const wrapped = joined.finally(() => {
					if (handleReleasePromise === wrapped) handleReleasePromise = null;
				});
				handleReleasePromise = wrapped;
				return wrapped;
			}

			let finalPending: Promise<void>;
			finalPending = entry.lease.release().then(
				() => {
					if (entry.inFlightFinalRelease === finalPending) {
						entry.inFlightFinalRelease = null;
					}
					entry.count = 0;
					if (activeNativeAgentLeases.get(key) === entry) {
						activeNativeAgentLeases.delete(key);
					}
					handleReleased = true;
				},
				error => {
					if (entry.inFlightFinalRelease === finalPending) {
						entry.inFlightFinalRelease = null;
					}
					throw error;
				},
			);
			entry.inFlightFinalRelease = finalPending;
			const wrapped = finalPending.finally(() => {
				if (handleReleasePromise === wrapped) handleReleasePromise = null;
			});
			handleReleasePromise = wrapped;
			return wrapped;
		},
	};
}

function joinPendingAcquire(
	key: string,
	entry: PendingNativeAcquireEntry,
	signal: AbortSignal | undefined,
	waitIfFull: boolean,
): Promise<NativeJoinOutcome> {
	const { promise, resolve, reject } = Promise.withResolvers<NativeJoinOutcome>();
	const waiter: NativeAcquireWaiter = {
		signal,
		waitIfFull,
		aborted: false,
		resolve,
		reject,
		cleanupListener: () => {},
	};
	entry.waiters.add(waiter);

	if (signal) {
		const onAbort = () => {
			if (waiter.aborted || entry.settled) return;
			waiter.aborted = true;
			waiter.cleanupListener();
			entry.waiters.delete(waiter);

			if (entry.waiters.size > 0) {
				resolve({ kind: "settled", lease: null });
				return;
			}

			entry.aborted = true;
			entry.controller.abort();
			entry.promise.then(() => {
				if (entry.hasTerminalError) {
					reject(entry.terminalError);
				} else {
					resolve({ kind: "settled", lease: null });
				}
			});
		};
		waiter.cleanupListener = () => {
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	}

	return promise;
}


/**
 * Acquire a native host-wide lane slot, waiting while the host cap is full until
 * admitted or `signal` aborts. When `waitIfFull` is false, rejects full capacity
 * immediately with `LaneAdmissionError('nested_host_lane_cap_reached', ...)`.
 * Returns `null` when aborted before admission.
 */
export async function acquireNativeHostLaneWait(options: {
	owner: string;
	signal?: AbortSignal;
	cap?: number;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	globalConfigRoot?: string;
	waitIfFull?: boolean;
}): Promise<NativeHostLaneLease | null> {
	const pollMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_MS;
	const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
	const waitIfFull = options.waitIfFull ?? true;

	while (!options.signal?.aborted) {
		const res = await laneAdmissionDriver.acquire({
			owner: options.owner,
			kind: "native",
			callerPid: process.pid,
			workerPid: process.pid,
			cap: options.cap,
			globalConfigRoot: options.globalConfigRoot,
		});
		if (res.admitted && res.slot_id && res.lease_token) {
			const slotId = res.slot_id;
			const leaseToken = res.lease_token;
			if (options.signal?.aborted) {
				await releaseSlotDurably({
					slotId,
					leaseToken,
					cap: options.cap,
					globalConfigRoot: options.globalConfigRoot,
				});
				return null;
			}
			let released = false;
			let inFlightRelease: Promise<void> | null = null;
			const timer = setInterval(() => {
				if (released || inFlightRelease) return;
				void laneAdmissionDriver
					.heartbeat({
						slotId,
						leaseToken,
						globalConfigRoot: options.globalConfigRoot,
					})
					.catch(() => {});
			}, heartbeatMs);
			timer.unref?.();

			return {
				slotId,
				leaseToken,
				release(): Promise<void> {
					if (released) return Promise.resolve();
					if (inFlightRelease) return inFlightRelease;
					let pending: Promise<void>;
					pending = releaseSlotDurably({
						slotId,
						leaseToken,
						cap: options.cap,
						globalConfigRoot: options.globalConfigRoot,
					}).then(
						() => {
							released = true;
							clearInterval(timer);
							if (inFlightRelease === pending) inFlightRelease = null;
						},
						error => {
							if (inFlightRelease === pending) inFlightRelease = null;
							throw error;
						},
					);
					inFlightRelease = pending;
					return pending;
				},
			};
		}
		if (res.reason !== "host_lane_cap_reached") {
			throw new LaneAdmissionError(
				res.reason ?? "admission_failed",
				`Host lane admission failed closed (${res.reason ?? "unknown"})`,
			);
		}
		if (options.signal?.aborted) {
			return null;
		}
		if (!waitIfFull) {
			throw new LaneAdmissionError(
				"nested_host_lane_cap_reached",
				`Host lane admission cap (${res.cap}) reached (${res.active_lanes}/${res.cap} active) for nested owner "${options.owner}"; nested subagents fail fast instead of polling while holding parent slots`,
			);
		}
		await waitAbortably(pollMs, options.signal);
	}
	return null;
}

/**
 * Acquire or borrow the active in-process host lane lease for a subagent `agentId`.
 * Prevents double-counting or deadlocking when a running subagent turn triggers an
 * internal wake/replay turn before releasing its outer lease, and shares a single
 * in-flight acquisition per `agentId` across concurrent callers.
 */
export async function acquireSubagentHostLane(options: {
	agentId: string;
	owner: string;
	signal?: AbortSignal;
	cap?: number;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	globalConfigRoot?: string;
	waitIfFull?: boolean;
}): Promise<NativeHostLaneLease | null> {
	if (options.signal?.aborted) return null;

	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const key = `${getLaneAdmissionLedgerPath(globalConfigRoot)}\0${options.agentId}`;
	const callerWaitIfFull = options.waitIfFull ?? true;

	for (;;) {
		if (options.signal?.aborted) return null;

		const existing = activeNativeAgentLeases.get(key);
		if (existing) {
			if (existing.inFlightFinalRelease) {
				await awaitSettleAbortably(existing.inFlightFinalRelease, options.signal);
				if (options.signal?.aborted) return null;
				continue;
			}
			existing.count += 1;
			return createBorrowedLeaseHandle(key, existing);
		}

		const pending = pendingNativeAgentAcquires.get(key);
		if (pending) {
			if (pending.aborted) {
				await awaitSettleAbortably(pending.promise, options.signal);
				if (options.signal?.aborted) return null;
				continue;
			}
			const outcome = await joinPendingAcquire(key, pending, options.signal, callerWaitIfFull);
			if (outcome.kind === "retry") continue;
			return outcome.lease;
		}

		// Install shared acquisition entry and initial waiter synchronously before starting
		// the underlying acquire so concurrent same-key callers join one flight.
		const entry: PendingNativeAcquireEntry = {
			controller: new AbortController(),
			waitIfFull: callerWaitIfFull,
			waiters: new Set(),
			aborted: false,
			settled: false,
			hasTerminalError: false,
			terminalError: undefined,
			promise: Promise.resolve(),
		};
		pendingNativeAgentAcquires.set(key, entry);
		const callerPromise = joinPendingAcquire(key, entry, options.signal, callerWaitIfFull);

		entry.promise = acquireNativeHostLaneWait({
			owner: options.owner,
			signal: entry.controller.signal,
			cap: options.cap,
			pollIntervalMs: options.pollIntervalMs,
			heartbeatIntervalMs: options.heartbeatIntervalMs,
			globalConfigRoot,
			waitIfFull: callerWaitIfFull,
		}).then(
			async underlyingLease => {
				const activeWaiters: NativeAcquireWaiter[] = [];
				for (const waiter of entry.waiters) {
					waiter.cleanupListener();
					if (waiter.aborted || waiter.signal?.aborted) {
						waiter.aborted = true;
						waiter.resolve({ kind: "settled", lease: null });
					} else {
						activeWaiters.push(waiter);
					}
				}
				entry.waiters.clear();

				if (!underlyingLease || activeWaiters.length === 0) {
					entry.aborted = true;
					if (underlyingLease) {
						try {
							await underlyingLease.release();
						} catch (error) {
							entry.hasTerminalError = true;
							entry.terminalError = error;
						}
					}
					entry.settled = true;
					if (pendingNativeAgentAcquires.get(key) === entry) {
						pendingNativeAgentAcquires.delete(key);
					}
					for (const waiter of activeWaiters) {
						if (entry.hasTerminalError) {
							waiter.reject(entry.terminalError);
						} else {
							waiter.resolve({ kind: "settled", lease: null });
						}
					}
					return;
				}

				entry.settled = true;
				if (pendingNativeAgentAcquires.get(key) === entry) {
					pendingNativeAgentAcquires.delete(key);
				}
				const activeEntry: ActiveNativeLeaseEntry = {
					lease: underlyingLease,
					count: activeWaiters.length,
					inFlightFinalRelease: null,
				};
				activeNativeAgentLeases.set(key, activeEntry);
				for (const waiter of activeWaiters) {
					waiter.resolve({
						kind: "settled",
						lease: createBorrowedLeaseHandle(key, activeEntry),
					});
				}
			},
			error => {
				entry.settled = true;
				if (pendingNativeAgentAcquires.get(key) === entry) {
					pendingNativeAgentAcquires.delete(key);
				}
				entry.hasTerminalError = true;
				entry.terminalError = error;
				const remaining = Array.from(entry.waiters);
				entry.waiters.clear();
				for (const waiter of remaining) {
					waiter.cleanupListener();
					if (waiter.aborted || waiter.signal?.aborted) {
						waiter.aborted = true;
						waiter.resolve({ kind: "settled", lease: null });
					} else if (
						waiter.waitIfFull &&
						!entry.waitIfFull &&
						error instanceof LaneAdmissionError &&
						error.code === "nested_host_lane_cap_reached"
					) {
						waiter.resolve({ kind: "retry" });
					} else {
						waiter.reject(error);
					}
				}
			},
		);

		const outcome = await callerPromise;
		if (outcome.kind === "retry") continue;
		return outcome.lease;
	}
}
