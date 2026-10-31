/**
 * Resolution of a read path to a file on disk: the literal path, then a unique suffix match within
 * the working directory, and the archive and SQLite candidates a path with a member suffix names.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "@veyyon/natives";
import { isAbortError, isTimeoutError, untilAborted } from "@veyyon/utils/abortable";
import { getRemoteDir } from "@veyyon/utils/dirs";
import { isMissingPath, nonRegularKind } from "@veyyon/utils/fs-error";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { parseArchivePathCandidates } from "../../utils/zip";
import { resolveReadPath } from "../core/path-utils";
import { isSqliteFile, parseSqlitePathCandidates } from "../core/sqlite-reader";
import { ToolError, throwIfAborted } from "../core/tool-errors";

// Remote mount path prefix (sshfs mounts) - skip fuzzy matching to avoid
// hangs. Resolved per call, not frozen at module load: the dirs resolver is
// rebuilt after profile/agent `.env` files apply, AFTER this module imports.
function isRemoteMountPath(absolutePath: string): boolean {
	return absolutePath.startsWith(getRemoteDir() + path.sep);
}

const GLOB_TIMEOUT_MS = 5000;

/**
 * Escape glob metacharacters so a literal path (e.g. `foo[1].ts`) interpolated
 * into a suffix-glob pattern matches itself. Each metachar is wrapped in a
 * character class (the native glob engine rewrites `\` to `/`, so backslash
 * escaping is unavailable). `]`/`}` need no escaping once their openers are
 * neutralized — unmatched closers are literal.
 */
function escapeGlobMetachars(value: string): string {
	return value.replace(/[*?[{]/g, "[$&]");
}

/** The one path a suffix search found. */
interface SuffixMatch {
	absolutePath: string;
	displayPath: string;
}

/**
 * Attempt to resolve a non-existent path by finding a unique suffix match within the workspace.
 * Uses a glob suffix pattern so the native engine handles matching directly.
 * Returns null when 0 or >1 candidates match (ambiguous = no auto-resolution), or when the walk
 * outlasts `timeoutMs`.
 */
async function findUniqueSuffixMatch(
	rawPath: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<SuffixMatch | null> {
	const normalized = trimTrailingSlashes(rawPath.replace(/\\/g, "/").replace(/^\.\//, ""));
	if (!normalized) return null;
	const pattern = `**/${escapeGlobMetachars(normalized)}`;

	// scopedTimeoutSignal cancels the backing timer on settle, so the glob
	// timeout never outlives the walk (a bare AbortSignal.timeout would keep its
	// timer armed for the full window and accumulate under load). The native
	// walk takes the signal too: racing the promise alone returned at the
	// deadline and left the walk running to the end of the tree, so every miss
	// in a large working directory kept a walker busy in the background.
	const { signal: combinedSignal, cancel } = scopedTimeoutSignal(timeoutMs, signal);

	let matches: string[];
	try {
		const result = await untilAborted(combinedSignal, () =>
			glob({
				pattern,
				path: cwd,
				// No fileType filter: matches both files and directories
				hidden: true,
				// Two matches already make the suffix ambiguous, so no more are returned.
				maxResults: 2,
				signal: combinedSignal,
			}),
		);
		matches = result.matches.map(m => m.path);
	} catch (error) {
		// The suffix search is a convenience, so a deadline on it is not the
		// caller's problem: give up silently and let the path resolve as missing.
		// A real cancellation is the caller's problem and must propagate with its
		// reason, so the operator learns why the read stopped rather than reading
		// the generic sentinel.
		//
		// This used to ask `isAbortError` and then infer which of the two had
		// happened from `!signal?.aborted`, because `AbortError` stamped its own
		// name over the `TimeoutError` reason and the guard could not see a
		// timeout as one. The error now carries its own name, so the question is
		// asked directly.
		if (isTimeoutError(error)) return null;
		if (isAbortError(error)) throwIfAborted(signal, "read");
		return null;
	} finally {
		cancel();
	}

	if (matches.length !== 1) return null;

	return {
		absolutePath: path.resolve(cwd, matches[0]),
		displayPath: matches[0],
	};
}

export function prependSuffixResolutionNotice(text: string, suffixResolution?: { from: string; to: string }): string {
	if (!suffixResolution) return text;

	const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
	return text ? `${notice}\n${text}` : notice;
}

export interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
}

export interface ResolvedSqliteReadPath {
	absolutePath: string;
	sqliteSubPath: string;
	queryString: string;
	suffixResolution?: { from: string; to: string };
}

/** A path found on disk, with the suffix match that found it when the literal path was missing. */
export type ResolvedReadPath = {
	absolutePath: string;
	stat: Stats;
	suffixResolution?: { from: string; to: string };
};

/**
 * The suffix searches of one read call. Each path is searched once, a miss recorded as `null`, so
 * the archive, SQLite and plain-path stages of one path share it. Every search shares one
 * {@link GLOB_TIMEOUT_MS} limit counted from the first: a working directory too large to search in
 * that time is searched for 5 s per read, not 5 s for each path of a list that misses.
 */
export class SuffixSearch {
	readonly #matches = new Map<string, SuffixMatch | null>();
	#deadline: number | undefined;

	async find(cwd: string, rawPath: string, signal?: AbortSignal): Promise<SuffixMatch | null> {
		const hit = this.#matches.get(rawPath);
		if (hit !== undefined) return hit;
		this.#deadline ??= performance.now() + GLOB_TIMEOUT_MS;
		const remaining = this.#deadline - performance.now();
		const match = remaining > 0 ? await findUniqueSuffixMatch(rawPath, cwd, remaining, signal) : null;
		this.#matches.set(rawPath, match);
		return match;
	}
}

/**
 * Reject a resolved read path that is neither a regular file nor a directory, before anything opens it.
 *
 * Opening a named pipe blocks until a writer opens the other end, and a character device such as a
 * terminal blocks until input arrives, so reading one held the turn with no end. A socket cannot be
 * opened at all. The stat follows symbolic links, so a link to one of these is rejected the same way.
 * The rejection propagates from every caller, the archive, SQLite and PDF member probes included: it
 * is a definite answer about the named path, not a stat failure the next probe may route around.
 */
function assertOpenable(stat: Stats, displayPath: string): void {
	if (stat.isFile() || stat.isDirectory()) return;
	throw new ToolError(
		`Path '${displayPath}' is ${nonRegularKind(stat)}, not a file or directory. read opens only regular files and directories, because opening a pipe, socket or device can block indefinitely. Read it through bash with a timeout instead.`,
	);
}

export async function statCandidateWithSuffix(
	cwd: string,
	rawPath: string,
	suffixSearch: SuffixSearch,
	signal?: AbortSignal,
	options: { throwNonMissing?: boolean } = {},
): Promise<ResolvedReadPath | null> {
	const absolutePath = resolveReadPath(rawPath, cwd);
	let stat: Stats;
	try {
		stat = await fs.stat(absolutePath);
	} catch (error) {
		if (!isMissingPath(error)) {
			if (options.throwNonMissing) throw error;
			return null;
		}
		if (isRemoteMountPath(absolutePath)) return null;
		const suffixMatch = await suffixSearch.find(cwd, rawPath, signal);
		if (!suffixMatch) return null;
		let suffixStat: Stats;
		try {
			suffixStat = await fs.stat(suffixMatch.absolutePath);
		} catch (retryError) {
			if (!isMissingPath(retryError)) throw retryError;
			return null;
		}
		assertOpenable(suffixStat, suffixMatch.displayPath);
		return {
			absolutePath: suffixMatch.absolutePath,
			stat: suffixStat,
			suffixResolution: { from: rawPath, to: suffixMatch.displayPath },
		};
	}
	assertOpenable(stat, rawPath);
	return { absolutePath, stat };
}

export async function resolveArchiveReadPath(
	cwd: string,
	readPath: string,
	suffixSearch: SuffixSearch,
	signal?: AbortSignal,
): Promise<ResolvedArchiveReadPath | null> {
	for (const candidate of parseArchivePathCandidates(readPath)) {
		const resolved = await statCandidateWithSuffix(cwd, candidate.archivePath, suffixSearch, signal);
		if (resolved && !resolved.stat.isDirectory()) {
			return {
				absolutePath: resolved.absolutePath,
				archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
				suffixResolution: resolved.suffixResolution,
			};
		}
	}
	return null;
}

export async function resolveSqliteReadPath(
	cwd: string,
	readPath: string,
	suffixSearch: SuffixSearch,
	signal?: AbortSignal,
): Promise<ResolvedSqliteReadPath | null> {
	for (const candidate of parseSqlitePathCandidates(readPath)) {
		const resolved = await statCandidateWithSuffix(cwd, candidate.sqlitePath, suffixSearch, signal);
		if (resolved && !resolved.stat.isDirectory() && (await isSqliteFile(resolved.absolutePath))) {
			return {
				absolutePath: resolved.absolutePath,
				sqliteSubPath: candidate.subPath,
				queryString: candidate.queryString,
				suffixResolution: resolved.suffixResolution,
			};
		}
	}
	return null;
}
