/**
 * Reads of discovery records: small JSON files a process publishes under the config root so a peer can
 * find a live session or terminal. A record counts as evidence only when the current user wrote it.
 * A single-record reader refuses unsafe records before parsing; the batch reader can discard explicit
 * non-matches from untrusted bytes, but verifies every record it returns.
 *
 * WHY: a record that is broadly readable or writable is not proof of ownership. Another local user can
 * plant one (a live pid, a socket path that answers), and a reader that trusts it refuses a session it
 * should open or routes a notice to a terminal that is not the user's.
 *
 * POSIX: the record is opened with `O_NOFOLLOW`, so a symlink is refused rather than followed, and with
 * `O_NONBLOCK`, so a FIFO is refused on its descriptor instead of blocking the open. Every check runs on
 * the open descriptor that is then read, so the file cannot change between check and read. Its containing
 * directory is separately lstat-checked as a real, owner-owned directory with no group or other access.
 * Refused: a non-regular file, a file owned by another uid, any group or other permission bit on the file
 * or its parent, and a process with no user id, because the owner then cannot be checked.
 * Windows: DOS device namespaces and reserved device basenames are refused before any file access. The
 * containing directory must be a real directory and pass the same protected owner-only DACL check as the
 * record. The file must not be a symbolic link. It is opened, its handle is checked for type and size, and
 * {@link verifyOwnerOnlyWindowsAcl} must pass on the path (protected DACL, one full-control allow ACE for
 * the current user, no reparse point). The path is then compared to the opened handle, so a file replaced
 * in between is refused before any byte is read, unless it is swapped back (see below).
 * WHAT IT DOES NOT CATCH: a process running as the same user, which may edit its own record; a record
 * another user deletes or renames over (the reader sees ENOENT or refuses the foreign file).
 *
 * WINDOWS RESIDUAL WINDOW: the handle is opened before the file ACL check, and the ACL is checked by path. A writer
 * that can rename within the record's directory can swap a file with a passing ACL in at the path during the
 * check, then swap the opened file back before the identity comparison. The comparison then passes for a file
 * whose ACL was never checked. The reader narrows that window and does not close it, and it claims no atomic
 * protection against that writer. The containing directory's owner-only DACL check helps keep a foreign user
 * from replacing the record at all.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isFsError } from "./fs-error";
import {
	verifyOwnerOnlyWindowsAcl,
	verifyOwnerOnlyWindowsAclSync,
	verifyOwnerOnlyWindowsAcls,
	type WindowsAclOptions,
} from "./windows-acl";

/** A discovery record is a few hundred bytes. A larger file is not one this build published. */
const MAX_DISCOVERY_RECORD_BYTES = 64 * 1024;

/**
 * POSIX open flags. `O_NOFOLLOW` refuses a symlink; `O_NONBLOCK` stops an open of a FIFO with no writer
 * from blocking, so the descriptor reaches the fstat check, which refuses it as not a regular file.
 */
const POSIX_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

export interface OwnerOnlyReadOptions {
	/** Defaults to `process.platform`. Injectable so the Windows branch runs on any host under test. */
	platform?: NodeJS.Platform;
	/** Forwarded to the Windows ACL check. `run` and `runSync` keep that check hermetic in tests. */
	windowsAcl?: WindowsAclOptions;
}

function refuse(filePath: string, reason: string): Error {
	return new Error(`Refusing discovery record ${filePath}: ${reason}`);
}

/** Windows interprets device namespaces, ADS, and reserved DOS names as non-file targets. */
function assertWindowsFilePath(filePath: string): void {
	const normalized = filePath.replace(/\//g, "\\");
	if (
		normalized.startsWith("\\\\?\\") ||
		normalized.startsWith("\\\\.\\") ||
		normalized.startsWith("\\??\\") ||
		normalized.startsWith("\\\\??\\")
	) {
		throw refuse(filePath, "Windows device path");
	}
	for (const segment of normalized.split("\\").filter(Boolean)) {
		if (segment.includes(":") && !/^[a-z]:$/i.test(segment)) {
			throw refuse(filePath, "Windows device path");
		}
		const name = segment.replace(/[ .]+$/g, "");
		const stem = name.split(".", 1)[0].replace(/[ .]+$/g, "");
		if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(stem)) {
			throw refuse(filePath, "Windows device path");
		}
	}
}

function assertParentStats(filePath: string, stats: fs.Stats, platform: NodeJS.Platform): void {
	if (stats.isSymbolicLink()) throw refuse(filePath, "parent directory is a symbolic link");
	if (!stats.isDirectory()) throw refuse(filePath, "parent path is not a directory");
	if (platform === "win32") return;
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid === undefined) throw refuse(filePath, "cannot check the owner: process.getuid is unavailable");
	if (stats.uid !== uid) throw refuse(filePath, "parent directory is owned by another user");
	if ((stats.mode & 0o077) !== 0) throw refuse(filePath, "parent directory is accessible by other users");
}

async function checkParent(filePath: string, platform: NodeJS.Platform, options: OwnerOnlyReadOptions): Promise<void> {
	const parentPath = path.dirname(filePath);
	assertParentStats(filePath, await fsp.lstat(parentPath), platform);
	if (platform === "win32") {
		await verifyOwnerOnlyWindowsAcl(parentPath, { ...options.windowsAcl, platform });
	}
}

function checkParentSync(filePath: string, platform: NodeJS.Platform, options: OwnerOnlyReadOptions): void {
	const parentPath = path.dirname(filePath);
	assertParentStats(filePath, fs.lstatSync(parentPath), platform);
	if (platform === "win32") {
		verifyOwnerOnlyWindowsAclSync(parentPath, { ...options.windowsAcl, platform });
	}
}

/** The rules both readers apply to the stats of the file they are about to parse. */
function assertRecordStats(filePath: string, stats: fs.Stats, platform: NodeJS.Platform): void {
	if (!stats.isFile()) throw refuse(filePath, "not a regular file");
	if (stats.size > MAX_DISCOVERY_RECORD_BYTES) throw refuse(filePath, "larger than a discovery record");
	// Windows ownership and ACL are decided by verifyOwnerOnlyWindowsAcl, not by POSIX mode bits.
	if (platform === "win32") return;
	// Fail closed: without a user id the owner cannot be checked, so the record is refused.
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid === undefined) throw refuse(filePath, "cannot check the owner: process.getuid is unavailable");
	if (stats.uid !== uid) throw refuse(filePath, "owned by another user");
	if ((stats.mode & 0o077) !== 0) throw refuse(filePath, "readable or writable by other users");
}

/** The descriptor opened after the Windows check must name the file that was checked. */
function assertSameFile(filePath: string, checked: fs.Stats, opened: fs.Stats): void {
	if (opened.dev !== checked.dev || opened.ino !== checked.ino) {
		throw refuse(filePath, "replaced while it was checked");
	}
}

/**
 * Read a discovery record that only the current user can have written. Rejects, and returns no content,
 * when the record is refused. A missing file rejects with its `ENOENT` error, as a plain read does.
 */
export async function readOwnerOnlyFile(filePath: string, options: OwnerOnlyReadOptions = {}): Promise<string> {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") assertWindowsFilePath(filePath);
	await checkParent(filePath, platform, options);
	if (platform === "win32") {
		// A symbolic link is refused before it is opened, so the open never follows one.
		if ((await fsp.lstat(filePath)).isSymbolicLink()) throw refuse(filePath, "is a symbolic link");
		const handle = await fsp.open(filePath, "r");
		try {
			const opened = await handle.stat();
			assertRecordStats(filePath, opened, platform);
			await verifyOwnerOnlyWindowsAcl(filePath, { ...options.windowsAcl, platform });
			assertSameFile(filePath, await fsp.lstat(filePath), opened);
			return await handle.readFile({ encoding: "utf8" });
		} finally {
			await handle.close();
		}
	}
	// O_NOFOLLOW reports a symlink as ELOOP; name that refusal instead of the raw errno.
	const handle = await fsp.open(filePath, POSIX_READ_FLAGS).catch(error => {
		throw isFsError(error) && error.code === "ELOOP" ? refuse(filePath, "is a symbolic link") : error;
	});
	try {
		assertRecordStats(filePath, await handle.stat(), platform);
		return await handle.readFile({ encoding: "utf8" });
	} finally {
		await handle.close();
	}
}

/**
 * Read sibling records, checking their parent once and batching Windows file ACL checks.
 * `couldMatch` sees UNTRUSTED bytes only to exclude explicit non-matches, never to accept an owner.
 * Malformed or ambiguous claims must remain candidates. Every returned record passes the file checks.
 * Discovery is a snapshot: a same-user writer can change a claim after any read.
 */
export async function readOwnerOnlyFiles(
	filePaths: readonly string[],
	couldMatch: (untrusted: string) => boolean,
	options: OwnerOnlyReadOptions = {},
): Promise<string[]> {
	if (filePaths.length === 0) return [];
	const platform = options.platform ?? process.platform;
	const parent = path.dirname(filePaths[0]);
	for (const filePath of filePaths) {
		if (path.dirname(filePath) !== parent) throw new Error("Discovery records must share a parent directory");
		if (platform === "win32") assertWindowsFilePath(filePath);
	}
	await checkParent(filePaths[0], platform, options);
	const candidates: Array<{ filePath: string; handle: fsp.FileHandle; stats: fs.Stats; content: string }> = [];
	try {
		for (const filePath of filePaths) {
			let handle: fsp.FileHandle | undefined;
			try {
				if (platform === "win32" && (await fsp.lstat(filePath)).isSymbolicLink()) {
					throw refuse(filePath, "is a symbolic link");
				}
				handle = await fsp.open(filePath, platform === "win32" ? "r" : POSIX_READ_FLAGS);
				const stats = await handle.stat();
				assertRecordStats(filePath, stats, platform);
				const content = await handle.readFile({ encoding: "utf8" });
				if (couldMatch(content)) {
					candidates.push({ filePath, handle, stats, content });
					handle = undefined;
				}
			} catch (error) {
				if (!isFsError(error) || error.code !== "ENOENT") throw error;
			} finally {
				await handle?.close();
			}
		}
		await verifyOwnerOnlyWindowsAcls(
			candidates.map(candidate => candidate.filePath),
			{ ...options.windowsAcl, platform },
		);
		for (const candidate of candidates) {
			assertSameFile(candidate.filePath, await fsp.lstat(candidate.filePath), candidate.stats);
		}
		return candidates.map(candidate => candidate.content);
	} finally {
		await Promise.all(candidates.map(candidate => candidate.handle.close()));
	}
}

/** Synchronous {@link readOwnerOnlyFile}, with the same refusals and the same missing-file error. */
export function readOwnerOnlyFileSync(filePath: string, options: OwnerOnlyReadOptions = {}): string {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") assertWindowsFilePath(filePath);
	checkParentSync(filePath, platform, options);
	if (platform === "win32") {
		// A symbolic link is refused before it is opened, so the open never follows one.
		if (fs.lstatSync(filePath).isSymbolicLink()) throw refuse(filePath, "is a symbolic link");
		const fd = fs.openSync(filePath, "r");
		try {
			const opened = fs.fstatSync(fd);
			assertRecordStats(filePath, opened, platform);
			verifyOwnerOnlyWindowsAclSync(filePath, { ...options.windowsAcl, platform });
			assertSameFile(filePath, fs.lstatSync(filePath), opened);
			return fs.readFileSync(fd, "utf8");
		} finally {
			fs.closeSync(fd);
		}
	}
	let fd: number;
	try {
		fd = fs.openSync(filePath, POSIX_READ_FLAGS);
	} catch (error) {
		// O_NOFOLLOW reports a symlink as ELOOP; name that refusal instead of the raw errno.
		throw isFsError(error) && error.code === "ELOOP" ? refuse(filePath, "is a symbolic link") : error;
	}
	try {
		assertRecordStats(filePath, fs.fstatSync(fd), platform);
		return fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}
