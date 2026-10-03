import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	errorMessage,
	getSessionsDir,
	getTerminalSessionsDir,
	isEnoent,
	logger,
	resolveEquivalentPath,
} from "@veyyon/utils";
import { getTerminalId } from "@veyyon/utils/ttyid";
import type { SessionStorage } from "./session-storage";

const migratedSessionRoots = new Set<string>();

/**
 * Merge or rename a legacy session directory into its canonical target.
 * Best effort: callers decide whether migration failures should surface.
 */
function migrateSessionDirPath(oldPath: string, newPath: string): void {
	try {
		fs.mkdirSync(newPath);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	if (!fs.lstatSync(newPath).isDirectory()) {
		throw new Error(`Session migration target is not a directory: ${newPath}`);
	}
	for (const file of fs.readdirSync(oldPath)) {
		const src = path.join(oldPath, file);
		const dst = path.join(newPath, file);
		if (fs.lstatSync(src).isDirectory()) {
			migrateSessionDirPath(src, dst);
			continue;
		}
		try {
			fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
			throw error;
		}
		// A writer can replace the source path after publication; retain its unowned copy.
	}
	if (fs.readdirSync(oldPath).length === 0) fs.rmdirSync(oldPath);
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
	const encoded = relative.replace(/[/\\:]/g, "-");
	return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

function getDefaultSessionDirName(cwd: string): { encodedDirName: string; hashedDirName: string; resolvedCwd: string } {
	const resolvedCwd = path.resolve(cwd);
	const canonicalCwd = resolveEquivalentPath(resolvedCwd);
	const home = os.homedir();
	const canonicalHome = resolveEquivalentPath(home);
	const tempRoot = os.tmpdir();
	const canonicalTempRoot = resolveEquivalentPath(tempRoot);
	const homeRelative = path.relative(canonicalHome, canonicalCwd);
	const tempRelative = path.relative(canonicalTempRoot, canonicalCwd);
	const inHome = homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative));
	const inTemp = tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative));
	const encodedDirName = inHome
		? encodeRelativeSessionDirName("-", homeRelative)
		: inTemp
			? encodeRelativeSessionDirName("-tmp", tempRelative)
			: encodeLegacyAbsoluteSessionDirName(canonicalCwd);
	// Recover the short-lived hashed layout without making it the active layout again.
	const scope = inHome ? "home" : inTemp ? "tmp" : "abs";
	const readable = path
		.basename(canonicalCwd)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	const digest = createHash("sha256").update(canonicalCwd.replaceAll("\\", "/")).digest("hex");
	return { encodedDirName, hashedDirName: `${scope}-${readable || "project"}-${digest}`, resolvedCwd };
}

/**
 * Migrate old `--<home-encoded>-*--` session dirs to the new `-*` format.
 * Runs once per sessions root on first access, best-effort.
 */
function migrateHomeSessionDirs(sessionsRoot: string): void {
	if (migratedSessionRoots.has(sessionsRoot)) return;
	migratedSessionRoots.add(sessionsRoot);

	const home = os.homedir();
	const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const oldPrefix = `--${homeEncoded}-`;
	const oldExact = `--${homeEncoded}--`;

	let entries: string[];
	try {
		entries = fs.readdirSync(sessionsRoot);
	} catch {
		return;
	}

	for (const entry of entries) {
		let remainder: string;
		if (entry === oldExact) {
			remainder = "";
		} else if (entry.startsWith(oldPrefix) && entry.endsWith("--")) {
			remainder = entry.slice(oldPrefix.length, -2);
		} else {
			continue;
		}

		const newName = remainder ? `-${remainder}` : "-";
		const oldPath = path.join(sessionsRoot, entry);
		const newPath = path.join(sessionsRoot, newName);

		try {
			migrateSessionDirPath(oldPath, newPath);
		} catch (error) {
			// The migration runs once per sessions root, so a failure here is permanent
			// for this process: the transcripts under the old name are never listed
			// again and the operator sees a session history that starts empty.
			logger.warn("Legacy session directory could not be migrated; its transcripts will not be listed", {
				from: oldPath,
				to: newPath,
				error: errorMessage(error),
			});
		}
	}
}

function migrateLegacyAbsoluteSessionDir(cwd: string, sessionDir: string, sessionsRoot: string): void {
	const legacyDir = path.join(sessionsRoot, encodeLegacyAbsoluteSessionDirName(cwd));
	if (legacyDir === sessionDir || !fs.existsSync(legacyDir)) return;

	try {
		migrateSessionDirPath(legacyDir, sessionDir);
	} catch (error) {
		// Same loss as migrateHomeSessionDirs: the transcripts stay under a directory
		// name nothing looks at again.
		logger.warn("Legacy absolute session directory could not be migrated; its transcripts will not be listed", {
			from: legacyDir,
			to: sessionDir,
			error: errorMessage(error),
		});
	}
}

export function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined {
	const currentDirName = path.basename(sessionDir);
	const { encodedDirName } = getDefaultSessionDirName(cwd);
	if (currentDirName !== encodedDirName && currentDirName !== encodeLegacyAbsoluteSessionDirName(cwd)) {
		return undefined;
	}
	return path.dirname(sessionDir);
}

/**
 * Compute the default session directory for a cwd.
 * Classifies cwd by canonical location so symlink/alias paths resolve to the
 * same home-relative or temp-root directory names as their real targets.
 */
export function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	const { encodedDirName, hashedDirName, resolvedCwd } = getDefaultSessionDirName(cwd);
	migrateHomeSessionDirs(sessionsRoot);
	const sessionDir = path.join(sessionsRoot, encodedDirName);
	const target = fs.lstatSync(sessionDir, { throwIfNoEntry: false });
	if (target && !target.isDirectory()) throw new Error(`Session directory is not a directory: ${sessionDir}`);
	migrateLegacyAbsoluteSessionDir(resolvedCwd, sessionDir, sessionsRoot);
	const hashedDir = path.join(sessionsRoot, hashedDirName);
	if (hashedDir !== sessionDir && fs.existsSync(hashedDir)) {
		try {
			migrateSessionDirPath(hashedDir, sessionDir);
		} catch (error) {
			logger.warn("Hashed session directory could not be migrated; its transcripts will not be listed", {
				from: hashedDir,
				to: sessionDir,
				error: errorMessage(error),
			});
		}
	}
	storage.ensureDirSync(sessionDir);
	return sessionDir;
}

// =============================================================================
// Terminal breadcrumbs: maps terminal (TTY) -> last session file for --continue
// =============================================================================

/**
 * Overwrite `file` with `content` unless it already holds exactly that, so
 * re-recording an unchanged pointer costs a read instead of a disk write.
 */
function writeIfChangedSync(file: string, content: string): void {
	try {
		if (fs.readFileSync(file, "utf8") === content) return;
	} catch {
		// Missing or unreadable: write it below.
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** Prefix for the optional cwd device+inode line in a terminal breadcrumb. */
const CWDSTAT_PREFIX = "cwdstat ";

export interface CwdIdentity {
	dev: string;
	ino: string;
}

/**
 * Snapshot the directory identity of `cwd` for later move detection.
 * A later path with the same device+inode is the same directory after rename.
 */
export function readCwdIdentity(cwd: string): CwdIdentity | undefined {
	try {
		const st = fs.statSync(path.resolve(cwd), { bigint: true });
		if (!st.isDirectory()) return undefined;
		return { dev: st.dev.toString(), ino: st.ino.toString() };
	} catch {
		return undefined;
	}
}

/**
 * True when `targetCwd` is the same directory that `cwdIdentity` was recorded
 * from — i.e. the project was renamed or moved, not merely deleted/unmounted.
 * Missing identity (legacy breadcrumb, or cwd absent at write time) is not evidence.
 */
export function hasPositiveMovedProjectEvidence(cwdIdentity: CwdIdentity | undefined, targetCwd: string): boolean {
	if (!cwdIdentity) return false;
	const target = readCwdIdentity(targetCwd);
	return target !== undefined && target.dev === cwdIdentity.dev && target.ino === cwdIdentity.ino;
}

function parseBreadcrumbExtras(lines: string[]): { fresh: boolean; cwdIdentity?: CwdIdentity } {
	let fresh = false;
	let cwdIdentity: CwdIdentity | undefined;
	for (const extra of lines.slice(2)) {
		if (extra === "fresh") fresh = true;
		else if (extra.startsWith(CWDSTAT_PREFIX)) {
			const [dev, ino] = extra.slice(CWDSTAT_PREFIX.length).split(" ");
			if (dev && ino) cwdIdentity = { dev, ino };
		}
	}
	return { fresh, cwdIdentity };
}

/**
 * Write a breadcrumb linking the current terminal to a session file.
 * The breadcrumb contains the cwd and session path so --continue can
 * find "this terminal's last session" even when running concurrent instances.
 *
 * When `cwd` exists, the breadcrumb also records its device+inode so
 * `--continue` can tell a rename/move from a deleted or unmounted path.
 */
export function writeTerminalBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
	const terminalId = getTerminalId();
	if (!terminalId) return;

	const breadcrumbDir = getTerminalSessionsDir();
	const breadcrumbFile = path.join(breadcrumbDir, terminalId);
	const extras: string[] = [];
	if (fresh) extras.push("fresh");
	const identity = readCwdIdentity(cwd);
	if (identity) extras.push(`${CWDSTAT_PREFIX}${identity.dev} ${identity.ino}`);
	const extraBlock = extras.length > 0 ? `${extras.join("\n")}\n` : "";
	const content = `${cwd}\n${sessionFile}\n${extraBlock}`;
	// Synchronous + best-effort. Infrequent (session create/switch/reset, never
	// per-append), and writing in order matters: a lazy `/new` fresh crumb is
	// re-stamped non-fresh the instant the session materializes, so an async
	// fire-and-forget could land the two writes out of order and leave a
	// materialized session marked fresh. Re-recording the same session (resume,
	// cwd re-adoption) leaves an identical crumb alone instead of rewriting it.
	try {
		writeIfChangedSync(breadcrumbFile, content);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb write failed", { err });
	}
}

export interface TerminalBreadcrumb {
	cwd: string;
	sessionFile: string;
	/** The recorded session file exists on disk right now. */
	exists: boolean;
	/** Recorded as a `/new` fresh-session boundary whose JSONL may not exist yet. */
	fresh: boolean;
	/** Device+inode of `cwd` when the breadcrumb was written, if that path existed. */
	cwdIdentity?: CwdIdentity;
}

/**
 * Read the raw terminal breadcrumb for the current terminal.
 * Returns the recorded cwd + session file (verified to exist) regardless of
 * whether the recorded cwd still matches the current one. Callers decide how
 * to interpret a cwd mismatch (e.g. a moved/renamed worktree).
 */
export async function readTerminalBreadcrumbEntry(): Promise<TerminalBreadcrumb | null> {
	const terminalId = getTerminalId();
	if (!terminalId) return null;

	try {
		const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
		const content = await Bun.file(breadcrumbFile).text();
		const lines = content.replace(/\r/g, "").trim().split("\n");
		if (lines.length < 2) return null;

		const breadcrumbCwd = lines[0];
		const sessionFile = lines[1];

		const { fresh, cwdIdentity } = parseBreadcrumbExtras(lines);

		const stat = fs.statSync(sessionFile, { throwIfNoEntry: false });
		const exists = stat?.isFile() === true;
		// A materialized target resumes normally; a missing target is honored only
		// for a fresh `/new` boundary (never-written lazy session).
		if (exists || fresh) return { cwd: breadcrumbCwd, sessionFile, exists, fresh, cwdIdentity };
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		// Breadcrumb doesn't exist or is corrupt — fall through
	}
	return null;
}
