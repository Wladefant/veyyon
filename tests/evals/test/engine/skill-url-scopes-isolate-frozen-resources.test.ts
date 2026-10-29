import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@veyyon/coding-agent/extensibility/skills";
import { InternalUrlRouter } from "@veyyon/coding-agent/internal-urls/router";

const makeSkill = (root: string, name: string, content: string): Skill => {
	const baseDir = path.join(root, name);
	const filePath = path.join(baseDir, "SKILL.md");
	return { name, description: "Frozen test resource", filePath, baseDir, source: "eval-experiment" };
};

describe("skill URL session isolation", () => {
	it("resolves concurrent skill URLs from their session snapshots and keeps a baseline skill absent", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-skill-scope-test-"));
		try {
			const alphaText = "alpha frozen content";
			const betaText = "beta frozen content";
			const alpha = makeSkill(root, "alpha", alphaText);
			const beta = makeSkill(root, "beta", betaText);
			await fs.mkdir(alpha.baseDir, { recursive: true });
			await fs.mkdir(beta.baseDir, { recursive: true });
			await fs.writeFile(alpha.filePath, alphaText, "utf8");
			await fs.writeFile(beta.filePath, betaText, "utf8");

			const router = InternalUrlRouter.instance();
			const [alphaResource, betaResource, absent] = await Promise.all([
				router.resolve("skill://alpha", { cwd: root, skills: [alpha] }),
				router.resolve("skill://beta", { cwd: root, skills: [beta] }),
				router.resolve("skill://alpha", { cwd: root, skills: [] })
					.then(() => "unexpected")
					.catch(error => String(error)),
			]);
			expect(alphaResource.content).toBe(alphaText);
			expect(betaResource.content).toBe(betaText);
			expect(absent).toContain("Unknown skill: alpha");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
