/**
 * Prints static context-selection estimates per role, with full and selected context side by side.
 * `main` has no role definition and receives the untrimmed context. Other roles load installed
 * definitions from the agent directory's sibling `subagents` directory.
 *
 *   bun scripts/measure-role-context.ts [--cwd <project dir>] [--agent-dir <profile agent dir>]
 *       [--roles main,task,codex-worker,reviewer,opus]
 *
 * Tokens use the same estimator the prompt inspector uses (`estimateTokensFromText`). Component
 * estimates are not provider-token counts; cost needs a same-task A/B run. The selected context is
 * not the complete built system prompt.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseAgentFields, type ParsedAgentFields } from "../src/discovery/helpers";
import { estimateTokensFromText, getAgentDir, parseFrontmatter } from "@veyyon/utils";
import { loadSkills } from "../src/extensibility/skills";
import { loadProjectContextFiles } from "../src/system-prompt";
import { selectRoleContext } from "../src/task/role-context";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const cwd = flag("--cwd") ?? process.cwd();
const roles = (flag("--roles") ?? "main,task,qa-verifier,codex-worker,codex-reviewer,reviewer,sonnet,opus").split(",");
const agentDir = flag("--agent-dir") ?? getAgentDir();
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
console.log(`cwd=${cwd} agentDir=${agentDir} files=${contextFiles.length} skills=${skills.length}`);
console.log("role | component files full->selected | skills full->selected | combined estimate full->selected | markers");
for (const role of roles) {
	let fields: ParsedAgentFields | null = null;
	if (role !== "main") {
		const raw = await fs.readFile(path.join(rolesDir, `${role}.md`), "utf8");
		const fm = parseFrontmatter(raw).frontmatter as Record<string, unknown>;
		fields = parseAgentFields({ ...fm, name: role, description: String(fm.description ?? role) });
	}
	const sel = role === "main"
		? { contextFiles, skills }
		: await selectRoleContext({
				agent: { name: role, contextVariant: fields?.contextVariant, skillList: fields?.skillList },
				contextFiles,
				skills,
				cwd,
				agentDir,
			});
	const f = filesTokens(sel.contextFiles ?? []);
	const s = listedTokens(sel.skills ?? []);
	const text = (sel.contextFiles ?? []).map(x => x.content).join("\n");
	const markers = [
		"Production",
		"Bitwarden",
		"--no-ff",
		"No visible windows",
		"build_slot",
		"shell",
	].filter(m => text.toLowerCase().includes(m.toLowerCase()));
	console.log(
		`${role} | ${beforeFiles}->${f} | ${beforeSkills}->${s} | ${beforeFiles + beforeSkills}->${f + s} | ${markers.length}/6`,
	);
}
