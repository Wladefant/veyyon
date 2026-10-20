/**
 * Per-session snapshot store used by {@link Recovery} and {@link Patcher} to
 * bind hashline section tags to the exact file content that minted them.
 *
 * A section tag is a content-derived hash of the *whole file* (see
 * {@link computeFileHash}). Any read of byte-identical content mints the same
 * tag, so reads of one file state fuse onto one anchor and a follow-up edit
 * anchored at any line validates whenever the live file still hashes to it.
 *
 * Producers (typically `read` / `search` / `write` tools) call
 * {@link SnapshotStore.record} with the full normalized text they observed.
 * The store hashes it, dedups against the per-path history, and returns the
 * tag. Consumers (recovery, the patcher) resolve a stale tag back to the
 * recorded full text and map its unchanged edit anchors onto live content.
 *
 * The abstract base class lets callers plug in whatever storage they like
 * (LRU, persistent SQLite, etc.). {@link InMemorySnapshotStore} ships as a
 * sensible default backed by `lru-cache`: a bounded set of paths, each with a
 * short history of full-file versions so in-session edit chains can still
 * recover against the version a stale tag names.
 */
import { LRUCache } from "lru-cache/raw";
import { computeFileHash } from "./format";

/**
 * One full-file version observed at a point in time. The tag the model sees is
 * {@link Snapshot.hash}; recovery replays edits against {@link Snapshot.text}.
 */
export interface Snapshot {
	/** Canonical path this version belongs to. */
	readonly path: string;
	/** Full normalized (LF, no BOM) file text as observed. */
	readonly text: string;
	/** Content-derived tag for {@link Snapshot.text} (see {@link computeFileHash}). */
	readonly hash: string;
	/** Timestamp (ms since epoch) the version was recorded. */
	recordedAt: number;
	/**
	 * 1-indexed file lines a producer (read/search) actually *displayed* under
	 * this tag. A partial read (range, or a structural summary that collapsed
	 * bodies) leaves this sparse; a whole-file read fills every line. Multiple
	 * reads of the same content union into one set. `undefined` means "no
	 * provenance recorded" — the patcher then skips the seen-line check and
	 * applies as before. Mutated in place as more of the same content is read.
	 */
	seenLines?: Set<number>;
	/**
	 * 1-indexed lines a producer DISPLAYED BUT CLIPPED at its per-line column
	 * cap: the model received the line number and a leading prefix, never the
	 * full width. Deliberately kept out of {@link seenLines}, because an edit
	 * that rewrites those bytes would be rewriting bytes nobody read.
	 *
	 * Tracked separately rather than merely omitted so the patcher can tell a
	 * clipped line from one that was never rendered at all (an elided body, a
	 * folded summary row, a line outside the read range). The distinction is
	 * what lets a pure insertion anchor a clipped line — an insertion uses the
	 * anchor's POSITION and leaves its bytes alone — while every destructive
	 * form stays refused. A line never rendered is refused for every form,
	 * insertion included: without even a prefix there is nothing to identify.
	 */
	clippedLines?: Set<number>;
}

/**
 * Storage seam for full-file version snapshots. The patcher calls {@link head}
 * for the latest version of a path and {@link byHash} when it needs the
 * historical version a section's stale tag names.
 */
export abstract class SnapshotStore {
	/** Most-recently recorded version for `path`, or `null` if none. */
	abstract head(path: string): Snapshot | null;

	/**
	 * Recorded version for `path` whose tag equals `hash`, or `null`. When two
	 * distinct texts collide on the 16-bit tag, returns the most-recently
	 * recorded one.
	 */
	abstract byHash(path: string, hash: string): Snapshot | null;

	/**
	 * Recorded version for `path` whose {@link Snapshot.text} equals `fullText`,
	 * or `null`. The patcher uses it on the no-drift path to attach seen-line
	 * provenance to the exact text the model read.
	 */
	abstract byContent(path: string, fullText: string): Snapshot | null;

	/**
	 * Every retained version whose tag equals `hash`, across all tracked
	 * paths. The patcher uses this to recover the intended file when a section
	 * names a path that does not exist on disk but carries a tag the store
	 * minted — the model mistyped the path of a file it read this session.
	 *
	 * The base returns no matches (recovery disabled); stores that can
	 * enumerate their contents override it to enable tag-based path recovery.
	 */
	findByHash(_hash: string): Snapshot[] {
		return [];
	}

	/**
	 * Merge into `snapshot` the displayed and clipped lines of every other
	 * retained version, under any path, whose text equals `snapshot.text`. The
	 * tag is a hash of the content, so a line displayed in one copy of a text
	 * was displayed for every copy. A copy with no displayed-line record adds
	 * nothing.
	 */
	mergeDisplayedCopies(snapshot: Snapshot): void {
		for (const copy of this.findByHash(snapshot.hash)) {
			if (copy === snapshot || copy.text !== snapshot.text) continue;
			mergeLines(snapshot, "seenLines", copy.seenLines);
			mergeLines(snapshot, "clippedLines", copy.clippedLines);
		}
	}

	/**
	 * Record the full normalized text of `path` and return its content tag.
	 * `seenLines` (optional) are the 1-indexed lines the producer displayed;
	 * they merge into {@link Snapshot.seenLines} across reads of identical text.
	 */
	abstract record(path: string, fullText: string, seenLines?: Iterable<number>): string;

	/**
	 * Merge `lines` into the {@link Snapshot.seenLines} of the version whose tag
	 * equals `hash`. No-op when no such version is retained (the content aged
	 * out or was overwritten). Lets producers attach displayed lines after the
	 * tag was already minted (the body is formatted after the hash is computed).
	 */
	abstract recordSeenLines(path: string, hash: string, lines: Iterable<number>): void;

	/**
	 * Merge `lines` into the {@link Snapshot.clippedLines} of the version whose
	 * tag equals `hash`. Same contract as {@link recordSeenLines}, for the lines
	 * a producer showed only a prefix of. A producer that applies a per-line
	 * column cap reports both sets: the lines it displayed in full here as seen,
	 * and the ones it truncated here.
	 */
	abstract recordClippedLines(path: string, hash: string, lines: Iterable<number>): void;

	/** Drop the version history for a single path. */
	abstract invalidate(path: string): void;

	/**
	 * Move retained version history (and read provenance) from `from` to `to`.
	 * No-op when `from` has no history. Used by file moves so tags minted from
	 * reads of the source path stay valid at the destination.
	 */
	abstract relocate(from: string, to: string): void;

	/** Drop every version history. */
	abstract clear(): void;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
/** Global ceiling on retained snapshot text across all paths (UTF-16 code units). */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Paths whose dropped versions keep their displayed-line provenance. */
const DEFAULT_MAX_DROPPED_PATHS = 1024;
/** Ceiling on retained provenance across every dropped version, in range bounds (4 bytes each). */
const MAX_DROPPED_RANGE_BOUNDS = 256 * 1024;

/** Union `lines` into `snapshot[key]`, lazily creating the set. */
function mergeLines(snapshot: Snapshot, key: "seenLines" | "clippedLines", lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	snapshot[key] ??= new Set<number>();
	const target = snapshot[key];
	for (const line of lines) target.add(line);
}

/**
 * Displayed-line provenance of a version the store no longer holds, kept
 * without its text. `length` and `digest` identify the exact text; `seen` and
 * `clipped` are inclusive `[start, end]` line ranges, flattened.
 */
interface DroppedVersion {
	readonly length: number;
	readonly digest: bigint;
	readonly seen?: Uint32Array;
	readonly clipped?: Uint32Array;
}

/**
 * Identity of a dropped version's text, computed on every eviction. `node:crypto`
 * has no non-cryptographic hash: SHA-1 of a 26 KB file takes 9 µs, xxHash64 1 µs.
 */
function textDigest(text: string): bigint {
	return Bun.hash.xxHash64(text);
}

function toRanges(lines: Set<number> | undefined): Uint32Array | undefined {
	if (lines === undefined || lines.size === 0) return undefined;
	const sorted = Uint32Array.from(lines).sort();
	const bounds: number[] = [];
	let start = sorted[0];
	let end = start;
	for (let i = 1; i < sorted.length; i++) {
		const line = sorted[i];
		if (line === end + 1) {
			end = line;
			continue;
		}
		bounds.push(start, end);
		start = line;
		end = line;
	}
	bounds.push(start, end);
	return Uint32Array.from(bounds);
}

function* fromRanges(bounds: Uint32Array): Generator<number> {
	for (let i = 0; i < bounds.length; i += 2) {
		for (let line = bounds[i]; line <= bounds[i + 1]; line++) yield line;
	}
}

function droppedVersion(version: Snapshot): DroppedVersion | undefined {
	const seen = toRanges(version.seenLines);
	const clipped = toRanges(version.clippedLines);
	if (seen === undefined && clipped === undefined) return undefined;
	return { length: version.text.length, digest: textDigest(version.text), seen, clipped };
}

export interface InMemorySnapshotStoreOptions {
	/** Maximum number of distinct paths tracked at once (default 30). LRU eviction. */
	maxPaths?: number;
	/** Maximum full-file versions retained per path (default 4). Oldest dropped first. */
	maxVersionsPerPath?: number;
	/**
	 * Global ceiling on retained snapshot text summed across every path's
	 * version history, measured in UTF-16 code units (default 64 MiB).
	 * Least-recently-used path histories are evicted to stay under it.
	 */
	maxTotalBytes?: number;
	/**
	 * Maximum number of paths whose dropped versions keep their displayed-line
	 * provenance (default 1024). LRU eviction.
	 */
	maxDroppedPaths?: number;
}

/**
 * In-memory {@link SnapshotStore} backed by `lru-cache`. Per-path history is a
 * short ring of full-file versions (oldest dropped first); per-session path
 * tracking is LRU-bounded so cold paths age out automatically.
 *
 * Recording byte-identical content again refreshes recency and reuses the
 * existing tag (read fusion); recording new content unshifts a fresh version
 * onto the front of the path history. Two distinct texts that collide on the
 * short 4-hex tag are retained as separate versions so callers can still tell
 * them apart via {@link Snapshot.text} — the tag is only a fast index, never
 * the identity.
 *
 * A version that leaves the store by LRU eviction or by the per-path ring keeps
 * its {@link Snapshot.seenLines} and {@link Snapshot.clippedLines} as compact
 * ranges keyed by a digest of its text. Recording the same text again restores
 * them, so a line displayed before the version was dropped stays displayed
 * under the tag it was displayed with. {@link invalidate} and {@link clear}
 * discard that provenance.
 */
export class InMemorySnapshotStore extends SnapshotStore {
	readonly #versions: LRUCache<string, Snapshot[]>;
	readonly #dropped: LRUCache<string, DroppedVersion[]>;
	readonly #maxVersionsPerPath: number;

	constructor(options: InMemorySnapshotStoreOptions = {}) {
		super();
		this.#versions = new LRUCache<string, Snapshot[]>({
			max: options.maxPaths ?? DEFAULT_MAX_PATHS,
			maxSize: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
			sizeCalculation: history => {
				let total = 1;
				for (const version of history) total += version.text.length;
				return total;
			},
			dispose: (history, path, reason) => {
				if (reason === "evict") this.#retainDropped(path, history);
			},
		});
		this.#dropped = new LRUCache<string, DroppedVersion[]>({
			max: options.maxDroppedPaths ?? DEFAULT_MAX_DROPPED_PATHS,
			maxSize: MAX_DROPPED_RANGE_BOUNDS,
			sizeCalculation: dropped => {
				let total = 1;
				for (const version of dropped) total += (version.seen?.length ?? 0) + (version.clipped?.length ?? 0);
				return total;
			},
		});
		this.#maxVersionsPerPath = options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
	}

	/** Keep the provenance of `versions`, which are leaving the store, ahead of what `path` already kept. */
	#retainDropped(path: string, versions: readonly Snapshot[]): void {
		const kept: DroppedVersion[] = [];
		for (const version of versions) {
			const dropped = droppedVersion(version);
			if (dropped) kept.push(dropped);
		}
		if (kept.length === 0) return;
		for (const earlier of this.#dropped.get(path) ?? []) {
			if (!kept.some(version => version.digest === earlier.digest)) kept.push(earlier);
		}
		this.#dropped.set(path, kept.slice(0, this.#maxVersionsPerPath));
	}

	/** Restore onto a freshly minted `snapshot` the provenance its text had when an earlier version of it was dropped. */
	#restoreDropped(snapshot: Snapshot): void {
		const dropped = this.#dropped.get(snapshot.path);
		if (dropped === undefined) return;
		const { length } = snapshot.text;
		if (!dropped.some(version => version.length === length)) return;
		const digest = textDigest(snapshot.text);
		const match = dropped.find(version => version.length === length && version.digest === digest);
		if (match === undefined) return;
		if (match.seen) mergeLines(snapshot, "seenLines", fromRanges(match.seen));
		if (match.clipped) mergeLines(snapshot, "clippedLines", fromRanges(match.clipped));
		const rest = dropped.filter(version => version !== match);
		if (rest.length === 0) this.#dropped.delete(snapshot.path);
		else this.#dropped.set(snapshot.path, rest);
	}

	head(path: string): Snapshot | null {
		return this.#versions.get(path)?.[0] ?? null;
	}

	byHash(path: string, hash: string): Snapshot | null {
		const history = this.#versions.get(path);
		return history?.find(version => version.hash === hash) ?? null;
	}

	byContent(path: string, fullText: string): Snapshot | null {
		const history = this.#versions.get(path);
		return history?.find(version => version.text === fullText) ?? null;
	}

	findByHash(hash: string): Snapshot[] {
		const matches: Snapshot[] = [];
		for (const history of this.#versions.values()) {
			for (const version of history) {
				if (version.hash === hash) matches.push(version);
			}
		}
		return matches;
	}

	/**
	 * Also merges the provenance kept for a dropped version of the same text
	 * under another path. The entry stays, since that path may record the text
	 * again.
	 */
	mergeDisplayedCopies(snapshot: Snapshot): void {
		super.mergeDisplayedCopies(snapshot);
		const { length } = snapshot.text;
		let digest: bigint | undefined;
		for (const [path, dropped] of this.#dropped.entries()) {
			if (path === snapshot.path) continue;
			for (const version of dropped) {
				if (version.length !== length) continue;
				digest ??= textDigest(snapshot.text);
				if (version.digest !== digest) continue;
				if (version.seen) mergeLines(snapshot, "seenLines", fromRanges(version.seen));
				if (version.clipped) mergeLines(snapshot, "clippedLines", fromRanges(version.clipped));
			}
		}
	}

	record(path: string, fullText: string, seenLines?: Iterable<number>): string {
		const hash = computeFileHash(fullText);
		// `get` refreshes LRU recency for `path`.
		const history = this.#versions.get(path) ?? [];
		// Dedup requires full-text equality, not just tag equality: two distinct
		// texts that happen to share the 4-hex tag are DIFFERENT snapshots — fusing
		// them under one entry would corrupt seenLines (attaching lines from
		// text B onto the stored text A) and let the patcher misresolve which
		// snapshot the section tag names during recovery or seen-line validation.
		// See issue #4075.
		const existing = history.find(version => version.hash === hash && version.text === fullText);
		if (existing) {
			// Same content state observed again: refresh recency and promote to
			// head (it is the current file content), then reuse the tag. Union any
			// newly-displayed lines so re-reading more of the file widens coverage.
			existing.recordedAt = Date.now();
			mergeLines(existing, "seenLines", seenLines);
			if (history[0] !== existing) {
				this.#versions.set(path, [existing, ...history.filter(version => version !== existing)]);
			}
			return hash;
		}

		const snapshot: Snapshot = { path, text: fullText, hash, recordedAt: Date.now() };
		this.#restoreDropped(snapshot);
		mergeLines(snapshot, "seenLines", seenLines);
		const next = [snapshot, ...history];
		if (next.length > this.#maxVersionsPerPath) this.#retainDropped(path, next.slice(this.#maxVersionsPerPath));
		this.#versions.set(path, next.slice(0, this.#maxVersionsPerPath));
		return hash;
	}

	recordSeenLines(path: string, hash: string, lines: Iterable<number>): void {
		const version = this.#versions.get(path)?.find(snapshot => snapshot.hash === hash);
		if (version) mergeLines(version, "seenLines", lines);
	}

	recordClippedLines(path: string, hash: string, lines: Iterable<number>): void {
		const version = this.#versions.get(path)?.find(snapshot => snapshot.hash === hash);
		if (version) mergeLines(version, "clippedLines", lines);
	}

	invalidate(path: string): void {
		this.#versions.delete(path);
		this.#dropped.delete(path);
	}

	relocate(from: string, to: string): void {
		const sourceDropped = this.#dropped.get(from);
		if (sourceDropped !== undefined) {
			this.#dropped.delete(from);
			const destDropped = this.#dropped.get(to) ?? [];
			const merged = sourceDropped.concat(
				destDropped.filter(version => !sourceDropped.some(source => source.digest === version.digest)),
			);
			this.#dropped.set(to, merged.slice(0, this.#maxVersionsPerPath));
		}
		const sourceHistory = this.#versions.get(from);
		if (sourceHistory === undefined || sourceHistory.length === 0) return;
		const relocated = sourceHistory.map(version => ({ ...version, path: to }));
		const destHistory = this.#versions.get(to);
		if (destHistory === undefined) {
			this.#versions.set(to, relocated);
		} else {
			const seen = new Set<string>();
			const merged: Snapshot[] = [];
			for (const version of relocated.concat(destHistory)) {
				if (seen.has(version.hash)) continue;
				seen.add(version.hash);
				merged.push(version);
			}
			if (merged.length > this.#maxVersionsPerPath) this.#retainDropped(to, merged.slice(this.#maxVersionsPerPath));
			this.#versions.set(to, merged.slice(0, this.#maxVersionsPerPath));
		}
		this.#versions.delete(from);
	}

	clear(): void {
		this.#versions.clear();
		this.#dropped.clear();
	}
}
