import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	assertNotSymlink,
	normalizeRelativePath,
	validateRelativePath,
	validateSecurityAllowlist,
} from "./allowlist";
import { extractHindsightReference } from "./hindsight-reference";
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
	type SkillTier,
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
	subPath = "",
): Promise<DiscoveredFile[]> {
	const results: DiscoveredFile[] = [];
	const currentDir = path.join(rootDir, subPath);

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

		// Symlink rejection
		const symlinkCheck = await assertNotSymlink(fullPath);
		if (!symlinkCheck.valid) {
			continue;
		}

		let stat;
		try {
			stat = await fs.stat(fullPath);
		} catch {
			continue;
		}

		if (stat.isDirectory()) {
			const subResults = await scanDirectory(rootDir, entryRel);
			results.push(...subResults);
		} else if (stat.isFile()) {
			let content = "";
			try {
				content = await fs.readFile(fullPath, "utf-8");
			} catch {
				continue;
			}

			const allowCheck = await validateSecurityAllowlist(entryRel, { fullPath, content });
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

/**
 * Collects all text knowledge catalog items from local directories according to options.
 */
export async function collectLocalKnowledge(options: ExportOptions): Promise<{
	items: CatalogItem[];
	files: Map<string, string>; // relativePath -> content
	hindsightReference?: HindsightReferenceConfig;
}> {
	const items: CatalogItem[] = [];
	const files = new Map<string, string>();
	const enabledCategories = new Set(options.categories ?? KNOWLEDGE_CATEGORIES);

	const agentDir = options.agentDir;
	const globalDir = options.globalDir;
	const workflowsDir = options.workflowsDir;

	// 1. Authored skills
	if (enabledCategories.has("skills") && agentDir) {
		const skillsDir = path.join(agentDir, "skills");
		const discovered = await scanDirectory(skillsDir);
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
		const discovered = await scanDirectory(managedDir);
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
				const content = await fs.readFile(candidate, "utf-8");
				const allowCheck = await validateSecurityAllowlist("lessons/learned.md", { fullPath: candidate, content });
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
			const discovered = await scanDirectory(rulesDir);
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
					const content = await fs.readFile(full, "utf-8");
					const catalogPath = `rules/profile-${filename}`;
					const allowCheck = await validateSecurityAllowlist(catalogPath, { fullPath: full, content });
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
				const content = await fs.readFile(globalAgents, "utf-8");
				const catalogPath = "rules/global-AGENTS.md";
				const allowCheck = await validateSecurityAllowlist(catalogPath, { fullPath: globalAgents, content });
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
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code !== "ENOENT") throw error;
			}
		}
	}

	// 5. Workflows
	if (enabledCategories.has("workflows") && workflowsDir) {
		const discovered = await scanDirectory(workflowsDir);
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
	if (enabledCategories.has("config")) {
		if (options.hindsightConfig) {
			const extracted = extractHindsightReference(options.hindsightConfig as Record<string, unknown>);
			if (extracted) {
				hindsightReference = extracted;
			}
		} else if (agentDir) {
			// Try reading agent config.yml if available
			const configPath = path.join(agentDir, "config.yml");
			try {
				const raw = await fs.readFile(configPath, "utf-8");
				// Parse key-value lines for hindsight settings
				const parsedConfig: Record<string, unknown> = {};
				const lines = raw.split("\n");
				for (const line of lines) {
					const match = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*:\s*(.+)$/);
					if (match) {
						const key = match[1].trim();
						let val: unknown = match[2].trim().replace(/^['"]|['"]$/g, "");
						if (val === "true") val = true;
						if (val === "false") val = false;
						parsedConfig[key] = val;
					}
				}
				const extracted = extractHindsightReference(parsedConfig);
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

	return { items, files, hindsightReference };
}

/**
 * Validates a catalog manifest and ensures all referenced items pass security allowlist checks.
 */
export async function readCatalog(catalogDir: string): Promise<{
	manifest: KnowledgeManifest;
	files: Map<string, string>;
}> {
	const manifestPath = path.join(catalogDir, "manifest.json");
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

	if (!parsed || typeof parsed !== "object" || !("schemaVersion" in parsed) || !("items" in parsed)) {
		throw new Error(`Catalog manifest at ${manifestPath} has invalid structure`);
	}

	const manifest = parsed as KnowledgeManifest;
	if (manifest.schemaVersion > KNOWLEDGE_SCHEMA_VERSION) {
		throw new Error(
			`Catalog schema version ${manifest.schemaVersion} is newer than supported ${KNOWLEDGE_SCHEMA_VERSION}`,
		);
	}

	const files = new Map<string, string>();

	for (const item of manifest.items) {
		const pathCheck = validateRelativePath(item.relativePath);
		if (!pathCheck.valid) {
			throw new Error(`Catalog item has invalid relative path '${item.relativePath}': ${pathCheck.reason}`);
		}

		const fullPath = path.join(catalogDir, item.relativePath);
		const symlinkCheck = await assertNotSymlink(fullPath);
		if (!symlinkCheck.valid) {
			throw new Error(`Catalog file is a forbidden symlink: ${item.relativePath}`);
		}

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

		const allowCheck = await validateSecurityAllowlist(item.relativePath, { fullPath, content });
		if (!allowCheck.valid) {
			throw new Error(`Catalog file violates security allowlist: ${item.relativePath} (${allowCheck.reason})`);
		}

		files.set(item.relativePath, content);
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
