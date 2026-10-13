import * as fs from "node:fs/promises";
import { computeSha256 } from "./catalog";
import type {
	CatalogItem,
	ComparisonResult,
	ItemComparison,
	KnowledgeBaseline,
	KnowledgeManifest,
} from "./types";

export interface TargetPathResolver {
	(item: CatalogItem): string;
}

/**
 * Computes the SHA-256 hash of a file on disk, or returns undefined if ENOENT.
 */
async function getFileSha256(filePath: string): Promise<string | undefined> {
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return computeSha256(content);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/**
 * Checks if target directory has an authored version of a given skill name.
 */
async function targetHasAuthoredSkill(
	skillName: string,
	targetResolver: TargetPathResolver,
): Promise<boolean> {
	const authoredCandidate: CatalogItem = {
		category: "skills",
		relativePath: `skills/${skillName}/SKILL.md`,
		name: skillName,
		tier: "authored",
		sha256: "",
		size: 0,
	};
	const resolvedPath = targetResolver(authoredCandidate);
	try {
		await fs.access(resolvedPath);
		return true;
	} catch {
		// Also check single-file skill "skills/<name>.md"
		const fileCandidate: CatalogItem = {
			...authoredCandidate,
			relativePath: `skills/${skillName}.md`,
		};
		try {
			await fs.access(targetResolver(fileCandidate));
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Performs a 3-way comparison between incoming catalog, local target files, and baseline.
 */
export async function compareCatalogToTarget(
	incomingManifest: KnowledgeManifest,
	targetResolver: TargetPathResolver,
	baseline?: KnowledgeBaseline,
): Promise<ComparisonResult> {
	const items: ItemComparison[] = [];
	const conflicts: ItemComparison[] = [];
	const creates: ItemComparison[] = [];
	const updates: ItemComparison[] = [];
	const unchanged: ItemComparison[] = [];
	const deletes: ItemComparison[] = [];
	const shadowed: ItemComparison[] = [];

	const baselineItems = baseline?.items ?? {};
	const incomingPathSet = new Set<string>();

	// Track authored skill names in incoming manifest for precedence resolution
	const incomingAuthoredSkills = new Set<string>();
	for (const item of incomingManifest.items) {
		if (item.category === "skills" && (item.tier === "authored" || item.tier === undefined)) {
			incomingAuthoredSkills.add(item.name);
		}
	}

	for (const item of incomingManifest.items) {
		incomingPathSet.add(item.relativePath);
		const targetPath = targetResolver(item);
		const targetSha256 = await getFileSha256(targetPath);
		const targetExists = targetSha256 !== undefined;
		const baselineSha256 = baselineItems[item.relativePath];

		// 1. Authored-over-managed precedence rule
		if (item.category === "managed-skills" || item.tier === "managed") {
			// Check if incoming catalog also contains an authored version of the same skill
			if (incomingAuthoredSkills.has(item.name)) {
				const comparison: ItemComparison = {
					item,
					status: "PRECEDENCE_SHADOWED",
					targetExists,
					targetSha256,
					baselineSha256,
					incomingSha256: item.sha256,
					reason: `Managed skill '${item.name}' is shadowed by authored skill in incoming catalog`,
				};
				items.push(comparison);
				shadowed.push(comparison);
				continue;
			}

			// Check if target filesystem already has an authored version of this skill
			const targetHasAuthored = await targetHasAuthoredSkill(item.name, targetResolver);
			if (targetHasAuthored) {
				const comparison: ItemComparison = {
					item,
					status: "PRECEDENCE_SHADOWED",
					targetExists,
					targetSha256,
					baselineSha256,
					incomingSha256: item.sha256,
					reason: `Managed skill '${item.name}' is shadowed by existing authored skill at destination`,
				};
				items.push(comparison);
				shadowed.push(comparison);
				continue;
			}
		}

		// 2. Target does not exist
		if (!targetExists) {
			if (baselineSha256 === undefined) {
				// Clean create
				const comparison: ItemComparison = {
					item,
					status: "CREATE",
					targetExists: false,
					baselineSha256,
					incomingSha256: item.sha256,
				};
				items.push(comparison);
				creates.push(comparison);
			} else if (item.sha256 === baselineSha256) {
				// Local was deleted while baseline was unchanged; clean no-op / delete
				const comparison: ItemComparison = {
					item,
					status: "UNCHANGED",
					targetExists: false,
					baselineSha256,
					incomingSha256: item.sha256,
					reason: "Target was deleted locally and upstream is unchanged",
				};
				items.push(comparison);
				unchanged.push(comparison);
			} else {
				// Local deleted it, but upstream modified it! Conflict.
				const comparison: ItemComparison = {
					item,
					status: "CONFLICT",
					targetExists: false,
					baselineSha256,
					incomingSha256: item.sha256,
					reason: "Target was deleted locally, but modified upstream",
				};
				items.push(comparison);
				conflicts.push(comparison);
			}
			continue;
		}

		// 3. Target exists
		if (targetSha256 === item.sha256) {
			// Contents are identical
			const comparison: ItemComparison = {
				item,
				status: "UNCHANGED",
				targetExists: true,
				targetSha256,
				baselineSha256,
				incomingSha256: item.sha256,
			};
			items.push(comparison);
			unchanged.push(comparison);
			continue;
		}

		// Contents differ
		if (baselineSha256 !== undefined) {
			if (targetSha256 === baselineSha256) {
				// Clean update: target was not modified since baseline, incoming changed
				const comparison: ItemComparison = {
					item,
					status: "UPDATE",
					targetExists: true,
					targetSha256,
					baselineSha256,
					incomingSha256: item.sha256,
				};
				items.push(comparison);
				updates.push(comparison);
			} else {
				// DIVERGENT EDIT (CONFLICT): both target and incoming diverged from baseline!
				const comparison: ItemComparison = {
					item,
					status: "CONFLICT",
					targetExists: true,
					targetSha256,
					baselineSha256,
					incomingSha256: item.sha256,
					reason: `Divergent edit: both local target (${targetSha256.slice(0, 8)}) and incoming (${item.sha256.slice(0, 8)}) diverged from baseline (${baselineSha256.slice(0, 8)})`,
				};
				items.push(comparison);
				conflicts.push(comparison);
			}
		} else {
			// No baseline, but target file already exists with different content!
			const comparison: ItemComparison = {
				item,
				status: "CONFLICT",
				targetExists: true,
				targetSha256,
				baselineSha256: undefined,
				incomingSha256: item.sha256,
				reason: `Unbaselined collision: target exists (${targetSha256.slice(0, 8)}) and differs from incoming (${item.sha256.slice(0, 8)})`,
			};
			items.push(comparison);
			conflicts.push(comparison);
		}
	}

	// 4. Check for baseline items deleted in incoming catalog
	for (const [relPath, baseSha256] of Object.entries(baselineItems)) {
		if (incomingPathSet.has(relPath)) {
			continue;
		}

		// Synthetic item representing deleted baseline entry
		const deletedItem: CatalogItem = {
			category: "skills", // Default placeholder
			relativePath: relPath,
			name: path.basename(relPath),
			sha256: "",
			size: 0,
		};

		const targetPath = targetResolver(deletedItem);
		const targetSha256 = await getFileSha256(targetPath);

		if (targetSha256 === undefined) {
			// Already deleted locally
			continue;
		}

		if (targetSha256 === baseSha256) {
			// Clean delete: unmodified locally, deleted upstream
			const comparison: ItemComparison = {
				item: deletedItem,
				status: "DELETE",
				targetExists: true,
				targetSha256,
				baselineSha256: baseSha256,
				incomingSha256: "",
			};
			items.push(comparison);
			deletes.push(comparison);
		} else {
			// Conflict: modified locally, deleted upstream
			const comparison: ItemComparison = {
				item: deletedItem,
				status: "CONFLICT",
				targetExists: true,
				targetSha256,
				baselineSha256: baseSha256,
				incomingSha256: "",
				reason: `Conflict: target was modified locally (${targetSha256.slice(0, 8)}), but deleted upstream`,
			};
			items.push(comparison);
			conflicts.push(comparison);
		}
	}

	return {
		canApply: conflicts.length === 0,
		hasConflicts: conflicts.length > 0,
		items,
		conflicts,
		creates,
		updates,
		unchanged,
		deletes,
		shadowed,
	};
}
