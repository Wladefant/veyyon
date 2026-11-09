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
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";

const DEFAULT_PAGE_CHARACTERS = 8_000;
const MAX_PAGE_CHARACTERS = 12_000;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
// Record types are returned as metadata, not as paged raw evidence.
const MAX_RECORD_TYPE_CHARACTERS = 128;
const MAX_STORED_SESSION_ID_CHARACTERS = 128;
// A valid 128-character ASCII entry ID may use six JSON characters per escaped character.
const MAX_ID_MEMBER_JSON_CHARACTERS = 2 + 6 * 128;
// Search results must supply IDs that the public history:// entry/leaf grammar can read.
const ADDRESSABLE_HISTORY_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_INDEX_ENTRIES = 100_000;
const MAX_SCANNED_BYTES = 128 * 1024 * 1024;
// Unlike an isolated malformed line, a hard scan cap leaves unseen IDs behind.
const SCAN_BOUND_EXCEEDED = Symbol("stored-history-scan-bound");
const HARD_BOUND_DETAIL =
	"Stored history exceeded the 128 MiB or 100,000-entry scan bound; branch identity and unique record IDs cannot be verified";
const DUPLICATE_ID_DETAIL = "Duplicate stored entry ID makes branch identity and exact evidence ambiguous";

function decodeRecord(parts: Buffer[], bytes: number): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes)).replace(/\r$/, "");
	} catch {
		return undefined;
	}
}

/** Discard an oversized line while streaming, before allocating its full text. */
async function* storedLines(filePath: string): AsyncGenerator<string | undefined | typeof SCAN_BOUND_EXCEEDED> {
	const input = createReadStream(filePath, { highWaterMark: 64 * 1024 });
	let parts: Buffer[] = [];
	let bytes = 0;
	let oversized = false;
	let scannedBytes = 0;
	try {
		for await (const chunk of input) {
			const buffer = chunk as Buffer;
			scannedBytes += buffer.length;
			if (scannedBytes > MAX_SCANNED_BYTES) {
				yield SCAN_BOUND_EXCEEDED;
				return;
			}
			let start = 0;
			while (start < buffer.length) {
				const newline = buffer.indexOf(10, start);
				const end = newline < 0 ? buffer.length : newline;
				if (!oversized) {
					bytes += end - start;
					if (bytes > MAX_RECORD_BYTES) {
						oversized = true;
						parts = [];
					} else {
						parts.push(buffer.subarray(start, end));
					}
				}
				if (newline >= 0) {
					yield oversized ? undefined : decodeRecord(parts, bytes);
					parts = [];
					bytes = 0;
					oversized = false;
				}
				start = newline < 0 ? buffer.length : newline + 1;
			}
		}
		if (oversized || bytes > 0) yield oversized ? undefined : decodeRecord(parts, bytes);
	} finally {
		input.destroy();
	}
}

function isFileReadError(error: unknown): boolean {
	return error instanceof Error && "code" in error;
}

/** Both search passes and exact reads must agree on what is a stored entry. */
type StoredEntryShape = { type?: unknown; id?: unknown; parentId?: unknown };
type StoredAdmissionState = {
	sessionId?: string;
	headerSeen: boolean;
	entrySeen: boolean;
	titleSeen: boolean;
	invalidIdentity: boolean;
};
type StoredRecordResult =
	| { kind: "entry"; entry: StoredEntryShape }
	| { kind: "metadata" }
	| { kind: "invalid"; invalidIdentity: boolean; claimedId?: string };

function readBoundedJsonString(raw: string, start: number): { value: string; end: number } | undefined {
	if (raw[start] !== '"') return undefined;
	let end = start + 1;
	while (end < raw.length) {
		if (raw[end] === "\\") {
			end += 2;
			continue;
		}
		if (raw[end++] === '"') break;
	}
	if (raw[end - 1] !== '"' || end - start > MAX_ID_MEMBER_JSON_CHARACTERS) return undefined;
	try {
		const value = JSON.parse(raw.slice(start, end)) as unknown;
		return typeof value === "string" ? { value, end } : undefined;
	} catch {
		return undefined;
	}
}

function claimedRecordId(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as StoredEntryShape;
	// Title and session metadata are not entry claims; their identity has its own rules.
	if (entry.type === "title" || entry.type === "session") return undefined;
	return typeof entry.id === "string" && ADDRESSABLE_HISTORY_ID.test(entry.id) ? entry.id : undefined;
}

interface TopLevelMemberScan {
	duplicates: ReadonlySet<string>;
	sessionTypeMember: boolean;
	identityAmbiguous: boolean;
	arrayIdentityCandidate: boolean;
	nestedIdentityCandidate: boolean;
	claimedId?: string;
}

function scanTopLevelMembers(raw: string): TopLevelMemberScan {
	const keys = new Set<string>();
	const duplicates = new Set<string>();
	let sessionTypeMember = false;
	let topLevelType: string | undefined;
	let claimedId: string | undefined;
	let identityAmbiguous = false;
	let arrayIdentityCandidate = false;
	let nestedIdentityCandidate = false;
	let rootMemberSeen = false;
	let depth = 0;
	// JSON array string elements are never root-level object member names.
	let arrayDepth = 0;
	for (let i = 0; i < raw.length; ) {
		const char = raw[i]!;
		if (char === '"') {
			const start = i++;
			while (i < raw.length) {
				if (raw[i] === "\\") {
					i += 2;
					continue;
				}
				if (raw[i++] === '"') break;
			}
			// A root string *value* followed by malformed `:` is not a member key.
			// The full JSON parser still rejects the row; do not invent a duplicate
			// ID or session boundary from a value that happens to spell "id"/"type".
			let previous = start - 1;
			while (previous >= 0 && /\s/.test(raw[previous]!)) previous--;
			let next = i;
			while (/\s/.test(raw[next] ?? "")) next++;
			const keyLike = raw[next] === ":" && raw[previous] !== ":";
			// A scalar or impossible opener can shift a later identity-bearing
			// object below the root depth. Preserve that signal for pre-header
			// classification without treating arbitrary brace punctuation as a header.
			if (keyLike && (depth > 1 || arrayDepth > 0)) {
				const key = readBoundedJsonString(raw, start)?.value;
				if (key === "type" || key === "id") {
					let valueStart = next + 1;
					while (/\s/.test(raw[valueStart] ?? "")) valueStart++;
					const member = readBoundedJsonString(raw, valueStart)?.value;
					if ((key === "type" && member === "session") ||
						(key === "id" && typeof member === "string" && ADDRESSABLE_HISTORY_ID.test(member))) {
						nestedIdentityCandidate = true;
					}
				}
			}
			if (depth === 1 && arrayDepth === 0 && raw[previous] !== ":") {
				if (!keyLike) {
					if (!rootMemberSeen) identityAmbiguous = true;
				} else {
					rootMemberSeen = true;
					let key: string;
					try {
						key = JSON.parse(raw.slice(start, i)) as string;
					} catch {
						// A malformed member name must not hide a later session type.
						// The complete record will still fail JSON.parse below.
						continue;
					}
					if (keys.has(key)) duplicates.add(key);
					else keys.add(key);
					if (key === "type" || key === "id") {
						let valueCursor = next + 1;
						while (/\s/.test(raw[valueCursor] ?? "")) valueCursor++;
						if (raw[valueCursor] === '"') {
							const valueStart = valueCursor++;
							while (valueCursor < raw.length) {
								if (raw[valueCursor] === "\\") {
									valueCursor += 2;
									continue;
								}
								if (raw[valueCursor++] === '"') break;
							}
							if (valueCursor - valueStart <= MAX_ID_MEMBER_JSON_CHARACTERS && raw[valueCursor - 1] === '"') {
								try {
									const member = JSON.parse(raw.slice(valueStart, valueCursor)) as unknown;
									if (typeof member === "string") {
										if (key === "type") {
											topLevelType = member;
											if (member === "session") sessionTypeMember = true;
										} else if (ADDRESSABLE_HISTORY_ID.test(member)) claimedId = member;
									}
								} catch {
									// An invalid string member cannot establish a session boundary or ID claim.
								}
							}
						}
					}
				}
			}
			// A malformed array cannot contain bare object members. Before a
			// root type is established, an identity-looking pair here could be
			// a hidden session header or addressable entry claim. Once a root
			// message type is known, nested malformed metadata remains recoverable.
			if (depth === 1 && arrayDepth > 0 && topLevelType === undefined && keyLike) {
				let key: string | undefined;
				try {
					key = JSON.parse(raw.slice(start, i)) as string;
				} catch {
					// An invalid array string cannot establish an identity claim.
				}
				if (key === "type" || key === "id") {
					let valueCursor = next + 1;
					while (/\s/.test(raw[valueCursor] ?? "")) valueCursor++;
					if (raw[valueCursor] === '"') {
						const valueStart = valueCursor++;
						while (valueCursor < raw.length) {
							if (raw[valueCursor] === "\\") {
								valueCursor += 2;
								continue;
							}
							if (raw[valueCursor++] === '"') break;
						}
						if (raw[valueCursor - 1] === '"' && valueCursor - valueStart <= MAX_ID_MEMBER_JSON_CHARACTERS) {
							try {
								const member = JSON.parse(raw.slice(valueStart, valueCursor)) as unknown;
								if ((key === "type" && member === "session") ||
									(key === "id" && typeof member === "string" && ADDRESSABLE_HISTORY_ID.test(member))) {
									arrayIdentityCandidate = true;
								}
							} catch {
								// An invalid string value cannot establish an identity claim.
							}
						}
					}
				}
			}
			continue;
		}
		// Before the first root member, an object/array/scalar opener cannot be
		// a valid JSON object prefix. Do not let it shift later identity keys
		// into a nested depth where the scanner would mistake them for metadata.
		if (depth === 1 && arrayDepth === 0 && !rootMemberSeen &&
			char.trim().length > 0 && char !== "}") {
			identityAmbiguous = true;
		}
		if (char === "{") depth++;
		else if (char === "}") depth--;
		else if (char === "[") arrayDepth++;
		else if (char === "]") arrayDepth = Math.max(0, arrayDepth - 1);
		i++;
	}
	// A malformed JSON object can still claim an entry ID even when full parsing fails.
	// A recognizable session/title member is metadata and must not claim an entry ID.
	return {
		duplicates,
		sessionTypeMember,
		identityAmbiguous: identityAmbiguous || (arrayIdentityCandidate && topLevelType === undefined),
		arrayIdentityCandidate,
		nestedIdentityCandidate,
		claimedId: topLevelType === "session" || topLevelType === "title" ? undefined : claimedId,
	};
}

/**
 * Inspect a malformed JSONL row's first object suffix for identity claims.
 * Plain non-JSON siblings remain ordinary unreadable records; a damaged prefix
 * must not hide a repeated session header or an addressable duplicate ID.
 */
function inspectMalformedIdentitySuffix(line: string): { invalidIdentity: boolean; claimedId?: string } {
	const trimmed = line.trimStart();
	const objectStart = trimmed.indexOf("{");
	if (objectStart < 0) return { invalidIdentity: false };
	const scanned = scanTopLevelMembers(trimmed.slice(objectStart));
	const invalidIdentity = scanned.identityAmbiguous || scanned.sessionTypeMember ||
		scanned.duplicates.has("type") || scanned.duplicates.has("id") || scanned.duplicates.has("parentId");
	return {
		invalidIdentity,
		claimedId: invalidIdentity ? undefined : scanned.claimedId,
	};
}

/** Whether a bounded structural scan found an identity-bearing claim. */
function hasBrokenIdentity(scanned: TopLevelMemberScan): boolean {
	return scanned.sessionTypeMember ||
		scanned.arrayIdentityCandidate ||
		scanned.duplicates.has("type") ||
		scanned.duplicates.has("id") ||
		scanned.duplicates.has("parentId") ||
		scanned.claimedId !== undefined ||
		(scanned.identityAmbiguous && scanned.nestedIdentityCandidate);
}

/** Reject identity-bearing fragments before a valid session header. */
function resemblesBrokenHeader(line: string): boolean {
	const trimmed = line.trimStart();
	// The synthetic object catches leading member fragments, nested arrays and
	// scalar prefixes. Ordinary punctuation-only legacy titles remain harmless.
	if (hasBrokenIdentity(scanTopLevelMembers(`{${trimmed}}`))) return true;

	// Preserve the first-object suffix check as a second recovery view: unmatched
	// closers or an earlier metadata member can otherwise move the synthetic
	// scanner's depth/root-member state past the later identity-bearing object.
	const objectStart = trimmed.indexOf("{");
	return objectStart >= 0 && hasBrokenIdentity(scanTopLevelMembers(trimmed.slice(objectStart)));
}
function decodeStoredRecord(raw: string, state: StoredAdmissionState): StoredRecordResult {
	let sessionTypeMember = false;
	let malformedClaimedId: string | undefined;
	try {
		const scanned = scanTopLevelMembers(raw);
		sessionTypeMember = scanned.sessionTypeMember;
		malformedClaimedId = scanned.claimedId;
		if (scanned.identityAmbiguous) state.invalidIdentity = true;
		const { duplicates } = scanned;
		if (duplicates.size > 0) {
			// Duplicate identity members are never safe to ignore, even in a
			// sibling. A repeated session header is an identity boundary even
			// when its duplicated member is otherwise unrelated metadata.
			if (!state.headerSeen || sessionTypeMember ||
				duplicates.has("type") || duplicates.has("id") || duplicates.has("parentId")) {
				state.invalidIdentity = true;
			}
			let claimedId = !state.invalidIdentity && !sessionTypeMember ? malformedClaimedId : undefined;
			if (!claimedId && !state.invalidIdentity && !sessionTypeMember) {
				// JSON permits duplicate *unrelated* members, but their malformed row
				// can still claim an entry ID already present elsewhere in the file.
				try {
					claimedId = claimedRecordId(JSON.parse(raw));
				} catch {
					// Non-decodable content cannot establish an addressable entry claim.
				}
			}
			return { kind: "invalid", invalidIdentity: state.invalidIdentity, claimedId };
		}
	} catch {
		if (!state.headerSeen) state.invalidIdentity = true;
		return { kind: "invalid", invalidIdentity: state.invalidIdentity };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		// An unparseable repeated session header still invalidates identity
		// even when the type member follows other top-level metadata.
		if (!state.headerSeen || sessionTypeMember) {
			state.invalidIdentity = true;
		}
		return {
			kind: "invalid",
			invalidIdentity: state.invalidIdentity,
			claimedId: state.invalidIdentity ? undefined : malformedClaimedId,
		};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		if (!state.headerSeen) state.invalidIdentity = true;
		return { kind: "invalid", invalidIdentity: state.invalidIdentity };
	}
	const entry = value as StoredEntryShape;
	if (entry.type === "session") {
		if (state.headerSeen || state.entrySeen) {
			state.invalidIdentity = true;
		} else if (typeof entry.id !== "string") {
			state.invalidIdentity = true;
			return { kind: "invalid", invalidIdentity: true };
		} else if (!entry.id.trim() || entry.id.length > MAX_STORED_SESSION_ID_CHARACTERS) {
			state.invalidIdentity = true;
		} else {
			state.headerSeen = true;
			state.sessionId = entry.id;
		}
		return { kind: "metadata" };
	}
	if (entry.type === "title") {
		if (state.titleSeen || state.headerSeen || state.entrySeen)
			return { kind: "invalid", invalidIdentity: state.invalidIdentity };
		state.titleSeen = true;
		return { kind: "metadata" };
	}
	if (!state.headerSeen) {
		state.invalidIdentity = true;
		return { kind: "invalid", invalidIdentity: true };
	}
	if (!isStoredEntry(entry)) {
		return {
			kind: "invalid",
			invalidIdentity: state.invalidIdentity,
			// A malformed sibling may still claim an existing public-addressable ID.
			// Its claim must participate in uniqueness checks without admitting the row.
			claimedId: claimedRecordId(entry),
		};
	}
	state.entrySeen = true;
	return { kind: "entry", entry };
}

function isStoredEntry(entry: StoredEntryShape): entry is { type: string; id: string; parentId?: string | null } {
	return (
		typeof entry.id === "string" &&
		ADDRESSABLE_HISTORY_ID.test(entry.id) &&
		typeof entry.type === "string" &&
		entry.type.trim().length > 0 &&
		entry.type.length <= MAX_RECORD_TYPE_CHARACTERS &&
		(entry.parentId === undefined || entry.parentId === null ||
			(typeof entry.parentId === "string" && ADDRESSABLE_HISTORY_ID.test(entry.parentId)))
	);
}

function claimedIdError(
	id: string,
	parents: ReadonlyMap<string, string | undefined>,
	malformedClaims: ReadonlySet<string>,
): string | undefined {
	if (parents.has(id) || malformedClaims.has(id)) return DUPLICATE_ID_DETAIL;
	if (parents.size + malformedClaims.size >= MAX_INDEX_ENTRIES) return HARD_BOUND_DETAIL;
	return undefined;
}

export interface ExactHistoryRequest {
	entryId: string;
	leafId?: string | null;
	revision?: string;
	offset: number;
	limit: number;
}

export interface ExactHistoryResult {
	status: "ok" | "missing" | "not_on_branch" | "unavailable" | "stale";
	revision?: string;
	entryId: string;
	leafId?: string;
	sessionId?: string;
	recordType?: string;
	source: "stored-jsonl" | "live-session";
	offset?: number;
	totalCharacters?: number;
	fragment?: string;
	nextOffset?: number | null;
	detail?: string;
}

function idParam(input: string | null, name: string): string {
	if (!input || !ADDRESSABLE_HISTORY_ID.test(input)) {
		throw new Error(`history:// exact read requires a valid ${name} (1-128 ID characters)`);
	}
	return input;
}

function numericParam(input: string | null, name: string, fallback: number, maximum: number): number {
	if (input === null) return fallback;
	if (!/^(0|[1-9][0-9]*)$/.test(input)) {
		throw new Error(`history:// exact read ${name} must be a nonnegative integer`);
	}
	const n = Number(input);
	if (!Number.isSafeInteger(n) || n > maximum) {
		throw new Error(`history:// exact read ${name} exceeds the supported range`);
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
	const revision = url.searchParams.get("revision") ?? undefined;
	if (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) {
		throw new Error("history:// revision must be the returned SHA-256 token");
	}
	if (offset > 0 && (!revision || !leafId)) {
		throw new Error("history:// continuation requires the previous page's leaf and revision");
	}
	return { entryId, leafId, revision, offset, limit };
}

function recordDigest(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

function recordRevision(
	digest: string,
	source: ExactHistoryResult["source"],
	leafId: string,
	sessionId?: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([1, source, sessionId ?? null, leafId, digest]))
		.digest("hex");
}

function page(
	raw: string,
	request: ExactHistoryRequest,
	leafId: string,
	source: ExactHistoryResult["source"],
	recordType: string,
	sessionId?: string,
): ExactHistoryResult {
	if (request.offset > 0 && (!request.revision || !request.leafId)) {
		throw new Error("history:// continuation requires the previous page's leaf and revision");
	}
	const revision = recordRevision(recordDigest(raw), source, leafId, sessionId);
	if (request.revision !== undefined && request.revision !== revision) {
		return {
			status: "stale",
			entryId: request.entryId,
			leafId,
			sessionId,
			source,
			revision,
			detail: "Record or selected branch changed; restart the read at offset zero",
		};
	}
	// Page by Unicode code point rather than UTF-8 byte or JS UTF-16 offsets;
	// splitting a multibyte character would corrupt a supposedly exact read.
	let totalCharacters = 0;
	let fragment = "";
	for (const character of raw) {
		if (totalCharacters >= request.offset && totalCharacters < request.offset + request.limit) fragment += character;
		totalCharacters++;
	}
	if (request.offset > totalCharacters) {
		return {
			status: "missing",
			entryId: request.entryId,
			leafId,
			sessionId,
			source,
			detail: "Page offset is beyond the end of this saved record",
		};
	}
	const next = Math.min(totalCharacters, request.offset + request.limit);
	return {
		status: "ok",
		entryId: request.entryId,
		leafId,
		sessionId,
		source,
		recordType,
		revision,
		offset: request.offset,
		totalCharacters,
		fragment,
		nextOffset: next < totalCharacters ? next : null,
		detail: "Exact saved record text; historic pruning and external blob references are not reversed",
	};
}

/** A parent cycle makes an otherwise well-formed stored branch ambiguous. */
function selectedBranchIds(parents: ReadonlyMap<string, string | undefined>, leafId: string): Set<string> | undefined {
	const selected = new Set<string>();
	let current: string | undefined = leafId;
	while (current !== undefined) {
		// A missing parent is not a root: it leaves branch ancestry unprovable.
		if (selected.has(current) || !parents.has(current)) return undefined;
		selected.add(current);
		current = parents.get(current);
	}
	return selected;
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
	const malformedClaims = new Set<string>();
	const admission: StoredAdmissionState = {
		headerSeen: false,
		entrySeen: false,
		titleSeen: false,
		invalidIdentity: false,
	};
	let sessionId: string | undefined;
	let initialPlainTitle = false;
	let initialTitleSeparated = false;
	let lastId: string | undefined;
	let raw: string | undefined;
	let recordType: string | undefined;
	let incomplete = false;
	try {
		for await (const line of storedLines(filePath)) {
			if (line === SCAN_BOUND_EXCEEDED) {
				return {
					status: "unavailable",
					entryId: request.entryId,
					sessionId,
					source: "stored-jsonl",
					detail: HARD_BOUND_DETAIL,
				};
			}
			if (line === undefined) {
				incomplete = true;
				// Before a valid header, an unreadable line could itself be an
				// earlier session header. A later header cannot certify identity.
				if (!admission.headerSeen) admission.invalidIdentity = true;
				continue;
			}
			if (!line.trimStart().startsWith("{")) {
				if (!admission.headerSeen && !admission.entrySeen && line.trim().length > 0) {
					if (initialPlainTitle || resemblesBrokenHeader(line)) {
						admission.invalidIdentity = true;
						incomplete = true;
					} else {
						initialPlainTitle = true;
					}
				} else if (line.trim().length > 0) {
					incomplete = true;
					const suffix = inspectMalformedIdentitySuffix(line);
					if (!admission.headerSeen || suffix.invalidIdentity) admission.invalidIdentity = true;
					if (suffix.claimedId) {
						const detail = claimedIdError(suffix.claimedId, parents, malformedClaims);
						if (detail) return {
							status: "unavailable",
							entryId: request.entryId,
							sessionId,
							source: "stored-jsonl",
							detail,
						};
						malformedClaims.add(suffix.claimedId);
					}
				} else if (initialPlainTitle) {
					initialTitleSeparated = true;
				}
				continue;
			}
			if (initialPlainTitle && !initialTitleSeparated) admission.invalidIdentity = true;
			const decoded = decodeStoredRecord(line, admission);
			sessionId = admission.sessionId;
			if (decoded.kind === "invalid") {
				incomplete = true;
				// All addressable physical ID claims count, even when a sibling's
				// parent field is otherwise invalid.
				if (decoded.claimedId) {
					const detail = claimedIdError(decoded.claimedId, parents, malformedClaims);
					if (detail) return {
						status: "unavailable",
						entryId: request.entryId,
						sessionId,
						source: "stored-jsonl",
						detail,
					};
					malformedClaims.add(decoded.claimedId);
				}
				continue;
			}
			if (decoded.kind === "metadata") continue;
			const entry = decoded.entry;
			if (!isStoredEntry(entry)) {
				incomplete = true;
				continue;
			}
			if (parents.has(entry.id) || malformedClaims.has(entry.id)) {
				return {
					status: "unavailable",
					entryId: request.entryId,
					sessionId,
					source: "stored-jsonl",
					detail: DUPLICATE_ID_DETAIL,
				};
			}
			if (parents.size + malformedClaims.size >= MAX_INDEX_ENTRIES) {
				return {
					status: "unavailable",
					entryId: request.entryId,
					sessionId,
					source: "stored-jsonl",
					detail: HARD_BOUND_DETAIL,
				};
			}
			parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : undefined);
			lastId = entry.id;
			if (entry.id === request.entryId) {
				raw = line;
				recordType = entry.type;
			}
		}
	} catch (error) {
		if (!isFileReadError(error)) throw error;
		return {
			status: "unavailable",
			entryId: request.entryId,
			source: "stored-jsonl",
			detail: "Stored session file could not be read; this is not a negative evidence lookup",
		};
	}
	if (!admission.headerSeen || admission.invalidIdentity) {
		return {
			status: "unavailable",
			entryId: request.entryId,
			sessionId,
			source: "stored-jsonl",
			detail: "Stored session identity is missing or ambiguous",
		};
	}
	// An unreadable record may be the real tip rather than the last readable sibling.
	if (request.leafId === undefined && incomplete) {
		return {
			status: "unavailable",
			entryId: request.entryId,
			sessionId,
			source: "stored-jsonl",
			detail:
				"Cannot select a default branch after unreadable/oversized stored records; provide leaf= for intentional archived-branch reads",
		};
	}
	const leafId = request.leafId === null ? undefined : (request.leafId ?? lastId);
	const selectedIds = leafId && parents.has(leafId) ? selectedBranchIds(parents, leafId) : undefined;
	if (leafId && parents.has(leafId) && !selectedIds) {
		return {
			status: "unavailable",
			entryId: request.entryId,
			leafId,
			sessionId,
			source: "stored-jsonl",
			detail: "Selected branch has cyclic parent links; exact history is ambiguous",
		};
	}
	if (!raw || !recordType || !leafId || !parents.has(leafId)) {
		return {
			status: request.revision ? "stale" : incomplete ? "unavailable" : "missing",
			entryId: request.entryId,
			leafId,
			sessionId,
			source: "stored-jsonl",
			detail: incomplete
				? "Malformed/oversized records or the 128 MiB/100,000-entry scan bound prevents a reliable negative lookup"
				: "No stored record or requested branch leaf was found",
		};
	}
	if (!selectedIds!.has(request.entryId)) {
		return {
			status: incomplete ? "unavailable" : "not_on_branch",
			entryId: request.entryId,
			leafId,
			sessionId,
			source: "stored-jsonl",
			detail: incomplete
				? "A record could not be inspected to verify branch membership"
				: "Record exists, but is not an ancestor of the selected branch leaf",
		};
	}
	return page(raw, request, leafId, "stored-jsonl", recordType, sessionId);
}

/** For intentionally non-persistent sessions only; loaded sessions use the disk source. */
export function readLiveHistoryEntry(
	branch: readonly SessionEntry[],
	request: ExactHistoryRequest,
	sessionId?: string,
): ExactHistoryResult {
	const leafIndex =
		request.leafId === null
			? -1
			: request.leafId
				? branch.findIndex(entry => entry.id === request.leafId)
				: branch.length - 1;
	const leafId = leafIndex >= 0 ? branch[leafIndex]?.id : (request.leafId ?? undefined);
	const index = branch.findIndex(entry => entry.id === request.entryId);
	if (index < 0 || leafIndex < 0) {
		return {
			status: request.revision ? "stale" : "missing",
			entryId: request.entryId,
			leafId,
			sessionId,
			source: "live-session",
			detail: "Entry or branch leaf not present in the active in-memory branch",
		};
	}
	if (index > leafIndex) {
		return {
			status: "not_on_branch",
			entryId: request.entryId,
			leafId,
			sessionId,
			source: "live-session",
			detail: "Entry is newer than the selected branch leaf",
		};
	}
	const entry = branch[index]!;
	return page(JSON.stringify(entry), request, leafId!, "live-session", entry.type, sessionId);
}

/** A bounded raw-record text search that discovers IDs for exact reads. */
export interface HistorySearchRequest {
	query: string;
	leafId?: string | null;
	limit: number;
}
export interface HistorySearchResult {
	status: "ok" | "partial" | "missing_branch" | "unavailable";
	sessionId?: string;
	leafId?: string;
	query: string;
	source: "stored-jsonl" | "live-session";
	matches: Array<{ entryId: string; recordType: string; preview: string; revision: string }>;
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
	// Some lowercase mappings expand a character (e.g. U+0130 -> i + combining dot).
	// Project the match offset back to the original UTF-16 string before slicing it.
	let originalPosition = 0;
	let loweredPosition = 0;
	for (const character of raw) {
		const width = character.toLowerCase().length;
		if (loweredPosition + width > position) break;
		loweredPosition += width;
		originalPosition += character.length;
	}
	// Keep the full matching evidence visible even for the maximum allowed
	// 180-character query: 70 units of prefix would otherwise exceed the cap.
	const leadingContext = Math.min(70, Math.max(0, MAX_PREVIEW_CHARACTERS - term.length));
	const start = Math.max(0, originalPosition - leadingContext);
	const end = Math.min(raw.length, originalPosition + term.length + 110);
	// The context/window and preview cap are UTF-16 offsets. Do not emit half
	// of an astral character when either boundary falls between surrogates.
	const splitsPair = (index: number): boolean =>
		index > 0 &&
		index < raw.length &&
		raw.charCodeAt(index - 1) >= 0xd800 &&
		raw.charCodeAt(index - 1) <= 0xdbff &&
		raw.charCodeAt(index) >= 0xdc00 &&
		raw.charCodeAt(index) <= 0xdfff;
	const safeStart = splitsPair(start) ? start + 1 : start;
	const cappedEnd = Math.min(end, safeStart + MAX_PREVIEW_CHARACTERS);
	const safeEnd = splitsPair(cappedEnd) ? cappedEnd - 1 : cappedEnd;
	return raw.slice(safeStart, safeEnd);
}

/**
 * Stream a stored session to search its serialized records. Only the latest
 * 500 selected-branch candidate snippets remain resident; if more match,
 * the status is partial. Two read-only passes resolve ancestry before limiting
 * hits, refusing concurrent transcript changes rather than mixing versions.
 * Search covers stored JSONL text, not externalized blob contents.
 */
export async function searchStoredHistoryEntries(
	filePath: string,
	request: HistorySearchRequest,
): Promise<HistorySearchResult> {
	const parents = new Map<string, string | undefined>();
	const malformedClaims = new Set<string>();
	const admission: StoredAdmissionState = {
		headerSeen: false,
		entrySeen: false,
		titleSeen: false,
		invalidIdentity: false,
	};
	const query = request.query.toLowerCase();
	let lastId: string | undefined;
	let sessionId: string | undefined;
	let unreadable = false;
	const topologyHash = createHash("sha256");
	let initialPlainTitle = false;
	let initialTitleSeparated = false;
	let unlocatedUnreadable = false;
	try {
		for await (const line of storedLines(filePath)) {
			if (line === SCAN_BOUND_EXCEEDED) {
				return {
					status: "unavailable",
					sessionId,
					query: request.query,
					source: "stored-jsonl",
					matches: [],
					detail: HARD_BOUND_DETAIL,
				};
			}
			topologyHash.update(line ?? "\0unreadable").update("\n");
			if (line === undefined) {
				unlocatedUnreadable = true;
				unreadable = true;
				// Keep exact reads and search consistent on pre-header corruption.
				if (!admission.headerSeen) admission.invalidIdentity = true;
				continue;
			}
			if (!line.trimStart().startsWith("{")) {
				if (!admission.headerSeen && !admission.entrySeen && line.trim().length > 0) {
					if (initialPlainTitle || resemblesBrokenHeader(line)) {
						admission.invalidIdentity = true;
						unreadable = true;
					} else {
						initialPlainTitle = true;
					}
				} else if (line.trim().length > 0) {
					unlocatedUnreadable = true;
					unreadable = true;
					const suffix = inspectMalformedIdentitySuffix(line);
					if (!admission.headerSeen || suffix.invalidIdentity) admission.invalidIdentity = true;
					if (suffix.claimedId) {
						const detail = claimedIdError(suffix.claimedId, parents, malformedClaims);
						if (detail) return {
							status: "unavailable",
							sessionId,
							query: request.query,
							source: "stored-jsonl",
							matches: [],
							detail,
						};
						malformedClaims.add(suffix.claimedId);
					}
				} else if (initialPlainTitle) {
					initialTitleSeparated = true;
				}
				continue;
			}
			if (initialPlainTitle && !initialTitleSeparated) admission.invalidIdentity = true;
			const decoded = decodeStoredRecord(line, admission);
			sessionId = admission.sessionId;
			if (decoded.kind === "invalid") {
				unreadable = true;
				let rejectedParentId: unknown;
				try {
					rejectedParentId = (JSON.parse(line) as StoredEntryShape).parentId;
				} catch {
					// A malformed row cannot locate its corruption outside the selected branch.
				}
				if (!(decoded.claimedId && !parents.has(decoded.claimedId) && rejectedParentId === "")) {
					unlocatedUnreadable = true;
				}
				if (decoded.claimedId) {
					const detail = claimedIdError(decoded.claimedId, parents, malformedClaims);
					if (detail) return {
						status: "unavailable",
						sessionId,
						query: request.query,
						source: "stored-jsonl",
						matches: [],
						detail,
					};
					malformedClaims.add(decoded.claimedId);
				}
				continue;
			}
			if (decoded.kind === "metadata") continue;
			const entry = decoded.entry;
			if (!isStoredEntry(entry)) {
				unreadable = true;
				continue;
			}
			if (parents.has(entry.id) || malformedClaims.has(entry.id)) {
				return {
					status: "unavailable",
					sessionId,
					query: request.query,
					source: "stored-jsonl",
					matches: [],
					detail: DUPLICATE_ID_DETAIL,
				};
			}
			if (parents.size + malformedClaims.size >= MAX_INDEX_ENTRIES) {
				return {
					status: "unavailable",
					sessionId,
					query: request.query,
					source: "stored-jsonl",
					matches: [],
					detail: HARD_BOUND_DETAIL,
				};
			}
			parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : undefined);
			lastId = entry.id;
		}
	} catch (error) {
		if (!isFileReadError(error)) throw error;
		return {
			status: "unavailable",
			query: request.query,
			source: "stored-jsonl",
			matches: [],
			detail: "Stored session file could not be read; this is not a negative evidence lookup",
		};
	}
	if (!admission.headerSeen || admission.invalidIdentity) {
		return {
			status: "unavailable",
			sessionId,
			query: request.query,
			source: "stored-jsonl",
			matches: [],
			detail: "Stored session identity is missing or ambiguous",
		};
	}
	// An unreadable record may be the real tip rather than the last readable sibling.
	if (request.leafId === undefined && unreadable) {
		return {
			status: "unavailable",
			sessionId,
			query: request.query,
			source: "stored-jsonl",
			matches: [],
			detail:
				"Cannot select a default branch after unreadable/oversized stored records; provide leaf= for intentional archived-branch search",
		};
	}
	const leafId = request.leafId === null ? undefined : (request.leafId ?? lastId);
	if (!leafId || !parents.has(leafId)) {
		return {
			status: unreadable ? "unavailable" : "missing_branch",
			sessionId,
			leafId,
			query: request.query,
			source: "stored-jsonl",
			matches: [],
			detail: unreadable
				? "Cannot verify the requested branch after unreadable records"
				: "Requested session branch was not found",
		};
	}
	// Select the lineage before enforcing the candidate cap. Otherwise
	// unrelated sibling matches can evict an older matching ancestor.
	const selectedIds = selectedBranchIds(parents, leafId);
	if (!selectedIds) {
		return {
			status: "unavailable",
			sessionId,
			leafId,
			query: request.query,
			source: "stored-jsonl",
			matches: [],
			detail: "Selected branch has cyclic parent links; search ancestry is ambiguous",
		};
	}
	const candidates: Array<{ entryId: string; recordType: string; preview: string; digest: string }> = [];
	let truncated = false;
	const matchesHash = createHash("sha256");
	const replayAdmission: StoredAdmissionState = {
		headerSeen: false,
		entrySeen: false,
		titleSeen: false,
		invalidIdentity: false,
	};
	try {
		for await (const line of storedLines(filePath)) {
			if (line === SCAN_BOUND_EXCEEDED) {
				return {
					status: "unavailable",
					sessionId,
					leafId,
					query: request.query,
					source: "stored-jsonl",
					matches: [],
					detail: HARD_BOUND_DETAIL,
				};
			}
			matchesHash.update(line ?? "\0unreadable").update("\n");
			if (line === undefined || !line.trimStart().startsWith("{")) continue;
			const decoded = decodeStoredRecord(line, replayAdmission);
			if (decoded.kind !== "entry") continue;
			const entry = decoded.entry;
			if (!isStoredEntry(entry)) continue;
			if (!selectedIds.has(entry.id) || !line.toLowerCase().includes(query)) continue;
			if (candidates.length >= MAX_CANDIDATE_MATCHES) {
				candidates.shift();
				truncated = true;
			}
			candidates.push({
				entryId: entry.id,
				recordType: entry.type,
				preview: previewAt(line, query),
				digest: recordDigest(line),
			});
		}
	} catch (error) {
		if (!isFileReadError(error)) throw error;
		return {
			status: "unavailable",
			sessionId,
			leafId,
			query: request.query,
			source: "stored-jsonl",
			matches: [],
			detail: "Stored session file could not be read; this is not a negative evidence lookup",
		};
	}
	// Session history can be rewritten while this read-only search runs.
	// A second pass must not combine newer text with an older branch graph.
	if (topologyHash.digest("hex") !== matchesHash.digest("hex")) {
		return {
			status: "unavailable",
			sessionId,
			leafId,
			query: request.query,
			source: "stored-jsonl",
			matches: [],
			detail: "Stored session changed during search; retry to select a consistent branch",
		};
	}
	const selectedCorruption = unlocatedUnreadable || [...malformedClaims].some(id => selectedIds.has(id));
	const matches = candidates
		.reverse()
		.slice(0, request.limit)
		.map(({ digest, ...match }) => ({
			...match,
			revision: recordRevision(digest, "stored-jsonl", leafId, sessionId),
		}));
	return {
		status: selectedCorruption || truncated ? "partial" : "ok",
		sessionId,
		leafId,
		query: request.query,
		source: "stored-jsonl",
		matches,
		detail:
			selectedCorruption || truncated
				? "Not exhaustive: malformed/oversized records on the selected branch or more than 500 selected-branch candidates; stored text only, blobs not searched"
				: "Bounded newest-first matches from stored JSONL text; externalized blobs were not searched",
	};
}

/** In-memory sessions use their current branch, not a process-wide agent index. */
export function searchLiveHistoryEntries(
	branch: readonly SessionEntry[],
	request: HistorySearchRequest,
	sessionId?: string,
): HistorySearchResult {
	const leafIndex =
		request.leafId === null
			? -1
			: request.leafId
				? branch.findIndex(entry => entry.id === request.leafId)
				: branch.length - 1;
	const leafId = branch[leafIndex]?.id ?? request.leafId ?? undefined;
	if (leafIndex < 0) {
		return {
			status: "missing_branch",
			leafId,
			sessionId,
			query: request.query,
			source: "live-session",
			matches: [],
			detail: "Requested leaf is not in the active in-memory branch",
		};
	}
	const query = request.query.toLowerCase();
	const matches: HistorySearchResult["matches"] = [];
	for (let i = leafIndex; i >= 0 && matches.length < request.limit; i--) {
		const entry = branch[i]!;
		const raw = JSON.stringify(entry);
		if (!raw.toLowerCase().includes(query)) continue;
		matches.push({
			entryId: entry.id,
			recordType: entry.type,
			preview: previewAt(raw, query),
			revision: recordRevision(recordDigest(raw), "live-session", leafId!, sessionId),
		});
	}
	return {
		status: "ok",
		leafId,
		sessionId,
		query: request.query,
		source: "live-session",
		matches,
		detail: "Bounded newest-first matches in the active in-memory branch",
	};
}
