import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, errorMessage, isEnoent, logger, postmortem } from "@veyyon/utils";
import { tryWithFileLock, withFileLock } from "@veyyon/utils/file-lock";
import { getProcessStartIdentity } from "@veyyon/utils/process-liveness";
import { type BrokerLeaseClock, daemonOwnerIsAlive, daemonOwnerRetirement } from "./broker-lease";
import {
	canonicalProjectDir,
	daemonBrokerLeasePath,
	daemonPresenceDir,
	daemonPresenceEntryPath,
	daemonRuntimeDir,
} from "./paths";

/**
 * Basename of the container holding per-project daemon scopes
 * (`<state>/run/daemons`). {@link pruneDeadDaemonRuntimeDirs} refuses to sweep
 * any other root so a runtime dir passed from outside the state tree cannot
 * turn the reclaim into an rm -rf of unrelated neighbours (issue #8721).
 */
const DAEMONS_DIR = "daemons";
/**
 * Name shape of a project daemon scope: the 16-hex wyhash of the project dir
 * produced by `getDaemonRuntimeDir`. Only entries matching this are pruned,
 * which excludes the machine-global `global` container and any foreign dir.
 */
const DAEMON_SCOPE_KEY = /^[0-9a-f]{16}$/;
/**
 * Grace before a dead daemon runtime dir becomes prune-eligible. Guards against
 * deleting a scope whose owning veyyon process is mid-startup (token written, broker
 * not yet spawned, presence not yet registered). The leak this reclaims is a
 * weeks-scale accumulation, so a few minutes of slack costs nothing.
 */
const DAEMON_RUNTIME_STALE_GRACE_MS = 5 * 60_000;
/** Handle keeping one veyyon process registered in a project daemon scope. */
export interface DaemonProjectPresence {
	close(): Promise<void>;
}

/** Register this veyyon process so project daemons survive while it remains alive. */
export async function registerDaemonProjectPresence(
	projectDir: string,
	runtimeOverride?: string,
): Promise<DaemonProjectPresence> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = runtimeOverride ?? daemonRuntimeDir(canonical);
	const clientsDir = daemonPresenceDir(runtimeDir);
	const id = `${process.pid}-${crypto.randomUUID()}`;
	const presencePath = daemonPresenceEntryPath(clientsDir, id);
	const removeOwnedPresence = async (): Promise<void> => {
		try {
			const raw: unknown = JSON.parse(await fs.readFile(presencePath, "utf8"));
			if (typeof raw === "object" && raw !== null && "id" in raw && raw.id === id) {
				await fs.rm(presencePath, { force: true });
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	};
	// Share the broker transition lock with publication and whole-scope pruning.
	// Prune may detach the parent while we are waiting to acquire its lock.
	// Retry only that pre-publication race, not a failed presence publication.
	for (;;) {
		let entered = false;
		let observed: Stats | undefined;
		try {
			await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
			observed = await fs.stat(runtimeDir);
			await withFileLock(daemonBrokerLeasePath(runtimeDir), async () => {
				entered = true;
				try {
					await fs.mkdir(clientsDir, { recursive: true, mode: 0o700 });
					await atomicWriteFile(
						presencePath,
						JSON.stringify({
							pid: process.pid,
							processIdentity: getProcessStartIdentity(process.pid),
							id,
							projectDir: canonical,
						}),
					);
					await fs.chmod(presencePath, 0o600);
				} catch (error) {
					await removeOwnedPresence();
					throw error;
				}
			});
			break;
		} catch (error) {
			if (entered) throw error;
			if (isEnoent(error)) continue;
			const current = await fs.stat(runtimeDir).catch((statError: unknown) => {
				if (isEnoent(statError)) return null;
				throw statError;
			});
			if (current === null || (observed && (current.dev !== observed.dev || current.ino !== observed.ino))) {
				continue;
			}
			throw error;
		}
	}
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		cancelCleanup();
		await removeOwnedPresence();
	};
	const cancelCleanup = postmortem.register(`daemon-presence:${id}`, () => close());
	return { close };
}

/** Return whether a registered veyyon process in this runtime directory is still alive. */
export async function hasLiveDaemonProjectPresence(runtimeDir: string, clock: BrokerLeaseClock = {}): Promise<boolean> {
	const clientsDir = daemonPresenceDir(runtimeDir);
	let entries: string[];
	try {
		entries = await fs.readdir(clientsDir);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	let live = false;
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const presencePath = path.join(clientsDir, entry);
		try {
			const decoded: unknown = JSON.parse(await fs.readFile(presencePath, "utf8"));
			if (
				typeof decoded !== "object" ||
				decoded === null ||
				!("pid" in decoded) ||
				typeof decoded.pid !== "number"
			) {
				await fs.rm(presencePath, { force: true });
				continue;
			}
			const mtimeMs = (await fs.stat(presencePath)).mtimeMs;
			const identity =
				"processIdentity" in decoded && typeof decoded.processIdentity === "string"
					? decoded.processIdentity
					: null;
			// Only a matching OS incarnation proves ownership. A live numeric PID
			// alone (including an unreadable identity) gets the 24-hour lease bound.
			const verified = identity !== null && getProcessStartIdentity(decoded.pid) === identity;
			if (
				daemonOwnerIsAlive(decoded, mtimeMs) &&
				(verified || (clock.now ?? Date.now)() - mtimeMs <= 24 * 60 * 60_000)
			) {
				live = true;
			} else await fs.rm(presencePath, { force: true });
		} catch (error) {
			if (!isEnoent(error)) await fs.rm(presencePath, { force: true });
		}
	}
	return live;
}

/** Retire only the stale record when an authenticated replacement serves this scope. */
async function retireDaemonBroker(runtimeDir: string, clock: BrokerLeaseClock): Promise<boolean> {
	const leasePath = daemonBrokerLeasePath(runtimeDir);
	let raw: unknown;
	let mtimeMs = (clock.now ?? Date.now)();
	try {
		const text = await fs.readFile(leasePath, "utf8");
		mtimeMs = (await fs.stat(leasePath)).mtimeMs;
		raw = JSON.parse(text);
	} catch (error) {
		if (!isEnoent(error) && !(error instanceof SyntaxError)) throw error;
	}
	const retirement = await daemonOwnerRetirement(runtimeDir, raw, mtimeMs, clock);
	if (retirement === "retire-record") await fs.rm(leasePath, { force: true });
	return retirement === "retire-scope";
}

/**
 * Remove sibling project daemon runtime directories whose broker is dead and
 * whose client-presence set is empty, reclaiming the disk that short-lived
 * project directories leave behind (issue #8674).
 *
 * Best-effort and non-throwing: a scope is deleted only when its `broker.pid`
 * is absent or has retirement evidence, no live client presence remains, and it has been untouched
 * for {@link DAEMON_RUNTIME_STALE_GRACE_MS}. The caller's own `currentRuntimeDir`
 * is always skipped, and the sweep runs only inside the {@link DAEMONS_DIR}
 * container over entries named like a {@link DAEMON_SCOPE_KEY} — so a runtime
 * dir relocated elsewhere (e.g. the smoke test under `os.tmpdir()`) never
 * reclaims unrelated neighbours (issue #8721).
 */
export async function pruneDeadDaemonRuntimeDirs(
	currentRuntimeDir: string,
	clock: BrokerLeaseClock = {},
): Promise<void> {
	const root = path.dirname(currentRuntimeDir);
	if (path.basename(root) !== DAEMONS_DIR) return;
	const current = path.resolve(currentRuntimeDir);
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to scan daemon runtime root for pruning", {
				root,
				error: errorMessage(error),
			});
		}
		return;
	}
	const now = (clock.now ?? Date.now)();
	for (const entry of entries) {
		if (!entry.isDirectory() || !DAEMON_SCOPE_KEY.test(entry.name)) continue;
		const dir = path.join(root, entry.name);
		if (path.resolve(dir) === current) continue;
		try {
			const stat = await fs.stat(dir);
			if (now - stat.mtimeMs < DAEMON_RUNTIME_STALE_GRACE_MS) continue;
			// Serialize the probe and retirement against broker lease publication.
			// Detach before releasing the lock so a starter can safely recreate the path.
			const retired = await tryWithFileLock(daemonBrokerLeasePath(dir), async () => {
				const observed = await fs.stat(dir);
				if (observed.dev !== stat.dev || observed.ino !== stat.ino) return null;
				if (!(await retireDaemonBroker(dir, clock))) return null;
				if (await hasLiveDaemonProjectPresence(dir, clock)) return null;
				const tombstone = path.join(root, `.retired-${entry.name}-${crypto.randomUUID()}`);
				await fs.rename(dir, tombstone);
				return tombstone;
			});
			if (retired.acquired && retired.value !== null) {
				await fs.rm(retired.value, { recursive: true, force: true });
			}
		} catch (error) {
			if (isEnoent(error)) continue;
			logger.warn("Failed to prune dead daemon runtime dir", {
				dir,
				error: errorMessage(error),
			});
		}
	}
}
