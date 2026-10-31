/**
 * An explicitly loaded, opt-in task-record compaction policy for the continuity pilot.
 * It uses the ordinary compaction commit path: execution/session/job ownership never moves.
 * The operator supplies the small record; exact branch evidence is archived before returning
 * a replacement. A missing, stale or unarchivable record cancels this attempted compaction.
 */
import { createHash } from "node:crypto";
import { resolveServerCompactionTransport } from "@veyyon/agent-core/compaction";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { ReadonlySessionManager } from "@veyyon/kernel/session/session-manager";
import { z } from "zod";
import type { SessionBeforeCompactEvent, SessionBeforeCompactResult } from "../shared-events";
import type { BuiltinExtensionAPI, ExtensionContext } from "./types";

export const TASK_RECORD_TYPE = "continuity-task-record-v1";
export const TASK_RECORD_FLAG = "task-record-context";
export const MAX_TASK_RECORD_BYTES = 12 * 1024;
export const MAX_TASK_ARCHIVE_BYTES = 8 * 1024 * 1024;

const shortText = z.string().min(1).max(512);
const identifier = z.string().min(1).max(128);
const taskRecordSchema = z.object({
	version: z.literal(1),
	objective: z.string().min(1).max(2048),
	constraints: z.array(shortText).max(16),
	facts: z.array(shortText).max(16),
	completed: z.array(z.object({
		id: identifier,
		summary: shortText,
		evidence: z.array(z.string().min(1).max(256)).max(4),
	}).strict()).max(32),
	pending: z.array(z.object({
		id: identifier,
		kind: z.enum(["tool", "job", "subagent"]),
		ownerSessionId: identifier,
	}).strict()).max(16),
	nextActions: z.array(shortText).max(16),
}).strict();

export type ContinuityTaskRecord = z.infer<typeof taskRecordSchema>;

const storedRecordSchema = z.object({
	version: z.literal(1),
	sessionId: identifier,
	coveredThroughEntryId: identifier,
	latestUserEntryId: identifier,
	record: taskRecordSchema,
}).strict();

export type StoredTaskRecord = z.infer<typeof storedRecordSchema>;

type RecordStore = Pick<ReadonlySessionManager,
	"getSessionId" | "getSessionFile" | "getLeafId" | "getBranch" | "saveArtifact" | "getArtifactPath"
>;

/** Parse without including supplied task text or secrets in validation errors. */
export function parseContinuityTaskRecord(text: string): ContinuityTaskRecord {
	if (Buffer.byteLength(text, "utf8") > MAX_TASK_RECORD_BYTES) {
		throw new Error("The task record exceeds the 12 KiB limit.");
	}
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error("The task record must be JSON."); }
	const parsed = taskRecordSchema.safeParse(value);
	if (!parsed.success) throw new Error("The task record does not match continuity schema 1.");
	const ids = [...parsed.data.completed, ...parsed.data.pending].map(item => item.id);
	if (new Set(ids).size !== ids.length) throw new Error("Completed and pending action IDs must be unique.");
	return parsed.data;
}

function latestUserId(entries: readonly SessionEntry[]): string | undefined {
	return entries.findLast(entry => entry.type === "message" && entry.message.role === "user")?.id;
}

/** Metadata is appended on the current branch, so a sibling's task state is never selected. */
export function captureContinuityTaskRecord(store: RecordStore, text: string): StoredTaskRecord {
	const record = parseContinuityTaskRecord(text);
	const leaf = store.getLeafId();
	const user = latestUserId(store.getBranch());
	if (!store.getSessionFile() || !leaf || !user) {
		throw new Error("A persisted session with a user task is required.");
	}
	if (record.pending.some(item => item.ownerSessionId !== store.getSessionId())) {
		throw new Error("Pending work must retain this execution session as its owner.");
	}
	return {
		version: 1, sessionId: store.getSessionId(), coveredThroughEntryId: leaf,
		latestUserEntryId: user, record,
	};
}

function branchDigest(entries: readonly SessionEntry[]): string {
	const hash = createHash("sha256");
	let bytes = 0;
	for (const entry of entries) {
		const line = JSON.stringify(entry);
		bytes += Buffer.byteLength(line, "utf8") + 1;
		if (bytes > MAX_TASK_ARCHIVE_BYTES) throw new Error("The branch exceeds the 8 MiB pilot archive limit.");
		hash.update(line).update("\n");
	}
	return hash.digest("hex");
}

function archiveBranch(event: SessionBeforeCompactEvent, sessionId: string, leaf: string): string {
	const originals = new Map(event.preparation.tailElisions?.map(item => [item.entryId, item.originalMessage]));
	let bytes = 0;
	const entries: string[] = [];
	for (const entry of event.branchEntries) {
		const original = originals.get(entry.id);
		const line = JSON.stringify(original && entry.type === "message" ? { ...entry, message: original } : entry);
		bytes += Buffer.byteLength(line, "utf8") + 1;
		if (bytes > MAX_TASK_ARCHIVE_BYTES - 1024) throw new Error("The branch exceeds the 8 MiB pilot archive limit.");
		entries.push(line);
	}
	// Serialized evidence data, not generated instruction prose. This matches recovery archive v1.
	const header = JSON.stringify({ version: 1, operation: "task-record-context", sessionId, branchLeafId: leaf });
	return `${header.slice(0, -1)},"entries":[${entries.join(",")}]}`;
}

/** Own timeout expires before the extension runner's 30-second handler budget. */
async function saveBeforeDeadline(store: RecordStore, content: string, signal: AbortSignal): Promise<string | undefined> {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	deadline.throwIfAborted();
	const cancellation = Promise.withResolvers<never>();
	const abort = () => cancellation.reject(new Error("Task-record archive was cancelled or timed out."));
	deadline.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([store.saveArtifact(content, "context-record"), cancellation.promise]);
	} finally {
		deadline.removeEventListener("abort", abort);
	}
}

/** Core policy used by the loaded extension; failures leave the ordinary runtime in charge of rollback. */
export async function prepareTaskRecordCompaction(
	event: SessionBeforeCompactEvent,
	store: RecordStore,
	transform: (text: string) => string = text => text,
): Promise<SessionBeforeCompactResult> {
	event.signal.throwIfAborted();
	const sessionId = store.getSessionId();
	const sessionFile = store.getSessionFile();
	const leaf = store.getLeafId();
	if (!sessionFile || !leaf) throw new Error("Task-record compaction requires persisted history.");
	const entries = event.branchEntries;
	const recordIndex = entries.findLastIndex(entry => entry.type === "custom" && entry.customType === TASK_RECORD_TYPE);
	const entry = entries[recordIndex];
	if (entry?.type !== "custom") throw new Error("Capture a task record before compacting.");
	const parsed = storedRecordSchema.safeParse(entry.data);
	if (!parsed.success) throw new Error("The stored task record is invalid.");
	const state = parsed.data;
	// Revalidate aggregate limits and action IDs for records restored from disk, not just commands.
	parseContinuityTaskRecord(JSON.stringify(state.record));
	if (state.sessionId !== sessionId || state.record.pending.some(item => item.ownerSessionId !== sessionId)) {
		throw new Error("The task record belongs to another execution session.");
	}
	if (state.latestUserEntryId !== latestUserId(entries)) throw new Error("A newer user message requires an updated task record.");
	if (entry.parentId !== state.coveredThroughEntryId || !entries.some(item => item.id === state.coveredThroughEntryId)) {
		throw new Error("The task record does not cover this branch.");
	}
	const cut = entries.findIndex(item => item.id === event.preparation.firstKeptEntryId);
	if (cut < 0 || cut > recordIndex + 1) {
		throw new Error("Newly discarded work requires an updated task record.");
	}
	const snapshotDigest = branchDigest(entries);
	if (entries.at(-1)?.id !== leaf || branchDigest(store.getBranch()) !== snapshotDigest) {
		throw new Error("The prepared branch is no longer current.");
	}
	const archive = archiveBranch(event, sessionId, leaf);
	const digest = createHash("sha256").update(archive).digest("hex");
	const artifactId = await saveBeforeDeadline(store, archive, event.signal);
	event.signal.throwIfAborted();
	if (!artifactId || !(await store.getArtifactPath(artifactId))) throw new Error("The recovery archive was not persisted.");
	if (store.getSessionId() !== sessionId || store.getSessionFile() !== sessionFile || store.getLeafId() !== leaf ||
		branchDigest(store.getBranch()) !== snapshotDigest) {
		throw new Error("The branch changed while its recovery archive was being saved.");
	}
	const recovery = { sessionId, branchLeafId: leaf, artifact: `artifact://${artifactId}`, sha256: digest };
	return {
		compaction: {
			summary: transform(JSON.stringify({
				version: 1, policy: "task-record-retrieval", task: state.record,
				taskRecordEntryId: entry.id, recovery,
			})),
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: { version: 1, contextPolicy: "task-record-retrieval", recovery, archiveBytes: Buffer.byteLength(archive, "utf8") },
		},
	};
}

/** Explicitly loaded only; registering the extension does not enable the policy. */
export default function taskRecordContext(api: BuiltinExtensionAPI): void {
	const disabledSessions = new Set<string>();
	api.registerFlag(TASK_RECORD_FLAG, {
		type: "boolean", default: false,
		description: "Use the experimental, operator-supplied task record for local compaction",
	});
	api.registerCommand("context-record", {
		description: "Capture schema-1 task-state JSON for the opt-in continuity pilot; off disables this invocation",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				if (args.trim() === "off") {
					disabledSessions.add(ctx.sessionManager.getSessionId());
					ctx.ui.notify("Task-record compaction disabled for this execution session.", "info");
					return;
				}
				const state = captureContinuityTaskRecord(ctx.sessionManager, args);
				api.appendEntry(TASK_RECORD_TYPE, state);
				disabledSessions.delete(state.sessionId);
				ctx.ui.notify("Task record captured on the current branch.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Task record could not be captured.", "error");
			}
		},
	});
	api.on("session_before_compact", async (event, ctx: ExtensionContext) => {
		if (api.getFlag(TASK_RECORD_FLAG) !== true || disabledSessions.has(ctx.sessionManager.getSessionId())) return;
		// Provider-native state and explicit summary instructions retain their existing owner.
		if (!ctx.model || resolveServerCompactionTransport(ctx.model) || event.customInstructions?.trim() ||
			event.preparation.previousPreserveData || event.preparation.remoteChain?.links.length) return;
		try {
			return await prepareTaskRecordCompaction(event, ctx.sessionManager, ctx.obfuscateProviderText);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : "Task-record compaction could not be prepared.", "warning");
			return { cancel: true };
		}
	});
}
