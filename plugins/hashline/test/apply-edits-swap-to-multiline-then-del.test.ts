import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Expand then delete in sequential pure applies.
 */

describe("expand then DEL sequence", () => {
	it("expand middle then delete first of expansion", () => {
		let cur = linesText(["A", "B", "C"]);
		cur = applyPatch(cur, "SWAP 2.=2:\n+X\n+Y\n+Z");
		expect(cur).toBe(linesText(["A", "X", "Y", "Z", "C"]));
		cur = applyPatch(cur, "DEL 2.=2");
		expect(cur).toBe(linesText(["A", "Y", "Z", "C"]));
	});
});
