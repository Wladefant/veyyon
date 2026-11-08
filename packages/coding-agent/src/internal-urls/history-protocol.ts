/**
 * Protocol handler for history:// URLs.
 *
 * Exposes agent transcripts as concise markdown. Live refs render from the
 * in-memory message array; parked refs (session disposed, sessionFile
 * retained) load read-only from the JSONL session file — no writer, no lock.
 *
 * Agents that are no longer in the `AgentRegistry` — one-shot helpers
 * unregistered after `finalizeSubagentLifecycle` (`keepAlive: false`, e.g. the
 * `eval` `agent()` bridge), agents released via the agent dashboard / vibe kill, or
 * any agent after a session resume — remain reachable: `resolve`, `complete`,
 * and the index all fall back to scanning artifacts dirs for `<id>.jsonl`,
 * mirroring how `agent://` reads `.md` outputs straight off disk.
 *
 * URL forms:
 * - history:// - Index of all registry + on-disk agents (id, status, kind, last activity)
 * - history://<agentId> - Concise markdown transcript of that agent
 * - history://<agentId>?q=term - Bounded, branch-aware search returning entry IDs
 * - history://<agentId>?entry=<entryId>&offset=0&limit=8000 - Exact stored record page
 */

import { loadSessionMessagesReadOnly } from "@veyyon/kernel/session/session-loader";
import type { AgentRef } from "../registry/agent-registry";
import { AgentRegistry } from "../registry/agent-registry";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import {
	parseExactHistoryRequest,
	parseHistorySearchRequest,
	readLiveHistoryEntry,
	readStoredHistoryEntry,
	searchLiveHistoryEntries,
	searchStoredHistoryEntries,
} from "./history-exact";
import { ambiguousSessionFileIds, sessionFilesFromDisk } from "./registry-helpers";
import { resolveHistoryCallerCapability } from "./history-caller";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

/** Humanize a last-activity timestamp as `Ns/Nm/Nh/Nd ago`. */
function formatAgo(timestamp: number): string {
	const diffMs = Math.max(0, Date.now() - timestamp);
	const secs = Math.floor(diffMs / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** One row of the history index — either a registered ref or a disk-only transcript. */
interface IndexEntry {
	id: string;
	status: string;
	kind: string;
	parent: string;
	lastActivity: string;
}

/**
 * A parked root retains its conversation scope and may still expose its own
 * archived agents through the global registry. Do not drop that scope from
 * the history read boundary just because the root session was detached.
 *
 * This guards distinct KNOWN registered scopes only. Legacy unscoped refs
 * and disk-only transcript provenance remain separate #885 policy work; this
 * is not caller-authenticated multi-conversation routing.
 */
function registeredConversationScopes(): string[] {
	const scopes = new Set<string>();
	for (const ref of AgentRegistry.global().list()) {
		if (ref.scope !== undefined) scopes.add(ref.scope);
	}
	return Array.from(scopes);
}


const ARCHIVED_HISTORY_UNAVAILABLE = "Archived history is unavailable for this caller and request.";

type ResolvedHistoryCaller = NonNullable<ReturnType<typeof resolveHistoryCallerCapability>>;
type ArchivedHistoryMode =
  | { kind: "index" }
  | { kind: "exact"; request: NonNullable<ReturnType<typeof parseExactHistoryRequest>> }
  | { kind: "search"; request: NonNullable<ReturnType<typeof parseHistorySearchRequest>> };

function archivedUnavailable(): never {
  throw new Error(ARCHIVED_HISTORY_UNAVAILABLE);
}

/**
 * Parse the opt-in as a closed query contract. URL-supplied actor/scope/session
 * claims and duplicate parameters are never authority and are rejected.
 */
function parseArchivedHistoryMode(url: InternalUrl, agentId: string): ArchivedHistoryMode | undefined {
  const archived = url.searchParams.getAll("archived");
  if (archived.length === 0) return undefined;
  if (archived.length !== 1 || archived[0] !== "1") return archivedUnavailable();

  if (
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    (url.rawPathname !== undefined && url.rawPathname !== "" && url.rawPathname !== "/")
  ) {
    return archivedUnavailable();
  }

  const keys = [...url.searchParams.keys()];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return archivedUnavailable();
    seen.add(key);
  }

  if (!agentId) {
    if (keys.some(key => key !== "archived")) return archivedUnavailable();
    return { kind: "index" };
  }

  const hasEntry = url.searchParams.has("entry");
  const hasQuery = url.searchParams.has("q");
  if (hasEntry === hasQuery) return archivedUnavailable();

  if (hasEntry) {
    const allowed = new Set(["archived", "entry", "leaf", "revision", "offset", "limit"]);
    if (keys.some(key => !allowed.has(key))) return archivedUnavailable();
    try {
      const request = parseExactHistoryRequest(url);
      if (!request) return archivedUnavailable();
      return { kind: "exact", request };
    } catch {
      return archivedUnavailable();
    }
  }

  const allowed = new Set(["archived", "q", "leaf", "limit"]);
  if (keys.some(key => !allowed.has(key))) return archivedUnavailable();
  try {
    const request = parseHistorySearchRequest(url);
    if (!request) return archivedUnavailable();
    return { kind: "search", request };
  } catch {
    return archivedUnavailable();
  }
}

/**
 * An exact registered ID wins over case-fold aliases. Without an exact match,
 * a case-folded alias is usable only when exactly one registered identity owns
 * that spelling. No disk-only or unknown-scope fallback exists in this mode.
 */
function archivedTargetForCaller(caller: ResolvedHistoryCaller, agentId: string): AgentRef | undefined {
  const exact = caller.registry.get(agentId);
  let target = exact;
  if (!target) {
    const matches = caller.registry.list().filter(ref => ref.id.toLowerCase() === agentId.toLowerCase());
    if (matches.length !== 1) return undefined;
    target = matches[0];
  }

  if (
    !target ||
    target.kind === "advisor" ||
    target.scope !== caller.scope ||
    (target.status !== "parked" && target.status !== "aborted") ||
    target.session !== null ||
    typeof target.sessionFile !== "string" ||
    target.sessionFile.trim().length === 0
  ) {
    return undefined;
  }

  return target;
}

/** A same-scope, parked-only roster. It never scans or merges disk-only names. */
function renderArchivedIndex(refs: AgentRef[], scope: string): string {
  const entries = refs
    .filter(
      ref =>
        ref.kind !== "advisor" &&
        ref.scope === scope &&
        ref.status === "parked" &&
        ref.session === null &&
        typeof ref.sessionFile === "string" &&
        ref.sessionFile.trim().length > 0,
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const lines = ["# Archived agents in this conversation", ""];
  if (entries.length === 0) {
    lines.push("No parked agents in this conversation.");
  } else {
    lines.push("| id | status | kind | last activity |", "|---|---|---|---|");
    for (const ref of entries) {
      lines.push(`| ${ref.id} | ${ref.status} | ${ref.kind} | ${formatAgo(ref.lastActivity)} |`);
    }
  }
  lines.push(
    "",
    "Read an exact stored record with `read history://<id>?archived=1&entry=<entryId>`.",
    "Search stored records with `read history://<id>?archived=1&q=<term>`.",
  );
  return `${lines.join("\n")}\n`;
}

async function resolveArchivedHistory(
  url: InternalUrl,
  agentId: string,
  mode: ArchivedHistoryMode,
  capability: unknown,
): Promise<InternalResource> {
  const caller = resolveHistoryCallerCapability(capability);
  if (!caller) return archivedUnavailable();

  if (mode.kind === "index") {
    const content = renderArchivedIndex(caller.registry.list(), caller.scope);
    return {
      url: url.href,
      content,
      contentType: "text/markdown",
      size: Buffer.byteLength(content, "utf-8"),
      notes: ["Same-conversation parked-only index; disk-only transcript names are not enumerated"],
    };
  }

  if (!agentId) return archivedUnavailable();
  const target = archivedTargetForCaller(caller, agentId);
  if (!target || !target.sessionFile) return archivedUnavailable();
  const sessionFile = target.sessionFile;

  const result =
    mode.kind === "exact"
      ? await readStoredHistoryEntry(sessionFile, mode.request)
      : await searchStoredHistoryEntries(sessionFile, mode.request);

  // The scan is bounded but asynchronous. Do not return its content if the
  // caller was disposed/rescoped or the target was revived/replaced mid-read.
  const currentCaller = resolveHistoryCallerCapability(capability);
  if (
    !currentCaller ||
    currentCaller.registry !== caller.registry ||
    currentCaller.actor !== caller.actor ||
    currentCaller.scope !== caller.scope ||
    caller.registry.get(target.id) !== target ||
    archivedTargetForCaller(currentCaller, agentId) !== target ||
    target.kind === "advisor" ||
    target.scope !== caller.scope ||
    (target.status !== "parked" && target.status !== "aborted") ||
    target.session !== null ||
    target.sessionFile !== sessionFile
  ) {
    return archivedUnavailable();
  }

  const content = JSON.stringify(result, null, 2);
  return {
    url: url.href,
    content,
    contentType: "application/json",
    size: Buffer.byteLength(content, "utf-8"),
    notes: ["Read-only bounded archived records in the caller's conversation; externalized blobs are not expanded or searched"],
  };
}


/**
 * Handler for history:// URLs.
 *
 * Resolves agent ids against the global AgentRegistry, then falls back to
 * on-disk `.jsonl` transcripts, serving read-only history for live, parked,
 * and unregistered agents alike.
 */
export class HistoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "history";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const agentId = url.rawHost || url.hostname;
		const archivedMode = parseArchivedHistoryMode(url, agentId);
		if (archivedMode) return resolveArchivedHistory(url, agentId, archivedMode, context?.historyCaller);
		const registry = AgentRegistry.global();
		// The disk fallback already refuses an id that names a transcript in two
		// conversations, but the REGISTRY path never reached it: `registry.get(id)`
		// is a process-global lookup by a name the caller chose, so a live ref
		// belonging to another conversation was served directly, and the bare index
		// listed every conversation's agents in one table. Neither can be filtered
		// here: `ProtocolHandler.resolve` is handed no agent id and no scope, so
		// this handler genuinely does not know who is asking. A parked root
		// retains its scope and may expose archived agents, so refusing only
		// while TWO ROOT SESSIONS ARE LIVE is insufficient. Refuse when more
		// than one known registered conversation scope remains, live or parked.
		// Single-scope archived access remains available as before.
		const conversations = registeredConversationScopes();
		if (conversations.length > 1) {
			throw new Error(
				`history:// is unavailable while this process retains ${conversations.length} conversations at once (live or parked).\n` +
					`Agent ids are per-conversation names and this URL carries no conversation, so serving one would ` +
					`be a guess between them.\n` +
					`Read the transcript from the session that spawned the agent, or open its session file directly.`,
			);
		}
		// Advisors are observability-only and must remain hidden from all
		// agent-facing history paths, even if their JSONL is discoverable on disk.
		const registered = registry.list();
		const visible = registered.filter(ref => ref.kind !== "advisor");
		const advisorFolded = new Set(registered.filter(ref => ref.kind === "advisor").map(ref => ref.id.toLowerCase()));

		if (!agentId) {
			if (url.searchParams.has("entry") || url.searchParams.has("q")) {
				throw new Error("history:// search and exact reads require an agent ID");
			}
			const content = await renderIndex(visible, new Set(registered.map(ref => ref.id.toLowerCase())));
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		const exactRegistered = registry.get(agentId);
		// An advisor's registered ID must not turn into a disk fallback when we
		// hide the ref. Refuse its case aliases too. An exact visible ref remains
		// usable when another registered advisor differs only in letter case.
		if (advisorFolded.has(agentId.toLowerCase()) && (!exactRegistered || exactRegistered.kind === "advisor")) {
			throw new Error(`Unknown agent: ${agentId}`);
		}
		let ref = exactRegistered;
		if (!ref) {
			// Case-insensitive convenience is safe only for a UNIQUE registered
			// identity. Two distinct names may differ solely by case; picking
			// whichever was registered first can expose the wrong transcript.
			const lower = agentId.toLowerCase();
			const matches = visible.filter(candidate => candidate.id.toLowerCase() === lower);
			if (matches.length > 1) {
				throw new Error(
					`Ambiguous registered agent: ${agentId}\n` +
						"Multiple registered IDs match this spelling. Use the exact agent ID shown in history://.",
				);
			}
			ref = matches[0];
		}
		// A known registered ref with no live/retained session must never borrow
		// a different registered identity's disk transcript through case-folded
		// fallback. Keep unique-ID archival recovery and direct ref reads.
		const diskFallbackSafe =
			!advisorFolded.has(agentId.toLowerCase()) &&
			!registered.some(
				candidate => candidate.id !== ref?.id && candidate.id.toLowerCase() === agentId.toLowerCase(),
			);

		// Exact reads are opt-in; the ordinary concise overview remains unchanged.
		// Resolve only registry-owned or uniquely discovered session files, never a
		// path supplied in the URL. The multi-conversation refusal above still applies.
		const exactRequest = parseExactHistoryRequest(url);
		const searchRequest = parseHistorySearchRequest(url);
		if (exactRequest || searchRequest) {
			// Navigation moves the active leaf without rewriting the append-only file.
			// Its last record may therefore belong to a different, abandoned branch.
			if (ref?.session) {
				const selectedLeaf = ref.session.sessionManager.getLeafId();
				if (exactRequest && exactRequest.leafId === undefined) exactRequest.leafId = selectedLeaf;
				if (searchRequest && searchRequest.leafId === undefined) searchRequest.leafId = selectedLeaf;
			}
			let sessionFile = ref?.session?.sessionManager.getSessionFile() ?? ref?.sessionFile ?? undefined;
			if (!sessionFile && !ref?.session && diskFallbackSafe) {
				const disk = await sessionFilesFromDisk();
				const found = Array.from(disk).find(([id]) => id.toLowerCase() === agentId.toLowerCase());
				sessionFile = found?.[1];
			}
			if (sessionFile) {
				if (exactRequest?.leafId === null || searchRequest?.leafId === null) {
					throw new Error("history:// active session has no branch leaf; pass leaf= to select stored history");
				}
				const result = exactRequest
					? await readStoredHistoryEntry(sessionFile, exactRequest)
					: await searchStoredHistoryEntries(sessionFile, searchRequest!);
				const content = JSON.stringify(result, null, 2);
				return {
					url: url.href,
					content,
					contentType: "application/json",
					size: Buffer.byteLength(content, "utf8"),
					notes: ["Read-only stored session records; externalized blobs are not expanded or searched"],
				};
			}
			if (ref?.session) {
				const requestedLeaf = exactRequest ? exactRequest.leafId : searchRequest!.leafId;
				const branch = requestedLeaf === null ? [] : ref.session.sessionManager.getBranch(requestedLeaf);
				const result = exactRequest
					? readLiveHistoryEntry(branch, exactRequest, ref.session.sessionManager.getSessionId())
					: searchLiveHistoryEntries(branch, searchRequest!, ref.session.sessionManager.getSessionId());
				const content = JSON.stringify(result, null, 2);
				return {
					url: url.href,
					content,
					contentType: "application/json",
					size: Buffer.byteLength(content, "utf8"),
					notes: ["Active in-memory branch; no persistent session file"],
				};
			}
			// Preserve the existing ambiguous/unknown-agent diagnostic below.
		}

		if (!ref) {
			// Registry miss — the agent may have been unregistered or lost on resume.
			// Serve its transcript straight from disk if the session file persists.
			const disk = await resolveFromDisk(agentId);
			if (disk) return { ...disk, url: url.href };

			// AMBIGUOUS is not UNKNOWN, and saying the wrong one sends the operator
			// looking for a lost transcript that is not lost. Two conversations in this
			// process each ran an agent by this name, so `sessionFilesFromDisk` dropped
			// it rather than hand back whichever dir was enumerated first.
			const ambiguous = await ambiguousSessionFileIds();
			const collided = ambiguous.has(agentId)
				? agentId
				: Array.from(ambiguous).find(id => id.toLowerCase() === agentId.toLowerCase());
			if (collided !== undefined) {
				throw new Error(
					`Ambiguous agent: ${collided}\n` +
						`More than one conversation in this process has an agent with that name, so the id alone ` +
						`cannot say which transcript you mean, and returning either one would be a guess.\n` +
						`Read it from the session that spawned it, or open the transcript file directly.`,
				);
			}

			const known = visible.map(candidate => candidate.id);
			const knownStr = known.length > 0 ? known.join(", ") : "none";
			throw new Error(`Unknown agent: ${agentId}\nKnown agents: ${knownStr}\nList all with history://`);
		}

		const notes: string[] = [];
		let messages: unknown[];
		if (ref.session) {
			messages = ref.session.messages;
			notes.push("Source: live session");
		} else if (ref.sessionFile) {
			messages = await loadSessionMessagesReadOnly(ref.sessionFile);
			notes.push(`Source: session file (read-only, ${ref.status})`);
		} else {
			// No live session and no retained sessionFile — try the disk scan before
			// giving up, in case the transcript lingers under an artifacts dir.
			if (diskFallbackSafe) {
				const disk = await resolveFromDisk(ref.id);
				if (disk) return { ...disk, url: url.href };
			}
			throw new Error(`Agent ${ref.id} has no transcript: session is gone and no session file was retained`);
		}

		const content = formatSessionHistoryMarkdown(messages, { title: `${ref.id} (${ref.status})` });
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: ref.sessionFile ?? undefined,
			notes,
		};
	}

	/**
	 * Completions are silent-empty while multiple registered scopes survive,
	 * for the reason `resolve` refuses: every id here is a name from SOME
	 * conversation and the completer cannot say which is the caller's. Offering
	 * them all would put another conversation's agent names in an operator's
	 * autocomplete, which is the leak stated as plainly as it can be, and every
	 * one of those completions resolves to a refusal anyway.
	 */
	async complete(): Promise<UrlCompletion[]> {
		if (registeredConversationScopes().length > 1) return [];
		const completions: UrlCompletion[] = [];
		// A disk-only case alias resolves to the registered agent, not its own file.
		const registered = AgentRegistry.global().list();
		// Also reserve hidden advisor names: a disk-only alias must not
		// resurrect one of their transcripts as a selectable completion.
		const registeredFolded = new Set(registered.map(ref => ref.id.toLowerCase()));
		for (const ref of registered) {
			if (ref.kind === "advisor") continue;
			completions.push({
				value: ref.id,
				description: `${ref.status} · ${ref.kind}${ref.parentId ? ` · parent ${ref.parentId}` : ""}`,
			});
		}
		const disk = await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			const foldedId = id.toLowerCase();
			// Only a registry-owned name shadows a disk row. Preserve disk-only
			// names according to the disk scanner (including its ambiguity policy).
			if (registeredFolded.has(foldedId)) continue;
			completions.push({ value: id, description: "on disk" });
		}
		return completions;
	}
}

/**
 * Load a transcript for `agentId` from an on-disk `.jsonl` session file,
 * matched case-insensitively. Returns `undefined` when no file is found.
 */
async function resolveFromDisk(agentId: string): Promise<InternalResource | undefined> {
	const files = await sessionFilesFromDisk();
	const lower = agentId.toLowerCase();
	let matchedId: string | undefined;
	let sessionFile: string | undefined;
	for (const [id, file] of files) {
		if (id === agentId || id.toLowerCase() === lower) {
			matchedId = id;
			sessionFile = file;
			if (id === agentId) break;
		}
	}
	if (!matchedId || !sessionFile) return undefined;
	const messages = await loadSessionMessagesReadOnly(sessionFile);
	const content = formatSessionHistoryMarkdown(messages, { title: `${matchedId} (on disk)` });
	return {
		url: "",
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: sessionFile,
		notes: ["Source: session file (read-only, unregistered)"],
	};
}

async function renderIndex(refs: AgentRef[], registeredFolded: ReadonlySet<string>): Promise<string> {
	const entries: IndexEntry[] = refs.map(ref => ({
		id: ref.id,
		status: ref.status,
		kind: ref.kind,
		parent: ref.parentId ?? "—",
		lastActivity: formatAgo(ref.lastActivity),
	}));
	// Merge on-disk transcripts for agents absent from the registry.
	// Resolve and completions compare agent IDs case-insensitively, so an
	// on-disk alias shadowed by any registered ID must not appear selectable.
	// The caller includes hidden registered advisor IDs in the reserved set.
	const disk = await sessionFilesFromDisk();
	for (const id of disk.keys()) {
		if (registeredFolded.has(id.toLowerCase())) continue;
		entries.push({ id, status: "on disk", kind: "—", parent: "—", lastActivity: "—" });
	}

	const lines: string[] = ["# Agents", ""];
	if (entries.length === 0) {
		lines.push("No agents registered.");
		return `${lines.join("\n")}\n`;
	}
	lines.push("| id | status | kind | parent | last activity |", "|---|---|---|---|---|");
	for (const entry of entries) {
		lines.push(`| ${entry.id} | ${entry.status} | ${entry.kind} | ${entry.parent} | ${entry.lastActivity} |`);
	}
	lines.push(
		"",
		"Read a transcript with `read history://<id>`. Search stored records with `read history://<id>?q=term`, then retrieve exact pages with `read history://<id>?entry=<entryId>&limit=8000`.",
	);
	return `${lines.join("\n")}\n`;
}
