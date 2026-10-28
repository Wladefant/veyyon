import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { linesText } from "./support/apply-patch";

/**
 * applyEdits pure transform contracts: SWAP/DEL exact text outcomes.
 * Body rows must use `+TEXT` (bare `|` is auto-prefixed and becomes literal).
 */

describe("applyEdits adversarial", () => {
	it("SWAP replaces a single line exactly", () => {
		const src = linesText(["a", "b", "c"]);
		const { edits } = parsePatch("SWAP 2.=2:\n+B2");
		const result = applyEdits(src, edits);
		expect(result.text).toBe(linesText(["a", "B2", "c"]));
	});

	it("DEL removes a contiguous range", () => {
		const src = linesText(["a", "b", "c", "d"]);
		const { edits } = parsePatch("DEL 2.=3");
		const result = applyEdits(src, edits);
		expect(result.text).toBe(linesText(["a", "d"]));
	});

	it("two SWAPs on different lines both apply", () => {
		const src = linesText(["a", "b", "c"]);
		const { edits } = parsePatch("SWAP 1.=1:\n+A2\nSWAP 3.=3:\n+C2");
		const result = applyEdits(src, edits);
		expect(result.text).toBe(linesText(["A2", "b", "C2"]));
	});

	it("empty edits leave text unchanged", () => {
		const src = linesText(["only"]);
		const result = applyEdits(src, []);
		expect(result.text).toBe(src);
	});

	it("unicode line bodies survive SWAP", () => {
		const src = linesText(["const 値 = 1;"]);
		const { edits } = parsePatch("SWAP 1.=1:\n+const 値 = 2;");
		const result = applyEdits(src, edits);
		expect(result.text).toBe(linesText(["const 値 = 2;"]));
	});

	it("SWAP of the only line yields a single-line file", () => {
		const src = linesText(["solo"]);
		const { edits } = parsePatch("SWAP 1.=1:\n+solo2");
		const result = applyEdits(src, edits);
		expect(result.text).toBe(linesText(["solo2"]));
	});

	it("bare body without + is auto-prefixed and warned", () => {
		const src = linesText(["a", "b"]);
		const parsed = parsePatch("SWAP 1.=1:\n|kept-pipe");
		expect(parsed.warnings.some(w => /auto-prefix|bare body/i.test(w))).toBe(true);
		const result = applyEdits(src, parsed.edits);
		// Auto-prefix turns `|kept-pipe` into literal `+|kept-pipe` content `|kept-pipe`.
		expect(result.text).toBe(linesText(["|kept-pipe", "b"]));
	});
});
