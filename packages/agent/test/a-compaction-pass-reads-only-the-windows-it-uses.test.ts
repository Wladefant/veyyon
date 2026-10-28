import { describe, expect, it } from "bun:test";
import {
	DEFAULT_COMPACTION_SETTINGS,
	KEEP_NOTHING_ENTRY_ID,
	prepareCompaction,
	REMOTE_COMPACTION_PRESERVE_KEY,
	type SessionEntry,
} from "@veyyon/agent-core/compaction";

/**
 * WHY: a session holds the server-side window of a compaction a newer compaction summarized on
 * disk, and reading that window reads the entry's line back from the session file. A pass that
 * validated every window on the branch, to find the furthest kept boundary and to pick one window
 * per provider and api to chain, read every old window back on each pass, though it uses only the
 * newest valid window of each host and the furthest valid boundary.
 *
 * The class this closes: over generated branches of server-side compactions on random hosts, with
 * random keep boundaries, valid and malformed windows, and a local compaction or none behind them,
 * and a written branch whose windows keep no further than the summary start, `prepareCompaction`
 * keeps from the boundary and chains the windows an eager validation of every window selects, and
 * never reads the window of a compaction whose host a newer valid window chains and whose keep
 * boundary lies behind the furthest valid one or at or behind the summary start.
 *
 * What it does NOT catch: the session side that moves the windows to disk;
 * `compacted-history-reads-back-from-the-session-file.test.ts` drives a cold session through a pass.
 */

/** A deterministic generator, so a failing seed reproduces. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const HOSTS = [
	{ provider: "openai", api: "openai-responses" },
	{ provider: "azure-openai-responses", api: "azure-openai-responses" },
	{ provider: "openai-codex", api: "openai-codex-responses" },
];

/** What the generator wrote into a window record, read without touching its window. */
interface WindowFacts {
	host: string;
	valid: boolean;
}

interface Branch {
	entries: SessionEntry[];
	windows: Map<string, WindowFacts>;
	/** Ids of the compactions whose window a reader read. */
	reads: Set<string>;
}

type Host = (typeof HOSTS)[number];

/** A valid window, one with no compaction item, an empty one, or one of a version no reader knows. */
type WindowKind = "valid" | "no-compaction-item" | "empty" | "unknown-version";

/** Writes a branch entry by entry, recording what each window holds and which windows a reader read. */
class BranchWriter implements Branch {
	readonly entries: SessionEntry[] = [];
	readonly windows = new Map<string, WindowFacts>();
	readonly reads = new Set<string>();
	readonly messageIds: string[] = [];
	#parentId: string | null = null;

	#push(entry: SessionEntry): void {
		this.entries.push(entry);
		this.#parentId = entry.id;
	}

	message(): void {
		const id = `m${this.entries.length}`;
		this.messageIds.push(id);
		this.#push({
			type: "message",
			id,
			parentId: this.#parentId,
			timestamp: TIMESTAMP,
			message: { role: "user", content: `turn ${this.entries.length}`, timestamp: this.entries.length },
		} as SessionEntry);
	}

	/** A compaction with no server-side window, keeping from `keep`. */
	local(keep: string): void {
		this.#push({
			type: "compaction",
			id: `c${this.entries.length}`,
			parentId: this.#parentId,
			timestamp: TIMESTAMP,
			summary: "local summary",
			firstKeptEntryId: keep,
			tokensBefore: 1,
		} as SessionEntry);
	}

	/** A server-side compaction on `host`, keeping from `keep`, whose window records each read. */
	window(host: Host, keep: string, kind: WindowKind): void {
		const id = `c${this.entries.length}`;
		const record: Record<string, unknown> = {
			version: kind === "unknown-version" ? 2 : 1,
			provider: host.provider,
			api: host.api,
			model: "m",
			compactedAt: TIMESTAMP,
		};
		const window =
			kind === "no-compaction-item"
				? [{ type: "message", role: "user", content: "retained" }]
				: kind === "empty"
					? []
					: [{ type: "compaction", encrypted_content: `blob-${id}` }];
		const reads = this.reads;
		Object.defineProperty(record, "window", {
			enumerable: true,
			get() {
				reads.add(id);
				return window;
			},
		});
		this.windows.set(id, { host: `${host.provider}/${host.api}`, valid: kind === "valid" });
		this.#push({
			type: "compaction",
			id,
			parentId: this.#parentId,
			timestamp: TIMESTAMP,
			summary: "",
			firstKeptEntryId: keep,
			tokensBefore: 1,
			preserveData: { [REMOTE_COMPACTION_PRESERVE_KEY]: record },
		} as SessionEntry);
	}
}

function generate(seed: number): Branch {
	const random = mulberry32(seed);
	const writer = new BranchWriter();
	const { messageIds } = writer;
	/** One of the last four messages, or the keep-nothing marker. */
	const keep = (): string =>
		random() < 0.2
			? KEEP_NOTHING_ENTRY_ID
			: messageIds[Math.max(0, messageIds.length - 1 - Math.floor(random() * 4))]!;
	writer.message();
	writer.message();
	if (random() < 0.3) {
		writer.local(keep());
		writer.message();
	}
	let host = HOSTS[0]!;
	const count = 2 + Math.floor(random() * 6);
	for (let w = 0; w < count; w++) {
		for (let turns = Math.floor(random() * 3); turns >= 0; turns--) writer.message();
		if (random() < 0.4) host = HOSTS[Math.floor(random() * HOSTS.length)]!;
		const roll = random();
		const kind = roll < 0.7 ? "valid" : roll < 0.8 ? "no-compaction-item" : roll < 0.9 ? "empty" : "unknown-version";
		writer.window(host, keep(), kind);
		writer.message();
	}
	return writer;
}

/**
 * Windows that keep no further than the summary start: a valid newer window keeps behind an
 * invalid older one of the same host, and the one window keeping past the summary start is
 * invalid. The boundary search ends at the summary start, so it never reads the older window,
 * whose host the newer one chains.
 */
function windowsAtTheSummaryStart(): Branch {
	const writer = new BranchWriter();
	const [openai, azure] = HOSTS;
	writer.message(); // m0
	writer.message(); // m1
	writer.message(); // m2
	writer.local("m2"); // c3: the summary starts at m2
	writer.message(); // m4
	writer.window(openai!, "m2", "empty"); // c5 keeps from the summary start
	writer.message(); // m6
	writer.window(openai!, "m1", "valid"); // c7 keeps behind it
	writer.message(); // m8
	writer.window(azure!, "m8", "no-compaction-item"); // c9 keeps past the summary start
	writer.message(); // m10
	return writer;
}

interface Expected {
	/** Undefined when the pass has nothing to summarize. */
	firstKeptEntryId: string | undefined;
	/** The compactions whose windows the pass chains, newest first; undefined when none. */
	chain: string[] | undefined;
	/** Compactions whose window the pass never needs. */
	unneeded: string[];
}

/**
 * What a pass that validates every window selects, keeping as much as its budget allows: the first
 * message at or past the furthest valid boundary, and the newest valid window of each host.
 */
function eagerSelection({ entries, windows }: Branch): Expected {
	const start = (index: number): number => {
		const keepId = (entries[index] as { firstKeptEntryId: string }).firstKeptEntryId;
		if (keepId === KEEP_NOTHING_ENTRY_ID) return index + 1;
		return Math.min(
			entries.findIndex(entry => entry.id === keepId),
			index + 1,
		);
	};
	let summaryStart = 0;
	const candidates: number[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "compaction") continue;
		if (!windows.has(entry.id)) {
			summaryStart = start(i);
			break;
		}
		candidates.push(i);
	}
	const validStarts = candidates.filter(i => windows.get(entries[i]!.id)!.valid).map(start);
	const furthestValid = Math.max(-1, ...validStarts);
	const boundaryStart = Math.max(summaryStart, furthestValid);
	const hosts = new Set<string>();
	const chain: string[] = [];
	const unneeded: string[] = [];
	for (const i of candidates) {
		const { host, valid } = windows.get(entries[i]!.id)!;
		if (hosts.has(host)) {
			if (start(i) < furthestValid || start(i) <= summaryStart) unneeded.push(entries[i]!.id);
			continue;
		}
		if (!valid) continue;
		hosts.add(host);
		chain.push(entries[i]!.id);
	}
	const cut = entries.findIndex((entry, i) => i >= boundaryStart && entry.type === "message");
	const summarizes = entries.slice(summaryStart, cut).some(entry => entry.type === "message");
	return {
		firstKeptEntryId: summarizes ? entries[cut]!.id : undefined,
		chain: chain.length > 0 ? chain : undefined,
		unneeded,
	};
}

describe("a compaction pass reads only the windows it uses", () => {
	it("selects what an eager validation selects and reads no window it does not need", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10_000_000 };
		let unneeded = 0;
		let chained = 0;
		let prepared = 0;
		const branches: [string, Branch][] = Array.from({ length: 300 }, (_, i) => [`seed ${i + 1}`, generate(i + 1)]);
		const atTheSummaryStart = windowsAtTheSummaryStart();
		branches.push(["windows at the summary start", atTheSummaryStart]);
		// The hand-written branch holds the window the boundary search stops in front of.
		expect(eagerSelection(atTheSummaryStart).unneeded).toEqual(["c5"]);
		for (const [name, branch] of branches) {
			const expected = eagerSelection(branch);
			const preparation = prepareCompaction(branch.entries, settings);
			const idOf = new Map<unknown, string>();
			for (const entry of branch.entries) {
				if (entry.type === "compaction" && entry.preserveData) idOf.set(entry.preserveData, entry.id);
			}
			expect({ name, firstKeptEntryId: preparation?.firstKeptEntryId }).toEqual({
				name,
				firstKeptEntryId: expected.firstKeptEntryId,
			});
			if (preparation !== undefined) {
				prepared += 1;
				const chain = preparation.remoteChain?.links.map(link => idOf.get(link.previousPreserveData));
				expect({ name, chain }).toEqual({ name, chain: expected.chain });
				if ((chain?.length ?? 0) > 1) chained += 1;
			}
			expect({ name, read: expected.unneeded.filter(id => branch.reads.has(id)) }).toEqual({ name, read: [] });
			unneeded += expected.unneeded.length;
		}
		// The sweep prepares passes, chains windows of more than one host, and holds windows a pass
		// never needs.
		expect(prepared).toBeGreaterThan(100);
		expect(chained).toBeGreaterThan(10);
		expect(unneeded).toBeGreaterThan(100);
	});
});
