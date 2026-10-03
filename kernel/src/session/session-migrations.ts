// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import { Snowflake } from "@veyyon/utils/snowflake";
import type { ToolResultMigrationContext } from "../registry/tool-result-codec";
import { type CompactionEntry, CURRENT_SESSION_VERSION, type FileEntry, type SessionHeader } from "./session-entries";
import { hasPendingToolResultMigrations, migrateToolResultEntries } from "./tool-result-codecs";

/** Generate a unique short ID (8 hex chars, collision-checked). */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(-8);
		if (!byId.has(id)) return id;
	}
	return Snowflake.next();
}

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
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const target = entries[comp.firstKeptEntryIndex];
				if (target && target.type !== "session") comp.firstKeptEntryId = target.id;
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
		} else if (entry.type === "message") {
			const message = entry.message as { role?: string };
			if (message.role === "hookMessage") message.role = "custom";
		}
	}
}

/** Structural migrations are safe without storage; domain payloads wait for a writable owner. */
export function migrateSessionEntries(entries: FileEntry[]): void {
	const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;
	if (version >= CURRENT_SESSION_VERSION) return;
	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	if (header && !hasPendingToolResultMigrations(entries)) header.version = CURRENT_SESSION_VERSION;
}

/** Publish the representation version only after every registered domain migration succeeds. */
export async function migrateToCurrentVersion(
	entries: FileEntry[],
	context?: ToolResultMigrationContext,
): Promise<boolean> {
	const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;
	migrateSessionEntries(entries);
	const migrated = context ? await migrateToolResultEntries(entries, context) : false;
	if (header && !hasPendingToolResultMigrations(entries)) header.version = CURRENT_SESSION_VERSION;
	return migrated || header?.version !== version;
}
