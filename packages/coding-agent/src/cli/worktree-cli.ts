/**
 * CLI handler for `veyyon worktree` — list and clean up agent-managed worktrees.
 *
 * Layout under `~/.veyyon/wt/`:
 *
 *   - **PR-checkout worktrees** (`tools/web/gh.ts`): a regular git worktree dir
 *     containing a `.git` *file* that points back at
 *     `<parent-repo>/.git/worktrees/<name>/`.
 *   - **Task-isolation dirs** (`task/worktree.ts`): a wrapper dir with a
 *     compact `m` subdir mounted/cloned by `natives.isoStart`. Legacy `merged`
 *     subdirs are still recognized. Setup preserves occupied slots and only
 *     reclaims dead marker-only reservations.
 *
 * Legacy entries from before the encoding change keep working because git still
 * tracks them by branch name. This command exists to GC them on demand.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@veyyon/natives";
import { errorMessage, formatCount, getWorktreesDir, isEnoent, isProcessInstanceAlive } from "@veyyon/utils";
import chalk from "chalk";
import {
	ISOLATION_CLAIM_FILE,
	ISOLATION_OWNER_FILE,
	isAbandonedEmptyReservation,
	isolationClaimIsLive,
	RETAINED_BACKEND_FILE,
	readIsolationOwner,
	readRetainedMountBackend,
	tryWithIsolationLifecycleLock,
} from "../task/isolation-ownership";
import { isTaskIsolationDir } from "../task/worktree";
import * as git from "../utils/git";

type WorktreeKind = "pr-checkout" | "task-isolation" | "empty" | "stray";

const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

export interface WorktreeEntry {
	/** Absolute path to the worktree dir (or stray container) under `~/.veyyon/wt/`. */
	path: string;
	/** Classification of what we found on disk. */
	kind: WorktreeKind;
	/** Parent repo root, when this is a registered git worktree. */
	parentRepo?: string;
	/** Branch name extracted from the parent's tracking file, when available. */
	branch?: string;
	/** When set, the entry is unhealthy and `veyyon worktree clear` will remove it. */
	orphanReason?: string;
	/**
	 * When set, something on disk could not be READ, so this entry's health is unknown.
	 *
	 * Kept strictly separate from `orphanReason`: an entry with an unknown state must never be deleted, and
	 * `clear` selects its targets by `orphanReason` alone. The text names the path and the underlying error so
	 * the operator can fix the permission or remount the volume and re-run.
	 */
	undeterminedReason?: string;
}

// Keep scan identities out of the public JSON listing.
const scannedIdentity = new WeakMap<WorktreeEntry, Stats>();

export interface ListWorktreesOptions {
	json: boolean;
}

export interface ClearWorktreesOptions {
	/** Remove every entry, including live PR-checkout worktrees. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	json: boolean;
}

async function stopRetainedMount(dir: string): Promise<void> {
	if (await isolationClaimIsLive(dir)) throw new Error("Live isolation claim; workspace left intact.");
	const backend = await readRetainedMountBackend(dir);
	if (backend === undefined) return;
	if (backend === natives.IsoBackendKind.Projfs) {
		// Projfs stop owns process-local handles; a fresh CLI cannot stop a live projection.
		throw new Error("Cannot stop retained Projfs from this process; workspace left intact.");
	}
	let found = false;
	for (const name of TASK_ISOLATION_MOUNT_DIRS) {
		const candidate = path.join(dir, name);
		const stat = await fs.stat(candidate).catch(error => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (!stat?.isDirectory()) continue;
		await natives.isoStop(backend, candidate);
		found = true;
	}
	if (!found) {
		throw new Error("Retained isolation mount directory is missing; workspace left intact.");
	}
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(`No agent-managed worktrees found under ${getWorktreesDir()}.`));
		return;
	}
	let live = 0;
	let orphaned = 0;
	for (const entry of entries) {
		const tag = entry.orphanReason
			? chalk.yellow("orphaned")
			: entry.undeterminedReason
				? chalk.red("unknown ")
				: chalk.green("live    ");
		const detail = formatEntryDetail(entry);
		console.log(`${tag}  ${entry.path}`);
		if (detail) console.log(`          ${chalk.dim(detail)}`);
		if (entry.orphanReason) orphaned += 1;
		else live += 1;
	}
	console.log(chalk.dim(`\n${live} live · ${orphaned} orphaned · ${entries.length} total`));
}

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	const targets = options.all ? entries : entries.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		} else {
			console.log(chalk.dim(options.all ? "No worktrees to remove." : "No orphaned worktrees to remove."));
		}
		return;
	}

	if (options.dryRun) {
		if (options.json) {
			console.log(JSON.stringify({ wouldRemove: targets.map(t => t.path) }, null, 2));
		} else {
			for (const target of targets) {
				console.log(`${chalk.yellow("would remove")}  ${target.path}`);
			}
			console.log(chalk.dim(`\n${formatCount("dir", targets.length)} would be removed.`));
		}
		return;
	}

	const results: { path: string; ok: boolean; error?: string }[] = [];
	const parentsToPrune = new Set<string>();
	for (const target of targets) {
		try {
			if (target.kind === "pr-checkout" && target.parentRepo && !target.orphanReason) {
				// Live worktree: ask git to remove it cleanly. If git refuses (locked,
				// dirty, etc.), fall back to fs.rm and rely on `worktree prune` to
				// clean the bookkeeping on the parent side.
				const removed = await git.worktree.tryRemove(target.parentRepo, target.path, { force: true });
				if (!removed) {
					await fs.rm(target.path, { recursive: true, force: true });
					parentsToPrune.add(target.parentRepo);
				}
			} else if (target.kind === "task-isolation") {
				const lockResult = await tryWithIsolationLifecycleLock(target.path, async () => {
					const stat = await statPath(target.path);
					if (!stat?.found) return;
					const expected = scannedIdentity.get(target);
					if (
						!expected ||
						stat.found.dev !== expected.dev ||
						stat.found.ino !== expected.ino ||
						stat.found.birthtimeMs !== expected.birthtimeMs
					) {
						throw new Error("Isolation slot changed since scan; workspace left intact.");
					}

					if (await isAbandonedEmptyReservation(target.path)) {
						await fs.rm(target.path, { recursive: true, force: true });
						return;
					}
					const sidecarStat = await statPath(path.join(target.path, RETAINED_BACKEND_FILE));
					const hasSidecar = sidecarStat?.found?.isFile();
					const owner = await readIsolationOwner(target.path).catch(() => null);

					if (!hasSidecar) {
						if (owner && isProcessInstanceAlive(owner.pid, owner.startIdentity)) {
							throw new Error(
								`Missing retained backend metadata in ${target.path}; refusing removal (active live owner PID ${owner.pid})`,
							);
						}
						throw new Error(`Missing retained backend metadata in ${target.path}; refusing removal`);
					}
					const initialStat = stat.found;
					const initialToken = owner?.token;

					await stopRetainedMount(target.path);

					const currentStat = await statPath(target.path);
					if (!currentStat?.found) return;
					if (
						initialStat.ino !== 0 &&
						currentStat.found.ino !== 0 &&
						(currentStat.found.dev !== initialStat.dev || currentStat.found.ino !== initialStat.ino)
					) {
						throw new Error(
							`Isolation directory instance changed during cleanup: ${target.path}; refusing removal`,
						);
					}
					if (initialToken !== undefined) {
						const currentOwner = await readIsolationOwner(target.path).catch(() => null);
						if (currentOwner?.token !== initialToken) {
							throw new Error(
								`Isolation directory instance changed during cleanup: ${target.path}; refusing removal`,
							);
						}
					}

					await fs.rm(target.path, { recursive: true, force: true });
				});

				if (!lockResult.acquired) {
					throw new Error(
						`Missing retained backend metadata in ${target.path}; refusing removal (lock unavailable or workspace in use)`,
					);
				}
			} else {
				await fs.rm(target.path, { recursive: true, force: true });
				if (target.parentRepo) parentsToPrune.add(target.parentRepo);
			}
			results.push({ path: target.path, ok: true });
		} catch (err) {
			results.push({ path: target.path, ok: false, error: errorMessage(err) });
		}
	}

	// Best-effort: drop stale entries from each affected parent's `.git/worktrees/`.
	for (const parent of parentsToPrune) {
		try {
			await git.worktree.prune(parent);
		} catch {
			/* parent repo may already be gone or pruned — ignore */
		}
	}

	const succeeded = results.filter(r => r.ok).length;
	const failed = results.length - succeeded;

	if (options.json) {
		console.log(JSON.stringify({ removed: succeeded, failed, results }, null, 2));
		if (failed > 0) process.exitCode = 1;
		return;
	}

	for (const result of results) {
		if (result.ok) {
			console.log(`${chalk.green("removed")}  ${result.path}`);
		} else {
			console.log(`${chalk.red("failed ")}  ${result.path}`);
			if (result.error) console.log(`          ${chalk.dim(result.error)}`);
		}
	}
	console.log(chalk.dim(`\n${succeeded} removed${failed > 0 ? ` · ${chalk.red(`${failed} failed`)}` : ""}`));
	if (failed > 0) process.exitCode = 1;
}

// ───────────────────────────────────────────────────────────────────────────
// Scanner
// ───────────────────────────────────────────────────────────────────────────

async function scanWorktrees(): Promise<WorktreeEntry[]> {
	const root = getWorktreesDir();
	let topLevel: string[];
	try {
		topLevel = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: WorktreeEntry[] = [];
	for (const name of topLevel) {
		const dir = path.join(root, name);
		const stat = await statPath(dir);
		if (!stat) {
			// Unreadable, so its kind is unknown and it must not be swept. Surfaced, never dropped.
			entries.push({ path: dir, kind: "stray", undeterminedReason: `cannot stat ${dir}` });
			continue;
		}
		if (!stat.found?.isDirectory()) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			scannedIdentity.set(direct, stat.found);
			entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.veyyon/wt/<encoded-project>/<branch-or-id>
		let children: string[];
		try {
			children = await fs.readdir(dir);
		} catch {
			continue;
		}
		let nested = 0;
		for (const child of children) {
			const childDir = path.join(dir, child);
			const childStat = await statPath(childDir);
			if (!childStat) {
				entries.push({ path: childDir, kind: "stray", undeterminedReason: `cannot stat ${childDir}` });
				nested += 1;
				continue;
			}
			if (!childStat.found?.isDirectory()) continue;
			const childClassified = await classifyDir(childDir);
			if (childClassified) {
				entries.push(childClassified);
				scannedIdentity.set(childClassified, childStat.found);
				nested += 1;
			}
		}
		if (nested === 0) {
			entries.push({
				path: dir,
				kind: children.length === 0 ? "empty" : "stray",
				orphanReason: children.length === 0 ? "empty directory" : "no recognizable worktree contents",
			});
		}
	}
	return entries;
}

/**
 * Stat a path, distinguishing "not there" from "could not look".
 *
 * This distinction decides whether files get DELETED. `veyyon worktree clear` removes every entry that
 * carries an `orphanReason`, and each orphan verdict below is reached by failing to stat something: a
 * missing `.git`, a parent repo that no longer tracks the worktree, a parent repo that is gone. When a
 * blanket `.catch(() => null)` collapsed both cases, a stat that failed for any other reason -- EACCES on
 * the parent repo, or a network volume that was briefly unreachable, which is the normal state of a repo
 * living on a mount -- read as "missing", and a LIVE worktree was reported as "parent repo missing" and
 * then deleted. Returning `undefined` for the unreadable case lets each caller fail closed toward keeping
 * the user's files.
 */
async function statPath(target: string): Promise<{ found: Stats | null } | undefined> {
	try {
		return { found: await fs.stat(target) };
	} catch (error) {
		if (isEnoent(error)) return { found: null };
		return undefined;
	}
}

async function classifyDir(dir: string): Promise<WorktreeEntry | null> {
	// A slot mid-setup holds no mount dir yet; the process that claimed it owns it.
	if (await isolationClaimIsLive(dir)) return { path: dir, kind: "task-isolation" };
	const gitEntry = path.join(dir, ".git");
	const gitStat = await statPath(gitEntry);
	if (!gitStat) {
		return { path: dir, kind: "stray", undeterminedReason: `cannot stat ${gitEntry}` };
	}
	if (gitStat.found?.isFile()) {
		return classifyPrCheckout(dir, gitEntry);
	}
	const hasOwnerRecord = (await statPath(path.join(dir, ISOLATION_OWNER_FILE)))?.found?.isFile();
	const hasRetainedSidecar = (await statPath(path.join(dir, RETAINED_BACKEND_FILE)))?.found?.isFile();
	const hasClaimFile = (await statPath(path.join(dir, ISOLATION_CLAIM_FILE)))?.found?.isFile();
	if (isTaskIsolationDir(dir) || hasOwnerRecord || hasRetainedSidecar || hasClaimFile) {
		for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
			const mountPath = path.join(dir, mountDir);
			const mountStat = await statPath(mountPath);
			if (!mountStat) {
				return { path: dir, kind: "task-isolation", undeterminedReason: `cannot stat ${mountPath}` };
			}
		}
		return {
			path: dir,
			kind: "task-isolation",
			orphanReason: "task-isolation leftover (no live task owns it)",
		};
	}
	for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
		const mountPath = path.join(dir, mountDir);
		const mountStat = await statPath(mountPath);
		if (!mountStat) {
			return { path: dir, kind: "task-isolation", undeterminedReason: `cannot stat ${mountPath}` };
		}
		if (!mountStat.found?.isDirectory()) continue;
		return {
			path: dir,
			kind: "task-isolation",
			orphanReason: "task-isolation leftover (no live task owns it)",
		};
	}
	return null;
}

async function classifyPrCheckout(dir: string, gitEntry: string): Promise<WorktreeEntry> {
	let contents: string;
	try {
		contents = await fs.readFile(gitEntry, "utf8");
	} catch (err) {
		return {
			path: dir,
			kind: "pr-checkout",
			orphanReason: `cannot read .git file: ${errorMessage(err)}`,
		};
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
	const parentGitDir = match?.[1];
	if (!parentGitDir) {
		return { path: dir, kind: "pr-checkout", orphanReason: "malformed .git file (no gitdir line)" };
	}
	// parentGitDir is `<parent-repo>/.git/worktrees/<name>`; back out the repo root.
	const parentRepo = path.dirname(path.dirname(path.dirname(parentGitDir)));
	const branch = await readWorktreeBranch(path.join(parentGitDir, "HEAD"));

	const parentDirStat = await statPath(parentGitDir);
	if (!parentDirStat) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			undeterminedReason: `cannot stat ${parentGitDir}`,
		};
	}
	if (!parentDirStat.found?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo no longer tracks this worktree",
		};
	}
	const parentRepoStat = await statPath(parentRepo);
	if (!parentRepoStat) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			undeterminedReason: `cannot stat ${parentRepo}`,
		};
	}
	if (!parentRepoStat.found?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo missing",
		};
	}
	return { path: dir, kind: "pr-checkout", parentRepo, branch };
}

/**
 * The branch a worktree has checked out, or undefined when it has none to name.
 *
 * Undefined already covers a detached HEAD, which the regex declines to match, so a HEAD file that cannot
 * be read reaches the same answer the listing already handles by showing the worktree without a branch.
 * The worktree itself is still listed, which matters more: hiding it because its HEAD was unreadable
 * would leave a directory on disk that the tool claims does not exist.
 */
async function readWorktreeBranch(headFile: string): Promise<string | undefined> {
	try {
		const head = (await fs.readFile(headFile, "utf8")).trim();
		const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return refMatch?.[1];
	} catch {
		return undefined;
	}
}

function formatEntryDetail(entry: WorktreeEntry): string {
	const parts: string[] = [];
	if (entry.kind === "pr-checkout") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : "unknown repo";
		const branch = entry.branch ?? "unknown branch";
		parts.push(`${repo} · ${branch}`);
	} else if (entry.kind === "task-isolation") {
		parts.push("task-isolation sandbox");
	} else if (entry.kind === "empty") {
		parts.push("legacy project shell");
	} else {
		parts.push("unrecognized contents");
	}
	if (entry.orphanReason) parts.push(entry.orphanReason);
	if (entry.undeterminedReason) parts.push(entry.undeterminedReason);
	return parts.join(" — ");
}
