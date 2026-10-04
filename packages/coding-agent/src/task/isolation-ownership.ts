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
 * Record the backend of an isolation workspace. Cleanup requires this record to distinguish
 * copy workspaces from mounts; a missing record never authorizes removal. Setup writes it
 * with `retained: false` so a crashed owner's slot is reclaimable; retention rewrites it
 * with `retainedAt`, which {@link isRetainedWorkspace} reads.
 */
export async function writeRetainedBackend(
	baseDir: string,
	backend: natives.IsoBackendKind,
	options: { retained?: boolean } = {},
): Promise<void> {
	const record = options.retained === false ? { backend } : { backend, retainedAt: new Date().toISOString() };
	await fs.writeFile(path.join(baseDir, RETAINED_BACKEND_FILE), JSON.stringify(record), "utf8");
}

/**
 * Whether the sidecar marks a deliberate retention (as opposed to the setup record of a slot
 * a task may still be running in). An unreadable sidecar counts as not retained, so callers
 * treating a live owner as a blocker stay conservative.
 */
export async function isRetainedWorkspace(dir: string): Promise<boolean> {
	try {
		const decoded: unknown = JSON.parse(await fs.readFile(path.join(dir, RETAINED_BACKEND_FILE), "utf8"));
		return typeof decoded === "object" && decoded !== null && "retainedAt" in decoded;
	} catch {
		return false;
	}
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
 * Source repositories that hold a linked-worktree registration for a checkout inside an
 * isolation slot. A copy backend such as Rcopy materialises `git worktree add` checkouts, so
 * deleting the slot with `fs.rm` alone leaves the repo listing a missing worktree, and the next
 * `ensureIsolation` for the same id fails with "missing but already registered". Callers collect
 * these before removal and run `git worktree prune` in each afterwards. Looks at the slot and
 * one level below it, which covers the mount dir of a plain slot and of a retained one.
 */
export async function findLinkedWorktreeRepos(baseDir: string): Promise<string[]> {
	const candidates = [baseDir];
	try {
		for (const entry of await fs.readdir(baseDir, { withFileTypes: true })) {
			if (entry.isDirectory()) candidates.push(path.join(baseDir, entry.name));
		}
	} catch {
		return [];
	}
	const repos = new Set<string>();
	for (const dir of candidates) {
		try {
			const pointer = await fs.readFile(path.join(dir, ".git"), "utf8");
			const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
			if (!match) continue;
			// <repo>/.git/worktrees/<name> -> <repo>/.git -> <repo>
			const commonDir = path.dirname(path.dirname(path.resolve(dir, match[1])));
			repos.add(path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir);
		} catch {
			/* not a linked worktree */
		}
	}
	return [...repos];
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
	let pid: number;
	let startIdentity: string | null;

	const claim = await readClaimIncarnation(baseDir);
	if (claim.state === "unreadable") return false;
	if (claim.state === "present") {
		pid = claim.pid;
		startIdentity = claim.startIdentity;
	} else {
		let owner: IsolationOwnerRecord | null;
		try {
			owner = await readIsolationOwner(baseDir);
		} catch {
			return false;
		}
		if (!owner) return false;
		pid = owner.pid;
		startIdentity = owner.startIdentity;
	}

	if (isProcessInstanceAlive(pid, startIdentity)) return false;

	try {
		const entries = await fs.readdir(baseDir);
		return entries.length > 0 && entries.every(e => e === ISOLATION_OWNER_FILE || e === ISOLATION_CLAIM_FILE);
	} catch {
		return false;
	}
}

/**
 * One canonical spelling of a physical path, so every alias of an isolation
 * slot (a case variant on Windows, a junction or symlink on a parent
 * directory) names the same lock and compares equal. Resolves the deepest
 * existing ancestor with `fs.realpath` and appends the not-yet-existing rest;
 * on win32 the result is lowercased with `\` separators.
 */
export async function canonicalIsolationPath(target: string): Promise<string> {
	const resolved = path.resolve(target);
	const rest: string[] = [];
	let current = resolved;
	let real: string | undefined;
	for (;;) {
		try {
			real = await fs.realpath(current);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = path.dirname(current);
			if (parent === current) {
				real = current;
				break;
			}
			rest.unshift(path.basename(current));
			current = parent;
		}
	}
	const joined = rest.length > 0 ? path.join(real, ...rest) : real;
	return process.platform === "win32" ? joined.replace(/\//g, "\\").toLowerCase() : joined;
}

/**
 * Path for a base directory's exclusive lifecycle lock outside the scanned
 * `wt` directory (under a sibling `isolation-locks` directory). The lock name
 * hashes the canonical path, so every alias of one slot shares one lock.
 */
export async function getIsolationLifecycleLockPath(baseDir: string): Promise<string> {
	const canonical = await canonicalIsolationPath(baseDir);
	const name = path.basename(canonical);
	const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
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
	const lockPath = await getIsolationLifecycleLockPath(baseDir);
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
	const lockPath = await getIsolationLifecycleLockPath(baseDir);
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
	const [original, destination] = await Promise.all([
		canonicalIsolationPath(originalBaseDir),
		canonicalIsolationPath(destinationBaseDir),
	]);
	if (original === destination) {
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
		const marker = { pid: process.pid, startIdentity: getProcessStartIdentity(process.pid) };
		await fs.writeFile(path.join(staging, ISOLATION_CLAIM_FILE), JSON.stringify(marker), "utf8");
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

type ClaimIncarnation =
	| { state: "absent" }
	| { state: "unreadable" }
	| { state: "present"; pid: number; startIdentity: string | null };

/**
 * Read the process incarnation (pid plus start identity) a claim marker names.
 * A marker written before start identities were recorded carries no
 * `startIdentity` key; it takes the owner record's identity instead, so a
 * reused PID is still told apart from the process that made the claim. A
 * marker that is present but unparseable reads `unreadable`.
 */
async function readClaimIncarnation(dir: string): Promise<ClaimIncarnation> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(dir, ISOLATION_CLAIM_FILE), "utf8");
	} catch (error) {
		return isEnoent(error) ? { state: "absent" } : { state: "unreadable" };
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		return { state: "unreadable" };
	}
	if (!decoded || typeof decoded !== "object" || !("pid" in decoded)) return { state: "unreadable" };
	const pid = decoded.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
		return { state: "unreadable" };
	}
	if ("startIdentity" in decoded) {
		return {
			state: "present",
			pid,
			startIdentity: typeof decoded.startIdentity === "string" ? decoded.startIdentity : null,
		};
	}
	const owner = await readIsolationOwner(dir).catch(() => null);
	return { state: "present", pid, startIdentity: owner?.pid === pid ? owner.startIdentity : null };
}

/**
 * Whether `dir` carries a claim whose process incarnation is still running. A
 * claim left by a dead process, or by a process whose PID has since been reused
 * by an unrelated one, is stale and reads false, so a crashed setup stays
 * reclaimable. An unreadable or malformed marker reads true: removal is the
 * unsafe answer.
 */
export async function isolationClaimIsLive(dir: string): Promise<boolean> {
	const claim = await readClaimIncarnation(dir);
	if (claim.state === "absent") return false;
	if (claim.state === "unreadable") return true;
	return isProcessInstanceAlive(claim.pid, claim.startIdentity);
}
