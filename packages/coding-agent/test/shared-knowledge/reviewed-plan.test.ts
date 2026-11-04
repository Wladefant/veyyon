import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifest, collectLocalKnowledge, validateReviewedPlan } from "../../src/shared-knowledge/catalog";
import { exportKnowledgeCatalog } from "../../src/shared-knowledge/syncer";
import type { CatalogItem, ExportOptions, KnowledgeCategory } from "../../src/shared-knowledge/types";

describe("reviewed shared knowledge plans", () => {
	let root: string;
	let agentDir: string;
	let workflowsDir: string;
	let planPath: string;
	let outDir: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewed-plan-"));
		agentDir = path.join(root, "agent");
		workflowsDir = path.join(root, "workflows");
		planPath = path.join(root, "review", "plan.json");
		outDir = path.join(root, "catalog");
		await fs.mkdir(path.join(agentDir, "skills", "guide"), { recursive: true });
		await fs.mkdir(workflowsDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "skills", "guide", "SKILL.md"), "# Reviewed guide\n");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function options(extra: Record<string, unknown> = {}) {
		return {
			agentDir,
			workflowsDir,
			outDir,
			categories: ["skills", "workflows"] as KnowledgeCategory[],
			...extra,
		} as ExportOptions;
	}

	async function candidates() {
		return collectLocalKnowledge(options());
	}

	async function writePlan(items?: CatalogItem[]) {
		const collected = await candidates();
		await fs.mkdir(path.dirname(planPath), { recursive: true });
		await fs.writeFile(planPath, `${JSON.stringify(buildManifest(items ?? collected.items, ["skills", "workflows"]), null, 2)}\n`);
		return collected;
	}

	it("selects unchanged reviewed inputs", async () => {
		const collected = await writePlan();
		const result = await validateReviewedPlan(planPath, collected.items);

		expect(result.items).toEqual(collected.items);
		expect(result.skippedPaths).toEqual([]);
	});

	it("refuses a reviewed input whose hash changed", async () => {
		const collected = await writePlan();
		const changed = collected.items.map(item => ({ ...item, sha256: "0".repeat(64) }));

		await expect(validateReviewedPlan(planPath, changed)).rejects.toThrow("Reviewed source is missing or changed");
	});

	it("refuses a reviewed input whose source file is missing", async () => {
		const collected = await writePlan();
		await fs.rm(path.join(agentDir, "skills", "guide", "SKILL.md"));
		const current = await candidates();

		expect(current.items).toHaveLength(0);
		await expect(validateReviewedPlan(planPath, current.items)).rejects.toThrow("Reviewed source is missing or changed");
		// Keep candidates sourced from disk; the reviewed item's disappearance is the contract under test.
		expect(collected.items).toHaveLength(1);
	});

	it("skips newly discovered inputs without returning them", async () => {
		const reviewed = await writePlan();
		await fs.writeFile(path.join(workflowsDir, "new.py"), "print('new')\n");
		const current = await candidates();
		const result = await validateReviewedPlan(planPath, current.items);

		expect(result.items).toEqual(reviewed.items);
		expect(result.items.map(item => item.relativePath)).not.toContain("workflows/new.py");
		expect(result.skippedPaths).toEqual(["workflows/new.py"]);
	});

	it("refuses a missing review plan", async () => {
		const collected = await candidates();

		await expect(validateReviewedPlan(path.join(root, "absent.json"), collected.items)).rejects.toThrow();
	});

	it("rejects malformed plans with unknown fields", async () => {
		const collected = await writePlan();
		const malformed = { ...buildManifest(collected.items, ["skills", "workflows"]), unexpected: true };
		await fs.writeFile(planPath, JSON.stringify(malformed));

		await expect(validateReviewedPlan(planPath, collected.items)).rejects.toThrow();
	});

	it("refuses a real export when no reviewed plan exists and writes no output", async () => {
		await expect(exportKnowledgeCatalog(options())).rejects.toThrow();
		await expect(exportKnowledgeCatalog(options({ reviewedPlanPath: path.join(root, "absent.json") }))).rejects.toThrow();

		await expect(fs.access(outDir)).rejects.toThrow();
	});

	it("refuses changed reviewed files before creating export output", async () => {
		await exportKnowledgeCatalog(options({ planPath }));
		await fs.writeFile(path.join(agentDir, "skills", "guide", "SKILL.md"), "# Changed guide\n");

		await expect(exportKnowledgeCatalog(options({ reviewedPlanPath: planPath }))).rejects.toThrow("Reviewed source is missing or changed");
		await expect(fs.access(outDir)).rejects.toThrow();
	});

	it("exports only reviewed files and skips newly added files", async () => {
		await exportKnowledgeCatalog(options({ planPath }));
		await fs.writeFile(path.join(workflowsDir, "new.py"), "print('new')\n");

		const result = await exportKnowledgeCatalog(options({ reviewedPlanPath: planPath }));
		const output = await fs.readFile(path.join(outDir, "skills", "guide", "SKILL.md"), "utf8");

		expect(result.exportedCount).toBe(1);
		expect(result.skippedPaths).toEqual(["workflows/new.py"]);
		expect(output).toBe("# Reviewed guide\n");
		await expect(fs.access(path.join(outDir, "workflows", "new.py"))).rejects.toThrow();
	});

	it("skips unlisted secret content without exporting it", async () => {
		await exportKnowledgeCatalog(options({ planPath }));
		await fs.writeFile(path.join(workflowsDir, "private.py"), "apiToken = ordinary_plaintext_credential\n");
		const result = await exportKnowledgeCatalog(options({ reviewedPlanPath: planPath }));
		expect(result.exportedCount).toBe(1);
		expect(result.skippedPaths).toEqual(["workflows/private.py"]);
		await expect(fs.access(path.join(outDir, "workflows", "private.py"))).rejects.toThrow();
	});

	it("exports unchanged reviewed files", async () => {
		await exportKnowledgeCatalog(options({ planPath }));

		const result = await exportKnowledgeCatalog(options({ reviewedPlanPath: planPath }));
		const output = await fs.readFile(path.join(outDir, "skills", "guide", "SKILL.md"), "utf8");

		expect(result.exportedCount).toBe(1);
		expect(result.skippedPaths).toEqual([]);
		expect(output).toBe("# Reviewed guide\n");
	});
});
