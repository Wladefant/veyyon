/**
 * Whole-project diagnostics: the project type read from its root markers, and its checker run in the
 * project root.
 */

import path from "node:path";
import { pathExists, ptree, trimTrailingSlashes } from "@veyyon/utils";
import { adoptIntoPrimarySessionCpuBudget } from "../session/cpu-limit";
import { ToolAbortError, throwIfAborted } from "../tools/core/tool-errors";

/** Project type detection result */
interface ProjectType {
	type: "rust" | "typescript" | "go" | "python" | "unknown";
	command?: string[];
	description: string;
}

/** Convert a `go.work` use directory into the package pattern `go build` needs. */
function goWorkspaceBuildPattern(diskPath: string): string | null {
	const trimmed = diskPath.trim();
	if (!trimmed) return null;

	const isAbsolute = path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed);
	const normalized = trimTrailingSlashes(trimmed.replaceAll("\\", "/"));
	const dir = normalized || ".";
	if (dir === ".") return "./...";
	if (dir.endsWith("/...")) return dir;
	if (isAbsolute || dir.startsWith("./") || dir.startsWith("../")) return `${dir}/...`;
	return `./${dir}/...`;
}

/** Parse `go work edit -json` output into per-module package patterns. */
function parseGoWorkspaceBuildPatterns(output: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		// `go work edit -json` prints nothing but JSON when it succeeds, and the caller only reaches here when
		// the command exited zero, so unparseable output means a Go version whose format this does not know.
		// The empty list means "no workspace patterns", which the caller answers by falling back to the
		// single-module patterns -- a narrower build scope, not a wrong one.
		return [];
	}

	if (!parsed || typeof parsed !== "object" || !("Use" in parsed) || !Array.isArray(parsed.Use)) return [];

	const patterns = new Set<string>();
	for (const entry of parsed.Use) {
		if (!entry || typeof entry !== "object" || !("DiskPath" in entry) || typeof entry.DiskPath !== "string") {
			continue;
		}
		const pattern = goWorkspaceBuildPattern(entry.DiskPath);
		if (pattern) patterns.add(pattern);
	}
	return Array.from(patterns);
}

/**
 * Runs `command` in `cwd` under the session CPU budget with stdout and all of stderr captured. A non-zero
 * exit is returned; an abort, during the run or after it, kills the process tree and throws.
 */
async function runChecker(command: string[], cwd: string, signal: AbortSignal | undefined): Promise<ptree.ExecResult> {
	const result = await ptree.exec(command, {
		cwd,
		signal,
		stderr: "full",
		allowNonZero: true,
		onSpawnPid: adoptIntoPrimarySessionCpuBudget,
	});
	throwIfAborted(signal);
	return result;
}

/** Resolve the `go build` command for a `go.work` workspace. */
async function resolveGoWorkspaceDiagnosticsCommand(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const fallback = ["go", "build", "./..."];
	try {
		const { stdout, exitCode } = await runChecker(["go", "work", "edit", "-json"], cwd, signal);
		if (exitCode !== 0) return fallback;
		const patterns = parseGoWorkspaceBuildPatterns(stdout);
		return patterns.length > 0 ? ["go", "build", ...patterns] : fallback;
	} catch {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return fallback;
	}
}

/**
 * Detect the project type from the marker files in its root.
 *
 * The markers are probed with `pathExists` rather than `fs.existsSync`. This runs on the
 * diagnostics path while a session is live, and the probes are SEQUENTIAL by design (the
 * order encodes precedence, a Go workspace outranks a single Go module), so a synchronous
 * version stops the event loop once per marker, up to six times in a row, before the tool
 * has done any work. On a cold or network filesystem that is a visible stall in the TUI.
 * `pathExists` also reports a path that exists and cannot be stat'd instead of reading it
 * as absent, which for a marker file means the project is misdetected rather than silently
 * skipped.
 *
 * The order is load-bearing and must not be reordered into a parallel probe: `go.work`
 * outranks `go.mod` because a workspace member has both, and `Cargo.toml` outranks the rest
 * because a Rust project with a `tsconfig.json` for its docs site is still a Rust project.
 */
async function detectProjectType(cwd: string, signal?: AbortSignal): Promise<ProjectType> {
	// Check for Rust (Cargo.toml)
	if (await pathExists(path.join(cwd, "Cargo.toml"), "a Rust project root")) {
		return { type: "rust", command: ["cargo", "check", "--message-format=short"], description: "Rust (cargo check)" };
	}

	// Check for TypeScript (tsconfig.json)
	if (await pathExists(path.join(cwd, "tsconfig.json"), "a TypeScript project root")) {
		return { type: "typescript", command: ["npx", "tsc", "--noEmit"], description: "TypeScript (tsc --noEmit)" };
	}

	// Check for Go workspaces before single-module Go projects.
	if (await pathExists(path.join(cwd, "go.work"), "a Go workspace root")) {
		return {
			type: "go",
			command: await resolveGoWorkspaceDiagnosticsCommand(cwd, signal),
			description: "Go workspace (go build)",
		};
	}

	// Check for Go (go.mod)
	if (await pathExists(path.join(cwd, "go.mod"), "a Go module root")) {
		return { type: "go", command: ["go", "build", "./..."], description: "Go (go build)" };
	}

	// Check for Python (pyproject.toml or pyrightconfig.json)
	if (
		(await pathExists(path.join(cwd, "pyproject.toml"), "a Python project root")) ||
		(await pathExists(path.join(cwd, "pyrightconfig.json"), "a Python project root"))
	) {
		return { type: "python", command: ["pyright"], description: "Python (pyright)" };
	}

	return { type: "unknown", description: "Unknown project type" };
}

/** Run workspace diagnostics command and parse output */
export async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType }> {
	throwIfAborted(signal);
	const projectType = await detectProjectType(cwd, signal);
	if (!projectType.command) {
		return {
			output: `Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.work/go.mod), Python (pyproject.toml)`,
			projectType,
		};
	}
	try {
		const { stdout, stderr } = await runChecker(projectType.command, cwd, signal);
		const combined = (stdout + stderr).trim();
		if (!combined) {
			return { output: "No issues found", projectType };
		}
		// Limit output length
		const lines = combined.split("\n");
		if (lines.length > 50) {
			return { output: `${lines.slice(0, 50).join("\n")}\n[…${lines.length - 50}ln elided…]`, projectType };
		}
		return { output: combined, projectType };
	} catch (e) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return { output: `Failed to run ${projectType.command.join(" ")}: ${e}`, projectType };
	}
}
