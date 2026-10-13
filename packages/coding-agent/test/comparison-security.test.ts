import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeSha256 } from "../src/shared-knowledge/catalog";
import { compareCatalogToTarget } from "../src/shared-knowledge/comparator";
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
			const categories: CatalogItem["category"][] = ["skills", "managed-skills", "lessons", "rules", "workflows", "config"];
			const baselineItems = Object.fromEntries(categories.map((category) => [`${category}/item.md`, computeSha256("x")]));
			const itemDetails = Object.fromEntries(categories.map((category) => {
				const relativePath = `${category}/item.md`;
				return [relativePath, item(category, relativePath, computeSha256("x"))];
			}));
			const baseline: KnowledgeBaseline = {
				schemaVersion: 1,
				appliedAt: "2026-01-01T00:00:00.000Z",
				baselineId: "test",
				items: baselineItems,
				itemDetails,
			};
			const targets = new Map<string, string>();
			const resolver = (catalogItem: CatalogItem): string => {
				const destination = path.join(directory, `${catalogItem.category}-${path.basename(catalogItem.relativePath)}`);
				targets.set(catalogItem.relativePath, destination);
				return destination;
			};
			for (const category of categories) await fs.writeFile(resolver(item(category, `${category}/item.md`, computeSha256("x"))), "x");
			const result = await compareCatalogToTarget(emptyManifest(), resolver, baseline);
			expect(result.deletes.map(({ item: deleted }) => deleted.category).sort()).toEqual([...categories].sort());
			expect([...targets.values()].map((value) => path.basename(value))).toEqual(categories.map((category) => `${category}-item.md`));
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
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
