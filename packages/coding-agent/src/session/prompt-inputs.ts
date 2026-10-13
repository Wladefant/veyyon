/**
 * The inputs a session's system prompt is rebuilt from: the project it renders (re-discovered when
 * the session's cwd moves), the appended-prompt blocks, the discoverable-tool listing, and the
 * caller's replacement prompt.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import { parseFrontmatter } from "@veyyon/utils";
import { isMissingPath } from "@veyyon/utils/fs-error";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { DiscoveredAdvisors } from "../advisor/config";
import { captureDiscoveryReadErrors, clearCache as clearDiscoveryFsCache } from "../discovery/capability/fs";
import type { Rule } from "../discovery/capability/rule";
import { type BucketRulesOptions, bucketRules, type RuleBuckets } from "../discovery/capability/rule-buckets";
import type { EffectiveToolDiscoveryMode } from "../discovery/mode";
import {
	collectDiscoverableTools,
	type DiscoverableTool,
	filterBySource,
	formatDiscoverableToolServerSummary,
	summarizeDiscoverableTools,
} from "../discovery/tool-index";
import type { TtsrManager } from "../export/ttsr";
import type { Skill, SkillWarning } from "../extensibility/skills";
import type { BuildSystemPromptOptions, BuildSystemPromptResult } from "../system-prompt";
import type { ContextFileEntry } from "../tools";
import { TOOL } from "../tools/core/builtin-names";
import type { NonProjectReason } from "../tools/fs/reroot-hint";
import type { ActiveRepoContext } from "../utils/active-repo-context";
import type { WorkspaceTree } from "../workspace-tree";
import type { ProjectInputDiscovery } from "./factory-extensions";
import { MAX_MCP_INSTRUCTIONS_LENGTH } from "./factory-mcp";
import type { CreateAgentSessionOptions } from "./factory-options";

/** The project inputs the system prompt renders. */
export interface ProjectPromptSnapshot {
	readonly cwd: string;
	readonly contextFiles: ContextFileEntry[];
	/** A pending scan at startup: the prompt races it again on every build until it settles. */
	readonly workspaceTree: WorkspaceTree | Promise<WorkspaceTree>;
	readonly activeRepoContext: ActiveRepoContext | null;
	/** A pending check at startup, raced by every build until it settles, like {@link workspaceTree}. */
	readonly nonProjectCwd: NonProjectReason | null | Promise<NonProjectReason | null>;
	readonly skills: Skill[];
	readonly rulebookRules: Rule[];
	readonly alwaysApplyRules: Rule[];
}

/** The `buildSystemPrompt` options a {@link ProjectPromptSnapshot} supplies. */
export type ProjectPromptOptions = Pick<
	BuildSystemPromptOptions,
	| "cwd"
	| "skills"
	| "contextFiles"
	| "rules"
	| "alwaysApplyRules"
	| "workspaceTree"
	| "activeRepoContext"
	| "nonProjectCwd"
>;

/** Every input discovered for the directory a session moved to, TTSR rules already registered. */
export interface DiscoveredProjectInputs {
	readonly cwd: string;
	readonly contextFiles: ContextFileEntry[];
	readonly workspaceTree: WorkspaceTree;
	readonly activeRepoContext: ActiveRepoContext | null;
	readonly skills: Skill[];
	readonly skillWarnings: SkillWarning[];
	/** Every discovered rule, before bucketing. */
	readonly rules: Rule[];
	readonly buckets: RuleBuckets;
	readonly watchdogFiles: string[];
	readonly advisors: DiscoveredAdvisors;
}

export interface ProjectPromptInputsOptions {
	readonly initial: ProjectPromptSnapshot;
	/** Caller-owned inputs are never validated or refreshed from disk. */
	readonly supplied?: Pick<CreateAgentSessionOptions, "contextFiles" | "skills" | "rules">;
	/** The session's live cwd; `set_cwd` and `/move` change it mid-session. */
	getCwd(): string;
	discover(cwd: string): ProjectInputDiscovery;
	readonly ttsrManager: TtsrManager;
	ttsrOptions(): BucketRulesOptions;
	/** Installs a moved project's inputs everywhere outside the prompt. Runs after {@link ProjectPromptInputs.current} changes. */
	onChange(next: DiscoveredProjectInputs): void;
}

/**
 * The project a session's system prompt renders, re-discovered when the session's cwd moves.
 *
 * Refreshes run one at a time. A refresh whose cwd moved again while it discovered is discarded
 * rather than installing one project's inputs under another project's path, and the caller then
 * refreshes for the newer cwd. A failed TTSR registration restores the previous rule set and leaves
 * the snapshot unchanged.
 */
export class ProjectPromptInputs {
	#snapshot: ProjectPromptSnapshot;
	#pending: Promise<void> = Promise.resolve();
	readonly #options: ProjectPromptInputsOptions;
	#skillDigests: Map<string, string>;
	#reloadWarnings: string[] = [];

	constructor(options: ProjectPromptInputsOptions) {
		this.#options = options;
		this.#snapshot = options.initial;
		this.#skillDigests = this.#readSkillDigests(options.initial.skills);
	}

	get current(): ProjectPromptSnapshot {
		return this.#snapshot;
	}

	/** The project half of a `buildSystemPrompt` call, read off {@link current}. */
	promptOptions(): ProjectPromptOptions {
		const project = this.#snapshot;
		return {
			cwd: project.cwd,
			skills: project.skills,
			// Every api inlines the operator's layers here, cursor-agent included. That api's
			// server discards the client's system-prompt blobs and applies none of the
			// request-context rules, so the provider carries the assembled prompt on the
			// active user turn — the one thing it delivers verbatim. Either way the prompt
			// IS the instruction payload, and one composer builds it for every api.
			contextFiles: project.contextFiles,
			rules: project.rulebookRules,
			alwaysApplyRules: project.alwaysApplyRules,
			workspaceTree: project.workspaceTree,
			activeRepoContext: project.activeRepoContext,
			nonProjectCwd: project.nonProjectCwd,
		};
	}

	/** Force the existing re-root discovery path to read the current directory again. */
	async reload(): Promise<string[]> {
		const before = this.#fileContents();
		await this.refresh(true);
		if (this.#reloadWarnings.length) {
			return this.#reloadWarnings.map(error => `Could not reload ${error}; keeping the previous rules and skills.`);
		}
		const after = this.#fileContents();
		const added: string[] = [];
		const changed: string[] = [];
		const dropped: string[] = [];
		for (const [file, content] of after) {
			if (!before.has(file)) added.push(file);
			else if (before.get(file) !== content) changed.push(file);
		}
		for (const file of before.keys()) {
			if (!after.has(file)) dropped.push(file);
		}
		const lines: string[] = [];
		if (added.length)
			lines.push(
				`Rule files and skills now in effect: ${added.join(", ")}. Follow them for the rest of the session.`,
			);
		if (changed.length)
			lines.push(`Changed rule files and skills: ${changed.join(", ")}. Follow their reloaded contents.`);
		if (dropped.length) lines.push(`No longer in effect: ${dropped.join(", ")}. Stop applying them.`);
		if (!lines.length) lines.push("The rule files and skills in effect are unchanged.");
		lines.push("Rule files and skills reloaded. The next model turn uses the rebuilt system prompt.");
		return lines;
	}

	#fileContents(): Map<string, string> {
		const current = this.#snapshot;
		const files = new Map(current.contextFiles.map(file => [file.path, file.content]));
		for (const skill of current.skills) {
			if (this.#options.supplied?.skills === undefined)
				files.set(skill.filePath, `${JSON.stringify(skill)}\n${this.#skillDigests.get(skill.filePath) ?? ""}`);
			else files.set(skill.filePath, JSON.stringify(skill));
		}
		for (const rule of [
			...current.rulebookRules,
			...current.alwaysApplyRules,
			...this.#options.ttsrManager.getRules(),
		]) {
			files.set(rule.path, JSON.stringify(rule));
		}
		return files;
	}

	#readSkillDigests(skills: Skill[]): Map<string, string> {
		const digests = new Map<string, string>();
		if (this.#options.supplied?.skills !== undefined) return digests;
		for (const skill of skills) {
			try {
				if (fs.statSync(skill.filePath).isFile()) {
					digests.set(skill.filePath, createHash("sha256").update(fs.readFileSync(skill.filePath)).digest("hex"));
				}
			} catch {
				// Caller-owned skills may not have a disk file. Discovery reports disk read failures.
			}
		}
		return digests;
	}

	/** Re-discover the project when the live cwd differs from the rendered one; resolves once they agree. */
	async refresh(force = false): Promise<void> {
		if (!force && this.#liveCwd() === this.#snapshot.cwd) return;
		const refresh = this.#pending.catch(() => undefined).then(() => this.#discoverLiveCwd(force));
		this.#pending = refresh;
		await refresh;
		if (this.#liveCwd() !== this.#snapshot.cwd) await this.refresh();
	}

	#liveCwd(): string {
		return path.resolve(this.#options.getCwd());
	}

	async #discoverLiveCwd(force: boolean): Promise<void> {
		const cwd = this.#liveCwd();
		if (!force && cwd === this.#snapshot.cwd) return;
		if (force) {
			this.#reloadWarnings = [];
			// A fail-soft loader must not turn an unreadable loaded file into an intentional removal.
			const { supplied } = this.#options;
			const files = new Set([
				...(supplied?.contextFiles === undefined ? this.#snapshot.contextFiles.map(file => file.path) : []),
				...(supplied?.skills === undefined ? this.#snapshot.skills.map(skill => skill.filePath) : []),
				...(supplied?.rules === undefined
					? [
							...this.#snapshot.rulebookRules,
							...this.#snapshot.alwaysApplyRules,
							...this.#options.ttsrManager.getRules(),
						].map(rule => rule.path)
					: []),
			]);
			for (const file of files) {
				try {
					const stat = await fs.promises.stat(file);
					if (!stat.isFile()) throw new Error("not a regular file");
					await fs.promises.readFile(file);
				} catch (error) {
					if (!isMissingPath(error)) this.#reloadWarnings.push(`${file}: ${errorMessage(error)}`);
				}
			}
			if (this.#reloadWarnings.length) return;
			clearDiscoveryFsCache();
		}

		const captured = await captureDiscoveryReadErrors(async () => {
			const discovery = this.#options.discover(cwd);
			return Promise.all([
				discovery.contextFiles,
				discovery.workspaceTree,
				discovery.activeRepoContext,
				discovery.nonProjectCwd,
				discovery.skills,
				discovery.rules,
				discovery.watchdogFiles,
				discovery.advisors,
			]);
		});
		const [
			contextFiles,
			workspaceTree,
			activeRepoContext,
			nonProjectCwd,
			skillsResult,
			rules,
			watchdogFiles,
			advisors,
		] = captured.result;
		if (force && captured.errors.length) {
			this.#reloadWarnings = captured.errors;
			return;
		}
		if (force && this.#options.supplied?.rules === undefined) {
			for (const file of new Set(rules.map(rule => rule.path))) {
				try {
					if (!(await fs.promises.stat(file)).isFile()) throw new Error("not a regular file");
					const content = await fs.promises.readFile(file, "utf8");
					parseFrontmatter(content, { source: file, level: "fatal" });
				} catch (error) {
					this.#reloadWarnings.push(
						`${file}: invalid or unreadable rule frontmatter (${error instanceof Error ? error.name : "error"})`,
					);
				}
			}
			if (this.#reloadWarnings.length) return;
		}
		if (this.#liveCwd() !== cwd) return;

		const buckets = this.#registerRules(rules);
		const next: DiscoveredProjectInputs = {
			cwd,
			contextFiles,
			workspaceTree,
			activeRepoContext,
			skills: skillsResult.skills,
			skillWarnings: skillsResult.warnings,
			rules,
			buckets,
			watchdogFiles,
			advisors,
		};
		this.#snapshot = {
			cwd,
			contextFiles,
			workspaceTree,
			activeRepoContext,
			nonProjectCwd,
			skills: next.skills,
			rulebookRules: buckets.rulebookRules,
			alwaysApplyRules: buckets.alwaysApplyRules,
		};
		this.#skillDigests = this.#readSkillDigests(next.skills);
		this.#options.onChange(next);
	}

	/** Replace the TTSR rule set with `rules`, restoring the previous set when registration throws. */
	#registerRules(rules: readonly Rule[]): RuleBuckets {
		const { ttsrManager } = this.#options;
		const previous = ttsrManager.getRules();
		ttsrManager.clearRules();
		try {
			return bucketRules(rules, ttsrManager, this.#options.ttsrOptions());
		} catch (error) {
			ttsrManager.clearRules();
			for (const rule of previous) ttsrManager.addRule(rule);
			throw error;
		}
	}
}

/**
 * The appended-prompt text: memory instructions, auto-learn guidance, the connected MCP servers'
 * instructions (each clipped to {@link MAX_MCP_INSTRUCTIONS_LENGTH}), then the caller's append.
 * Undefined when every part is empty.
 */
export function composeAppendPrompt(parts: {
	memoryInstructions: string | undefined;
	autoLearnInstructions: string | null;
	serverInstructions: ReadonlyMap<string, string> | undefined;
	appendSystemPrompt: string | undefined;
}): string | undefined {
	const blocks: string[] = [];
	if (parts.memoryInstructions) blocks.push(parts.memoryInstructions);
	if (parts.autoLearnInstructions) blocks.push(parts.autoLearnInstructions);
	if (parts.serverInstructions && parts.serverInstructions.size > 0) {
		blocks.push(
			"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
		);
		for (const [server, instructions] of parts.serverInstructions) {
			const clipped =
				instructions.length > MAX_MCP_INSTRUCTIONS_LENGTH
					? `${instructions.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH)}\n[truncated]`
					: instructions;
			blocks.push(`### ${server}\n${clipped}`);
		}
	}
	if (parts.appendSystemPrompt) blocks.push(parts.appendSystemPrompt);
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/** The tools the prompt lists as loadable through `search_tool_bm25`. */
export interface PromptDiscoverableTools {
	/** Inactive discoverable local tools (mode `all` only), then every MCP tool when MCP discovery is on. */
	readonly tools: DiscoverableTool[];
	/** True when the prompt teaches discovery: MCP discovery is on, the search tool is active, and it has tools to find. */
	readonly searchable: boolean;
	readonly serverSummaries: string[];
}

export function promptDiscoverableTools(input: {
	tools: ReadonlyMap<string, AgentTool>;
	activeToolNames: readonly string[];
	mcpDiscoveryEnabled: boolean;
	discoveryMode: EffectiveToolDiscoveryMode;
	builtInToolNames: ReadonlySet<string>;
}): PromptDiscoverableTools {
	const active = new Set(input.activeToolNames);
	const local =
		input.discoveryMode === "all"
			? Array.from(input.tools.values()).flatMap(tool => {
					if (tool.loadMode !== "discoverable" || active.has(tool.name)) return [];
					return collectDiscoverableTools([tool], {
						source: input.builtInToolNames.has(tool.name) ? "builtin" : "custom",
					});
				})
			: [];
	const mcp = input.mcpDiscoveryEnabled ? filterBySource(collectDiscoverableTools(input.tools.values()), "mcp") : [];
	const tools = local.concat(mcp);
	return {
		tools,
		searchable: input.mcpDiscoveryEnabled && active.has(TOOL.search_tool_bm25) && tools.length > 0,
		serverSummaries: summarizeDiscoverableTools(tools).servers.map(formatDiscoverableToolServerSummary),
	};
}

/** The prompt a session sends: the assembled one, or the caller's replacement for it. */
export function applySystemPromptOverride(
	assembled: BuildSystemPromptResult,
	override: CreateAgentSessionOptions["systemPrompt"],
): BuildSystemPromptResult {
	if (override === undefined) return assembled;
	const replacement = typeof override === "function" ? override(assembled.systemPrompt) : override;
	return {
		systemPrompt: typeof replacement === "string" ? [replacement] : replacement,
		// The caller replaced the assembled prompt, so no statement produced these blocks.
		statementContext: null,
		statementOverrides: null,
		replacedStatementSections: [],
	};
}
