/**
 * The operator's side of project trust: see what a repository wants to run, and decide.
 *
 * WHY THIS IS A COMMAND AND NOT A STARTUP PROMPT. The gate refuses first and reports what it
 * withheld, so the decision is never racing a side effect. That ordering is the safety property,
 * and it holds only because nothing asks before the refusal — an early prompt would have to run
 * before the TUI exists, from a path that also serves print mode, ACP and agents, and the
 * caller who cannot answer is exactly the caller that must not load project code. So the answer
 * is given out of band, once, and remembered.
 *
 * WHAT IT DECIDES. Project-controlled files that grant execution: the project plugin registry,
 * whose entries name install directories that then supply extensions, hooks, custom tools, slash
 * commands and MCP servers, plus any path the operator names explicitly (that is how a file the
 * gate withheld by name is approved, without this module having to predict every discovery
 * route). A path outside the project root is the operator's own and is refused as out of scope
 * rather than recorded, because a decision about `~/.veyyon` would be a decision about their own
 * configuration.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathExists } from "@veyyon/utils";
import {
	canonicalProjectRoot,
	describeProjectExecutable,
	type ProjectExecutable,
	ProjectTrust,
	type ProjectTrustVerdict,
} from "../config/project-trust";
import { describeProjectSkill } from "../config/project-skill-trust";
import { findRepoRoot } from "../discovery/capability/fs";
import { clearClaudePluginRootsCache, resolveActiveProjectRegistryPath } from "../discovery/helpers";
import { discoverProjectSkillPaths } from "../discovery/project-skills";

export type TrustAction = "approve" | "deny" | "forget" | "list";

export interface TrustCommandArgs {
	cwd: string;
	agentDir: string;
	action: TrustAction;
	/** Paths named on the command line; empty means "everything discovered". */
	paths: readonly string[];
}

export interface TrustCandidate {
	relativePath: string;
	absolutePath: string;
	verdict: ProjectTrustVerdict;
	/** What this file grants, in the operator's terms. */
	grants: string;
}

export interface TrustCommandResult {
	action: TrustAction;
	projectRoot: string;
	storePath: string;
	decision: "trusted" | "denied" | "undecided";
	candidates: TrustCandidate[];
	/** Paths the caller named that are not inside the project root. */
	outOfScope: string[];
	/** Paths the caller named that do not exist or cannot be read. */
	unreadable: string[];
}

/**
 * Every project-controlled file that grants execution, whether or not it is decided.
 *
 * Discovery is deliberately narrow: this lists the doors, not everything behind them. The plugin
 * registry's install directories are usually outside the tree — an approved registry is consent
 * to the plugins it names — so listing them here would ask the operator to approve files the
 * project does not control.
 */
async function discoverCandidatePaths(projectRoot: string): Promise<string[]> {
	const registry = await resolveActiveProjectRegistryPath(projectRoot);
	const skillPaths = await discoverProjectSkillPaths(projectRoot);
	return registry ? [registry, ...skillPaths] : skillPaths;
}

function grantsFor(relativePath: string): string {
	if (relativePath.endsWith("installed_plugins.json")) {
		return "plugins: extensions, hooks, custom tools, slash commands and MCP servers";
	}
	if (path.basename(relativePath).toLowerCase() === "skill.md") {
		return "skill: specialized instructions, scripts and assets";
	}
	return "code loaded at startup";
}

export async function runTrustCommand(args: TrustCommandArgs): Promise<TrustCommandResult> {
	const repoRoot = await findRepoRoot(args.cwd);
	const effectiveRoot = repoRoot ?? args.cwd;
	const projectRoot = await canonicalProjectRoot(effectiveRoot);
	const trust = await ProjectTrust.load(args.agentDir);

	const named = args.paths.map(p => path.resolve(args.cwd, p));
	const discovered = named.length > 0 ? named : await discoverCandidatePaths(effectiveRoot);

	const outOfScope: string[] = [];
	const unreadable: string[] = [];
	const executables: ProjectExecutable[] = [];
	for (const absolutePath of discovered) {
		const isSkill =
			path.basename(absolutePath).toLowerCase() === "skill.md" ||
			(await pathExists(path.join(absolutePath, "SKILL.md"), "a skill directory containing SKILL.md"));
		const executable = isSkill
			? await describeProjectSkill(absolutePath, projectRoot)
			: await describeProjectExecutable(absolutePath, projectRoot);
		if (executable) {
			executables.push(executable);
			continue;
		}
		// Describers return null for both an invalid/unreadable candidate and one that resolves
		// outside its root. Use the real target to keep those operator actions distinct.
		try {
			const realPath = await fs.realpath(absolutePath);
			const relative = path.relative(projectRoot, realPath);
			if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
				outOfScope.push(absolutePath);
			} else {
				unreadable.push(absolutePath);
			}
		} catch {
			unreadable.push(absolutePath);
		}
	}

	if (args.action === "approve" && executables.length > 0) await trust.trust(projectRoot, executables);
	if (args.action === "deny") await trust.deny(projectRoot);
	if (args.action === "forget") await trust.forget(projectRoot);

	const record = trust.recordFor(projectRoot);
	const candidates = executables.map(executable => ({
		relativePath: executable.relativePath,
		absolutePath: executable.absolutePath,
		verdict: trust.evaluate(projectRoot, executable),
		grants: grantsFor(executable.relativePath),
	}));

	return {
		action: args.action,
		projectRoot,
		storePath: trust.filePath,
		decision: record?.decision ?? "undecided",
		candidates,
		outOfScope,
		unreadable,
	};
}

/** The report an operator reads. One line per file, decision first. */
export function renderTrustReport(result: TrustCommandResult): string {
	const lines: string[] = [];
	lines.push(`Project: ${result.projectRoot}`);
	lines.push(`Decision: ${result.decision}`);
	if (result.candidates.length === 0) {
		lines.push("No project-controlled executable files found.");
	}
	for (const candidate of result.candidates) {
		lines.push(`  ${candidate.verdict === "trusted" ? "trusted  " : "withheld "} ${candidate.relativePath}`);
		lines.push(`            grants ${candidate.grants}`);
	}
	for (const outside of result.outOfScope) {
		lines.push(`  skipped   ${outside}`);
		lines.push("            outside this project; nothing to decide (it is already yours)");
	}
	for (const missing of result.unreadable) {
		lines.push(`  missing   ${missing}`);
	}
	if (result.decision !== "trusted" && result.candidates.some(c => c.verdict !== "trusted")) {
		lines.push("");
		lines.push("Run `veyyon trust` in this directory to approve these exact files.");
	}
	lines.push("");
	lines.push(`Recorded in ${result.storePath}`);
	return `${lines.join("\n")}\n`;
}

/**
 * The `/trust` verb, for a session that is already running.
 *
 * Same authority and same report as the CLI command; only the parsing differs, because a slash
 * command has one argument string rather than flags and positionals. A bare `/trust` reports and
 * changes nothing: approving project code is not something a bare keystroke should do. Paths
 * after the verb are decided instead of the discovered set, which is how a file the gate named in
 * a refusal gets approved without leaving the session.
 */
export async function runTrustSlashCommand(args: string, agentDir: string, cwd: string): Promise<string> {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const verb = (words[0] ?? "").toLowerCase();
	const action: TrustAction | null =
		verb === "" || verb === "list"
			? "list"
			: verb === "approve" || verb === "deny" || verb === "forget"
				? verb
				: null;
	if (action === null) return `Unknown /trust verb "${verb}". Use approve, deny, forget, or nothing to report.\n`;
	const result = await runTrustCommand({ cwd, agentDir, action, paths: words.slice(1) });
	// A decision changes what discovery may read, and plugin roots are cached for the life of the
	// process; without this the operator would have to restart to see their own answer take effect.
	if (action !== "list") clearClaudePluginRootsCache();
	return renderTrustReport(result);
}
