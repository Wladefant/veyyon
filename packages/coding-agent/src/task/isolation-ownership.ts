/**
 * Sidecar helpers for retained mounting-backend isolation workspaces.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@veyyon/natives";
import { errorMessage, isEnoent } from "@veyyon/utils";

const { IsoBackendKind } = natives;

/** Sidecar recording the mounting backend of a retained workspace. */
export const RETAINED_BACKEND_FILE = ".veyyon-retained-backend.json";

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
		pid = (JSON.parse(raw) as { pid?: unknown } | null)?.pid;
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
