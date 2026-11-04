/**
 * WHY: three readers answered "where does the context this session sends start" three ways. The
 * context builder applies the newest compaction the branch's default model can read. Moving
 * compacted history out of memory took the newest compaction, readable or not. The prune and
 * rescue passes took the newest compaction the model the session RUNS on can read. A session
 * resumed onto another model than the one that minted its server-side windows found none that
 * model reads, so every turn walked the whole session from its first entry and read its history
 * back from disk, where it then stayed: a 146 MiB session's turns grew the heap by the whole
 * history. A branch whose default model reads none of its compactions had the history its context
 * re-expands moved out of memory again on every publish and read back on every build.
 *
 * The class: any reader of the sent boundary that disagrees with the builder. The builder and
 * `compactedHistoryEnd` must agree on exactly which messages are sent, and the boundary the prune
 * passes resolve from `contextCompaction` must never start before the sent context, for every
 * branch shape and for every bundled provider as the branch's default model, so a new provider
 * arrives covered. The one shape where the prune boundary starts later than the sent context is
 * pinned by exact equality: a keep-nothing marker names no entry, and the shared reader resolves
 * it past the NEWEST compaction rather than the one that applies.
 *
 * Not caught here: a reader that computes the boundary without going through `contextCompaction`
 * or `compactedHistoryEnd`. The turn sweep in
 * `compacted-history-reads-back-from-the-session-file.test.ts` runs a resumed session's real
 * turn on a model other than the branch's default and pins its reads of the history at zero, which
 * catches the prune passes; the rescue truncation and the spend tally are not driven there.
 */

import { describe, expect, test } from "bun:test";
import { REMOTE_COMPACTION_PRESERVE_KEY, type RemoteCompactionPreserveData } from "@veyyon/agent-core/compaction";
import { KEEP_NOTHING_ENTRY_ID, resolveCompactionBoundaryIndex } from "@veyyon/agent-core/compaction/entries";
import { getBundledProviders } from "@veyyon/catalog/models";
import {
	buildSessionContextFromPath,
	compactedHistoryEnd,
	contextCompaction,
} from "@veyyon/kernel/session/session-context";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";

const MINTING_PROVIDER = "openai";
const TIMESTAMP = "2025-01-01T00:00:00Z";

type Step =
	| { user: string }
	| { summary: string; keep: string }
	| { window: string; keep: string }
	| { legacy: string; keep: string };

const WINDOW: RemoteCompactionPreserveData = {
	version: 1,
	provider: MINTING_PROVIDER,
	api: "openai-responses",
	model: "gpt-5.1",
	window: [{ id: "cmp_001", type: "compaction", encrypted_content: "gAAAAABpM0Yj-fake" }],
	compactedAt: TIMESTAMP,
};

/** The entry `step` records, under `parentId`. */
function entryOf(step: Step, parentId: string | null): SessionEntry {
	const base = { parentId, timestamp: TIMESTAMP };
	if ("user" in step) {
		return { ...base, type: "message", id: step.user, message: { role: "user", content: step.user, timestamp: 1 } };
	}
	const compaction = { ...base, type: "compaction" as const, firstKeptEntryId: step.keep, tokensBefore: 1 };
	if ("summary" in step) return { ...compaction, id: step.summary, summary: `summary of ${step.summary}` };
	if ("window" in step) {
		// What a server-side pass writes: the window and no summary text.
		return {
			...compaction,
			id: step.window,
			summary: "",
			preserveData: { [REMOTE_COMPACTION_PRESERVE_KEY]: WINDOW },
		};
	}
	return {
		...compaction,
		id: step.legacy,
		summary: "Remote compaction preserved provider-native history for this session.",
		preserveData: { openaiRemoteCompaction: { items: [] } },
	};
}

/** `steps` chained root first, after a `model_change` naming `defaultModel` when there is one. */
function branchOf(defaultModel: string | undefined, steps: readonly Step[]): SessionEntry[] {
	const path: SessionEntry[] = [];
	if (defaultModel !== undefined) {
		path.push({ type: "model_change", id: "model", parentId: null, timestamp: TIMESTAMP, model: defaultModel });
	}
	for (const step of steps) path.push(entryOf(step, path.at(-1)?.id ?? null));
	return path;
}

/** Every branch shape a keep boundary can rest on. */
const SHAPES: Record<string, Step[]> = {
	"no compaction": [{ user: "u1" }, { user: "u2" }],
	"a summary": [{ user: "u1" }, { user: "u2" }, { summary: "c1", keep: "u2" }, { user: "u3" }],
	"a window": [{ user: "u1" }, { user: "u2" }, { window: "w1", keep: "u2" }, { user: "u3" }],
	"a summary, then a window": [
		{ user: "u1" },
		{ user: "u2" },
		{ summary: "c1", keep: "u2" },
		{ user: "u3" },
		{ user: "u4" },
		{ window: "w1", keep: "u4" },
		{ user: "u5" },
	],
	"a window, then a summary": [
		{ user: "u1" },
		{ user: "u2" },
		{ window: "w1", keep: "u2" },
		{ user: "u3" },
		{ user: "u4" },
		{ summary: "c1", keep: "u4" },
		{ user: "u5" },
	],
	"a summary that kept nothing, then a window": [
		{ user: "u1" },
		{ summary: "c1", keep: KEEP_NOTHING_ENTRY_ID },
		{ user: "u2" },
		{ user: "u3" },
		{ window: "w1", keep: "u3" },
		{ user: "u4" },
	],
	"a legacy provider-native entry after a summary": [
		{ user: "u1" },
		{ user: "u2" },
		{ summary: "c1", keep: "u2" },
		{ user: "u3" },
		{ user: "u4" },
		{ legacy: "l1", keep: "u4" },
		{ user: "u5" },
	],
	"a keep marker that names no entry": [
		{ user: "u1" },
		{ user: "u2" },
		{ summary: "c1", keep: "gone" },
		{ user: "u3" },
	],
};

/** Every default model a branch can record: one per bundled provider, and none at all. */
function defaultModels(): (string | undefined)[] {
	return [...getBundledProviders().map(provider => `${provider}/any-model`), undefined];
}

/** Indices on `path` of the message entries whose message the context built from it sends. */
function sentIndices(path: readonly SessionEntry[]): number[] {
	const sent = new Set(buildSessionContextFromPath(path).messages);
	const indices: number[] = [];
	for (let i = 0; i < path.length; i++) {
		const entry = path[i]!;
		if (entry.type === "message" && sent.has(entry.message)) indices.push(i);
	}
	return indices;
}

/** Indices on `path` of the message entries at or after `from`. */
function messageIndicesFrom(path: readonly SessionEntry[], from: number): number[] {
	const indices: number[] = [];
	for (let i = from; i < path.length; i++) if (path[i]!.type === "message") indices.push(i);
	return indices;
}

describe("every reader of the sent context boundary agrees with the context builder", () => {
	test("the sweep reaches a provider that reads the window and one that does not", () => {
		const providers = getBundledProviders();
		expect(providers).toContain(MINTING_PROVIDER);
		const steps = SHAPES["a summary, then a window"]!;
		const minting = compactedHistoryEnd(branchOf(`${MINTING_PROVIDER}/gpt-5.1`, steps));
		const foreign = compactedHistoryEnd(branchOf("anthropic/claude-sonnet-4-5", steps));
		expect(minting).toBeGreaterThan(foreign);
	});

	test("the history moved out of memory ends exactly where the sent context starts", () => {
		for (const [shape, steps] of Object.entries(SHAPES)) {
			for (const defaultModel of defaultModels()) {
				const path = branchOf(defaultModel, steps);
				expect({ shape, defaultModel, sent: messageIndicesFrom(path, compactedHistoryEnd(path)) }).toEqual({
					shape,
					defaultModel,
					sent: sentIndices(path),
				});
			}
		}
	});

	test("the prune passes never start before the sent context, and start after it only behind a keep-nothing marker", () => {
		const later = new Set<string>();
		for (const [shape, steps] of Object.entries(SHAPES)) {
			for (const defaultModel of defaultModels()) {
				const path = branchOf(defaultModel, steps);
				const sentFrom = compactedHistoryEnd(path);
				const pruneFrom = resolveCompactionBoundaryIndex(path, contextCompaction(path)?.firstKeptEntryId);
				expect({ shape, defaultModel, before: pruneFrom < sentFrom }).toEqual({
					shape,
					defaultModel,
					before: false,
				});
				if (pruneFrom > sentFrom) later.add(shape);
			}
		}
		expect([...later]).toEqual(["a summary that kept nothing, then a window"]);
	});
});
