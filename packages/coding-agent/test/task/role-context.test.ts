import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyContextVariant,
	applySkillList,
	contextVariantPath,
	selectRoleContext,
} from "../../src/task/role-context";
import type { Skill } from "../../src/extensibility/skills";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "role-context-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const entry = (p: string, content: string) => ({ path: p, content, level: "project" as const, depth: 0 });

const makeSkill = (name: string, hide = false): Skill => ({
	name,
	description: `${name} fixture`,
	filePath: `${name}/SKILL.md`,
	baseDir: name,
	source: "test",
	...(hide ? { hide: true } : {}),
});

describe("contextVariantPath", () => {
	it("inserts the variant before the extension", () => {
		for (const variant of ["lane", "Lane2", "worker-core", "task_v2", "7"]) {
			expect(contextVariantPath(path.join("a", "AGENTS.md"), variant)).toBe(
				path.join("a", `AGENTS.${variant}.md`),
			);
		}
	});
	it("rejects a variant that could leave the directory", () => {
		for (const variant of ["../x", "..\\x", "x/y", "x\\y", "..", "", "/x", "C:\\x", ".", " lane", "lane x"]) {
			expect(() => contextVariantPath(path.join("a", "AGENTS.md"), variant)).toThrow("Invalid contextVariant");
		}
	});
});

describe("applyContextVariant", () => {
	it("swaps in the sibling when it exists and keeps files without one", async () => {
		const full = path.join(dir, "AGENTS.md");
		await Bun.write(full, "FULL RULES");
		await Bun.write(path.join(dir, "AGENTS.lane.md"), "LANE CORE");
		const other = path.join(dir, "sub", "AGENTS.md");
		const result = await applyContextVariant([entry(full, "FULL RULES"), entry(other, "OTHER")], "lane");
		expect(result.swapped).toBe(1);
		expect(result.contextFiles[0].content).toBe("LANE CORE");
		expect(result.contextFiles[1].content).toBe("OTHER");
	});
});

describe("applySkillList", () => {
	const skills = [makeSkill("a"), makeSkill("b"), makeSkill("c", true)];
	it("none hides everything", () => {
		expect(applySkillList(skills, "none").every(s => s.hide === true)).toBe(true);
	});
	it("a name list keeps only those listed", () => {
		const out = applySkillList(skills, ["a"]);
		expect(out.map(s => s.hide === true)).toEqual([false, true, true]);
	});
});

describe("selectRoleContext", () => {
	const roles = ["task", "qa-verifier", "codex-worker", "codex-reviewer", "reviewer", "sonnet", "opus"];
	const requiredSafety = [
		"Production authorization",
		"No visible windows",
		"--no-ff",
		"secrets",
		"tool/shell contracts",
	];

	it.each(roles)("defaults %s to its sibling lane context", async role => {
		const full = path.join(dir, "AGENTS.md");
		await Bun.write(full, "FULL RULES");
		await Bun.write(path.join(dir, "AGENTS.lane.md"), "LANE RULES\n" + requiredSafety.join("\n"));
		const files = [entry(full, "FULL RULES")];
		const out = await selectRoleContext({ agent: { name: role }, contextFiles: files, skills: [], cwd: dir });
		expect(out.contextFiles?.[0]?.content).toContain("LANE RULES");
		for (const marker of requiredSafety) expect(out.contextFiles?.[0]?.content).toContain(marker);
	});

	it.each(["missing", "empty"])("retains full files when variant is %s", async variant => {
		const full = path.join(dir, "AGENTS.md");
		await Bun.write(full, "FULL RULES");
		if (variant === "empty") await Bun.write(path.join(dir, "AGENTS.lane.md"), " \n");
		const files = [entry(full, "FULL RULES")];
		const out = await selectRoleContext({
			agent: { name: "task" },
			contextFiles: files,
			skills: [],
			cwd: dir,
		});
		expect(out.contextFiles?.[0]?.content).toBe("FULL RULES");
	});

	it("lets an explicit variant override the role default", async () => {
		const full = path.join(dir, "AGENTS.md");
		await Bun.write(full, "FULL RULES");
		await Bun.write(path.join(dir, "AGENTS.custom.md"), "CUSTOM RULES");
		const out = await selectRoleContext({
			agent: { name: "task", contextVariant: "custom" },
			contextFiles: [entry(full, "FULL RULES")],
			skills: [],
			cwd: dir,
		});
		expect(out.contextFiles?.[0]?.content).toBe("CUSTOM RULES");
	});

	it.each(["custom-role", "main"])("leaves %s unchanged", async role => {
		const files = [entry(path.join(dir, "AGENTS.md"), "x")];
		const out = await selectRoleContext({ agent: { name: role }, contextFiles: files, skills: [], cwd: dir });
		expect(out.contextFiles).toBe(files);
	});

	it("keeps the same references for an unknown role with no selection fields", async () => {
		const files = [entry(path.join(dir, "AGENTS.md"), "x")];
		const skills = [makeSkill("keep")];
		const out = await selectRoleContext({ agent: { name: "custom-role" }, contextFiles: files, skills, cwd: dir });
		expect(out.contextFiles).toBe(files);
		expect(out.skills).toBe(skills);
	});

	it("does not change the skill list when a role gets its default context", async () => {
		const full = path.join(dir, "AGENTS.md");
		await Bun.write(full, "FULL RULES");
		await Bun.write(path.join(dir, "AGENTS.lane.md"), "LANE RULES");
		const skills = [makeSkill("keep")];
		const out = await selectRoleContext({
			agent: { name: "task" },
			contextFiles: [entry(full, "FULL RULES")],
			skills,
			cwd: dir,
		});
		expect(out.skills).toBe(skills);
	});
});
