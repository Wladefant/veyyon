import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * INS.POST between each consecutive pair of a short list.
 */

describe("INS.POST between pairs", () => {
	it("interleaves separators between A B C via sequential posts", () => {
		let cur = linesText(["A", "B", "C"]);
		// After A (line 1)
		cur = applyPatch(cur, "INS.POST 1:\n+-");
		// After B (now line 3)
		cur = applyPatch(cur, "INS.POST 3:\n+-");
		expect(cur).toBe(linesText(["A", "-", "B", "-", "C"]));
	});
});
