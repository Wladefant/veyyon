/**
 * Project Skills Provider
 *
 * Discovers agent skills located inside the repository:
 *   - `.agents/skills`
 *   - `.github/skills`
 *   - `.claude/skills`
 *
 * Each directory contains child folders with `SKILL.md` definitions.
 * Execution is gated by project trust: skills are hashed at the whole-folder level
 * and must be trusted before their instructions or scripts are loaded.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, getAgentDir, logger, parseFrontmatter, pathExists } from "@veyyon/utils";
import { canonicalProjectRoot, describeRefusal, ProjectTrust } from "../config/project-trust";
import { describeProjectSkill } from "../config/project-skill-trust";
import { registerProvider } from "./capability";
import { createSourceMeta } from "./helpers";
import { type DiscoveredSkill, type SkillFrontmatter, skillCapability } from "./capability/skill";
import type { LoadContext, LoadResult } from "./capability/types";

export const PROVIDER_ID = "project-skills";
export const APP_DISPLAY_NAME = "Project Skills";
export const DESCRIPTION = "Agent skills stored in the repository (.agents/skills, .github/skills, .claude/skills)";
export const PRIORITY = 200;

export const PROJECT_SKILL_DIRECTORIES = [
	".agents/skills",
	".github/skills",
	".claude/skills",
] as const;

/**
 * Discover all candidate project skill paths (SKILL.md files) in the project root.
 * Enumerates child SKILL.md files in .agents/skills, .github/skills, and .claude/skills.
 */
export async function discoverProjectSkillPaths(projectRoot: string): Promise<string[]> {
	const discovered: string[] = [];

	for (const relDir of PROJECT_SKILL_DIRECTORIES) {
		const fullDir = path.join(projectRoot, relDir);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(fullDir, { withFileTypes: true });
		} catch {
			continue;
		}

		entries.sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const skillPath = path.join(fullDir, entry.name, "SKILL.md");
				if (await pathExists(skillPath, "a project skill definition file")) {
					discovered.push(skillPath);
				}
			}
		}
	}

	return discovered;
}

/**
 * Load project skills from the active repository root.
 *
 * Project root is `ctx.repoRoot ?? ctx.cwd`.
 * Every candidate skill is verified against project trust before content is parsed.
 */
export async function loadProjectSkills(ctx: LoadContext): Promise<LoadResult<DiscoveredSkill>> {
	const items: DiscoveredSkill[] = [];
	const warnings: string[] = [];

	const projectRoot = ctx.repoRoot ?? ctx.cwd;
	const canonicalRoot = await canonicalProjectRoot(projectRoot);
	const trust = await ProjectTrust.load(ctx.agentDir ?? getAgentDir());

	const skillPaths = await discoverProjectSkillPaths(projectRoot);

	for (const skillPath of skillPaths) {
		const executable = await describeProjectSkill(skillPath, canonicalRoot);
		if (!executable) {
			const rel = path.relative(canonicalRoot, skillPath).split(path.sep).join("/");
			const reason = `project-skills: ${rel} was not loaded because the skill folder is unsafe or unreadable.`;
			logger.warn(reason, { path: skillPath, relativePath: rel });
			warnings.push(reason);
			continue;
		}

		const verdict = trust.evaluate(canonicalRoot, executable);
		if (verdict !== "trusted") {
			const reason = describeRefusal("project-skills", executable.relativePath, verdict);
			logger.warn("project-skills: refusal for skill", {
				path: skillPath,
				relativePath: executable.relativePath,
				verdict,
				reason,
			});
			warnings.push(reason);
			continue;
		}

		// Parse the bytes in the approved snapshot, not a second read after the hash check.
		try {
			const { frontmatter, body } = parseFrontmatter(executable.content, { source: executable.absolutePath });
			if (frontmatter.enabled === false) {
				continue;
			}
			const skillDirName = path.basename(path.dirname(executable.absolutePath));
			const rawName = frontmatter.name;
			const name = typeof rawName === "string" ? rawName.trim() || skillDirName : skillDirName;

			items.push({
				name,
				path: executable.absolutePath,
				content: body,
				frontmatter: frontmatter as SkillFrontmatter,
				level: "project",
				_source: createSourceMeta(PROVIDER_ID, executable.absolutePath, "project"),
			});
		} catch (err) {
			const msg = `Failed to read skill file: ${executable.absolutePath} (${errorMessage(err)})`;
			logger.warn(msg, { path: executable.absolutePath, error: errorMessage(err) });
			warnings.push(msg);
		}
	}

	return { items, warnings };
}

registerProvider<DiscoveredSkill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: APP_DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadProjectSkills,
});
