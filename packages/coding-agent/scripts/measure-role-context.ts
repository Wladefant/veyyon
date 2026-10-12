/**
 * Prints, per role, the static prompt-prefix tokens the role's context selection removes:
 * context files (global, profile, project AGENTS.md) and the skill list, before vs after.
 *
 *   bun scripts/measure-role-context.ts [--cwd <project dir>] [--roles task,qa-verifier,...]
 *
 * Tokens use the same estimator the prompt inspector uses (`estimateTokensFromText`). This measures
 * the prefix a role is sent on every turn; it is NOT a cost number. Cost needs a same-task A/B run.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { estimateTokensFromText, getAgentDir, parseFrontmatter } from "@veyyon/utils";
import { parseAgentFields } from "../src/discovery/helpers";
import { loadSkills } from "../src/extensibility/skills";
import { loadProjectContextFiles } from "../src/system-prompt";
import { selectRoleContext } from "../src/task/role-context";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const cwd = flag("--cwd") ?? process.cwd();
const roles = (flag("--roles") ?? "task,qa-verifier,codex-worker,codex-reviewer,sonnet,opus").split(",");
const agentDir = getAgentDir();
const rolesDir = path.join(agentDir, "..", "..", "..", "subagents");

const contextFiles = await loadProjectContextFiles({ cwd, agentDir });
const skills = (await loadSkills({ cwd, agentDir })).skills;
const listedTokens = (list: typeof skills): number =>
	estimateTokensFromText(
		list
			.filter(s => s.hide !== true)
			.map(s => `${s.name}: ${s.description ?? ""}`)
			.join("\n"),
	);
const filesTokens = (list: typeof contextFiles): number =>
	list.reduce((sum, f) => sum + estimateTokensFromText(f.content), 0);

const beforeFiles = filesTokens(contextFiles);
const beforeSkills = listedTokens(skills);
console.log(`cwd=${cwd} files=${contextFiles.length} skills=${skills.length}`);
console.log("role | files before->after | skills before->after | total before->after | safety markers kept");
for (const role of roles) {
	const raw = await fs.readFile(path.join(rolesDir, `${role}.md`), "utf8");
	const fm = parseFrontmatter(raw).frontmatter as Record<string, unknown>;
	const fields = parseAgentFields({ ...fm, name: role, description: String(fm.description ?? role) });
	const sel = await selectRoleContext({
		agent: { name: role, contextVariant: fields?.contextVariant, skillList: fields?.skillList },
		contextFiles,
		skills,
		cwd,
		agentDir,
	});
	const f = filesTokens(sel.contextFiles ?? []);
	const s = listedTokens(sel.skills ?? []);
	const text = (sel.contextFiles ?? []).map(x => x.content).join("\n");
	const markers = ["Production", "Bitwarden", "--no-ff", "No visible windows", "build_slot"].filter(m =>
		text.includes(m),
	);
	console.log(
		`${role} | ${beforeFiles}->${f} | ${beforeSkills}->${s} | ${beforeFiles + beforeSkills}->${f + s} | ${markers.length}/5`,
	);
}
