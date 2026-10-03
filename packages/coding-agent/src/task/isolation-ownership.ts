/**
 * Sidecar helpers for retained mounting-backend isolation workspaces and
 * cross-process lifecycle ownership records.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@veyyon/natives";
import {
	errorMessage,
	type FileLockOptions,
	getProcessStartIdentity,
	getWorktreesDir,
	isEnoent,
	isProcessInstanceAlive,
	type TryFileLockResult,
	tryWithFileLock,
	withFileLock,
} from "@veyyon/utils";

const { IsoBackendKind } = natives;

/** Sidecar recording the mounting backend of a retained workspace. */
export const RETAINED_BACKEND_FILE = ".veyyon-retained-backend.json";

/** Process ownership record created during atomic slot claim. */
export const ISOLATION_OWNER_FILE = ".veyyon-owner.json";

export interface IsolationOwnerRecord {
	pid: number;
	startIdentity: string | null;
	token: string;
	createdAt: string;
}

/**
 * Backends that mount a live filesystem over the workspace: recursive removal
 * through the mount destroys the preserved layer and fails on the mountpoint,
 * so these must be unmounted before `veyyon worktree clear` removes them. Copy
 * and snapshot backends need no unmount — and their `stop` routines delete
 * data themselves, so they must never be routed through unmount.
 */
export function isMountingIsolationBackend(backend: unknown): backend is natives.IsoBackendKind {
	return backend === IsoBackendKind.Overlayfs || backend === IsoBackendKind.Projfs;
}

/**
 * Record every retained backend. Cleanup requires this record to distinguish
 * copy workspaces from mounts; a missing record never authorizes removal.
 */
export async function writeRetainedBackend(baseDir: string, backend: natives.IsoBackendKind): Promise<void> {
	await fs.writeFile(
		path.join(baseDir, RETAINED_BACKEND_FILE),
		JSON.stringify({ backend, retainedAt: new Date().toISOString() }),
		"utf8",
	);
}

/**
 * Backend recorded for a retained workspace when it needs unmount-before-
 * remove. `undefined` only for a recorded copy or snapshot backend. Missing,
 * unreadable or invalid metadata fails closed.
 */
export async function readRetainedMountBackend(dir: string): Promise<natives.IsoBackendKind | undefined> {
	const sidecarPath = path.join(dir, RETAINED_BACKEND_FILE);
	let raw: string;
	try {
		raw = await fs.readFile(sidecarPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Missing retained backend metadata in ${dir}; refusing removal`);
		throw error;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Failed to parse retained mount metadata in ${dir}: ${errorMessage(error)}`);
	}
	if (typeof decoded !== "object" || decoded === null || !("backend" in decoded)) {
		throw new Error(`Invalid retained mount metadata in ${dir}: missing backend field`);
	}
	const backend = decoded.backend;
	if (typeof backend !== "number" || !Number.isInteger(backend)) {
		throw new Error(`Invalid retained mount metadata in ${dir}: backend must be an integer`);
	}
	if (isMountingIsolationBackend(backend)) {
		return backend;
	}
	const knownBackends = Object.values(natives.IsoBackendKind);
	if (knownBackends.includes(backend as natives.IsoBackendKind)) {
		return undefined;
	}
	throw new Error(`Invalid retained mount metadata in ${dir}: unknown backend ${backend}`);
}

/**
/**
 * Write a process ownership record during atomic slot claim before native
 * backend initialization.
 */
export async function writeIsolationOwner(
	baseDir: string,
	token: string = crypto.randomUUID(),
): Promise<IsolationOwnerRecord> {
	const record: IsolationOwnerRecord = {
		pid: process.pid,
		startIdentity: getProcessStartIdentity(process.pid),
		token,
		createdAt: new Date().toISOString(),
	};
	const ownerPath = path.join(baseDir, ISOLATION_OWNER_FILE);
	await fs.writeFile(ownerPath, JSON.stringify(record, null, 2), "utf8");
	return record;
}

/**
 * Read the process ownership record of an isolation slot, or `null` when missing.
 * Throws on corrupt JSON or missing required fields so callers can fail closed.
 */
export async function readIsolationOwner(baseDir: string): Promise<IsolationOwnerRecord | null> {
	const ownerPath = path.join(baseDir, ISOLATION_OWNER_FILE);
	let raw: string;
	try {
		raw = await fs.readFile(ownerPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Failed to parse isolation owner record in ${baseDir}: ${errorMessage(error)}`);
	}
	if (typeof decoded !== "object" || decoded === null) {
		throw new Error(`Invalid isolation owner record in ${baseDir}: record must be an object`);
	}
	const rec = decoded as Record<string, unknown>;
	if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0 || rec.pid > 0x7fffffff) {
		throw new Error(`Invalid isolation owner record in ${baseDir}: pid must be a positive integer <= 0x7fffffff`);
	}
	if (typeof rec.token !== "string" || rec.token.trim().length === 0) {
		throw new Error(`Invalid isolation owner record in ${baseDir}: token must be a non-empty string`);
	}
	return {
		pid: rec.pid,
		startIdentity: typeof rec.startIdentity === "string" ? rec.startIdentity : null,
		token: rec.token,
		createdAt: typeof rec.createdAt === "string" ? rec.createdAt : "",
	};
}

/**
 * Determine whether a directory represents an abandoned empty reservation:
 * - Contains a valid owner record whose owner process is proven dead; AND
 * - Contains ONLY that owner record file (no `m`, `merged`, mount files,
 *   sentinels, backend files, unknown children, or backend metadata).
 *
 * Missing, unreadable, or invalid owner records fail closed (return `false`).
 * Directories with any other contents fail closed (return `false`).
 */
export async function isAbandonedEmptyReservation(baseDir: string): Promise<boolean> {
	let pid: number | null = null;
	let startIdentity: string | null = null;

	try {
		const rawClaim = await fs.readFile(path.join(baseDir, ISOLATION_CLAIM_FILE), "utf8");
		let decoded: unknown;
		try {
			decoded = JSON.parse(rawClaim);
		} catch {
			return false;
		}
		if (decoded && typeof decoded === "object" && "pid" in decoded) {
			const candidatePid = decoded.pid;
			if (
				typeof candidatePid === "number" &&
				Number.isInteger(candidatePid) &&
				candidatePid > 0 &&
				candidatePid <= 0x7fffffff
			) {
				pid = candidatePid;
				if ("startIdentity" in decoded && typeof decoded.startIdentity === "string") {
					startIdentity = decoded.startIdentity;
				}
			} else {
				return false;
			}
		} else {
			return false;
		}
	} catch (err) {
		if (!isEnoent(err)) return false;
	}

	if (pid === null) {
		let owner: IsolationOwnerRecord | null = null;
		try {
			owner = await readIsolationOwner(baseDir);
		} catch {
			return false;
		}
		if (owner) {
			pid = owner.pid;
			startIdentity = owner.startIdentity;
		}
	}

	if (pid === null) return false;
	if (isProcessInstanceAlive(pid, startIdentity)) return false;

	try {
		const entries = await fs.readdir(baseDir);
		return entries.length > 0 && entries.every(e => e === ISOLATION_OWNER_FILE || e === ISOLATION_CLAIM_FILE);
	} catch {
		return false;
	}
}

/**
 * Path for a base directory's exclusive lifecycle lock outside the scanned
 * `wt` directory (under a sibling `isolation-locks` directory).
 */
export function getIsolationLifecycleLockPath(baseDir: string): string {
	const resolved = path.resolve(baseDir);
	const name = path.basename(resolved);
	const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 16);
	let locksDir: string;
	try {
		const wtRoot = path.resolve(getWorktreesDir());
		locksDir = path.join(path.dirname(wtRoot), "isolation-locks");
	} catch {
		locksDir = path.join(os.tmpdir(), "veyyon-isolation-locks");
	}
	return path.join(locksDir, `${name}-${hash}`);
}

/**
 * Run an operation while holding the exclusive cross-process lifecycle lock
 * for `baseDir`.
 */
export async function withIsolationLifecycleLock<T>(
	baseDir: string,
	fn: () => Promise<T>,
	options?: FileLockOptions,
): Promise<T> {
	const lockPath = getIsolationLifecycleLockPath(baseDir);
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	return await withFileLock(lockPath, fn, options);
}

/**
 * Run an operation under the lifecycle lock if immediately available.
 */
export async function tryWithIsolationLifecycleLock<T>(
	baseDir: string,
	fn: () => Promise<T>,
	options?: FileLockOptions,
): Promise<TryFileLockResult<T>> {
	const lockPath = getIsolationLifecycleLockPath(baseDir);
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	return await tryWithFileLock(lockPath, fn, options);
}

/**
 * Lock during retention workspace publication. When moving to a new path,
 * locks original first then destination in deterministic order to avoid
 * deadlocks, releasing only after state is complete.
 */
export async function withRetentionLifecycleLock<T>(
	originalBaseDir: string,
	destinationBaseDir: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (path.resolve(originalBaseDir) === path.resolve(destinationBaseDir)) {
		return await withIsolationLifecycleLock(originalBaseDir, fn);
	}
	return await withIsolationLifecycleLock(originalBaseDir, async () => {
		return await withIsolationLifecycleLock(destinationBaseDir, fn);
	});
}

/**
 * Marker naming the process that is setting up an isolation slot. It exists
 * only while `ensureIsolation` is between claiming the slot and finishing
 * `isoStart`, the interval in which the slot holds no mount directory yet and
 * would otherwise read to `veyyon worktree clear` as an empty orphan.
 */
export const ISOLATION_CLAIM_FILE = ".veyyon-isolation-claim.json";

/**
 * Claim `baseDir` for the calling process. The directory is built under a
 * private sibling name with its marker already inside, then renamed into place,
 * so the slot never exists unmarked. Rename onto an occupied slot fails, which
 * refuses replacement; the private name is removed on any failure.
 */
export async function claimIsolationSlot(baseDir: string): Promise<void> {
	const staging = `${baseDir}.claim-${process.pid}-${Math.floor(Math.random() * 2 ** 32).toString(16)}`;
	await fs.mkdir(staging);
	try {
		await fs.writeFile(path.join(staging, ISOLATION_CLAIM_FILE), JSON.stringify({ pid: process.pid }), "utf8");
		await fs.rename(staging, baseDir);
	} catch (error) {
		await fs.rm(staging, { recursive: true, force: true });
		throw error;
	}
}

/** Drop the marker once the slot holds its mount, so the workspace is an ordinary leftover again. */
export async function releaseIsolationClaim(baseDir: string): Promise<void> {
	await fs.rm(path.join(baseDir, ISOLATION_CLAIM_FILE), { force: true });
}

/**
 * Whether `dir` carries a claim whose process is still running. A claim left by
 * a dead process is stale and reads false, so a crashed setup stays reclaimable.
 * An unreadable or malformed marker reads true: removal is the unsafe answer.
 */
export async function isolationClaimIsLive(dir: string): Promise<boolean> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(dir, ISOLATION_CLAIM_FILE), "utf8");
	} catch (error) {
		return !isEnoent(error);
	}
	let pid: unknown;
	try {
		const decoded = JSON.parse(raw);
		if (decoded && typeof decoded === "object" && "pid" in decoded) {
			pid = decoded.pid;
		}
	} catch {
		return true;
	}
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
