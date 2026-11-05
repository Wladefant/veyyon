/**
 * Git object readers for suites that compare the working tree against an approved commit.
 *
 * A suite reads an approved snapshot straight from the Git object database instead of committing
 * a copy of it as a fixture. Every reader rejects a commit missing from `BASELINE_COMMITS`, and
 * checks that the commit is reachable before reading it. CI checks out one commit deep and runs
 * `bun scripts/git-baseline.ts --fetch`, which fetches each listed commit without its history.
 */

import { execFileSync } from "node:child_process";
import { existingOnly, REPO_ROOT } from "./workspace-layout";

export { REPO_ROOT };

/** Every commit a suite reads from the object store, keyed by what the suite reads there. */
export const BASELINE_COMMITS = {
	/** The approved frozen tool renderers `packages/coding-agent/test/oracles/historical-loader.ts` reads. */
	oracleSnapshot: "81eee11283051f29967dbfc506b297d45fd375b1",
} as const;

const LISTED_COMMITS: ReadonlySet<string> = new Set(Object.values(BASELINE_COMMITS));

function hasCommit(repoRoot: string, commit: string): boolean {
	try {
		execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Asserts that the commit is listed in `BASELINE_COMMITS` and reachable in the local repository.
 * Throws with the corrective action when it is unlisted, or missing because the checkout is shallow.
 */
export function ensureBaselineAvailable(repoRoot: string, commit: string): void {
	if (!LISTED_COMMITS.has(commit)) {
		throw new Error(
			`The commit ${commit} is not listed in BASELINE_COMMITS.\n` +
				"Corrective action: add it to BASELINE_COMMITS in scripts/git-baseline.ts, so a shallow CI checkout fetches it.",
		);
	}
	if (!hasCommit(repoRoot, commit)) {
		throw new Error(
			`The commit ${commit} is not available in the local repository object store (it may be shallow or unfetched).\n` +
				"Corrective action: run 'bun scripts/git-baseline.ts --fetch' to fetch every baseline commit.",
		);
	}
}

/**
 * Fetches each of `commits` that is missing from the object store and returns the fetched ones. A
 * shallow repository fetches each commit one deep, so the history behind it stays out of the clone.
 */
export function fetchBaselineCommits(
	repoRoot: string = REPO_ROOT,
	commits: readonly string[] = [...LISTED_COMMITS],
): string[] {
	const missing = commits.filter(commit => !hasCommit(repoRoot, commit));
	if (missing.length === 0) return missing;
	const shallow =
		execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repoRoot, encoding: "utf-8" }).trim() ===
		"true";
	execFileSync("git", ["fetch", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", ...missing], {
		cwd: repoRoot,
		stdio: ["ignore", "inherit", "inherit"],
	});
	const unfetched = missing.filter(commit => !hasCommit(repoRoot, commit));
	if (unfetched.length > 0) {
		throw new Error(`git fetch from origin returned without the commits ${unfetched.join(", ")}.`);
	}
	return missing;
}

export interface GitTreeEntry {
	readonly mode: string;
	readonly type: "blob" | "commit" | "tree";
	readonly sha: string;
	readonly path: string;
}

/**
 * Lists all tracked files at the specified commit using `git ls-tree -r -z` for null-safe path extraction.
 * Enforces strict shape validation on all tree records, metadata columns, modes, and object hashes.
 */
export function readGitTree(commit: string, repoRoot: string = REPO_ROOT): Map<string, GitTreeEntry> {
	ensureBaselineAvailable(repoRoot, commit);
	const output = execFileSync("git", ["ls-tree", "-r", "-z", commit], {
		cwd: repoRoot,
		maxBuffer: 64 * 1024 * 1024,
	});

	const tree = new Map<string, GitTreeEntry>();
	let offset = 0;
	const len = output.length;

	while (offset < len) {
		const nulIdx = output.indexOf(0, offset);
		if (nulIdx === -1) {
			throw new Error(`Malformed git ls-tree -r -z output: incomplete entry at offset ${offset}`);
		}
		const entry = output.subarray(offset, nulIdx).toString("utf-8");
		offset = nulIdx + 1;

		const tabIdx = entry.indexOf("\t");
		if (tabIdx === -1) {
			throw new Error(`Malformed git ls-tree -r -z entry: missing tab separator in "${entry}"`);
		}

		const meta = entry.slice(0, tabIdx);
		const filePath = entry.slice(tabIdx + 1);
		if (filePath.length === 0) {
			throw new Error(`Malformed git ls-tree -r -z entry: empty path in "${entry}"`);
		}

		const parts = meta.split(" ");
		if (parts.length !== 3) {
			throw new Error(`Malformed git ls-tree -r -z metadata: "${meta}" in "${entry}"`);
		}

		const mode = parts[0] ?? "";
		const type = parts[1] ?? "";
		const sha = parts[2] ?? "";

		if (!/^\d{6}$/.test(mode)) {
			throw new Error(`Invalid mode "${mode}" in git ls-tree entry "${entry}"`);
		}
		if (type !== "blob" && type !== "tree" && type !== "commit") {
			throw new Error(`Invalid type "${type}" in git ls-tree entry "${entry}"`);
		}
		if (!/^[0-9a-f]{40}$/.test(sha)) {
			throw new Error(`Invalid sha "${sha}" in git ls-tree entry "${entry}"`);
		}

		tree.set(filePath, { mode, type, sha, path: filePath });
	}

	if (offset !== len) {
		throw new Error(`Malformed git ls-tree -r -z output: ${len - offset} trailing unparsed bytes`);
	}

	return tree;
}

/**
 * Reads a single file as Buffer from the specified commit.
 * Returns null if the path does not exist in the commit; throws on git execution errors.
 */
export function readGitFileBuffer(relativePath: string, commit: string, repoRoot: string = REPO_ROOT): Buffer | null {
	ensureBaselineAvailable(repoRoot, commit);
	try {
		return execFileSync("git", ["show", `${commit}:${relativePath}`], {
			cwd: repoRoot,
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (err: unknown) {
		const execError = err as { stderr?: Buffer; message?: string };
		const stderr = execError.stderr ? execError.stderr.toString("utf-8") : "";
		const isMissing =
			stderr.includes("does not exist in") ||
			stderr.includes("exists on disk, but not in") ||
			stderr.includes("not a valid object name") ||
			stderr.includes("path not found");
		if (isMissing) {
			return null;
		}
		throw new Error(
			`Failed to read git object ${commit}:${relativePath}: ${stderr || execError.message || String(err)}`,
		);
	}
}

/**
 * Reads a single file as string from the specified commit.
 * Returns null if the path does not exist in the commit; throws on git execution errors.
 */
export function readGitFileText(relativePath: string, commit: string, repoRoot: string = REPO_ROOT): string | null {
	const buffer = readGitFileBuffer(relativePath, commit, repoRoot);
	return buffer ? buffer.toString("utf-8") : null;
}

/**
 * Lists tracked files in the repository using null-safe git ls-files.
 */
export function listTrackedFiles(
	repoRoot: string = REPO_ROOT,
	paths?: string | readonly string[],
	flags: readonly string[] = ["--cached", "--others", "--exclude-standard"],
	maxBuffer = 64 * 1024 * 1024,
): string[] {
	const args = ["ls-files", "-z", ...flags];
	if (typeof paths === "string") {
		args.push("--", paths);
	} else if (Array.isArray(paths) && paths.length > 0) {
		args.push("--", ...paths);
	}
	try {
		const output = execFileSync("git", args, {
			cwd: repoRoot,
			maxBuffer,
		});
		return existingOnly(repoRoot, output.toString("utf-8").split("\0").filter(Boolean));
	} catch (error) {
		throw new Error(
			`Failed to enumerate files under "${typeof paths === "string" ? paths : Array.isArray(paths) ? paths.join(", ") : "."}" via git ls-files at ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length !== 1 || args[0] !== "--fetch") {
		process.stderr.write("Usage: bun scripts/git-baseline.ts --fetch\n");
		process.exit(2);
	}
	const fetched = fetchBaselineCommits();
	process.stdout.write(
		fetched.length === 0 ? "Every baseline commit is present.\n" : `Fetched ${fetched.join(", ")}.\n`,
	);
}
