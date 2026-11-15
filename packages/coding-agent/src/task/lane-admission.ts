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

export interface UnregisteredLiveOwner {
	sessionId: string;
	pid: number;
	profile: string;
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
	unregistered_live_owners: UnregisteredLiveOwner[];
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
	unregistered_live_owners?: UnregisteredLiveOwner[];
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
	if (!Array.isArray(parsed.reservations) || !parsed.reservations.every(isValidReservation)) {
		throw new LaneAdmissionError("corrupt_admission_ledger", `Invalid reservations array in ${ledgerPath}`);
	}
	return {
		version: LANE_ADMISSION_VERSION,
		cap: typeof parsed.cap === "number" && Number.isSafeInteger(parsed.cap) ? parsed.cap : defaultCap,
		reservations: parsed.reservations.map(item => ({ ...item })),
	};
}

async function writeLedgerUnderLock(ledgerPath: string, ledger: LaneAdmissionLedger): Promise<void> {
	await atomicWriteFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
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
	seen: Set<string>,
): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(directory);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const fullPath = path.join(directory, entry);
		let raw: string;
		try {
			raw = readOwnerOnlyFileSync(fullPath);
		} catch {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!isPlainRecord(parsed)) continue;
		if (parsed.version !== 1) continue;
		if (typeof parsed.sessionId !== "string" || !VALID_SESSION_ID_RE.test(parsed.sessionId)) continue;
		if (!isValidPid(parsed.pid) || !liveness.isPidAlive(parsed.pid)) continue;
		const caps = Array.isArray(parsed.capabilities) ? parsed.capabilities : [];
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

export function listUnregisteredLiveTerminalOwners(
	globalConfigRoot = getGlobalConfigRootDir(),
	liveness: LaneLivenessProbe = DEFAULT_LIVENESS_PROBE,
): UnregisteredLiveOwner[] {
	const owners: UnregisteredLiveOwner[] = [];
	const seen = new Set<string>();
	scanTerminalDirectory(path.join(globalConfigRoot, "run", "terminals"), "root", liveness, owners, seen);

	const profilesDir = path.join(globalConfigRoot, PROFILES_DIR_NAME);
	let profileEntries: fs.Dirent[] = [];
	try {
		profileEntries = fs.readdirSync(profilesDir, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	for (const entry of profileEntries) {
		if (!entry.isDirectory()) continue;
		scanTerminalDirectory(
			path.join(profilesDir, entry.name, "run", "terminals"),
			entry.name,
			liveness,
			owners,
			seen,
		);
	}
	return owners;
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
	const explicitCap = options?.cap !== undefined ? resolveCap(options.cap) : undefined;
	const liveness = options?.liveness ?? DEFAULT_LIVENESS_PROBE;
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);

	const { retained, reclaimedCount, cap: resolvedCap } = await withLedgerLock(ledgerPath, async () => {
		const ledger = await readLedgerUnderLock(ledgerPath, explicitCap ?? DEFAULT_HOST_LANE_CAP);
		const responseCap = explicitCap ?? ledger.cap;
		const result = reclaimProvenDeadReservations(ledger.reservations, liveness);
		if (result.reclaimedCount > 0) {
			await writeLedgerUnderLock(ledgerPath, {
				version: LANE_ADMISSION_VERSION,
				cap: responseCap,
				reservations: result.retained,
			});
		}
		return { ...result, cap: responseCap };
	});

	const unregistered = listUnregisteredLiveTerminalOwners(globalConfigRoot, liveness);
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
		all_host_enforced: unregistered.length === 0,
		unregistered_live_owners: unregistered,
		reclaimed_count: reclaimedCount,
		reservations: retained,
	};
}

export async function acquireLaneAdmission(
	options: LaneAdmissionAcquireOptions,
): Promise<LaneAdmissionAcquireResult> {
	const owner = options.owner.trim();
	if (!owner) {
		throw new LaneAdmissionError("invalid_owner", "Lane admission owner must be non-empty");
	}
	const kind: LaneAdmissionKind = options.kind ?? "external";
	const effectiveCap = resolveCap(options.cap);
	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const liveness = options.liveness ?? DEFAULT_LIVENESS_PROBE;
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);

	const unregistered = listUnregisteredLiveTerminalOwners(globalConfigRoot, liveness);
	const allHostEnforced = unregistered.length === 0;
	if (kind === "external" && !allHostEnforced) {
		return {
			ok: false,
			admitted: false,
			reason: "older_unregistered_veyyon_processes_live",
			cap: effectiveCap,
			active_lanes: 0,
			n_free: 0,
			all_host_enforced: false,
			unregistered_live_owners: unregistered,
		};
	}

	try {
		return await withLedgerLock(ledgerPath, async () => {
			const ledger = await readLedgerUnderLock(ledgerPath, effectiveCap);
			const { retained, reclaimedCount } = reclaimProvenDeadReservations(ledger.reservations, liveness);

			if (retained.some(r => r.owner === owner)) {
				if (reclaimedCount > 0) {
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
					unregistered_live_owners: unregistered,
					reclaimed_count: reclaimedCount,
				};
			}
			if (retained.length >= effectiveCap) {
				if (reclaimedCount > 0) {
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
					unregistered_live_owners: unregistered,
					reclaimed_count: reclaimedCount,
				};
			}

			const now = Date.now();
			const callerPid = options.callerPid === undefined ? null : options.callerPid;
			if (callerPid !== null && !isValidPid(callerPid)) {
				throw new LaneAdmissionError("invalid_pid", `Invalid caller pid: ${String(callerPid)}`);
			}
			const workerPid =
				options.workerPid !== undefined ? options.workerPid : kind === "native" ? process.pid : null;
			if (workerPid !== null && !isValidPid(workerPid)) {
				throw new LaneAdmissionError("invalid_pid", `Invalid worker pid: ${String(workerPid)}`);
			}

			const callerProcessIdentity = callerPid !== null ? liveness.getStartIdentity(callerPid) : null;
			const workerProcessIdentity = workerPid !== null ? liveness.getStartIdentity(workerPid) : null;
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
				identityVerified: workerPid !== null && workerProcessIdentity !== null,
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
				unregistered_live_owners: unregistered,
				reclaimed_count: reclaimedCount,
			};
		});
	} catch (error) {
		if (error instanceof LaneAdmissionError) {
			return {
				ok: false,
				admitted: false,
				reason: error.code,
				cap: effectiveCap,
				active_lanes: 0,
				n_free: 0,
				all_host_enforced: allHostEnforced,
				unregistered_live_owners: unregistered,
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

export async function releaseLaneAdmission(
	options: LaneAdmissionReleaseOptions,
): Promise<LaneAdmissionReleaseResult> {
	const explicitCap = options.cap !== undefined ? resolveCap(options.cap) : undefined;
	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);

	try {
		return await withLedgerLock(ledgerPath, async () => {
			const ledger = await readLedgerUnderLock(ledgerPath, explicitCap ?? DEFAULT_HOST_LANE_CAP);
			const responseCap = explicitCap ?? ledger.cap;
			const index = ledger.reservations.findIndex(r => r.slotId === options.slotId);
			if (index === -1) {
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
			await writeLedgerUnderLock(ledgerPath, { ...ledger, reservations: nextReservations });
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

const activeNativeAgentLeases = new Map<string, { lease: NativeHostLaneLease; count: number }>();

/**
 * Acquire a native host-wide lane slot, waiting while the host cap is full until
 * admitted or `signal` aborts. Returns `null` when aborted before admission.
 */
export async function acquireNativeHostLaneWait(options: {
	owner: string;
	signal?: AbortSignal;
	cap?: number;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	globalConfigRoot?: string;
}): Promise<NativeHostLaneLease | null> {
	const pollMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_MS;
	const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;

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
				await laneAdmissionDriver
					.release({
						slotId,
						leaseToken,
						cap: options.cap,
						globalConfigRoot: options.globalConfigRoot,
					})
					.catch(() => {});
				return null;
			}
			let released = false;
			const timer = setInterval(() => {
				if (released) return;
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
				async release(): Promise<void> {
					if (released) return;
					released = true;
					clearInterval(timer);
					await laneAdmissionDriver.release({
						slotId,
						leaseToken,
						cap: options.cap,
						globalConfigRoot: options.globalConfigRoot,
					});
				},
			};
		}
		if (res.reason !== "host_lane_cap_reached") {
			throw new LaneAdmissionError(
				res.reason ?? "admission_failed",
				`Host lane admission failed closed (${res.reason ?? "unknown"})`,
			);
		}
		await waitAbortably(pollMs, options.signal);
	}
	return null;
}

/**
 * Acquire or borrow the active in-process host lane lease for a subagent `agentId`.
 * Prevents double-counting or deadlocking when a running subagent turn triggers an
 * internal wake/replay turn before releasing its outer lease.
 */
export async function acquireSubagentHostLane(options: {
	agentId: string;
	owner: string;
	signal?: AbortSignal;
	cap?: number;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	globalConfigRoot?: string;
}): Promise<NativeHostLaneLease | null> {
	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const key = `${getLaneAdmissionLedgerPath(globalConfigRoot)}\0${options.agentId}`;
	const existing = activeNativeAgentLeases.get(key);
	if (existing) {
		if (options.signal?.aborted) return null;
		existing.count += 1;
		let released = false;
		return {
			slotId: existing.lease.slotId,
			leaseToken: existing.lease.leaseToken,
			async release(): Promise<void> {
				if (released) return;
				released = true;
				const current = activeNativeAgentLeases.get(key);
				if (!current || current !== existing) return;
				current.count -= 1;
				if (current.count <= 0) {
					activeNativeAgentLeases.delete(key);
					await current.lease.release();
				}
			},
		};
	}

	const underlying = await acquireNativeHostLaneWait({
		owner: options.owner,
		signal: options.signal,
		cap: options.cap,
		pollIntervalMs: options.pollIntervalMs,
		heartbeatIntervalMs: options.heartbeatIntervalMs,
		globalConfigRoot,
	});
	if (!underlying) return null;

	const entry = { lease: underlying, count: 1 };
	activeNativeAgentLeases.set(key, entry);
	let released = false;
	return {
		slotId: underlying.slotId,
		leaseToken: underlying.leaseToken,
		async release(): Promise<void> {
			if (released) return;
			released = true;
			const current = activeNativeAgentLeases.get(key);
			if (current === entry) {
				current.count -= 1;
				if (current.count <= 0) {
					activeNativeAgentLeases.delete(key);
					await current.lease.release();
				}
			} else {
				await underlying.release();
			}
		},
	};
}
