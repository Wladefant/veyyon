import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeSha256 } from "../src/shared-knowledge/catalog";
import { compareCatalogToTarget } from "../src/shared-knowledge/comparator";
import { createTargetPathResolver } from "../src/shared-knowledge/syncer";
import type { CatalogItem, KnowledgeBaseline, KnowledgeManifest } from "../src/shared-knowledge/types";

const emptyManifest = (): KnowledgeManifest => ({
	schemaVersion: 1,
	createdAt: "2026-01-01T00:00:00.000Z",
	generator: "test",
	generatorVersion: "1",
	categories: [],
	items: [],
});

function item(category: CatalogItem["category"], relativePath: string, sha256: string): CatalogItem {
	return { category, relativePath, name: path.basename(relativePath), sha256, size: 1 };
}

describe("shared knowledge comparison security", () => {
	it("deletes using the original ownership and destination for every category", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-delete-categories-"));
		try {
			const roots = { agentDir: path.join(directory, "agent"), globalDir: path.join(directory, "global"), workflowsDir: path.join(directory, "workflows") };
			const hash = computeSha256("x");
			const owned: CatalogItem[] = [
				{ category: "skills", relativePath: "skills/guide/SKILL.md", name: "guide", tier: "authored", sha256: hash, size: 1 },
				{ category: "managed-skills", relativePath: "managed-skills/managed/SKILL.md", name: "managed", tier: "managed", sha256: hash, size: 1 },
				{ category: "lessons", relativePath: "lessons/learned.md", name: "learned-lessons", sha256: hash, size: 1 },
				{ category: "rules", relativePath: "rules/global-AGENTS.md", name: "global-AGENTS", sha256: hash, size: 1 },
				{ category: "workflows", relativePath: "workflows/audit.py", name: "audit", sha256: hash, size: 1 },
				{ category: "config", relativePath: "config/hindsight-reference.json", name: "hindsight-reference", sha256: hash, size: 1 },
			];
			const resolver = createTargetPathResolver(roots);
			const expected = [
				path.join(roots.agentDir, "skills", "guide", "SKILL.md"),
				path.join(roots.agentDir, "managed-skills", "managed", "SKILL.md"),
				path.join(roots.agentDir, "memories", "learned.md"),
				path.join(roots.globalDir, "AGENTS.md"),
				path.join(roots.workflowsDir, "audit.py"),
				path.join(roots.agentDir, "config", "hindsight-reference.json"),
			];
			for (const target of expected) {
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, "x");
			}
			const baseline: KnowledgeBaseline = {
				schemaVersion: 1, appliedAt: "2026-01-01T00:00:00.000Z", baselineId: "test",
				items: Object.fromEntries(owned.map(entry => [entry.relativePath, hash])),
				itemDetails: Object.fromEntries(owned.map(entry => [entry.relativePath, entry])),
			};
			const result = await compareCatalogToTarget(emptyManifest(), resolver, baseline);
			expect(result.deletes.map(({ item: deleted }) => deleted.category)).toEqual(owned.map(entry => entry.category));
			expect(result.deletes.map(entry => resolver(entry.item))).toEqual(expected);
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});

	it("does not infer ownership for legacy baseline entries", async () => {
		const baseline: KnowledgeBaseline = {
			schemaVersion: 1,
			appliedAt: "2026-01-01T00:00:00.000Z",
			baselineId: "legacy",
			items: { "rules/old.md": computeSha256("x") },
		};
		let resolved = false;
		const result = await compareCatalogToTarget(emptyManifest(), () => {
			resolved = true;
			return "unused";
		}, baseline);
		expect(result.deletes).toHaveLength(0);
		expect(resolved).toBe(false);
	});

	it("preserves a local-only edit while upstream remains at the baseline", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-local-only-"));
		try {
			const target = path.join(directory, "target.md");
			await fs.writeFile(target, "local edit");
			const baseSha256 = computeSha256("baseline");
			const incoming = item("rules", "rules/target.md", baseSha256);
			const result = await compareCatalogToTarget({ ...emptyManifest(), items: [incoming] }, () => target, {
				schemaVersion: 1,
				appliedAt: "2026-01-01T00:00:00.000Z",
				baselineId: "test",
				items: { [incoming.relativePath]: baseSha256 },
				itemDetails: { [incoming.relativePath]: incoming },
			});
			expect(result.canApply).toBe(true);
			expect(result.conflicts).toHaveLength(0);
			expect(result.unchanged).toHaveLength(1);
			expect(await fs.readFile(target, "utf8")).toBe("local edit");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
