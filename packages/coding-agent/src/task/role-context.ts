import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getAgentDir, logger } from "@veyyon/utils";
import { loadSkills, type Skill } from "../extensibility/skills";
import { loadProjectContextFiles } from "../system-prompt";
import type { ContextFileEntry } from "../tools";
import type { AgentDefinition, SkillListSelection } from "./types";

/**
 * Per-role selection of the static prompt prefix a spawned agent starts from.
 *
 * WHY. The context files (global, profile, project `AGENTS.md`) and the skill list are re-read on
 * every turn of every lane. A bounded worker does not need the orchestrator's playbook, yet it used
 * to receive the parent's whole set, and the largest file (the profile `AGENTS.md`) is mostly rules
 * for Main. A role may now name a smaller variant instead of being handed the full text.
 *
 * TWO OPT-IN FIELDS on the agent definition, both absent by default (= today's behaviour):
 *
 * - `contextVariant: lane` — every inherited context file `<dir>/AGENTS.md` is replaced by the
 *   sibling `<dir>/AGENTS.lane.md` when that file exists. A file with no such sibling stays whole,
 *   so a variant can only ever shrink what a scope contributes, never silently drop a scope. The
 *   variant is a plain file the operator writes and reviews, not text this code derives from the
 *   original: what a lane keeps is a policy decision and has one owner, the file.
 * - `skillList: none | all | [names]` — which skills the system prompt LISTS. A skill left off the
 *   list is only hidden (`hide: true`, the flag skills already use for this); `skill://<name>`,
 *   `/skill:<name>` and `autoloadSkills` still resolve it, so a brief that names a skill keeps working.
 *
 * Nothing here deletes policy: the full files stay on disk and a role without the fields still gets
 * them.
 */

/** A variant name is a file-name infix, so it must not be able to leave the directory. */
const VARIANT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

/** The sibling file that holds `variant` of `filePath`: `AGENTS.md` + `lane` → `AGENTS.lane.md`. */
export function contextVariantPath(filePath: string, variant: string): string {
	const ext = path.extname(filePath);
	const base = path.basename(filePath, ext);
	return path.join(path.dirname(filePath), `${base}.${variant}${ext}`);
}

/**
 * Replace each context file by its `variant` sibling where one exists. Returns the list and how many
 * files were swapped, so the caller can tell a role that found its variants from one that did not.
 */
export async function applyContextVariant(
	contextFiles: readonly ContextFileEntry[],
	variant: string,
): Promise<{ contextFiles: ContextFileEntry[]; swapped: number }> {
	if (!VARIANT_NAME.test(variant)) {
		throw new Error(`Invalid contextVariant "${variant}": use letters, digits, "-" or "_"`);
	}
	let swapped = 0;
	const out = await Promise.all(
		contextFiles.map(async entry => {
			// A synthesized entry with no real location has no sibling to look for.
			if (!path.isAbsolute(entry.path)) return entry;
			let content: string;
			try {
				content = await fs.readFile(contextVariantPath(entry.path, variant), "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					logger.warn("Context variant unreadable; the full file stays", {
						path: entry.path,
						variant,
						error: err instanceof Error ? err.message : String(err),
					});
				}
				return entry;
			}
			if (content.trim().length === 0) return entry;
			swapped += 1;
			return { ...entry, content };
		}),
	);
	return { contextFiles: out, swapped };
}

/** The skills with every one the selection leaves off the prompt list marked `hide: true`. */
export function applySkillList<T extends Pick<Skill, "name" | "hide">>(
	skills: readonly T[],
	selection: SkillListSelection,
): T[] {
	if (selection === "all") return skills.slice();
	const listed = selection === "none" ? new Set<string>() : new Set(selection);
	return skills.map(skill => (listed.has(skill.name) || skill.hide === true ? skill : { ...skill, hide: true }));
}

export interface RoleContextInput {
	agent: Pick<AgentDefinition, "name" | "contextVariant" | "skillList">;
	/** The spawner's inherited list; `undefined` means the child discovers its own. */
	contextFiles: ContextFileEntry[] | undefined;
	skills: Skill[] | undefined;
	cwd: string;
	agentDir?: string;
}

export interface RoleContext {
	contextFiles: ContextFileEntry[] | undefined;
	skills: Skill[] | undefined;
}

/**
 * The context files and skills a role starts from. A role with neither field returns the inputs
 * untouched (same references), so the default path costs nothing and discovers nothing extra.
 *
 * A child that was going to discover its own layers (`undefined`) is resolved here instead, because a
 * selection can only be applied to a list: discovery runs with the same `cwd` and `agentDir` the
 * child's own would, so the result is the list it would have found, minus what the role leaves out.
 */
export async function selectRoleContext(input: RoleContextInput): Promise<RoleContext> {
	const { agent } = input;
	let { contextFiles, skills } = input;
	const agentDir = input.agentDir ?? getAgentDir();

	if (agent.contextVariant !== undefined) {
		if (contextFiles === undefined) {
			contextFiles = await loadProjectContextFiles({ cwd: input.cwd, agentDir });
		}
		const { contextFiles: selected, swapped } = await applyContextVariant(contextFiles, agent.contextVariant);
		contextFiles = selected;
		if (swapped === 0) {
			logger.debug("Role asked for a context variant but no file has one; full context files kept", {
				agent: agent.name,
				variant: agent.contextVariant,
			});
		}
	}

	if (agent.skillList !== undefined && agent.skillList !== "all") {
		if (skills === undefined) {
			skills = (await loadSkills({ cwd: input.cwd, agentDir })).skills;
		}
		skills = applySkillList(skills, agent.skillList);
	}

	return { contextFiles, skills };
}
