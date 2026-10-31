/**
 * Read a precise, bounded slice of an existing session record.
 *
 * Unlike history:// overview formatting, this returns the stored JSONL entry
 * without normalizing text or dropping tool arguments. An entry can still
 * contain an externalized blob reference or a historic prune marker: this
 * reader does not pretend such references are the original media bytes.
 * No writer or session lock is opened.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";

const DEFAULT_PAGE_CHARACTERS = 8_000;
const MAX_PAGE_CHARACTERS = 12_000;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export interface ExactHistoryRequest {
	entryId: string;
	leafId?: string;
	offset: number;
	limit: number;
	/** First-page SHA-256 identity, required for subsequent pages. */
	revision?: string;
}

export interface ExactHistoryResult {
	status: "ok" | "missing" | "not_on_branch" | "unavailable" | "stale";
	entryId: string;
	leafId?: string;
	sessionId?: string;
	recordType?: string;
	source: "stored-jsonl" | "live-session";
	revision?: string;
	offset?: number;
	totalCharacters?: number;
	fragment?: string;
	nextOffset?: number | null;
	detail?: string;
}

function idParam(input: string | null, name: string): string {
	if (!input || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input)) {
		throw new Error("history:// exact read requires a valid " + name + " (1-128 ID characters)");
	}
	return input;
}

function numericParam(input: string | null, name: string, fallback: number, maximum: number): number {
	if (input === null) return fallback;
	if (!/^(0|[1-9][0-9]*)$/.test(input)) {
		throw new Error("history:// exact read " + name + " must be a nonnegative integer");
	}
	const n = Number(input);
	if (!Number.isSafeInteger(n) || n > maximum) {
		throw new Error("history:// exact read " + name + " exceeds the supported range");
	}
	return n;
}

/** An absent entry parameter leaves the old concise history:// behavior unchanged. */
export function parseExactHistoryRequest(url: URL): ExactHistoryRequest | undefined {
	if (!url.searchParams.has("entry")) return undefined;
	const entryId = idParam(url.searchParams.get("entry"), "entry");
	const leaf = url.searchParams.get("leaf");
	const leafId = leaf === null ? undefined : idParam(leaf, "leaf");
	const offset = numericParam(url.searchParams.get("offset"), "offset", 0, Number.MAX_SAFE_INTEGER);
	const limit = numericParam(url.searchParams.get("limit"), "limit", DEFAULT_PAGE_CHARACTERS, MAX_PAGE_CHARACTERS);
	if (limit === 0) throw new Error("history:// exact read limit must be at least 1");
	const revision = url.searchParams.get("rev");
	if (revision !== null && !/^[0-9a-f]{64}$/.test(revision)) {
		throw new Error("history:// exact read rev must be a SHA-256 digest");
	}
	if (offset > 0 && revision === null) {
		throw new Error("history:// exact read continuation requires rev from its first page");
	}
	return { entryId, leafId, offset, limit, revision: revision ?? undefined };
}

function page(
	raw: string,
	request: ExactHistoryRequest,
	leafId: string,
	source: ExactHistoryResult["source"],
	recordType: string,
	sessionId?: string,
): ExactHistoryResult {
	// Rewrites may retain the entry and leaf IDs. Bind every continuation to
	// the original source, session, selected leaf and record bytes.
	if (request.offset > 0 && !request.revision) {
		throw new Error("history:// exact read continuation requires rev from its first page");
	}
	const revision = createHash("sha256")
		.update(JSON.stringify([source, sessionId ?? null, leafId, request.entryId, raw]))
		.digest("hex");
	if (request.revision && request.revision !== revision) {
		return {
			status: "stale", entryId: request.entryId, leafId, sessionId, source,
			detail: "Saved record or selected branch changed; restart the exact read at offset 0",
		};
	}
	// Page by Unicode code point rather than UTF-8 byte or JS UTF-16 offsets;
	// splitting a multibyte character would corrupt a supposedly exact read.
	const characters = Array.from(raw);
	if (request.offset > characters.length) {
		return {
			status: "missing", entryId: request.entryId, leafId, sessionId, source,
			detail: "Page offset is beyond the end of this saved record",
		};
	}
	const next = Math.min(characters.length, request.offset + request.limit);
	return {
		status: "ok", entryId: request.entryId, leafId, sessionId, source, recordType, revision,
		offset: request.offset, totalCharacters: characters.length,
		fragment: characters.slice(request.offset, next).join(""),
		nextOffset: next < characters.length ? next : null,
		detail: "Exact saved record text; historic pruning and external blob references are not reversed",
	};
}

function onBranch(parents: ReadonlyMap<string, string | undefined>, entryId: string, leafId: string): boolean {
	const seen = new Set<string>();
	let current: string | undefined = leafId;
	while (current && !seen.has(current)) {
		if (current === entryId) return true;
		seen.add(current);
		current = parents.get(current);
	}
	return false;
}

/**
 * Read-only stream scan: retains only ID/parent relationships and the selected
 * JSON line, not a second resident copy of the full transcript.
 */
export async function readStoredHistoryEntry(
	filePath: string,
	request: ExactHistoryRequest,
): Promise<ExactHistoryResult> {
	const parents = new Map<string, string | undefined>();
	let sessionId: string | undefined;
	let lastId: string | undefined;
	let raw: string | undefined;
	let recordType: string | undefined;
	let incomplete = false;
	const input = createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.startsWith("{")) continue; // optional title slot and blank lines
			if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
				incomplete = true;
				continue; // refuse to materialize exceptionally large records
			}
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				incomplete = true;
				continue;
			}
			if (!record || typeof record !== "object") continue;
			const entry = record as { type?: unknown; id?: unknown; parentId?: unknown };
			if (entry.type === "session") {
				if (typeof entry.id === "string") sessionId = entry.id;
				continue;
			}
			if (typeof entry.id !== "string" || typeof entry.type !== "string") continue;
			parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : undefined);
			lastId = entry.id;
			if (entry.id === request.entryId) {
				raw = line;
				recordType = entry.type;
			}
		}
	} finally {
		lines.close();
		input.destroy();
	}
	// A skipped record may be the *actual* branch tip, leaving lastId pointing
	// at an abandoned sibling. Without an explicit leaf, never guess from it.
	if (!request.leafId && incomplete) {
		return {
			status: "unavailable", entryId: request.entryId, sessionId,
			source: "stored-jsonl",
			detail: "Cannot select a default branch after unreadable/oversized stored records; provide leaf= for intentional archived-branch reads",
		};
	}
	const leafId = request.leafId ?? lastId;
	if (!raw || !recordType || !leafId || !parents.has(leafId)) {
		return {
			status: incomplete ? "unavailable" : "missing", entryId: request.entryId, leafId,
			sessionId, source: "stored-jsonl",
			detail: incomplete ? "A malformed or oversized record prevents a reliable negative lookup" :
				"No stored record or requested branch leaf was found",
		};
	}
	if (!onBranch(parents, request.entryId, leafId)) {
		return {
			status: incomplete ? "unavailable" : "not_on_branch", entryId: request.entryId,
			leafId, sessionId, source: "stored-jsonl",
			detail: incomplete ? "A record could not be inspected to verify branch membership" :
				"Record exists, but is not an ancestor of the selected branch leaf",
		};
	}
	return page(raw, request, leafId, "stored-jsonl", recordType, sessionId);
}

/** For intentionally non-persistent sessions only; loaded sessions use the disk source. */
export function readLiveHistoryEntry(
	branch: readonly SessionEntry[],
	request: ExactHistoryRequest,
): ExactHistoryResult {
	const leafIndex = request.leafId
		? branch.findIndex(entry => entry.id === request.leafId)
		: branch.length - 1;
	const leafId = leafIndex >= 0 ? branch[leafIndex]?.id : request.leafId;
	const index = branch.findIndex(entry => entry.id === request.entryId);
	if (index < 0 || leafIndex < 0) {
		return {
			status: "missing", entryId: request.entryId, leafId, source: "live-session",
			detail: "Entry or branch leaf not present in the active in-memory branch",
		};
	}
	if (index > leafIndex) {
		return {
			status: "not_on_branch", entryId: request.entryId, leafId, source: "live-session",
			detail: "Entry is newer than the selected branch leaf",
		};
	}
	const entry = branch[index]!;
	return page(JSON.stringify(entry), request, leafId!, "live-session", entry.type);
}

/** A bounded raw-record text search that discovers IDs for exact reads. */
export interface HistorySearchRequest {
	query: string;
	leafId?: string;
	limit: number;
}
export interface HistorySearchResult {
	status: "ok" | "partial" | "missing_branch" | "unavailable";
	sessionId?: string;
	leafId?: string;
	query: string;
	source: "stored-jsonl" | "live-session";
	matches: Array<{ entryId: string; recordType: string; preview: string }>;
	detail: string;
}

const MAX_CANDIDATE_MATCHES = 500;
const MAX_PREVIEW_CHARACTERS = 200;

export function parseHistorySearchRequest(url: URL): HistorySearchRequest | undefined {
	if (!url.searchParams.has("q")) return undefined;
	if (url.searchParams.has("entry")) throw new Error("Use either q= for search or entry= for an exact read");
	const query = (url.searchParams.get("q") ?? "").trim();
	if (query.length < 2 || query.length > 180 || /[\x00-\x1f]/.test(query)) {
		throw new Error("history:// search requires 2-180 printable query characters");
	}
	const leaf = url.searchParams.get("leaf");
	const leafId = leaf === null ? undefined : idParam(leaf, "leaf");
	const limit = numericParam(url.searchParams.get("limit"), "limit", 20, 50);
	if (limit === 0) throw new Error("history:// search limit must be at least 1");
	return { query, leafId, limit };
}

function previewAt(raw: string, term: string): string {
	const position = raw.toLowerCase().indexOf(term);
	if (position < 0) return "";
	const start = Math.max(0, position - 70);
	const end = Math.min(raw.length, position + term.length + 110);
	return raw.slice(start, end).slice(0, MAX_PREVIEW_CHARACTERS);
}

/**
 * Stream a stored session to search its serialized records. Only the latest
 * 500 candidate snippets remain resident; if more match, the status is partial
 * rather than a false assertion that all matching history was searched.
 * Search covers stored JSONL text, not externalized blob contents.
 */
export async function searchStoredHistoryEntries(
	filePath: string,
	request: HistorySearchRequest,
): Promise<HistorySearchResult> {
	const parents = new Map<string, string | undefined>();
	const candidates: HistorySearchResult["matches"] = [];
	const query = request.query.toLowerCase();
	let lastId: string | undefined;
	let sessionId: string | undefined;
	let unreadable = false;
	let truncated = false;
	const input = createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.startsWith("{")) continue;
			if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
				unreadable = true;
				continue;
			}
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				unreadable = true;
				continue;
			}
			if (!record || typeof record !== "object") continue;
			const entry = record as { type?: unknown; id?: unknown; parentId?: unknown };
			if (entry.type === "session") {
				if (typeof entry.id === "string") sessionId = entry.id;
				continue;
			}
			if (typeof entry.id !== "string" || typeof entry.type !== "string") continue;
			parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : undefined);
			lastId = entry.id;
			if (!line.toLowerCase().includes(query)) continue;
			if (candidates.length >= MAX_CANDIDATE_MATCHES) {
				candidates.shift();
				truncated = true;
			}
			candidates.push({
				entryId: entry.id, recordType: entry.type, preview: previewAt(line, query),
			});
		}
	} finally {
		lines.close();
		input.destroy();
	}
	// The latest readable entry is not a safe default when a later branch
	// record may have been skipped. Never present another branch's matches.
	if (!request.leafId && unreadable) {
		return {
			status: "unavailable", sessionId, query: request.query,
			source: "stored-jsonl", matches: [],
			detail: "Cannot select a default branch after unreadable/oversized stored records; provide leaf= for intentional archived-branch search",
		};
	}
	const leafId = request.leafId ?? lastId;
	if (!leafId || !parents.has(leafId)) {
		return {
			status: "missing_branch", sessionId, leafId, query: request.query,
			source: "stored-jsonl", matches: [],
			detail: "Requested session branch was not found",
		};
	}
	const matches = candidates.filter(item => onBranch(parents, item.entryId, leafId)).reverse().slice(0, request.limit);
	return {
		status: unreadable || truncated ? "partial" : "ok", sessionId, leafId, query: request.query,
		source: "stored-jsonl", matches,
		detail: unreadable || truncated
			? "Not exhaustive: malformed/oversized records or more than 500 candidates; stored text only, blobs not searched"
			: "Bounded newest-first matches from stored JSONL text; externalized blobs were not searched",
	};
}

/** In-memory sessions use their current branch, not a process-wide agent index. */
export function searchLiveHistoryEntries(
	branch: readonly SessionEntry[],
	request: HistorySearchRequest,
): HistorySearchResult {
	const leafIndex = request.leafId
		? branch.findIndex(entry => entry.id === request.leafId)
		: branch.length - 1;
	const leafId = branch[leafIndex]?.id ?? request.leafId;
	if (leafIndex < 0) {
		return {
			status: "missing_branch", leafId, query: request.query, source: "live-session",
			matches: [], detail: "Requested leaf is not in the active in-memory branch",
		};
	}
	const query = request.query.toLowerCase();
	const matches: HistorySearchResult["matches"] = [];
	for (let i = leafIndex; i >= 0 && matches.length < request.limit; i--) {
		const entry = branch[i]!;
		const raw = JSON.stringify(entry);
		if (!raw.toLowerCase().includes(query)) continue;
		matches.push({ entryId: entry.id, recordType: entry.type, preview: previewAt(raw, query) });
	}
	return {
		status: "ok", leafId, query: request.query, source: "live-session", matches,
		detail: "Bounded newest-first matches in the active in-memory branch",
	};
}
