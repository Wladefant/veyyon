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

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "role-context-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const entry = (p: string, content: string) => ({ path: p, content, level: "project" as const, depth: 0 });

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
	const skills = [{ name: "a" }, { name: "b" }, { name: "c", hide: true }];
	it("none hides everything", () => {
		expect(applySkillList(skills, "none").every(s => s.hide === true)).toBe(true);
	});
	it("a name list keeps only those listed", () => {
		const out = applySkillList(skills, ["a"]);
		expect(out.map(s => s.hide === true)).toEqual([false, true, true]);
	});
});

describe("selectRoleContext", () => {
	it("returns the same references for a role with neither field", async () => {
		const files = [entry(path.join(dir, "AGENTS.md"), "x")];
		const out = await selectRoleContext({ agent: { name: "task" }, contextFiles: files, skills: [], cwd: dir });
		expect(out.contextFiles).toBe(files);
	});
});
