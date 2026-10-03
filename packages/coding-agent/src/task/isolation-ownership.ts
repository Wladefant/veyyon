/**
 * Ownership marker and sidecar helpers for task isolation workspaces.
 */
import * as path from "node:path";
import * as natives from "@veyyon/natives";

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
 * Record which backend mounted a retained workspace, so cleanup can unmount
 * it before removal. Best-effort: retention stays valid without it (the
 * workspace merely falls back to plain recursive removal).
 */
export async function writeRetainedBackend(baseDir: string, backend: natives.IsoBackendKind): Promise<void> {
	await Bun.write(
		path.join(baseDir, RETAINED_BACKEND_FILE),
		JSON.stringify({ backend, retainedAt: new Date().toISOString() }),
	);
}

/**
 * Backend recorded for a retained workspace when it needs unmount-before-
 * remove. `undefined` for ordinary sandboxes, foreign files, and malformed
 * or non-mounting records — all of which keep the standard removal behavior.
 */
export async function readRetainedMountBackend(dir: string): Promise<natives.IsoBackendKind | undefined> {
	let decoded: unknown;
	try {
		decoded = await Bun.file(path.join(dir, RETAINED_BACKEND_FILE)).json();
	} catch {
		return undefined;
	}
	if (typeof decoded !== "object" || decoded === null || !("backend" in decoded)) {
		return undefined;
	}
	const backend = decoded.backend;
	if (typeof backend !== "number" || !Number.isInteger(backend) || !isMountingIsolationBackend(backend)) {
		return undefined;
	}
	return backend;
}
