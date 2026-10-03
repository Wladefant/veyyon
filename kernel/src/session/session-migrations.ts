// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import { truncateHeadBytes } from "@veyyon/utils/byte-truncate";
import { Snowflake } from "@veyyon/utils/snowflake";
import { type CompactionEntry, CURRENT_SESSION_VERSION, type FileEntry, type SessionHeader } from "./session-entries";

export const EVAL_DISPLAY_VERSION = 1;
const MAX_DISPLAY_TEXT_BYTES = 8000;
const DISPLAY_ELISION_RESERVE_BYTES = 64;

export interface SessionMigrationContext {
	saveArtifact?(content: string, toolType: string): Promise<string> | string;
}

function formatDisplayPreview(fullText: string): { previewText: string; totalBytes: number } {
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	const head = truncateHeadBytes(fullText, MAX_DISPLAY_TEXT_BYTES - DISPLAY_ELISION_RESERVE_BYTES);
	let elidedCodePoints = 0;
	for (let index = head.text.length; index < fullText.length; ) {
		const codePoint = fullText.codePointAt(index) ?? 0;
		elidedCodePoints += 1;
		index += codePoint > 0xffff ? 2 : 1;
	}
	const previewText = `${head.text}\n[…${elidedCodePoints}ch elided…]`;
	return { previewText, totalBytes };
}

function isOldBoundedPreview(
	value: unknown,
): value is { preview: string; truncated: true; totalBytes: number; artifactId?: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (
		typeof obj.preview === "string" &&
		obj.truncated === true &&
		typeof obj.totalBytes === "number" &&
		!("version" in obj)
	) {
		return obj.preview.includes("\n[…") && obj.preview.endsWith("ch elided…]");
	}
	return false;
}

export type EvalDisplayMigrationPlan =
	| { type: "unchanged"; value: unknown }
	| { type: "migrated"; value: Record<string, unknown> }
	| { type: "save_artifact"; fullText: string; previewText: string; totalBytes: number };

export function planEvalDisplayOutputMigration(value: unknown): EvalDisplayMigrationPlan {
	if (isOldBoundedPreview(value)) {
		const migrated: Record<string, unknown> = {
			version: EVAL_DISPLAY_VERSION,
			preview: value.preview,
			truncated: true,
			totalBytes: value.totalBytes,
		};
		if (typeof value.artifactId === "string") {
			migrated.artifactId = value.artifactId;
		} else {
			migrated.recoveryUnavailable = true;
		}
		return { type: "migrated", value: migrated };
	}

	let fullText: string;
	try {
		fullText = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		fullText = String(value);
	}
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= MAX_DISPLAY_TEXT_BYTES) {
		return { type: "unchanged", value };
	}

	const { previewText } = formatDisplayPreview(fullText);
	return {
		type: "save_artifact",
		fullText,
		previewText,
		totalBytes,
	};
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(-8);
		if (!byId.has(id)) return id;
	}
	return Snowflake.next(); // fallback to full snowflake id
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		if (entry.type === "message") {
			const msg = entry.message as { role?: string };
			if (msg.role === "hookMessage") {
				(entry.message as { role: string }).role = "custom";
			}
		}
	}
}
function createBoundedDisplayOutput(
	plan: Extract<EvalDisplayMigrationPlan, { type: "save_artifact" }>,
	artifactId: string,
): Record<string, unknown> {
	return {
		version: EVAL_DISPLAY_VERSION,
		preview: plan.previewText,
		truncated: true,
		totalBytes: plan.totalBytes,
		artifactId,
	};
}

interface EvalMigrationTarget {
	details: Record<string, unknown> & { jsonOutputs: unknown[] };
}

function collectV3ToV4Targets(entries: FileEntry[]): EvalMigrationTarget[] {
	const targets: EvalMigrationTarget[] = [];
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 4;
			continue;
		}

		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			toolName?: string;
			details?: Record<string, unknown>;
		};
		if (message.role !== "toolResult" || message.toolName !== "eval") continue;
		const details = message.details;
		if (!details || typeof details !== "object" || !Array.isArray(details.jsonOutputs)) continue;

		const displayVersion = details.displayVersion;
		if (displayVersion === EVAL_DISPLAY_VERSION) continue;
		if (displayVersion !== undefined && displayVersion !== 0) {
			throw new Error(`Unsupported eval display version: ${displayVersion}`);
		}

		targets.push({ details: details as Record<string, unknown> & { jsonOutputs: unknown[] } });
	}
	return targets;
}

function executePlansSync(
	plans: EvalDisplayMigrationPlan[],
	save: (plan: Extract<EvalDisplayMigrationPlan, { type: "save_artifact" }>) => string,
): unknown[] {
	return plans.map(plan => {
		if (plan.type === "unchanged" || plan.type === "migrated") return plan.value;
		return createBoundedDisplayOutput(plan, save(plan));
	});
}

async function executePlansAsync(
	plans: EvalDisplayMigrationPlan[],
	save: (plan: Extract<EvalDisplayMigrationPlan, { type: "save_artifact" }>) => Promise<string>,
): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const plan of plans) {
		if (plan.type === "unchanged" || plan.type === "migrated") {
			results.push(plan.value);
		} else {
			results.push(createBoundedDisplayOutput(plan, await save(plan)));
		}
	}
	return results;
}

/** Migrate v3 → v4: bound oversized eval jsonOutputs to versioned preview with durable artifact reference. */
async function migrateV3ToV4(entries: FileEntry[], context?: SessionMigrationContext): Promise<void> {
	for (const { details } of collectV3ToV4Targets(entries)) {
		const plans = details.jsonOutputs.map(planEvalDisplayOutputMigration);
		details.jsonOutputs = await executePlansAsync(plans, async plan => {
			if (!context?.saveArtifact) {
				throw new Error("Cannot migrate oversized eval display: no artifact storage available");
			}
			return await context.saveArtifact(plan.fullText, "eval-display");
		});
		details.displayVersion = EVAL_DISPLAY_VERSION;
	}
}

function migrateV3ToV4Sync(entries: FileEntry[], context?: SessionMigrationContext): void {
	for (const { details } of collectV3ToV4Targets(entries)) {
		const plans = details.jsonOutputs.map(planEvalDisplayOutputMigration);
		details.jsonOutputs = executePlansSync(plans, plan => {
			if (!context?.saveArtifact) {
				throw new Error("Cannot migrate oversized eval display: no artifact storage available");
			}
			const res = context.saveArtifact(plan.fullText, "eval-display");
			if (typeof res !== "string") {
				throw new Error("Cannot migrate oversized eval display synchronously: saveArtifact returned a Promise");
			}
			return res;
		});
		details.displayVersion = EVAL_DISPLAY_VERSION;
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
export async function migrateToCurrentVersion(
	entries: FileEntry[],
	context?: SessionMigrationContext,
): Promise<boolean> {
	const header = entries.find(e => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	if (version < 4) await migrateV3ToV4(entries, context);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[], context?: SessionMigrationContext): void {
	const header = entries.find(e => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	if (version < 4) migrateV3ToV4Sync(entries, context);
}
