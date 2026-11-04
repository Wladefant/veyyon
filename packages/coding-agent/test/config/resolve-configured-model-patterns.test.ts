import { describe, expect, it } from "bun:test";
import { normalizeModelPatternList } from "@veyyon/coding-agent/config/model-pattern-list";

/**
 * normalizeModelPatternList turns a user's `model = "..."` setting (a string or string[], possibly
 * comma-joined) into the ordered list of model-id patterns the resolver matches against the registry.
 * Pinned: undefined/empty -> []; a comma-joined string and a string[] both split on commas; every entry
 * is trimmed and blank entries dropped. A regression here would let stray whitespace or empty segments
 * become bogus "patterns" that never match.
 *
 * Role aliases such as `@smol` are not expanded here: model roles were removed, and a helper's model
 * is an `agent.helpers.<id>` row, not an alias.
 */
describe("normalizeModelPatternList", () => {
	it("returns an empty list for undefined and empty input", () => {
		expect(normalizeModelPatternList(undefined)).toEqual([]);
		expect(normalizeModelPatternList("")).toEqual([]);
	});

	it("passes a single plain pattern through unchanged", () => {
		expect(normalizeModelPatternList("gpt-4o")).toEqual(["gpt-4o"]);
	});

	it("splits a comma-joined string, trimming each entry", () => {
		expect(normalizeModelPatternList("a, b ,c")).toEqual(["a", "b", "c"]);
	});

	it("splits every element of a string[] on commas and flattens", () => {
		expect(normalizeModelPatternList(["x , y", "z"])).toEqual(["x", "y", "z"]);
	});

	it("drops blank and whitespace-only segments", () => {
		expect(normalizeModelPatternList("a,,  ,b")).toEqual(["a", "b"]);
		expect(normalizeModelPatternList([" ", "keep"])).toEqual(["keep"]);
	});
});
