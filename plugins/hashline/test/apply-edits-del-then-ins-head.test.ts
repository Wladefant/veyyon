import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * DEL then INS.HEAD sequence.
 */

describe("DEL then INS.HEAD", () => {
	it("delete first then prepend", () => {
		let cur = linesText(["A", "B", "C"]);
		cur = applyPatch(cur, "DEL 1.=1");
		expect(cur).toBe(linesText(["B", "C"]));
		cur = applyPatch(cur, "INS.HEAD:\n+H");
		expect(cur).toBe(linesText(["H", "B", "C"]));
	});
});
