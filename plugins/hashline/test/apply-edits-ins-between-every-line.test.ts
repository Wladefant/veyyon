import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Sequential INS.POST after each original line (applied one at a time).
 */

describe("INS.POST sequential between lines", () => {
	it("insert after each of 3 lines via sequential applies", () => {
		let cur = linesText(["A", "B", "C"]);
		// After A
		cur = applyPatch(cur, "INS.POST 1:\n+x");
		expect(cur).toBe(linesText(["A", "x", "B", "C"]));
		// After B (now line 3)
		cur = applyPatch(cur, "INS.POST 3:\n+y");
		expect(cur).toBe(linesText(["A", "x", "B", "y", "C"]));
		// After C (now line 5)
		cur = applyPatch(cur, "INS.POST 5:\n+z");
		expect(cur).toBe(linesText(["A", "x", "B", "y", "C", "z"]));
	});
});
