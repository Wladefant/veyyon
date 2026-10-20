/**
 * WHY: `InMemorySnapshotStore` bounds what it holds. A version leaves it when
 * the path is evicted (path count or text budget) or when newer versions push
 * it off the per-path ring. Its displayed-line provenance (`seenLines`,
 * `clippedLines`) used to leave with it, so recording the same text again — a
 * later ranged read or a search hit — minted a fresh snapshot that held only
 * the newest lines. The patcher then refused an edit on lines the model had
 * read under that very tag ("never displayed"), and the read dedup refused the
 * re-read because the earlier output was still in context.
 *
 * The class closed here: every way a version leaves the store other than
 * `invalidate` and `clear` keeps its provenance, and recording the same text
 * again restores it. Each mutating method of the store is swept from the
 * prototype and must be classified below, so a new one turns this suite red.
 *
 * Not caught: a producer that never records seen lines in the first place, and
 * provenance pushed out by the store's own bound on dropped versions, which is
 * asserted here as a bound rather than a guarantee.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore } from "@veyyon/hashline";
import fc from "fast-check";

const A = "alpha\nbeta\ngamma\ndelta\n";
const B = "other body\n";

function seenOf(store: InMemorySnapshotStore, path: string, text: string): number[] {
	return [...(store.byContent(path, text)?.seenLines ?? [])].sort((x, y) => x - y);
}

function clippedOf(store: InMemorySnapshotStore, path: string, text: string): number[] {
	return [...(store.byContent(path, text)?.clippedLines ?? [])].sort((x, y) => x - y);
}

/** Record `a.ts`, then push it out by path count; asserts it is really gone. */
function evictByCount(lines: number[]): InMemorySnapshotStore {
	const store = new InMemorySnapshotStore({ maxPaths: 2 });
	store.record("a.ts", A, lines);
	store.record("b.ts", B, [1]);
	store.record("c.ts", B, [1]);
	expect(store.head("a.ts")).toBeNull();
	return store;
}

describe("a version dropped from the store keeps the lines it displayed", () => {
	it("restores them when an evicted path records the same text again", () => {
		const store = evictByCount([1, 2]);
		store.record("a.ts", A, [4]);
		expect(seenOf(store, "a.ts", A)).toEqual([1, 2, 4]);
	});

	it("restores them after eviction by the text budget", () => {
		const store = new InMemorySnapshotStore({ maxTotalBytes: 2 * (A.length + 1) });
		store.record("a.ts", A, [1, 2]);
		store.record("b.ts", A, [1]);
		store.record("c.ts", A, [1]);
		expect(store.head("a.ts")).toBeNull();
		store.record("a.ts", A, [4]);
		expect(seenOf(store, "a.ts", A)).toEqual([1, 2, 4]);
	});

	it("restores them when newer versions pushed the text off the per-path ring", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 2 });
		store.record("a.ts", A, [1, 2]);
		store.record("a.ts", "v2\n", [1]);
		store.record("a.ts", "v3\n", [1]);
		expect(store.byContent("a.ts", A)).toBeNull();
		store.record("a.ts", A, [4]);
		expect(seenOf(store, "a.ts", A)).toEqual([1, 2, 4]);
	});

	it("restores clipped lines alongside seen lines", () => {
		const store = new InMemorySnapshotStore({ maxPaths: 2 });
		const hash = store.record("a.ts", A, [1]);
		store.recordClippedLines("a.ts", hash, [3]);
		store.record("b.ts", B, [1]);
		store.record("c.ts", B, [1]);
		store.record("a.ts", A, [2]);
		expect(seenOf(store, "a.ts", A)).toEqual([1, 2]);
		expect(clippedOf(store, "a.ts", A)).toEqual([3]);
	});

	it("unions the lines of every read across repeated evictions", () => {
		const store = evictByCount([1]);
		store.record("a.ts", A, [2]);
		store.record("b.ts", B, [1]);
		store.record("c.ts", B, [1]);
		expect(store.head("a.ts")).toBeNull();
		store.record("a.ts", A, [4]);
		expect(seenOf(store, "a.ts", A)).toEqual([1, 2, 4]);
	});

	it("does not attach them to different text at the same path", () => {
		const store = evictByCount([1, 2]);
		store.record("a.ts", B, [1]);
		expect(seenOf(store, "a.ts", B)).toEqual([1]);
	});

	it("does not attach them to different text of the same length", () => {
		const store = evictByCount([1, 2]);
		const edited = A.replace("alpha", "alphb");
		expect(edited.length).toBe(A.length);
		store.record("a.ts", edited, [1]);
		expect(seenOf(store, "a.ts", edited)).toEqual([1]);
	});

	it("still restores them when the path returns to the displayed text after other content", () => {
		const store = evictByCount([1, 2]);
		store.record("a.ts", B, [1]);
		store.record("a.ts", A, [4]);
		expect(seenOf(store, "a.ts", A)).toEqual([1, 2, 4]);
	});

	it("keeps an earlier dropped version when the path is evicted again holding other content", () => {
		const store = evictByCount([1, 2]);
		store.record("a.ts", B, [1]);
		store.record("b.ts", B, [1]);
		store.record("c.ts", B, [1]);
		expect(store.head("a.ts")).toBeNull();
		store.record("a.ts", A, [4]);
		expect(seenOf(store, "a.ts", A)).toEqual([1, 2, 4]);
	});

	it("round-trips any set of displayed lines exactly", () => {
		fc.assert(
			fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 300 }), lines => {
				const store = evictByCount(lines);
				store.record("a.ts", A);
				expect(seenOf(store, "a.ts", A)).toEqual([...lines].sort((x, y) => x - y));
			}),
			{ numRuns: 200 },
		);
	});
});

describe("relocate carries dropped provenance to the destination", () => {
	it("moves the provenance of an evicted source", () => {
		const store = evictByCount([1, 2]);
		store.relocate("a.ts", "z.ts");
		store.record("z.ts", A, [4]);
		expect(seenOf(store, "z.ts", A)).toEqual([1, 2, 4]);
		store.record("a.ts", A, [3]);
		expect(seenOf(store, "a.ts", A)).toEqual([3]);
	});

	it("keeps the provenance of destination versions the merge pushes off the ring", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 2 });
		store.record("a.ts", "v1\n", [1]);
		store.record("a.ts", "v2\n", [1]);
		store.record("z.ts", A, [1, 2]);
		store.relocate("a.ts", "z.ts");
		expect(store.byContent("z.ts", A)).toBeNull();
		store.record("z.ts", A, [4]);
		expect(seenOf(store, "z.ts", A)).toEqual([1, 2, 4]);
	});
});

describe("invalidate and clear forget dropped provenance", () => {
	it("invalidate", () => {
		const store = evictByCount([1, 2]);
		store.invalidate("a.ts");
		store.record("a.ts", A, [4]);
		expect(seenOf(store, "a.ts", A)).toEqual([4]);
	});

	it("clear", () => {
		const store = evictByCount([1, 2]);
		store.clear();
		store.record("a.ts", A, [4]);
		expect(seenOf(store, "a.ts", A)).toEqual([4]);
	});
});

describe("dropped provenance is bounded", () => {
	it("keeps the most recently dropped paths up to maxDroppedPaths", () => {
		const store = new InMemorySnapshotStore({ maxPaths: 1, maxDroppedPaths: 2 });
		for (const path of ["p0.ts", "p1.ts", "p2.ts", "p3.ts"]) store.record(path, A, [1]);
		// p0, p1 and p2 were evicted; only the last two keep provenance.
		store.record("p0.ts", A, [4]);
		expect(seenOf(store, "p0.ts", A)).toEqual([4]);
		store.record("p2.ts", A, [4]);
		expect(seenOf(store, "p2.ts", A)).toEqual([1, 4]);
	});

	it("does not retain a version whose ranges exceed the provenance budget", () => {
		// Every other line: one range per line, 2 bounds each, past the 256 Ki-bound budget.
		const sparse = Array.from({ length: 128 * 1024 + 1 }, (_, i) => 2 * i + 1);
		const store = evictByCount(sparse);
		store.record("a.ts", A, [2]);
		expect(seenOf(store, "a.ts", A)).toEqual([2]);
	});
});

describe("every mutating method of the store is classified", () => {
	// A method that can drop a version must state here which test proves it
	// keeps or forgets provenance. A new method turns this red until it does.
	const CLASSIFIED: Record<string, string> = {
		record: "restores on re-record; drops off the per-path ring keep provenance",
		recordSeenLines: "merges into a held version only; drops nothing",
		recordClippedLines: "merges into a held version only; drops nothing",
		invalidate: "forgets",
		relocate: "carries provenance to the destination",
		clear: "forgets",
		head: "read only",
		byHash: "read only",
		byContent: "read only",
		findByHash: "read only",
	};

	it("matches the prototype exactly", () => {
		const methods = Object.getOwnPropertyNames(InMemorySnapshotStore.prototype).filter(
			name => name !== "constructor",
		);
		expect(methods.sort()).toEqual(Object.keys(CLASSIFIED).sort());
	});
});
