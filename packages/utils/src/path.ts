import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WINDOWS_DRIVE_EXTENDED_PREFIX = /^\\\\[?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_EXTENDED_PREFIX = /^\\\\[?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;
const WINDOWS_DRIVE_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/([A-Za-z]:\/.*)$/;
const WINDOWS_UNC_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/UNC\/([^/]+)\/(.+)$/i;
const WINDOWS_DRIVE_NT_PREFIX = /^\\\\[?][?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_NT_PREFIX = /^\\\\[?][?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;

/** Removes Win32 extended-length prefixes before passing paths to Bun APIs. */
export function stripWindowsExtendedLengthPathPrefix(
	filePath: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return filePath;

	const uncMatch = WINDOWS_UNC_EXTENDED_PREFIX.exec(filePath) ?? WINDOWS_UNC_NT_PREFIX.exec(filePath);
	if (uncMatch) return `\\\\${uncMatch[1]}\\${uncMatch[2]}`;

	const driveMatch = WINDOWS_DRIVE_EXTENDED_PREFIX.exec(filePath) ?? WINDOWS_DRIVE_NT_PREFIX.exec(filePath);
	if (driveMatch) return driveMatch[1];

	const forwardUncMatch = WINDOWS_UNC_EXTENDED_FORWARD_PREFIX.exec(filePath);
	if (forwardUncMatch) return `//${forwardUncMatch[1]}/${forwardUncMatch[2]}`;

	const forwardDriveMatch = WINDOWS_DRIVE_EXTENDED_FORWARD_PREFIX.exec(filePath);
	if (forwardDriveMatch) return forwardDriveMatch[1];

	return filePath;
}

/**
 * Whether a string was WRITTEN as a file path, judged without touching the disk.
 *
 * The question every "a path or the value itself?" option has to answer, and the
 * only honest way to answer it. Deciding by whether the file opens conflates two
 * different facts: `--system-prompt ./promtps/main.md` is a path with a typo in it,
 * and a reader that falls back to the literal string on `ENOENT` runs the agent with
 * a system prompt whose entire content is `./promtps/main.md` — no error, no warning,
 * and a prompt so short the model's behaviour changes completely. Asking about the
 * SHAPE first separates "you meant a file and it is not there" (an error naming the
 * path) from "you meant this text" (use it).
 *
 * A separator is decisive: no literal value contains `/` or `\` by accident. The
 * extension list is the caller's, because what looks like a filename is domain
 * knowledge — `.pem`/`.crt` for a certificate option, `.md`/`.txt` for a prompt —
 * and a shared list would either miss real filenames or claim ordinary prose.
 *
 * One owner because it was two: a private copy in the Anthropic provider decided it
 * for certificate options while prompt resolution had no shape check at all, so the
 * same class of typo was an error in one place and silent in the other.
 */
export function looksLikeFilePath(value: string, extensions: readonly string[] = []): boolean {
	if (value.includes("/") || value.includes("\\")) return true;
	if (extensions.length === 0) return false;
	const suffix = /\.([A-Za-z0-9]+)$/.exec(value)?.[1]?.toLowerCase();
	return suffix !== undefined && extensions.some(extension => extension.toLowerCase() === suffix);
}

/**
 * Expand a leading `~` to the home directory. Handles `~`, `~/x`, `~\x`
 * (Windows), and the bare `~name` form (joined under home). Everything else is
 * returned unchanged.
 */
export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return h + filePath.slice(1);
	}
	if (filePath.startsWith("~")) {
		return path.join(h, filePath.slice(1));
	}
	return filePath;
}

export function resolveEquivalentPath(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);
	try {
		return fs.realpathSync(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

export function normalizePathForComparison(inputPath: string): string {
	const resolvedPath = resolveEquivalentPath(inputPath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

export function pathIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The path from `root` down to `candidate`, or null when `candidate` is not under it.
 *
 * THE RELATIVE PATH IS TAKEN FROM THE CANDIDATE'S OWN SPELLING. Containment is decided on
 * `normalizePathForComparison`, which lowercases on Windows because that filesystem is
 * case-insensitive; the string handed back must not be, and it was. A project in
 * `C:\Users\dev\Projects\MyApp\Src` reported `myapp\src`, and that string is what the status
 * line paints and what a rule path is named by, so a Windows session read its own directories
 * in a case it had never used.
 */
export function relativePathWithinRoot(root: string, candidate: string): string | null {
	const resolvedRoot = resolveEquivalentPath(root);
	const resolvedCandidate = resolveEquivalentPath(candidate);
	const normalizedRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
	const normalizedCandidate = process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate;
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	// HOW DEEP, from the folded comparison; WHICH NAMES, from the candidate. Asking
	// `path.relative` for the answer over the resolved spellings is not enough: it folds case
	// on win32 and not on posix, so a root configured in one case and a directory on disk in
	// another walked up and back down (`../../Users/dev/Projects/MyApp`) wherever the platform
	// compares exactly. Containment is already settled above, so the tail is that many
	// segments off the end of the candidate.
	const depth = relative.split(PATH_SEPARATORS).filter(segment => segment !== "").length;
	if (depth === 0) return null;
	const segments = resolvedCandidate.split(PATH_SEPARATORS).filter(segment => segment !== "");
	return segments.slice(Math.max(0, segments.length - depth)).join(path.sep) || null;
}

/** Either platform's separator, since a resolved path may be spelled with either. */
const PATH_SEPARATORS = /[\\/]+/u;
