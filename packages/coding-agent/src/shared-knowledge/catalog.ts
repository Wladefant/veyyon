import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	scanContentForSecrets,
	isForbiddenDatabaseFile,
	isForbiddenSecretFile,
	isForbiddenRuntimeFile,
	normalizeRelativePath,
	validateSecurityAllowlist,
} from "./allowlist";
import { extractHindsightReference, validateHindsightReference } from "./hindsight-reference";
import { assertSafePath } from "./safe-fs";
import { YAML } from "bun";
import {
	type CatalogItem,
	type ExportOptions,
	GENERATOR_ID,
	GENERATOR_VERSION,
	type HindsightReferenceConfig,
	KNOWLEDGE_CATEGORIES,
	KNOWLEDGE_SCHEMA_VERSION,
	type KnowledgeCategory,
	type KnowledgeManifest,
} from "./types";

/**
 * Computes the SHA-256 hash of string or Buffer content.
 */
export function computeSha256(content: string | Buffer): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Derives a logical item name from a relative path and category.
 */
export function deriveItemName(relativePath: string, category: KnowledgeCategory): string {
	const normalized = normalizeRelativePath(relativePath);
	const segments = normalized.split("/");

	if (category === "skills" || category === "managed-skills") {
		// e.g. "skills/my-skill/SKILL.md" -> "my-skill"
		// or "skills/my-skill.md" -> "my-skill"
		if (segments.length >= 2 && segments[0] === category) {
			const sub = segments[1];
			return sub.replace(/\.md$/i, "");
		}
	}

	const basename = path.basename(normalized);
	return basename.replace(/\.(md|mdc|py|mjs|sh|json|yml|yaml)$/i, "");
}

interface DiscoveredFile {
	relativePath: string;
	fullPath: string;
	size: number;
	content: string;
}

/**
 * Recursively scans a directory for regular files matching the security allowlist.
 */
async function scanDirectory(
	rootDir: string,
	category: KnowledgeCategory,
	subPath = "",
	reviewedPaths?: Set<string>,
	skippedPaths = new Set<string>(),
): Promise<DiscoveredFile[]> {
	const results: DiscoveredFile[] = [];
	const currentDir = path.join(rootDir, subPath);
	await assertSafePath(rootDir, currentDir);

	let entries: string[];
	try {
		entries = await fs.readdir(currentDir);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return results;
		}
		throw error;
	}

	for (const entry of entries) {
		const entryRel = subPath ? `${subPath}/${entry}` : entry;
		const fullPath = path.join(rootDir, entryRel);
		const catalogPath = `${category}/${entryRel}`;
		const stat = await fs.lstat(fullPath);
		if (!stat.isDirectory() && reviewedPaths && !reviewedPaths.has(catalogPath)) {
			skippedPaths.add(catalogPath);
			continue;
		}
		if (isForbiddenDatabaseFile(entryRel) || isForbiddenSecretFile(entryRel) || isForbiddenRuntimeFile(entryRel)) {
			if (reviewedPaths) skippedPaths.add(catalogPath);
			continue;
		}
		await assertSafePath(rootDir, fullPath);

		if (stat.isDirectory()) {
			const subResults = await scanDirectory(rootDir, category, entryRel, reviewedPaths, skippedPaths);
			results.push(...subResults);
		} else if (stat.isFile()) {
			if (!(await validateSecurityAllowlist(`${category}/${entryRel}`)).valid) continue;
			const content = await fs.readFile(fullPath, "utf-8");
			if (!scanContentForSecrets(content).valid) throw new Error("Credential-bearing knowledge source refused");

			const allowCheck = await validateSecurityAllowlist(`${category}/${entryRel}`, { fullPath, content });
			if (allowCheck.valid) {
				results.push({
					relativePath: normalizeRelativePath(entryRel),
					fullPath,
					size: stat.size,
					content,
				});
			}
		}
	}

	return results;
}

/** Never read bytes from a source that the plan did not select. */
async function readSelectedSource(root: string, fullPath: string, catalogPath: string, reviewedPaths: Set<string> | undefined, skippedPaths: Set<string>): Promise<string | undefined> {
	if (reviewedPaths && !reviewedPaths.has(catalogPath)) {
		try {
			await fs.lstat(fullPath);
			skippedPaths.add(catalogPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return undefined;
	}
	await assertSafePath(root, fullPath);
	return fs.readFile(fullPath, "utf-8");
}

/**
 * Collects all text knowledge catalog items from local directories according to options.
 */
export async function collectLocalKnowledge(options: ExportOptions, reviewedItems?: CatalogItem[]): Promise<{
	items: CatalogItem[];
	files: Map<string, string>; // relativePath -> content
	hindsightReference?: HindsightReferenceConfig;
	skippedPaths: string[];
}> {
	const items: CatalogItem[] = [];
	const files = new Map<string, string>();
	const enabledCategories = new Set(options.categories ?? KNOWLEDGE_CATEGORIES);
	const reviewedPaths = reviewedItems ? new Set(reviewedItems.map(item => item.relativePath)) : undefined;
	const skippedPaths = new Set<string>();

	const agentDir = options.agentDir;
	const globalDir = options.globalDir;
	const workflowsDir = options.workflowsDir;

	// 1. Authored skills
	if (enabledCategories.has("skills") && agentDir) {
		const skillsDir = path.join(agentDir, "skills");
		const discovered = await scanDirectory(skillsDir, "skills", "", reviewedPaths, skippedPaths);
		for (const file of discovered) {
			const catalogPath = `skills/${file.relativePath}`;
			const sha256 = computeSha256(file.content);
			const name = deriveItemName(catalogPath, "skills");
			items.push({
				category: "skills",
				relativePath: catalogPath,
				name,
				tier: "authored",
				sha256,
				size: file.size,
			});
			files.set(catalogPath, file.content);
		}
	}

	// 2. Managed skills
	if (enabledCategories.has("managed-skills") && agentDir) {
		const managedDir = path.join(agentDir, "managed-skills");
		const discovered = await scanDirectory(managedDir, "managed-skills", "", reviewedPaths, skippedPaths);
		for (const file of discovered) {
			const catalogPath = `managed-skills/${file.relativePath}`;
			const sha256 = computeSha256(file.content);
			const name = deriveItemName(catalogPath, "managed-skills");
			items.push({
				category: "managed-skills",
				relativePath: catalogPath,
				name,
				tier: "managed",
				sha256,
				size: file.size,
			});
			files.set(catalogPath, file.content);
		}
	}

	// 3. Learned lessons
	if (enabledCategories.has("lessons") && agentDir) {
		const candidatePaths = [
			path.join(agentDir, "memories", "learned.md"),
			path.join(agentDir, "learned.md"),
		];

		for (const candidate of candidatePaths) {
			try {
				const content = await readSelectedSource(agentDir, candidate, "lessons/learned.md", reviewedPaths, skippedPaths);
				if (content === undefined) continue;
				const allowCheck = await validateSecurityAllowlist("lessons/learned.md", { fullPath: candidate, content });
				if (!allowCheck.valid) throw new Error("Unsafe learned knowledge source");
				if (allowCheck.valid) {
					const catalogPath = "lessons/learned.md";
					const sha256 = computeSha256(content);
					items.push({
						category: "lessons",
						relativePath: catalogPath,
						name: "learned-lessons",
						sha256,
						size: Buffer.byteLength(content, "utf-8"),
					});
					files.set(catalogPath, content);
					break; // Pick the first available learned lessons file
				}
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code !== "ENOENT") throw error;
			}
		}
	}

	// 4. Rules
	if (enabledCategories.has("rules")) {
		if (agentDir) {
			const rulesDir = path.join(agentDir, "rules");
			const discovered = await scanDirectory(rulesDir, "rules", "", reviewedPaths, skippedPaths);
			for (const file of discovered) {
				const catalogPath = `rules/${file.relativePath}`;
				const sha256 = computeSha256(file.content);
				const name = deriveItemName(catalogPath, "rules");
				items.push({
					category: "rules",
					relativePath: catalogPath,
					name,
					sha256,
					size: file.size,
				});
				files.set(catalogPath, file.content);
			}

			// Profile AGENTS.md and RULES.md
			const profileFiles = ["AGENTS.md", "RULES.md"];
			for (const filename of profileFiles) {
				const full = path.join(agentDir, filename);
				try {
					const catalogPath = `rules/profile-${filename}`;
					const content = await readSelectedSource(agentDir, full, catalogPath, reviewedPaths, skippedPaths);
					if (content === undefined) continue;
					const allowCheck = await validateSecurityAllowlist(catalogPath, { fullPath: full, content });
					if (!allowCheck.valid) throw new Error("Unsafe profile knowledge source");
					if (allowCheck.valid) {
						items.push({
							category: "rules",
							relativePath: catalogPath,
							name: `profile-${filename.replace(/\.md$/i, "")}`,
							sha256: computeSha256(content),
							size: Buffer.byteLength(content, "utf-8"),
						});
						files.set(catalogPath, content);
					}
				} catch (error) {
					const err = error as NodeJS.ErrnoException;
					if (err.code !== "ENOENT") throw error;
				}
			}
		}

		if (globalDir) {
			// Global AGENTS.md
			const globalAgents = path.join(globalDir, "AGENTS.md");
			try {
				const catalogPath = "rules/global-AGENTS.md";
				const content = await readSelectedSource(globalDir, globalAgents, catalogPath, reviewedPaths, skippedPaths);
				if (content !== undefined) {
				const allowCheck = await validateSecurityAllowlist(catalogPath, { fullPath: globalAgents, content });
				if (!allowCheck.valid) throw new Error("Unsafe global knowledge source");
				if (allowCheck.valid) {
					items.push({
						category: "rules",
						relativePath: catalogPath,
						name: "global-AGENTS",
						sha256: computeSha256(content),
						size: Buffer.byteLength(content, "utf-8"),
					});
					files.set(catalogPath, content);
				}
				}
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code !== "ENOENT") throw error;
			}
		}
	}

	// 5. Workflows
	if (enabledCategories.has("workflows") && workflowsDir) {
		const discovered = await scanDirectory(workflowsDir, "workflows", "", reviewedPaths, skippedPaths);
		for (const file of discovered) {
			const catalogPath = `workflows/${file.relativePath}`;
			const sha256 = computeSha256(file.content);
			const name = deriveItemName(catalogPath, "workflows");
			items.push({
				category: "workflows",
				relativePath: catalogPath,
				name,
				sha256,
				size: file.size,
			});
			files.set(catalogPath, file.content);
		}
	}

	// 6. Reviewed Configuration & Hindsight reference
	let hindsightReference: HindsightReferenceConfig | undefined;
	if (enabledCategories.has("config") && (!reviewedPaths || reviewedPaths.has("config/hindsight-reference.json"))) {
		if (options.hindsightConfig) {
			const extracted = extractHindsightReference(options.hindsightConfig as Record<string, unknown>);
			if (extracted) {
				hindsightReference = extracted;
			}
		} else if (agentDir) {
			// Try reading agent config.yml if available
			const configPath = path.join(agentDir, "config.yml");
			try {
				await assertSafePath(agentDir, configPath);
				const raw = await fs.readFile(configPath, "utf-8");
				const parsedConfig: unknown = YAML.parse(raw);
				if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) throw new Error("Invalid settings object");
				const extracted = extractHindsightReference(parsedConfig as Record<string, unknown>);
				if (extracted) {
					hindsightReference = extracted;
				}
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code !== "ENOENT") throw error;
			}
		}

		if (hindsightReference) {
			const jsonText = `${JSON.stringify(hindsightReference, null, 2)}\n`;
			const catalogPath = "config/hindsight-reference.json";
			items.push({
				category: "config",
				relativePath: catalogPath,
				name: "hindsight-reference",
				sha256: computeSha256(jsonText),
				size: Buffer.byteLength(jsonText, "utf-8"),
			});
			files.set(catalogPath, jsonText);
		}
	}
	else if (enabledCategories.has("config") && reviewedPaths) {
		if (options.hindsightConfig) skippedPaths.add("config/hindsight-reference.json");
		else if (agentDir) await readSelectedSource(agentDir, path.join(agentDir, "config.yml"), "config/hindsight-reference.json", reviewedPaths, skippedPaths);
	}

	return { items, files, hindsightReference, skippedPaths: [...skippedPaths] };
}

/** Validate catalog and baseline item metadata without echoing its values. */
export async function validateCatalogItem(value: unknown): Promise<CatalogItem> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog item");
	const item = value as CatalogItem;
	if (Object.keys(item).some(key => !["category", "relativePath", "name", "tier", "sha256", "size"].includes(key)) ||
		!KNOWLEDGE_CATEGORIES.includes(item.category) ||
		typeof item.relativePath !== "string" || !item.relativePath.startsWith(`${item.category}/`) ||
		typeof item.name !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(item.name) ||
		typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
		!Number.isSafeInteger(item.size) || item.size < 0 ||
		(item.category === "skills" ? item.tier !== "authored" : item.category === "managed-skills" ? item.tier !== "managed" : item.tier !== undefined) ||
		!(await validateSecurityAllowlist(item.relativePath)).valid) throw new Error("Invalid catalog item fields");
	const expectedName = item.category === "lessons" ? "learned-lessons" : deriveItemName(item.relativePath, item.category);
	if (item.name !== expectedName || !scanContentForSecrets(JSON.stringify({ name: item.name, relativePath: item.relativePath })).valid) throw new Error("Invalid catalog item identity");
	return item;
}


async function validateCatalogManifest(value: unknown): Promise<KnowledgeManifest> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog manifest");
	const data = value as Record<string, unknown>;
	if (Object.keys(data).some(key => !["schemaVersion", "createdAt", "generator", "generatorVersion", "baselineId", "categories", "items", "hindsightReference"].includes(key)) ||
		data.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION || typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt)) ||
		data.generator !== GENERATOR_ID || typeof data.generatorVersion !== "string" ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(data.generatorVersion) ||
		(data.baselineId !== undefined && (typeof data.baselineId !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(data.baselineId))) ||
		!scanContentForSecrets(JSON.stringify({ generatorVersion: data.generatorVersion, baselineId: data.baselineId })).valid ||
		!Array.isArray(data.categories) || data.categories.some(category => !KNOWLEDGE_CATEGORIES.includes(category)) ||
		new Set(data.categories).size !== data.categories.length || !Array.isArray(data.items)) throw new Error("Invalid catalog manifest fields");
	if (new Date(data.createdAt as string).toISOString() !== data.createdAt) throw new Error("Invalid catalog timestamp");
	if (data.hindsightReference !== undefined) validateHindsightReference(data.hindsightReference);
	const manifest = data as unknown as KnowledgeManifest;
	const destinations = new Set<string>();
	for (const item of manifest.items) {
		await validateCatalogItem(item);
		if (!manifest.categories.includes(item.category)) throw new Error("Catalog item category is not declared");
		const destination = item.relativePath.toLowerCase();
		if (destinations.has(destination)) throw new Error("Duplicate catalog destination");
		destinations.add(destination);
	}
	if ((manifest.hindsightReference !== undefined) !== destinations.has("config/hindsight-reference.json")) throw new Error("Unbound Hindsight reference");
	return manifest;
}

/** Load a validated selection before reading any source bytes. */
export async function readReviewedPlanItems(planPath: string): Promise<CatalogItem[]> {
	if (typeof planPath !== "string" || !planPath) throw new Error("A reviewed export plan is required");
	await assertSafePath(path.dirname(path.resolve(planPath)), planPath);
	const plan = await validateCatalogManifest(JSON.parse(await fs.readFile(planPath, "utf-8")));
	return plan.items;
}

/** Approve exact reviewed bytes only; a plan never approves future discoveries. */
export async function validateReviewedPlan(planPath: string, candidates: CatalogItem[]): Promise<{ items: CatalogItem[]; skippedPaths: string[] }> {
	if (typeof planPath !== "string" || !planPath) throw new Error("A reviewed export plan is required");
	await assertSafePath(path.dirname(path.resolve(planPath)), planPath);
	const plan = await validateCatalogManifest(JSON.parse(await fs.readFile(planPath, "utf-8")));
	const current = new Map(candidates.map(item => [item.relativePath, item]));
	if (current.size !== candidates.length) throw new Error("Duplicate export candidates");
	const items: CatalogItem[] = [];
	for (const reviewed of plan.items) {
		const candidate = current.get(reviewed.relativePath);
		if (!candidate || candidate.sha256 !== reviewed.sha256 || candidate.category !== reviewed.category ||
			candidate.size !== reviewed.size || candidate.tier !== reviewed.tier || candidate.name !== reviewed.name) throw new Error("Reviewed source is missing or changed");
		await validateCatalogItem(candidate);
		items.push(candidate);
		current.delete(reviewed.relativePath);
	}
	if (plan.hindsightReference) {
		const referenceBytes = `${JSON.stringify(plan.hindsightReference, null, 2)}\n`;
		const referenceItem = items.find(item => item.relativePath === "config/hindsight-reference.json");
		if (!referenceItem || referenceItem.sha256 !== computeSha256(referenceBytes)) throw new Error("Reviewed reference differs from selected content");
	}
	return { items, skippedPaths: [...current.keys()] };
}

/**
 * Validates a catalog manifest and ensures all referenced items pass security allowlist checks.
 */
export async function readCatalog(catalogDir: string): Promise<{
	manifest: KnowledgeManifest;
	files: Map<string, string>;
}> {
	const manifestPath = path.join(catalogDir, "manifest.json");
	await assertSafePath(catalogDir, manifestPath);
	let manifestRaw: string;
	try {
		manifestRaw = await fs.readFile(manifestPath, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		throw new Error(`Cannot read catalog manifest at ${manifestPath}: ${err.message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestRaw);
	} catch {
		throw new Error(`Catalog manifest at ${manifestPath} is not valid JSON`);
	}

	const manifest = await validateCatalogManifest(parsed);

	const files = new Map<string, string>();

	for (const item of manifest.items) {

		const fullPath = path.join(catalogDir, item.relativePath);
		await assertSafePath(catalogDir, fullPath);

		let content: string;
		try {
			content = await fs.readFile(fullPath, "utf-8");
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			throw new Error(`Missing or unreadable catalog file ${item.relativePath}: ${err.message}`);
		}

		const actualSha256 = computeSha256(content);
		if (actualSha256 !== item.sha256) {
			throw new Error(
				`SHA-256 digest mismatch for ${item.relativePath}: expected ${item.sha256}, got ${actualSha256}`,
			);
		}
		if (Buffer.byteLength(content, "utf-8") !== item.size) throw new Error("Catalog file size mismatch");

		const allowCheck = await validateSecurityAllowlist(item.relativePath, { fullPath, content });
		if (!allowCheck.valid) {
			throw new Error(`Catalog file violates security allowlist: ${item.relativePath} (${allowCheck.reason})`);
		}

		files.set(item.relativePath, content);
	}

	const referenceText = files.get("config/hindsight-reference.json");
	if ((manifest.hindsightReference !== undefined) !== (referenceText !== undefined)) throw new Error("Unbound Hindsight reference");
	if (referenceText !== undefined) {
		const reference: unknown = JSON.parse(referenceText);
		validateHindsightReference(reference);
		const keys = Object.keys(reference).sort() as (keyof HindsightReferenceConfig)[];
		if (keys.length !== Object.keys(manifest.hindsightReference!).length ||
			keys.some(key => JSON.stringify(reference[key]) !== JSON.stringify(manifest.hindsightReference![key]))) throw new Error("Hindsight reference differs from verified content");
	}

	return { manifest, files };
}

/**
 * Builds a manifest object from items.
 */
export function buildManifest(
	items: CatalogItem[],
	categories: KnowledgeCategory[],
	hindsightReference?: HindsightReferenceConfig,
): KnowledgeManifest {
	return {
		schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
		createdAt: new Date().toISOString(),
		generator: GENERATOR_ID,
		generatorVersion: GENERATOR_VERSION,
		categories: [...categories],
		items: [...items],
		hindsightReference,
	};
}
