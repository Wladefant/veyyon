import type * as fs from "node:fs/promises";

/**
 * Core types for Veyyon shared text knowledge synchronization.
 */

export const KNOWLEDGE_SCHEMA_VERSION = 1;
export const GENERATOR_ID = "veyyon/shared-knowledge";
export const GENERATOR_VERSION = "1.0.0";

export const KNOWLEDGE_CATEGORIES = [
	"skills",
	"lessons",
	"managed-skills",
	"rules",
	"workflows",
	"config",
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export type SkillTier = "authored" | "managed";

/**
 * An item in the shared knowledge catalog.
 */
export interface CatalogItem {
	/** Category of the text knowledge asset */
	category: KnowledgeCategory;
	/** Normalized relative POSIX path within the catalog */
	relativePath: string;
	/** Logical item name (e.g. skill name, rule name, workflow name) */
	name: string;
	/** Tier for skills: authored vs managed */
	tier?: SkillTier;
	/** SHA-256 digest of file content */
	sha256: string;
	/** File size in bytes */
	size: number;
	/** Optional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Reviewed Hindsight memory configuration reference.
 * Strictly excludes any credentials or tokens.
 */
export interface HindsightReferenceConfig {
	backend: "hindsight";
	apiUrl?: string;
	bankId?: string;
	bankIdPrefix?: string;
	scoping?: string;
	bankMission?: string;
	retainMission?: string;
	autoRecall?: boolean;
	autoRetain?: boolean;
	retainMode?: string;
	recallTypes?: string[];
	_referenceNotice: string;
}

/**
 * Manifest describing an entire exported text knowledge catalog.
 */
export interface KnowledgeManifest {
	schemaVersion: number;
	createdAt: string;
	generator: string;
	generatorVersion: string;
	baselineId?: string;
	categories: KnowledgeCategory[];
	items: CatalogItem[];
	hindsightReference?: HindsightReferenceConfig;
}

/**
 * Baseline recording previously applied catalog items.
 */
export interface KnowledgeBaseline {
	schemaVersion: number;
	appliedAt: string;
	baselineId: string;
	items: Record<string, string>; // relativePath -> sha256
	/** Original catalog items keyed by relativePath; absent in legacy baselines. */
	itemDetails?: Record<string, CatalogItem>;
	hindsightReference?: HindsightReferenceConfig;
}

export type ComparisonStatus =
	| "CREATE"
	| "UPDATE"
	| "UNCHANGED"
	| "DELETE"
	| "CONFLICT"
	| "PRECEDENCE_SHADOWED";

export interface ItemComparison {
	item: CatalogItem;
	status: ComparisonStatus;
	targetExists: boolean;
	targetSha256?: string;
	baselineSha256?: string;
	incomingSha256: string;
	reason?: string;
}

export interface ComparisonResult {
	canApply: boolean;
	hasConflicts: boolean;
	items: ItemComparison[];
	conflicts: ItemComparison[];
	creates: ItemComparison[];
	updates: ItemComparison[];
	unchanged: ItemComparison[];
	deletes: ItemComparison[];
	shadowed: ItemComparison[];
}

export interface ExportOptions {
	categories?: KnowledgeCategory[];
	agentDir?: string;
	globalDir?: string;
	workflowsDir?: string;
	outDir: string;
	/** Write candidates to this review plan without creating a catalog. */
	planPath?: string;
	/** Require this reviewed plan for a real export. */
	reviewedPlanPath?: string;
	includeHindsightReference?: boolean;
	hindsightConfig?: Partial<HindsightReferenceConfig>;
}

export interface ApplyOptions {
	catalogDir: string;
	targetAgentDir?: string;
	targetGlobalDir?: string;
	targetWorkflowsDir?: string;
	baselinePath?: string;
	dryRun?: boolean;
	preserveConflicts?: boolean;
	categories?: KnowledgeCategory[];
	/** Per-operation filesystem seam for deterministic commit-failure verification. */
	transaction?: { rename?: typeof fs.rename };
}

export interface ApplyResult {
	success: boolean;
	appliedCount: number;
	conflictCount: number;
	comparison: ComparisonResult;
	writtenFiles: string[];
	conflictFiles: string[];
	errors: string[];
}
