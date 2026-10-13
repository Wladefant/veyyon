import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "@veyyon/utils";
import {
	validateSecurityAllowlist,
} from "./allowlist";
import {
	buildManifest,
	collectLocalKnowledge,
	computeSha256,
	readCatalog,
} from "./catalog";
import { compareCatalogToTarget, type TargetPathResolver } from "./comparator";
import {
	applyHindsightReference,
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
): Promise<{ manifest: KnowledgeManifest; exportedCount: number }> {
	const outDir = path.resolve(options.outDir);
	await fs.mkdir(outDir, { recursive: true });

	const { items, files, hindsightReference } = await collectLocalKnowledge(options);

	// Pre-flight security validation of all files to be exported
	for (const item of items) {
		const content = files.get(item.relativePath) ?? "";
		const allowCheck = await validateSecurityAllowlist(item.relativePath, { content });
		if (!allowCheck.valid) {
			throw new Error(`Export rejected by security allowlist for ${item.relativePath}: ${allowCheck.reason}`);
		}
	}

	// Write each asset file into outDir
	for (const item of items) {
		const content = files.get(item.relativePath) ?? "";
		const destPath = path.join(outDir, item.relativePath);
		await fs.mkdir(path.dirname(destPath), { recursive: true });
		await atomicWriteFile(destPath, content);
	}

	const categories = options.categories ?? [...KNOWLEDGE_CATEGORIES];
	const manifest = buildManifest(items, categories, hindsightReference);
	const manifestPath = path.join(outDir, "manifest.json");
	await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	return { manifest, exportedCount: items.length };
}

/**
 * Reads a baseline file if it exists, returning undefined if missing.
 */
export async function readBaseline(baselinePath: string): Promise<KnowledgeBaseline | undefined> {
	try {
		const raw = await fs.readFile(baselinePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "items" in parsed) {
			return parsed as KnowledgeBaseline;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Writes an updated baseline file.
 */
export async function writeBaseline(
	baselinePath: string,
	manifest: KnowledgeManifest,
): Promise<void> {
	const itemsRecord: Record<string, string> = {};
	for (const item of manifest.items) {
		itemsRecord[item.relativePath] = item.sha256;
	}

	const baseline: KnowledgeBaseline = {
		schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
		appliedAt: new Date().toISOString(),
		baselineId: computeSha256(`${manifest.createdAt}:${manifest.items.length}`).slice(0, 16),
		items: itemsRecord,
		hindsightReference: manifest.hindsightReference,
	};

	await fs.mkdir(path.dirname(baselinePath), { recursive: true });
	await atomicWriteFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

/**
 * Compares an incoming catalog against a local target directory without applying changes.
 */
export async function diffKnowledgeCatalog(
	options: ApplyOptions,
): Promise<ComparisonResult> {
	const { manifest } = await readCatalog(options.catalogDir);

	const roots = {
		agentDir: options.targetAgentDir ?? process.cwd(),
		globalDir: options.targetGlobalDir ?? process.cwd(),
		workflowsDir: options.targetWorkflowsDir ?? path.join(process.cwd(), "workflows"),
	};

	const resolver = createTargetPathResolver(roots);
	const baselinePath = options.baselinePath ?? path.join(roots.agentDir, BASELINE_FILENAME);
	const baseline = await readBaseline(baselinePath);

	return compareCatalogToTarget(manifest, resolver, baseline);
}

/**
 * Applies an incoming catalog to the local target filesystem.
 * Enforces atomicity, baseline comparison, and conflict preservation:
 * - If ANY item has a divergent edit (conflict), writes are refused.
 * - Both target file and incoming input are preserved.
 * - No partial application: all checks must pass before any file is written.
 */
export async function applyKnowledgeCatalog(
	options: ApplyOptions,
): Promise<ApplyResult> {
	const catalogDir = path.resolve(options.catalogDir);
	const { manifest, files } = await readCatalog(catalogDir);

	const roots = {
		agentDir: path.resolve(options.targetAgentDir ?? process.cwd()),
		globalDir: path.resolve(options.targetGlobalDir ?? process.cwd()),
		workflowsDir: path.resolve(options.targetWorkflowsDir ?? path.join(process.cwd(), "workflows")),
	};

	const resolver = createTargetPathResolver(roots);
	const baselinePath = path.resolve(options.baselinePath ?? path.join(roots.agentDir, BASELINE_FILENAME));
	const baseline = await readBaseline(baselinePath);

	// 1. Security allowlist pre-flight validation on all incoming files
	for (const item of manifest.items) {
		const content = files.get(item.relativePath) ?? "";
		const allowCheck = await validateSecurityAllowlist(item.relativePath, { content });
		if (!allowCheck.valid) {
			const comparison = await compareCatalogToTarget(manifest, resolver, baseline);
			return {
				success: false,
				appliedCount: 0,
				conflictCount: 0,
				comparison,
				writtenFiles: [],
				conflictFiles: [],
				errors: [`Security allowlist violation for '${item.relativePath}': ${allowCheck.reason}`],
			};
		}
	}

	// 2. 3-way baseline / target / incoming comparison
	const comparison = await compareCatalogToTarget(manifest, resolver, baseline);

	// 3. Conflict enforcement: conflicts refuse writes and preserve both inputs
	if (comparison.hasConflicts) {
		const conflictFiles: string[] = [];

		if (options.preserveConflicts) {
			// Save incoming conflicting files as `.conflict.<hash>` alongside the target file.
			// Target files remain completely untouched.
			for (const conflict of comparison.conflicts) {
				const destPath = resolver(conflict.item);
				const content = files.get(conflict.item.relativePath);
				if (content !== undefined) {
					const shortHash = conflict.incomingSha256.slice(0, 8);
					const conflictCopyPath = `${destPath}.conflict.${shortHash}`;
					await fs.mkdir(path.dirname(conflictCopyPath), { recursive: true });
					await atomicWriteFile(conflictCopyPath, content);
					conflictFiles.push(conflictCopyPath);
				}
			}
		}

		return {
			success: false,
			appliedCount: 0,
			conflictCount: comparison.conflicts.length,
			comparison,
			writtenFiles: [],
			conflictFiles,
			errors: [
				`Divergent edits detected in ${comparison.conflicts.length} item(s). Refusing to overwrite target files.`,
				...comparison.conflicts.map(c => `Conflict on ${c.item.relativePath}: ${c.reason ?? "Divergent content"}`),
			],
		};
	}

	// 4. Dry-run early exit
	if (options.dryRun) {
		return {
			success: true,
			appliedCount: comparison.creates.length + comparison.updates.length,
			conflictCount: 0,
			comparison,
			writtenFiles: [],
			conflictFiles: [],
			errors: [],
		};
	}

	// 5. Apply writes atomically across all non-shadowed items
	const writtenFiles: string[] = [];
	const itemsToApply = [...comparison.creates, ...comparison.updates];

	for (const op of itemsToApply) {
		const destPath = resolver(op.item);
		const content = files.get(op.item.relativePath);
		if (content === undefined) {
			throw new Error(`Missing content in memory for catalog item ${op.item.relativePath}`);
		}

		await fs.mkdir(path.dirname(destPath), { recursive: true });
		await atomicWriteFile(destPath, content);
		writtenFiles.push(destPath);
	}

	// 6. Handle clean deletes
	for (const op of comparison.deletes) {
		const destPath = resolver(op.item);
		try {
			await fs.unlink(destPath);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") throw error;
		}
	}

	// 7. Reviewed Hindsight configuration reference
	if (manifest.hindsightReference) {
		const configYmlPath = path.join(roots.agentDir, "config.yml");
		let existingConfig: Record<string, unknown> = {};
		try {
			const raw = await fs.readFile(configYmlPath, "utf-8");
			const lines = raw.split("\n");
			for (const line of lines) {
				const match = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*:\s*(.+)$/);
				if (match) {
					existingConfig[match[1].trim()] = match[2].trim().replace(/^['"]|['"]$/g, "");
				}
			}
		} catch {
			// No config.yml exists yet
		}

		const merged = applyHindsightReference(manifest.hindsightReference, existingConfig);
		const configOutLines = Object.entries(merged).map(([k, v]) => `${k}: ${v}`);
		await atomicWriteFile(configYmlPath, `${configOutLines.join("\n")}\n`);
		writtenFiles.push(configYmlPath);
	}

	// 8. Update baseline on successful apply
	await writeBaseline(baselinePath, manifest);

	return {
		success: true,
		appliedCount: itemsToApply.length,
		conflictCount: 0,
		comparison,
		writtenFiles,
		conflictFiles: [],
		errors: [],
	};
}
