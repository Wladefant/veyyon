import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exportKnowledgeCatalog, applyKnowledgeCatalog, writeBaseline } from "../../src/shared-knowledge";
import type { PathLike } from "node:fs";
import type { KnowledgeManifest } from "../../src/shared-knowledge/types";
import type { ExportOptions } from "../../src/shared-knowledge/types";
import { commitTransaction, recoverTransaction } from "../../src/shared-knowledge/safe-fs";

describe("shared knowledge apply safety", () => {
	let root: string;
	let agentDir: string;
	let globalDir: string;
	let workflowsDir: string;
	let catalogDir: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "apply-safety-"));
		agentDir = path.join(root, "agent");
		globalDir = path.join(root, "global");
		workflowsDir = path.join(root, "workflows");
		catalogDir = path.join(root, "catalog");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(globalDir, { recursive: true });
		await fs.mkdir(workflowsDir, { recursive: true });
	});
	afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

	async function exportSkills() {
		await exportReviewedCatalog({ agentDir: path.join(root, "source"), outDir: catalogDir, categories: ["skills"] });
	}
	async function exportReviewedCatalog(options: ExportOptions) {
		const planPath = path.join(root, "reviewed-export-plan.json");
		await exportKnowledgeCatalog({ ...options, planPath });
		return exportKnowledgeCatalog({ ...options, reviewedPlanPath: planPath });
	}
	async function apply(extra: Record<string, unknown> = {}) {
		return applyKnowledgeCatalog({ catalogDir, targetAgentDir: agentDir, targetGlobalDir: globalDir, targetWorkflowsDir: workflowsDir, ...extra });
	}
	function manifest(): KnowledgeManifest {
		return { schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", generator: "veyyon/shared-knowledge", generatorVersion: "1.0.0", categories: ["skills"], items: [] };
	}

	it("preserves agent.db byte-for-byte during baseline writes and refuses direct apply targets", async () => {
		const db = path.join(agentDir, "agent.db");
		const bytes = Buffer.from([0, 1, 2, 255, 0, 42]);
		await fs.writeFile(db, bytes);
		await expect(writeBaseline(db, manifest())).rejects.toThrow();
		const disguisedDatabase = path.join(agentDir, "state.json");
		const sqliteBytes = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.from([1, 2, 3])]);
		await fs.writeFile(disguisedDatabase, sqliteBytes);
		await expect(writeBaseline(disguisedDatabase, manifest())).rejects.toThrow();
		expect(await fs.readFile(disguisedDatabase)).toEqual(sqliteBytes);
		const hardlink = path.join(agentDir, "state-copy.json");
		await fs.link(disguisedDatabase, hardlink);
		await expect(writeBaseline(hardlink, manifest())).rejects.toThrow();
		expect(await fs.readFile(disguisedDatabase)).toEqual(sqliteBytes);
		expect(await fs.readFile(hardlink)).toEqual(sqliteBytes);
		await writeBaseline(path.join(agentDir, ".knowledge-baseline.json"), manifest());
		expect(await fs.readFile(db)).toEqual(bytes);
		await exportSkills();
		await expect(apply({ baselinePath: db })).rejects.toThrow();
		expect(await fs.readFile(db)).toEqual(bytes);
	});

	it("refuses symlink ancestors and config-redirected targets without writes", async () => {
		const outside = path.join(root, "outside");
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "SKILL.md"), "outside");
		await fs.mkdir(path.join(agentDir, "skills"));
		await fs.symlink(outside, path.join(agentDir, "skills", "guide"), "junction");
		await fs.mkdir(path.join(root, "source", "skills", "guide"), { recursive: true });
		await fs.writeFile(path.join(root, "source", "skills", "guide", "SKILL.md"), "incoming");
		await exportSkills();
		await expect(apply()).rejects.toThrow();
		expect(await fs.readFile(path.join(outside, "SKILL.md"), "utf8")).toBe("outside");
		expect(await fs.stat(path.join(agentDir, ".knowledge-baseline.json")).then(() => false, () => true)).toBe(true);
		const db = path.join(agentDir, "agent.db");
		const bytes = Buffer.from([0, 1, 255, 0, 9]);
		await fs.writeFile(db, bytes);
		await fs.symlink(db, path.join(agentDir, "config.yml"));
		await fs.mkdir(path.join(root, "source"), { recursive: true });
		await exportReviewedCatalog({ agentDir: path.join(root, "source"), outDir: catalogDir, includeHindsightReference: true, hindsightConfig: { apiUrl: "https://memory.example", bankId: "safe-bank" } });
		await expect(apply()).rejects.toThrow();
		expect(await fs.readFile(db)).toEqual(bytes);
	});

	it("refuses malformed YAML and leaves every target byte unchanged", async () => {
		await fs.mkdir(path.join(root, "source"), { recursive: true });
		await fs.writeFile(path.join(root, "source", "config.yml"), "memory: [unterminated\n");
		await exportReviewedCatalog({ agentDir: path.join(root, "source"), outDir: catalogDir, includeHindsightReference: true, hindsightConfig: { apiUrl: "https://memory.example", bankId: "safe-bank" } });
		const config = path.join(agentDir, "config.yml");
		const original = Buffer.from("keep: [also-broken\n");
		await fs.writeFile(config, original);
		await expect(apply()).rejects.toThrow();
		expect(await fs.readFile(config)).toEqual(original);
		expect(await fs.readdir(agentDir)).toEqual(["config.yml"]);
	});

	it("serializes concurrent applies without losing edits or diverging the baseline", async () => {
		const sourceDir = path.join(root, "source");
		const firstCatalog = path.join(root, "catalog-a");
		const secondCatalog = path.join(root, "catalog-b");
		await fs.mkdir(path.join(sourceDir, "skills", "one"), { recursive: true });
		await fs.mkdir(path.join(sourceDir, "skills", "two"), { recursive: true });
		for (const name of ["one", "two"]) await fs.writeFile(path.join(sourceDir, "skills", name, "SKILL.md"), "version A");
		await exportReviewedCatalog({ agentDir: sourceDir, outDir: firstCatalog, categories: ["skills"] });
		for (const name of ["one", "two"]) await fs.writeFile(path.join(sourceDir, "skills", name, "SKILL.md"), "version B");
		await exportReviewedCatalog({ agentDir: sourceDir, outDir: secondCatalog, categories: ["skills"] });
		const results = await Promise.all([apply({ catalogDir: firstCatalog }), apply({ catalogDir: secondCatalog })]);
		expect(results.some(result => result.success)).toBe(true);
		const first = await fs.readFile(path.join(agentDir, "skills", "one", "SKILL.md"), "utf8");
		const second = await fs.readFile(path.join(agentDir, "skills", "two", "SKILL.md"), "utf8");
		expect(first).toBe(second);
		expect(["version A", "version B"]).toContain(first);
		const baseline = JSON.parse(await fs.readFile(path.join(agentDir, ".knowledge-baseline.json"), "utf8"));
		const sha = (content: string) => createHash("sha256").update(content).digest("hex");
		expect(baseline.items["skills/one/SKILL.md"]).toBe(sha(first));
		expect(baseline.items["skills/two/SKILL.md"]).toBe(sha(second));
	});

	it("rolls back an earlier replacement when a later file replacement fails", async () => {
		const first = path.join(agentDir, "first.md");
		const second = path.join(agentDir, "second.md");
		await fs.writeFile(first, "first before");
		await fs.writeFile(second, "second before");
		let replacements = 0;
		const rename = async (source: PathLike, destination: PathLike) => {
			if (String(source).includes(".stage-")) {
				replacements++;
				if (replacements === 2) {
					expect(await fs.readFile(first, "utf8")).toBe("first after");
					throw new Error("injected replacement failure");
				}
			}
			return fs.rename(source, destination);
		};
		await expect(commitTransaction(agentDir, [
			{ root: agentDir, target: first, content: "first after" },
			{ root: agentDir, target: second, content: "second after" },
		], { rename })).rejects.toThrow("injected replacement failure");
		expect(replacements).toBe(2);
		expect(await fs.readFile(first, "utf8")).toBe("first before");
		expect(await fs.readFile(second, "utf8")).toBe("second before");
		expect(await fs.stat(path.join(agentDir, ".knowledge-transaction.json")).then(() => false, () => true)).toBe(true);
	});

	it("recovers a simulated interrupted apply to its complete prior state", async () => {
		const target = path.join(agentDir, "recover.md");
		const backup = `${target}.backup-test`;
		const stage = `${target}.stage-test`;
		await fs.writeFile(target, "partial new state");
		await fs.writeFile(backup, "complete prior state");
		await fs.writeFile(stage, "staged new state");
		await fs.writeFile(path.join(agentDir, ".knowledge-transaction.json"), JSON.stringify({ entries: [{ root: agentDir, target, stage, backup }] }));
		await recoverTransaction(agentDir);
		expect(await fs.readFile(target, "utf8")).toBe("complete prior state");
		expect(await fs.stat(path.join(agentDir, ".knowledge-transaction.json")).then(() => false, () => true)).toBe(true);
	});

	it("reports dry-run conflicts without writing a conflict copy or baseline", async () => {
		await fs.mkdir(path.join(root, "source", "skills", "guide"), { recursive: true });
		const source = path.join(root, "source", "skills", "guide", "SKILL.md");
		await fs.writeFile(source, "upstream one");
		await exportSkills();
		await apply();
		await fs.writeFile(source, "upstream two");
		await exportSkills();
		const target = path.join(agentDir, "skills", "guide", "SKILL.md");
		await fs.writeFile(target, "local divergent edit");
		const baseline = await fs.readFile(path.join(agentDir, ".knowledge-baseline.json"));
		const directoryBefore = await fs.readdir(path.dirname(target));
		const result = await apply({ dryRun: true, preserveConflicts: true });
		expect(result.success).toBe(false);
		expect(result.conflictCount).toBe(1);
		expect(result.conflictFiles).toEqual([]);
		expect(await fs.readFile(target, "utf8")).toBe("local divergent edit");
		expect(await fs.readFile(path.join(agentDir, ".knowledge-baseline.json"))).toEqual(baseline);
		expect(await fs.readdir(path.dirname(target))).toEqual(directoryBefore);
	});

	it("applies selected categories while retaining other category files and baseline entries", async () => {
		await fs.mkdir(path.join(root, "source", "skills", "guide"), { recursive: true });
		await fs.writeFile(path.join(root, "source", "skills", "guide", "SKILL.md"), "skill");
		await fs.mkdir(path.join(root, "source", "memories"), { recursive: true });
		await fs.writeFile(path.join(root, "source", "memories", "learned.md"), "lesson");
		await exportReviewedCatalog({ agentDir: path.join(root, "source"), outDir: catalogDir });
		const initial = await apply();
		expect(initial.success).toBe(true);
		const lessonPath = path.join(agentDir, "memories", "learned.md");
		const lessonBefore = await fs.readFile(lessonPath);
		const baselinePath = path.join(agentDir, ".knowledge-baseline.json");
		const before = JSON.parse(await fs.readFile(baselinePath, "utf8"));
		await fs.writeFile(path.join(root, "source", "memories", "learned.md"), "excluded incoming lesson change");
		await exportReviewedCatalog({ agentDir: path.join(root, "source"), outDir: catalogDir });
		const result = await apply({ categories: ["skills"] });
		expect(result.success).toBe(true);
		expect(await fs.readFile(lessonPath)).toEqual(lessonBefore);
		const after = JSON.parse(await fs.readFile(baselinePath, "utf8"));
		expect(after.items["lessons/learned.md"]).toBe(before.items["lessons/learned.md"]);
		await fs.rm(path.join(root, "source", "memories", "learned.md"));
		await exportReviewedCatalog({ agentDir: path.join(root, "source"), outDir: catalogDir });
		expect((await apply({ categories: ["skills"] })).success).toBe(true);
		expect(await fs.readFile(lessonPath)).toEqual(lessonBefore);
		expect(JSON.parse(await fs.readFile(baselinePath, "utf8")).items["lessons/learned.md"]).toBe(before.items["lessons/learned.md"]);
		await fs.writeFile(path.join(root, "source", "memories", "learned.md"), "lesson");
		const sourceDir = path.join(root, "source");
		await fs.mkdir(path.join(sourceDir, "rules"), { recursive: true });
		await fs.mkdir(path.join(sourceDir, "workflows"), { recursive: true });
		await fs.writeFile(path.join(sourceDir, "rules", "AGENTS.md"), "profile rules");
		await fs.writeFile(path.join(sourceDir, "workflows", "cleanup.py"), "print('cleanup')");
		await exportReviewedCatalog({ agentDir: sourceDir, globalDir: path.join(root, "source-global"), workflowsDir: path.join(sourceDir, "workflows"), outDir: catalogDir });
		await expect(apply()).resolves.toMatchObject({ success: true });
		await fs.rm(path.join(sourceDir, "rules", "AGENTS.md"));
		await fs.rm(path.join(sourceDir, "workflows", "cleanup.py"));
		await exportReviewedCatalog({ agentDir: sourceDir, globalDir: path.join(root, "source-global"), workflowsDir: path.join(sourceDir, "workflows"), outDir: catalogDir });
		const deletion = await apply();
		expect(deletion.success).toBe(true);
		expect(await fs.stat(path.join(agentDir, "rules", "AGENTS.md")).then(() => false, () => true)).toBe(true);
		expect(await fs.stat(path.join(workflowsDir, "cleanup.py")).then(() => false, () => true)).toBe(true);
		const finalBaseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
		expect(finalBaseline.items["rules/AGENTS.md"]).toBeUndefined();
		expect(finalBaseline.items["workflows/cleanup.py"]).toBeUndefined();
	});
	it("preserves nested settings, comments, credentials, and local-only Hindsight overrides", async () => {
		await exportReviewedCatalog({ outDir: catalogDir, hindsightConfig: { apiUrl: "https://memory.example", bankId: "reviewed-bank" }, categories: ["config"] });
		const configPath = path.join(agentDir, "config.yml");
		const original = "# machine settings\ntheme:\n  dark: true\ncredentials:\n  apiToken: machine-only-value\n";
		await fs.writeFile(configPath, original);
		expect((await apply()).success).toBe(true);
		const updated = await fs.readFile(configPath, "utf8");
		expect(updated).toContain(original);
		const localOverride = updated.replace("reviewed-bank", "local-bank");
		await fs.writeFile(configPath, localOverride);
		expect((await apply()).success).toBe(true);
		expect(await fs.readFile(configPath, "utf8")).toBe(localOverride);
		await exportReviewedCatalog({ outDir: catalogDir, hindsightConfig: { apiUrl: "https://memory.example", bankId: "upstream-bank" }, categories: ["config"] });
		await expect(apply()).rejects.toThrow("Local Hindsight configuration conflict");
		expect(await fs.readFile(configPath, "utf8")).toBe(localOverride);
	});
	it("refuses an edit after comparison without erasing the concurrent local edit", async () => {
		const first = path.join(agentDir, "first.md");
		const second = path.join(agentDir, "second.md");
		await fs.writeFile(first, "first before");
		await fs.writeFile(second, "second before");
		await expect(commitTransaction(agentDir, [
			{ root: agentDir, target: first, content: "first incoming" },
			{ root: agentDir, target: second, content: "second incoming" },
		], { rename: async (source, destination) => {
			await fs.rename(source, destination);
			if (destination === first) await fs.writeFile(second, "concurrent local edit");
		} })).rejects.toThrow("Local edit during apply");
		expect(await fs.readFile(first, "utf8")).toBe("first before");
		expect(await fs.readFile(second, "utf8")).toBe("concurrent local edit");
	});
	it("keeps incoming owned paths through repeat apply, clean update, local-only edits, and single divergence", async () => {
		const source = path.join(root, "source", "skills", "guide", "SKILL.md");
		const target = path.join(agentDir, "skills", "guide", "SKILL.md");
		await fs.mkdir(path.dirname(source), { recursive: true });
		await fs.writeFile(source, "baseline bytes");
		await exportSkills();
		expect((await apply()).success).toBe(true);
		const baseline = JSON.parse(await fs.readFile(path.join(agentDir, ".knowledge-baseline.json"), "utf8"));
		expect(baseline.itemDetails["skills/guide/SKILL.md"].category).toBe("skills");
		const repeated = await apply();
		expect(repeated.success).toBe(true);
		expect(repeated.comparison.deletes).toHaveLength(0);
		expect(await fs.readFile(target, "utf8")).toBe("baseline bytes");
		await fs.writeFile(source, "clean upstream update");
		await exportSkills();
		const update = await apply();
		expect(update.success).toBe(true);
		expect(update.comparison.updates).toHaveLength(1);
		expect(update.comparison.deletes).toHaveLength(0);
		expect(await fs.readFile(target, "utf8")).toBe("clean upstream update");
		await fs.writeFile(target, "saved local-only edit");
		const localOnly = await apply();
		expect(localOnly.success).toBe(true);
		expect(localOnly.conflictCount).toBe(0);
		expect(localOnly.comparison.deletes).toHaveLength(0);
		expect(await fs.readFile(target, "utf8")).toBe("saved local-only edit");
		await fs.writeFile(source, "divergent upstream update");
		await exportSkills();
		const divergent = await apply({ preserveConflicts: true });
		expect(divergent.success).toBe(false);
		expect(divergent.conflictCount).toBe(1);
		expect(divergent.comparison.conflicts).toHaveLength(1);
		expect(divergent.conflictFiles).toHaveLength(1);
		expect(await fs.readFile(target, "utf8")).toBe("saved local-only edit");
	});
	it("restores the complete apply state when baseline publication fails after asset and settings replacements", async () => {
		const source = path.join(root, "source", "skills", "guide", "SKILL.md");
		const target = path.join(agentDir, "skills", "guide", "SKILL.md");
		const configPath = path.join(agentDir, "config.yml");
		const baselinePath = path.join(agentDir, ".knowledge-baseline.json");
		await fs.mkdir(path.dirname(source), { recursive: true });
		await fs.writeFile(source, "prior skill");
		await exportReviewedCatalog({ agentDir: path.join(root, "source"), outDir: catalogDir, hindsightConfig: { apiUrl: "https://memory.example", bankId: "prior-bank" } });
		expect((await apply()).success).toBe(true);
		const configBefore = await fs.readFile(configPath);
		const baselineBefore = await fs.readFile(baselinePath);
		const referencePath = path.join(agentDir, "config", "hindsight-reference.json");
		const referenceBefore = await fs.readFile(referencePath);
		await fs.writeFile(source, "incoming skill");
		await exportReviewedCatalog({ agentDir: path.join(root, "source"), outDir: catalogDir, hindsightConfig: { apiUrl: "https://memory.example", bankId: "incoming-bank" } });
		let failedAtBaseline = false;
		await expect(apply({ transaction: { rename: async (from: PathLike, to: PathLike) => {
			if (to === baselinePath) {
				expect(await fs.readFile(target, "utf8")).toBe("incoming skill");
				expect(await fs.readFile(configPath, "utf8")).toContain("incoming-bank");
				failedAtBaseline = true;
				throw new Error("injected baseline publication failure");
			}
			await fs.rename(from, to);
		} } })).rejects.toThrow("injected baseline publication failure");
		expect(failedAtBaseline).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("prior skill");
		expect(await fs.readFile(configPath)).toEqual(configBefore);
		expect(await fs.readFile(referencePath)).toEqual(referenceBefore);
		expect(await fs.readFile(baselinePath)).toEqual(baselineBefore);
		await expect(fs.access(path.join(agentDir, ".knowledge-transaction.json"))).rejects.toThrow();
	});
});
