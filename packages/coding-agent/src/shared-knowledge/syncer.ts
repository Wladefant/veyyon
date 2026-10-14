import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "@veyyon/utils/file-lock";
import { loadYaml, syncYamlTextToSettings } from "@veyyon/utils/yaml-sync";
import { assertSafePath, commitTransaction, recoverTransaction, type FileChange } from "./safe-fs";
import {
	validateSecurityAllowlist,
} from "./allowlist";
import {
	buildManifest,
	collectLocalKnowledge,
	computeSha256,
	readCatalog,
	readReviewedPlanItems,
	validateCatalogItem,
	validateReviewedPlan,
} from "./catalog";
import { compareCatalogToTarget, type TargetPathResolver } from "./comparator";
import {
	applyHindsightReference,
	extractHindsightReference,
	isHindsightReferenceConfig,
} from "./hindsight-reference";
import {
	type ApplyOptions,
	type ApplyResult,
	type CatalogItem,
	type ComparisonResult,
	type ExportOptions,
	KNOWLEDGE_CATEGORIES,
	KNOWLEDGE_SCHEMA_VERSION,
	type KnowledgeBaseline,
	type KnowledgeManifest,
} from "./types";

const BASELINE_FILENAME = ".knowledge-baseline.json";

/**
 * Resolves where a catalog item lands on the local target filesystem.
 */
export function createTargetPathResolver(roots: {
	agentDir: string;
	globalDir: string;
	workflowsDir: string;
}): TargetPathResolver {
	return (item: CatalogItem): string => {
		const rel = item.relativePath;

		if (item.category === "skills" || item.category === "managed-skills") {
			return path.join(roots.agentDir, rel);
		}

		if (item.category === "lessons") {
			return path.join(roots.agentDir, "memories", "learned.md");
		}

		if (item.category === "rules") {
			if (rel === "rules/profile-AGENTS.md") {
				return path.join(roots.agentDir, "AGENTS.md");
			}
			if (rel === "rules/profile-RULES.md") {
				return path.join(roots.agentDir, "RULES.md");
			}
			if (rel === "rules/global-AGENTS.md") {
				return path.join(roots.globalDir, "AGENTS.md");
			}
			return path.join(roots.agentDir, rel);
		}

		if (item.category === "workflows") {
			const subPath = rel.replace(/^workflows\//, "");
			return path.join(roots.workflowsDir, subPath);
		}

		if (item.category === "config") {
			return path.join(roots.agentDir, rel);
		}

		return path.join(roots.agentDir, rel);
	};
}

/**
 * Exports local reviewed text knowledge assets into a versioned catalog directory.
 */
export async function exportKnowledgeCatalog(
	options: ExportOptions,
): Promise<{ manifest: KnowledgeManifest; exportedCount: number; skippedPaths: string[] }> {
	if (!options.planPath && !options.reviewedPlanPath) throw new Error("A reviewed export plan is required");
	const reviewedItems = options.reviewedPlanPath ? await readReviewedPlanItems(options.reviewedPlanPath) : undefined;
	const collected = await collectLocalKnowledge(options, reviewedItems);
	const categories = options.categories ?? [...KNOWLEDGE_CATEGORIES];
	if (options.planPath) {
		if (options.reviewedPlanPath) throw new Error("Use either plan or reviewed-plan, not both");
		const planPath = path.resolve(options.planPath);
		const planRoot = path.dirname(planPath);
		await assertSafePath(planRoot, planPath);
		const manifest = buildManifest(collected.items, categories, collected.hindsightReference);
		await fs.mkdir(planRoot, { recursive: true });
		await withFileLock(path.join(planRoot, ".knowledge-apply"), async () => {
			await recoverTransaction(planRoot);
			await commitTransaction(planRoot, [{ root: planRoot, target: planPath, content: `${JSON.stringify(manifest, null, 2)}\n` }]);
		});
		return { manifest, exportedCount: 0, skippedPaths: [] };
	}
	const validated = await validateReviewedPlan(options.reviewedPlanPath!, collected.items);
	const items = validated.items;
	const skippedPaths = [...new Set([...collected.skippedPaths, ...validated.skippedPaths])];
	const files = new Map(items.map(item => [item.relativePath, collected.files.get(item.relativePath)!]));
	const hindsightReference = items.some(item => item.relativePath === "config/hindsight-reference.json") ? collected.hindsightReference : undefined;
	const outDir = path.resolve(options.outDir);
	await assertSafePath(outDir, outDir);

	// Pre-flight security validation of all files to be exported
	for (const item of items) {
		const content = files.get(item.relativePath) ?? "";
		const allowCheck = await validateSecurityAllowlist(item.relativePath, { content });
		if (!allowCheck.valid) {
			throw new Error(`Export rejected by security allowlist for ${item.relativePath}: ${allowCheck.reason}`);
		}
	}

	await fs.mkdir(outDir, { recursive: true });
	// Write each asset file into outDir
	const changes: FileChange[] = [];
	for (const item of items) {
		const content = files.get(item.relativePath) ?? "";
		const destPath = path.join(outDir, item.relativePath);
		await assertSafePath(outDir, destPath);
		changes.push({ root: outDir, target: destPath, content });
	}

	const manifest = buildManifest(items, categories, hindsightReference);
	const manifestPath = path.join(outDir, "manifest.json");
	await assertSafePath(outDir, manifestPath);
	changes.push({ root: outDir, target: manifestPath, content: `${JSON.stringify(manifest, null, 2)}\n` });
	await withFileLock(path.join(outDir, ".knowledge-apply"), async () => {
		await recoverTransaction(outDir);
		await commitTransaction(outDir, changes);
	});

	return { manifest, exportedCount: items.length, skippedPaths };
}

/**
 * Reads a baseline file if it exists, returning undefined if missing.
 */
export async function readBaseline(baselinePath: string): Promise<KnowledgeBaseline | undefined> {
	await assertSafePath(path.dirname(baselinePath), baselinePath);
	if (path.extname(baselinePath).toLowerCase() !== ".json") throw new Error("Baseline must be a JSON file");
	try {
		const parsed = JSON.parse(await fs.readFile(baselinePath, "utf-8")) as KnowledgeBaseline;
		if (parsed.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION || !parsed.items || typeof parsed.items !== "object" || Array.isArray(parsed.items)) throw new Error("Invalid knowledge baseline");
		if (parsed.hindsightReference && !isHindsightReferenceConfig(parsed.hindsightReference)) throw new Error("Invalid baseline reference");
		for (const [relativePath, hash] of Object.entries(parsed.items)) {
			const check = await validateSecurityAllowlist(relativePath);
			if (!check.valid || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid baseline ownership");
		}
		for (const [key, value] of Object.entries(parsed.itemDetails ?? {})) {
			const item = await validateCatalogItem(value);
			if (item.relativePath !== key || item.sha256 !== parsed.items[key]) throw new Error("Invalid baseline item identity");
		}
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function baselineText(manifest: KnowledgeManifest): string {
	const baseline: KnowledgeBaseline = {
		schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
		appliedAt: new Date().toISOString(),
		baselineId: computeSha256(JSON.stringify(manifest.items)).slice(0, 16),
		items: Object.fromEntries(manifest.items.map(item => [item.relativePath, item.sha256])),
		itemDetails: Object.fromEntries(manifest.items.map(item => [item.relativePath, item])),
		hindsightReference: manifest.hindsightReference,
	};
	return `${JSON.stringify(baseline, null, 2)}\n`;
}

export async function writeBaseline(baselinePath: string, manifest: KnowledgeManifest): Promise<void> {
	if (path.extname(baselinePath).toLowerCase() !== ".json") throw new Error("Baseline must be a JSON file");
	for (const item of manifest.items) await validateCatalogItem(item);
	if (manifest.hindsightReference && !isHindsightReferenceConfig(manifest.hindsightReference)) throw new Error("Invalid baseline reference");
	const root = path.dirname(path.resolve(baselinePath));
	await assertSafePath(root, baselinePath);
	await fs.mkdir(root, { recursive: true });
	await withFileLock(baselinePath, async () => {
		await recoverTransaction(root);
		await commitTransaction(root, [{ root, target: baselinePath, content: baselineText(manifest) }]);
	});
}

export async function diffKnowledgeCatalog(options: ApplyOptions): Promise<ComparisonResult> {
	return (await applyKnowledgeCatalog({ ...options, dryRun: true, preserveConflicts: false })).comparison;
}

/** Compare and commit under shared root and settings locks. Never write through aliases. */
export async function applyKnowledgeCatalog(options: ApplyOptions): Promise<ApplyResult> {
	const { manifest: complete, files } = await readCatalog(path.resolve(options.catalogDir));
	const roots = {
		agentDir: path.resolve(options.targetAgentDir ?? process.cwd()),
		globalDir: path.resolve(options.targetGlobalDir ?? process.cwd()),
		workflowsDir: path.resolve(options.targetWorkflowsDir ?? path.join(process.cwd(), "workflows")),
	};
	const baselinePath = path.resolve(options.baselinePath ?? path.join(roots.agentDir, BASELINE_FILENAME));
	if (path.extname(baselinePath).toLowerCase() !== ".json") throw new Error("Baseline must be a JSON file");
	await assertSafePath(roots.agentDir, baselinePath);
	const configPath = path.join(roots.agentDir, "config.yml");
	const selected = options.categories ?? [...KNOWLEDGE_CATEGORIES];
	if (selected.some(category => !KNOWLEDGE_CATEGORIES.includes(category))) throw new Error("Unknown knowledge category");
	const manifest: KnowledgeManifest = {
		...complete,
		items: complete.items.filter(item => selected.includes(item.category)),
		hindsightReference: selected.includes("config") ? complete.hindsightReference : undefined,
	};
	const rootFor = (item: CatalogItem): string => item.category === "workflows" ? roots.workflowsDir : item.relativePath === "rules/global-AGENTS.md" ? roots.globalDir : roots.agentDir;
	const resolver = createTargetPathResolver(roots);
	const execute = async (): Promise<ApplyResult> => {
		if (!options.dryRun) await recoverTransaction(roots.agentDir, Object.values(roots));
		const fullBaseline = await readBaseline(baselinePath);
		const baseline = fullBaseline ? {
			...fullBaseline,
			items: Object.fromEntries(Object.entries(fullBaseline.items).filter(([key]) => {
				const item = fullBaseline.itemDetails?.[key];
				return item && selected.includes(item.category);
			})),
		} : undefined;
		const allItems = [...manifest.items, ...Object.values(baseline?.itemDetails ?? {}).filter(item => selected.includes(item.category))];
		const destinations = new Set<string>();
		for (const item of allItems) {
			const check = await validateSecurityAllowlist(item.relativePath, { content: files.get(item.relativePath) });
			if (!check.valid) throw new Error("Unsafe knowledge item");
			await assertSafePath(rootFor(item), resolver(item));
			if (manifest.items.includes(item)) {
				const key = resolver(item).toLowerCase();
				if (destinations.has(key)) throw new Error("Duplicate knowledge destination");
				destinations.add(key);
			}
			if (item.category === "managed-skills") {
				await assertSafePath(roots.agentDir, path.join(roots.agentDir, "skills", item.name, "SKILL.md"));
				await assertSafePath(roots.agentDir, path.join(roots.agentDir, "skills", `${item.name}.md`));
			}
		}
		await assertSafePath(roots.agentDir, configPath);
		const comparison = await compareCatalogToTarget(manifest, resolver, baseline);
		const changes: FileChange[] = [];
		let configContent: string | undefined;
		let configExpectedHash: string | null = null;
		if (manifest.hindsightReference) {
			if (!isHindsightReferenceConfig(manifest.hindsightReference)) throw new Error("Invalid Hindsight reference");
			let raw = "";
			let configExists = true;
			try { raw = await fs.readFile(configPath, "utf-8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; configExists = false; }
			const yaml = loadYaml();
			const doc = yaml.parseDocument(raw, { uniqueKeys: true });
			configExpectedHash = configExists ? computeSha256(raw) : null;
			if (doc.errors.length || doc.warnings.length || (doc.contents !== null && !yaml.isMap(doc.contents))) throw new Error("Invalid configuration YAML");
			const current = (doc.toJS({ maxAliasCount: 0 }) ?? {}) as Record<string, unknown>;
			const localReference = extractHindsightReference(current);
			const incoming = manifest.hindsightReference;
			const oldReference = fullBaseline?.hindsightReference;
			const memory = current.memory as Record<string, unknown> | undefined;
			const configuredBackend = current["memory.backend"] ?? memory?.backend;
			if ((!localReference && oldReference && JSON.stringify(incoming) !== JSON.stringify(oldReference)) ||
				(!oldReference && configuredBackend !== undefined && configuredBackend !== "hindsight")) throw new Error("Local memory backend conflict");
			if (localReference && JSON.stringify(localReference) !== JSON.stringify(incoming)) {
				if (!oldReference || (JSON.stringify(localReference) !== JSON.stringify(oldReference) && JSON.stringify(incoming) !== JSON.stringify(oldReference))) throw new Error("Local Hindsight configuration conflict");
			}
			if (!oldReference || JSON.stringify(incoming) !== JSON.stringify(oldReference)) configContent = syncYamlTextToSettings(raw, applyHindsightReference(incoming, current));
		}
		if (comparison.hasConflicts) {
			const conflictFiles: string[] = [];
			if (options.preserveConflicts && !options.dryRun) {
				for (const conflict of comparison.conflicts) {
					const content = files.get(conflict.item.relativePath);
					if (content === undefined) continue;
					const target = `${resolver(conflict.item)}.conflict.${conflict.incomingSha256.slice(0, 8)}`;
					changes.push({ root: rootFor(conflict.item), target, content });
					conflictFiles.push(target);
				}
				await commitTransaction(roots.agentDir, changes, options.transaction);
			}
			return { success: false, appliedCount: 0, conflictCount: comparison.conflicts.length, comparison, writtenFiles: [], conflictFiles, errors: ["Divergent edits detected; target files preserved"] };
		}
		const applied = [...comparison.creates, ...comparison.updates];
		if (options.dryRun) return { success: true, appliedCount: applied.length, conflictCount: 0, comparison, writtenFiles: [], conflictFiles: [], errors: [] };
		for (const op of applied) {
			const content = files.get(op.item.relativePath);
			if (content === undefined) throw new Error("Missing verified catalog content");
			changes.push({ root: rootFor(op.item), target: resolver(op.item), content, expectedHash: op.targetSha256 ?? null });
		}
		for (const op of comparison.deletes) changes.push({ root: rootFor(op.item), target: resolver(op.item), expectedHash: op.targetSha256 ?? null });
		if (configContent !== undefined) changes.push({ root: roots.agentDir, target: configPath, content: configContent, expectedHash: configExpectedHash });
		const retained = Object.values(fullBaseline?.itemDetails ?? {}).filter(item => !selected.includes(item.category));
		const owned = manifest.items.filter(item => !comparison.shadowed.some(op => op.item.relativePath === item.relativePath));
		const nextManifest = { ...complete, items: [...retained, ...owned], hindsightReference: selected.includes("config") ? manifest.hindsightReference : fullBaseline?.hindsightReference };
		const nextBaseline = JSON.parse(baselineText(nextManifest)) as KnowledgeBaseline;
		for (const [key, hash] of Object.entries(fullBaseline?.items ?? {})) {
			if (!fullBaseline?.itemDetails?.[key]) nextBaseline.items[key] = hash;
		}
		changes.push({ root: roots.agentDir, target: baselinePath, content: `${JSON.stringify(nextBaseline, null, 2)}\n` });
		await commitTransaction(roots.agentDir, changes, options.transaction);
		return { success: true, appliedCount: applied.length, conflictCount: 0, comparison, writtenFiles: changes.map(change => change.target), conflictFiles: [], errors: [] };
	};
	for (const root of Object.values(roots)) await assertSafePath(root, root);
	if (options.dryRun) return execute();
	for (const root of Object.values(roots)) await fs.mkdir(root, { recursive: true });
	const lockPaths = [...new Set(Object.values(roots).map(root => path.join(root, ".knowledge-apply"))), configPath, baselinePath].sort();
	const locked = async (index: number): Promise<ApplyResult> => index === lockPaths.length ? execute() : withFileLock(lockPaths[index], () => locked(index + 1));
	return locked(0);
}
