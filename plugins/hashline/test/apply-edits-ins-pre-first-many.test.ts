import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Repeated INS.PRE 1 inserts always before the original first line content.
 */

describe("repeated INS.PRE 1", () => {
	it("each insert goes to the new front", () => {
		let cur = linesText(["body"]);
		cur = applyPatch(cur, "INS.PRE 1:\n+A");
		expect(cur).toBe(linesText(["A", "body"]));
		cur = applyPatch(cur, "INS.PRE 1:\n+B");
		expect(cur).toBe(linesText(["B", "A", "body"]));
		cur = applyPatch(cur, "INS.PRE 1:\n+C");
		expect(cur).toBe(linesText(["C", "B", "A", "body"]));
	});
});
