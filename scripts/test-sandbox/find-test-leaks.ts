#!/usr/bin/env bun
// Reports which test files leave process-global state changed behind them.
//
// Usage:
//   bun scripts/test-sandbox/find-test-leaks.ts packages/coding-agent/test        # a directory
//   bun scripts/test-sandbox/find-test-leaks.ts packages/utils/test/profiles.test.ts
//   bun scripts/test-sandbox/find-test-leaks.ts --json hosts/terminal/engine/test
//
// Why this exists: a full `bun test` run showed roughly twenty failures that
// vanished when the same files ran alone, and the count moved between runs
// (twenty, then thirty-three). All the files share one process, so a suite that
// sets `VEYYON_CONFIG_DIR`, `HOME`, or the working directory and does not restore
// it hands its roots to every file scheduled after it. The failures land on the
// victims, so reading the failing files finds nothing.
//
// Each file is run in its own process with `packages/utils/test/helpers/
// global-state-leak-tracer.ts` preloaded, which compares the tracked globals
// before and after every test. A file that leaks against its own process baseline
// leaks wherever it is scheduled, so the answer does not depend on run order.
//
// Exit code is 1 when any file leaks OR when any file could not be run, and 2
// when the walk found nothing to check, so this can be a gate: a run that
// measured nothing must never read as a clean tree.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { LEAK_FILE_ENV, type LeakReport, parseLeaks } from "../../packages/utils/test/helpers/global-state-leak-tracer";
import { testPreloadArgs } from "../test-preloads";
import { packagesWithTests, typeScriptMembersOf } from "../workspace-layout";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TRACER = "packages/utils/test/helpers/global-state-leak-preload.ts";
/** Lines of a failing run's own output the report echoes. Enough for a bun failure block. */
const FAILURE_TAIL_LINES = 40;

/**
 * Directories never walked, whatever they contain. `fixtures` holds deliberately broken
 * files that are inputs to tests, not tests.
 */
const SKIP_DIRS = new Set(["node_modules", "fixtures"]);

/**
 * True when git ignores the path, so it is not ours to check.
 *
 * This matters at the top of a tree: `tests/evals/datasets/repo-cache` is a gitignored
 * cache of CLONED EXTERNAL REPOSITORIES and it holds 3,332 `.test.ts` files — more than
 * twice the whole veyyon suite. Walking it would spend hours running other projects'
 * tests and report their leaks as ours. Asking git rather than growing a name list means
 * the next gitignored cache is excluded the day it appears.
 */
function isGitIgnored(repoRoot: string, absPath: string): boolean {
	const run = spawnSync("git", ["check-ignore", "-q", absPath], { cwd: repoRoot });
	// 0 = ignored, 1 = not ignored, 128 = not a git repo (then nothing is ignored).
	return run.status === 0;
}

/** Test files under a path, or the path itself when it is already a test file. */
export function testFilesUnder(repoRoot: string, target: string): string[] {
	const abs = path.resolve(repoRoot, target);
	if (!fs.existsSync(abs)) throw new Error(`no such path: ${target}`);
	// An explicitly named file is always checked, ignored or not: the caller asked for it.
	if (fs.statSync(abs).isFile()) return [path.relative(repoRoot, abs)];

	const found: string[] = [];
	const stack = [abs];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				if (isGitIgnored(repoRoot, full)) {
					// Loud, not silent: a skipped subtree is coverage this run does not have.
					console.error(`skipping gitignored directory: ${path.relative(repoRoot, full)}`);
					continue;
				}
				stack.push(full);
				continue;
			}
			if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
				found.push(path.relative(repoRoot, full));
			}
		}
	}
	return found.sort();
}

export interface FileResult {
	file: string;
	leaks: LeakReport[];
	/** True when the runner itself failed (a crash, not a leak). */
	runnerFailed: boolean;
	/** Why there is no verdict, when `runnerFailed`. Absent otherwise. */
	failure?: RunFailure;
	/**
	 * The failing run's own output, when `runnerFailed`. Absent otherwise.
	 *
	 * Without it the gate names a file and nothing else, and a failure that only
	 * happens under CI's nesting cannot be read at all: the reader has to guess
	 * the conditions and try to reproduce them, which is how one red suite cost a
	 * full CI cycle to identify. The child already produced the answer.
	 */
	output?: string;
}

/**
 * The two ways a file leaves the sweep with no verdict, which need different work.
 *
 * `did-not-load` is the tool's own problem to report: an import threw, the native
 * addon is missing, the process died before any test ran. `tests-failed` is a red
 * suite, and the tree it belongs to is broken for reasons that have nothing to do
 * with leaks.
 *
 * The distinction is worth carrying because reading one as the other sends the
 * reader to the wrong place. Eight `scripts` suites reported "could not run" for
 * two nightly sweeps in a row while every one of them loaded and ran perfectly
 * well: their assertions were failing, three of them were named by no runner at
 * all, and the sweep was the only job looking. A reader who trusts the message
 * goes hunting for a missing dependency instead of reading the assertion.
 */
export type RunFailure = "did-not-load" | "tests-failed";

/**
 * Which of the two a non-zero run was, from what bun printed.
 *
 * A per-test result line (`(pass)`, `(fail)`, `(skip)`, `(todo)`) is only printed
 * once bun has collected the file's tests and started running them, so one is
 * proof the file loaded. The summary counts are NOT that proof: a module whose
 * import throws is counted as `1 fail` with no test having run at all, which is
 * exactly the pair this function has to keep apart.
 */
export function classifyRunFailure(output: string): RunFailure {
	return /^\s*\((?:pass|fail|skip|todo)\)/m.test(output) ? "tests-failed" : "did-not-load";
}

/**
 * The directory, relative to the repository root, that the suite runner starts a file's test
 * process in: the workspace member holding the file, or the root (`""`) for a file no
 * member holds, such as a `scripts/` suite. Bun reads `bunfig.toml` from the cwd only, so tracing
 * from anywhere else runs the file under another directory's preloads and path filters: the root's
 * `pathIgnorePatterns` excludes `clients/python/**`, and a suite there traced from the root matched
 * no test file at all.
 */
export function runDirectory(repoRoot: string, file: string): string {
	const posix = file.split(path.sep).join("/");
	return typeScriptMembersOf(repoRoot).find(member => posix.startsWith(`${member}/`)) ?? "";
}

/**
 * `--preload` arguments for the probes the traced file's own member contributes.
 *
 * The tracer probes `@veyyon/utils` state and nothing else, deliberately: importing a
 * heavier package into every traced process risks the diagnostic initialising the very
 * state it is supposed to observe. So the dependency is inverted. A member that owns
 * module-global state worth watching drops a `test/helpers/leak-probes.ts` that calls
 * `registerLeakProbe`, and it is loaded only when tracing a file from that member.
 * The tracer never learns which members exist.
 *
 * Empty when the member has no probes file, which is the common case.
 */
function memberProbePreloadArgs(repoRoot: string, member: string): string[] {
	if (member === "") return [];
	const probes = path.join(repoRoot, member, "test", "helpers", "leak-probes.ts");
	return fs.existsSync(probes) ? ["--preload", probes] : [];
}

/** The `bun` invocation that traces one file. */
export interface TraceCommand {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/**
 * The command that runs one test file with the tracer preloaded.
 *
 * The process starts in the directory the suite runner uses ({@link runDirectory}) with the
 * preloads the runner passes every test process, so a traced file sees the configuration its own
 * run sees.
 *
 * The target is passed as an ABSOLUTE path. A bare relative path is a FILTER to
 * `bun test`, matched against the names of the files it discovers, and discovery
 * only picks up names containing `.test`/`.spec` — so a file named
 * `leaky-suite.fixture.ts` matched nothing and the run reported "did not match
 * any test files" instead of tracing it. An absolute (or `./`-prefixed) path is
 * treated as a path and runs whatever its name is, which is what lets the
 * deliberate-leak fixtures live outside the `*.test.ts` glob where an ordinary
 * `bun test <dir>` cannot collect them.
 */
export function traceCommand(repoRoot: string, file: string): TraceCommand {
	const member = runDirectory(repoRoot, file);
	return {
		// Absolute preload paths: bun resolves a bare relative path as a package
		// specifier and reports "preload not found".
		//
		// Member probes load BEFORE the tracer, because the tracer takes its baseline
		// snapshot at import and a probe registered afterwards would be absent from the
		// `before` side and read as a change the moment it first appeared.
		args: [
			"test",
			...testPreloadArgs,
			...memberProbePreloadArgs(repoRoot, member),
			"--preload",
			path.join(repoRoot, TRACER),
			path.resolve(repoRoot, file),
		],
		cwd: path.join(repoRoot, member),
		// The tracer reads the file name from the environment because Bun exposes no
		// current-test path to a hook.
		env: { ...process.env, [LEAK_FILE_ENV]: file },
	};
}

/** The verdict on one traced file, from its exit status and its combined stdout and stderr. */
export function traceResult(file: string, status: number | null, output: string): FileResult {
	const leaks = parseLeaks(output);
	// A non-zero exit with no leak lines means the file failed for its own
	// reasons. Reported rather than swallowed: a file whose tests do not run
	// tells this tool nothing about whether it leaks, and calling that "clean"
	// would be a silent skip.
	const runnerFailed = status !== 0 && leaks.length === 0;
	return {
		file,
		leaks,
		runnerFailed,
		...(runnerFailed ? { failure: classifyRunFailure(output), output } : {}),
	};
}

/** Runs one test file with the tracer preloaded and collects its leak lines. */
export function traceFile(repoRoot: string, file: string): FileResult {
	const { args, cwd, env } = traceCommand(repoRoot, file);
	const run = spawnSync("bun", args, { cwd, encoding: "utf8", env });
	return traceResult(file, run.status, `${run.stdout ?? ""}\n${run.stderr ?? ""}`);
}

/**
 * The directories `--workspace` walks: every workspace member that ships tests, then the
 * repo-level suites under `scripts/`. Resolved from the member list, so a member that lands under
 * a new top-level directory is swept from the commit that declares it.
 */
export function workspaceSweepRoots(repoRoot: string = REPO_ROOT): string[] {
	return [...packagesWithTests(repoRoot), "scripts"];
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const asJson = args.includes("--json");
	const targets = [
		...(args.includes("--workspace") ? workspaceSweepRoots() : []),
		...args.filter(arg => !arg.startsWith("--")),
	];
	if (targets.length === 0) {
		console.error("usage: bun scripts/test-sandbox/find-test-leaks.ts [--json] (--workspace | <file-or-directory>…)");
		process.exit(2);
	}

	// A member nested inside another is walked from both roots; each file is traced once.
	const files = [...new Set(targets.flatMap(target => testFilesUnder(REPO_ROOT, target)))];
	// A walk that found nothing measured nothing. The nightly sweep walks every member, so a
	// SKIP_DIRS entry that grows too far, a gitignore change, or a moved tree collapses the file
	// list, and reporting "checked 0 file(s)" with exit 0 says the tree is clean when nothing was
	// looked at. Explicit file targets always yield a file, so this only fires on a directory that
	// really holds no suites.
	if (files.length === 0) {
		console.error(`no test files under ${targets.join(", ")}: this run checked nothing`);
		process.exit(2);
	}

	const results: FileResult[] = [];
	for (const [index, file] of files.entries()) {
		const result = traceFile(REPO_ROOT, file);
		results.push(result);
		const state = result.leaks.length > 0 ? `LEAKS (${result.leaks.length})` : result.runnerFailed ? "FAILED" : "ok";
		console.error(`[${index + 1}/${files.length}] ${state}  ${file}`);
	}

	const leaking = results.filter(result => result.leaks.length > 0);
	const failed = results.filter(result => result.runnerFailed);

	if (asJson) {
		console.log(JSON.stringify({ checked: files.length, leaking, failed: failed.map(f => f.file) }, null, 2));
	} else {
		console.log(`\nchecked ${files.length} file(s): ${leaking.length} leaking, ${failed.length} failed to run`);
		for (const result of leaking) {
			console.log(`\n${result.file}`);
			for (const leak of result.leaks) {
				for (const diff of leak.diffs) {
					console.log(`  left behind  ${diff.key}: ${diff.before ?? "(unset)"} -> ${diff.after ?? "(unset)"}`);
				}
				// The per-test trail, so the file's own tests can be read in the right
				// order rather than top to bottom looking for a mutation.
				for (const move of leak.moves) {
					for (const diff of move.diffs) {
						console.log(`    first changed by test #${move.testIndex}: ${diff.key}`);
					}
				}
			}
		}
		for (const result of failed) {
			console.log(
				result.failure === "tests-failed"
					? `\nloaded, but its own tests failed (no leak verdict): ${result.file}`
					: `\ncould not load (no leak verdict): ${result.file}`,
			);
			// The child's own words, indented so the report stays readable. A tail
			// rather than everything: a red suite prints every passing test first,
			// and the reason is always at the end.
			const tail = (result.output ?? "").trimEnd().split("\n").slice(-FAILURE_TAIL_LINES);
			for (const line of tail) console.log(`  | ${line}`);
		}
	}

	// A file that could not RUN has no leak verdict, and the exit code used to call
	// that clean: a suite with an import error printed "1 failed to run" and exited
	// 0. Both gates built on this script, ci.yml's per-commit `test_leaks` and the
	// nightly sweep, therefore reported green for a tree where the suites never loaded,
	// which is precisely the state the sweep exists to notice. `runnerFailed` is
	// already computed and already printed; the exit code just has to agree.
	process.exit(leaking.length > 0 || failed.length > 0 ? 1 : 0);
}
