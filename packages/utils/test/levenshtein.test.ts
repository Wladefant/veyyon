import { describe, expect, it } from "bun:test";
import { damerauLevenshteinDistance, levenshteinDistance, nearestNames } from "../src/levenshtein";

describe("levenshteinDistance", () => {
	it("returns 0 for identical strings and the other length for empty input", () => {
		expect(levenshteinDistance("", "")).toBe(0);
		expect(levenshteinDistance("same", "same")).toBe(0);
		expect(levenshteinDistance("", "abc")).toBe(3);
		expect(levenshteinDistance("abc", "")).toBe(3);
	});

	it("counts single-operation edits as 1", () => {
		expect(levenshteinDistance("cat", "cut")).toBe(1); // substitution
		expect(levenshteinDistance("cat", "cats")).toBe(1); // insertion
		expect(levenshteinDistance("cats", "cat")).toBe(1); // deletion
	});

	it("computes classic multi-edit distances", () => {
		expect(levenshteinDistance("kitten", "sitting")).toBe(3);
		expect(levenshteinDistance("flaw", "lawn")).toBe(2);
		expect(levenshteinDistance("intention", "execution")).toBe(5);
	});

	it("is symmetric", () => {
		expect(levenshteinDistance("sunday", "saturday")).toBe(levenshteinDistance("saturday", "sunday"));
		expect(levenshteinDistance("sunday", "saturday")).toBe(3);
	});

	it("measures astral characters in UTF-16 code units per the documented contract", () => {
		// "😀" is one surrogate pair = two code units, so replacing it with two
		// ASCII letters is two substitutions, and dropping it costs 2.
		expect(levenshteinDistance("😀", "ab")).toBe(2);
		expect(levenshteinDistance("a😀b", "ab")).toBe(2);
	});

	/**
	 * The distance is computed bit-parallel, 32 pattern rows per word, with a character table shared
	 * across calls. The defects that shape admits are a wrong carry between words (a pattern of 33+
	 * units), a wrong score row in the last partial word, a pattern character left in the shared table
	 * for the next call, and a code unit above the ASCII range indexed wrong. Each case below is
	 * checked against the cell-by-cell table, in one long sequence of calls so a stale table entry
	 * from one pair reaches the next.
	 */
	it("agrees with the cell-by-cell table at every word boundary and over every code-unit range", () => {
		const reference = (a: string, b: string): number => {
			let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
			for (let i = 1; i <= a.length; i++) {
				const curr = [i];
				for (let j = 1; j <= b.length; j++) {
					const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
					curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
				}
				prev = curr;
			}
			return prev[b.length];
		};
		let seed = 0x9e3779b9;
		const next = (bound: number): number => {
			seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
			return (seed >>> 0) % bound;
		};
		const word = (alphabet: string, length: number): string => {
			let out = "";
			while (out.length < length) out += alphabet[next(alphabet.length)];
			return out;
		};
		const mutate = (source: string, length: number, alphabet: string): string => {
			const units = source.split("");
			for (let edits = next(4); edits >= 0; edits--) {
				const at = next(units.length + 1);
				const op = next(3);
				if (op === 0) units.splice(at, 0, alphabet[next(alphabet.length)]);
				else if (op === 1 && units.length > 0) units.splice(Math.min(at, units.length - 1), 1);
				else if (units.length > 0) units[Math.min(at, units.length - 1)] = alphabet[next(alphabet.length)];
			}
			return units.join("").slice(0, length);
		};
		const alphabets = ["ab", "abcdefgh", "abcdefghijklmnopqrstuvwxyz {}();=", "aé€😀\uffff\u0000z"];
		const lengths = [0, 1, 2, 7, 31, 32, 33, 63, 64, 65, 95, 96, 97, 128, 129, 200];
		const mismatches: string[] = [];
		let pairs = 0;
		for (const alphabet of alphabets) {
			for (const la of lengths) {
				for (const lb of lengths) {
					const a = word(alphabet, la);
					// Half the pairs are edits of `a`, so the distance is small and long runs of rows match.
					const b = next(2) === 0 ? word(alphabet, lb) : mutate(a, lb, alphabet);
					const expected = reference(a, b);
					pairs++;
					if (levenshteinDistance(a, b) !== expected || levenshteinDistance(b, a) !== expected) {
						mismatches.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}: expected ${expected}`);
					}
				}
			}
		}
		expect(pairs).toBe(alphabets.length * lengths.length * lengths.length);
		expect(mismatches).toEqual([]);
	});
});

/**
 * `nearestNames`, the one answer to "what did they probably mean?".
 *
 * WHY THIS SUITE EXISTS. Every surface that rejects a name a human typed wants
 * to suggest the near misses, and before this each one derived its own
 * threshold. That is how they end up disagreeing: the same typo earns a
 * suggestion from the config CLI and silence from a rule loader, for no reason
 * anyone decided. The tiers below are the contract, and the ordering is the
 * point: a certain answer must never be buried under a merely plausible one.
 */
describe("nearestNames", () => {
	const TOOLS = ["read", "write", "edit", "bash", "glob", "grep", "eval", "browser"];

	/** A name that differs only in case is a spelling of the same intent, not a
	 * near miss, so it must come first even when shorter names are closer by
	 * distance. */
	it("puts an exact case-insensitive match first", () => {
		expect(nearestNames("BASH", TOOLS)[0]).toBe("bash");
		expect(nearestNames("Browser", TOOLS)[0]).toBe("browser");
	});

	/** Containment covers a remembered fragment: someone types the leaf of a
	 * dotted path, or half a name. It outranks edit distance because it is
	 * evidence about intent rather than about spelling. */
	it("ranks a containment match above a merely close one", () => {
		expect(nearestNames("brow", TOOLS)[0]).toBe("browser");
	});

	/** The typo case, which is what the distance tier exists for: one substituted
	 * character, one dropped character, one extra character. */
	it("finds a single-character typo", () => {
		expect(nearestNames("wrixe", TOOLS)).toContain("write");
		expect(nearestNames("grap", TOOLS)).toContain("grep");
		expect(nearestNames("bsh", TOOLS)).toContain("bash");
		expect(nearestNames("evall", TOOLS)).toContain("eval");
	});

	/**
	 * The transposition case, and the reason suggestion uses a different metric
	 * from matching. Swapping two adjacent characters is the single most common
	 * way a short name is mistyped, and PLAIN Levenshtein charges it two edits,
	 * which puts it outside any budget tight enough to be useful on a four-letter
	 * name. Asserting both numbers here is what pins the choice: if `nearestNames`
	 * were ever repointed at `levenshteinDistance`, this goes red rather than
	 * quietly getting worse at its whole job.
	 */
	it("reaches a transposition in a short name", () => {
		expect(levenshteinDistance("raed", "read")).toBe(2);
		expect(damerauLevenshteinDistance("raed", "read")).toBe(1);
		expect(nearestNames("raed", TOOLS)).toContain("read");
		expect(nearestNames("wriet", TOOLS)).toContain("write");
	});

	/**
	 * The budget scales with the input, and this is the boundary that proves it.
	 * A four-character name allows one edit, so "read" is reachable from "readx"
	 * but a name three edits away is not: at short lengths almost every candidate
	 * would qualify and the suggestion would be noise.
	 */
	it("keeps the budget tight for short inputs", () => {
		expect(nearestNames("readx", TOOLS)).toContain("read");
		expect(nearestNames("zzz", TOOLS)).toEqual([]);
	});

	/** A longer input earns a little more room, because one edit in a long path
	 * is far less likely to be a different name than one edit in a short one. */
	it("allows more edits as the input grows", () => {
		const paths = ["startup.autoUpdate", "startup.autoUpdateChannel"];
		expect(nearestNames("startup.autoUpdat", paths)).toContain("startup.autoUpdate");
	});

	/** Ties break alphabetically so the same input always yields the same list.
	 * An unstable order makes a suggestion look like it changed meaning. */
	it("orders equal-distance candidates deterministically", () => {
		const candidates = ["bbb", "aaa", "ccc"];
		expect(nearestNames("aab", candidates)).toEqual(nearestNames("aab", candidates));
		expect(nearestNames("aab", candidates)[0]).toBe("aaa");
	});

	/** A name matched by two tiers appears once. Repeating it would spend the
	 * caller's limit on a single suggestion. */
	it("does not repeat a name that matches in more than one tier", () => {
		const result = nearestNames("read", ["read", "reads", "ready"]);
		expect(result.filter(n => n === "read")).toHaveLength(1);
	});

	/** The limit is honoured, because these render into an error message a person
	 * has to read. */
	it("returns no more than the limit", () => {
		expect(nearestNames("re", ["read", "ready", "real", "reap", "rear"], 2)).toHaveLength(2);
	});

	/** Empty and whitespace input match nothing rather than everything. An empty
	 * needle is contained in every string, so the containment tier would otherwise
	 * return the entire candidate list as "suggestions". */
	it("suggests nothing for empty or blank input", () => {
		expect(nearestNames("", TOOLS)).toEqual([]);
		expect(nearestNames("   ", TOOLS)).toEqual([]);
	});

	/** No candidates is a legitimate state (an empty registry), not an error. */
	it("suggests nothing when there are no candidates", () => {
		expect(nearestNames("read", [])).toEqual([]);
	});

	/** Any iterable works, since callers hold their names in a Set as often as an
	 * array and copying one to satisfy the signature is pure noise. */
	it("accepts a Set of candidates", () => {
		expect(nearestNames("bash", new Set(TOOLS))).toEqual(["bash"]);
	});
});

/**
 * The two distance functions are kept separate on purpose, and this pins why.
 *
 * `levenshteinDistance` is the edit tool's fuzzy-match hot path, where the
 * number feeds an acceptance threshold: changing it changes which edits apply.
 * `damerauLevenshteinDistance` serves suggestion messages, where a transposition
 * must cost one. Collapsing them would silently move one of those behaviours.
 */
describe("damerauLevenshteinDistance", () => {
	/** The defining difference: a swap is one edit here, two in plain Levenshtein. */
	it("charges an adjacent transposition one edit", () => {
		expect(damerauLevenshteinDistance("raed", "read")).toBe(1);
		expect(damerauLevenshteinDistance("teh", "the")).toBe(1);
		expect(damerauLevenshteinDistance("wriet", "write")).toBe(1);
	});

	/** A NON-adjacent swap is not a transposition and must still cost two, or the
	 * metric would call genuinely different names near-identical. */
	it("still charges a non-adjacent swap two edits", () => {
		expect(damerauLevenshteinDistance("dcba", "abcd")).toBeGreaterThan(1);
	});

	/** It agrees with plain Levenshtein everywhere a transposition is not
	 * involved, so swapping it in cannot shift unrelated results. */
	it("matches plain Levenshtein on substitutions, insertions and deletions", () => {
		for (const [a, b] of [
			["read", "reap"],
			["read", "reads"],
			["reads", "read"],
			["bash", "glob"],
			["", "read"],
		] as const) {
			expect(damerauLevenshteinDistance(a, b)).toBe(levenshteinDistance(a, b));
		}
	});

	/** The identity and empty-string boundaries, which every distance function
	 * has to get right before any of the above means anything. */
	it("returns 0 for identical strings and the other length for empty input", () => {
		expect(damerauLevenshteinDistance("", "")).toBe(0);
		expect(damerauLevenshteinDistance("same", "same")).toBe(0);
		expect(damerauLevenshteinDistance("", "abc")).toBe(3);
		expect(damerauLevenshteinDistance("abc", "")).toBe(3);
	});

	/** Symmetry: a distance that depended on argument order would make suggestion
	 * ranking depend on which side the caller passed first. */
	it("is symmetric", () => {
		expect(damerauLevenshteinDistance("raed", "read")).toBe(damerauLevenshteinDistance("read", "raed"));
		expect(damerauLevenshteinDistance("browser", "borwser")).toBe(damerauLevenshteinDistance("borwser", "browser"));
	});
});
