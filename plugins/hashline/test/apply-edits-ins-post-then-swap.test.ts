import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * INS.POST then SWAP of the inserted line.
 */

describe("INS.POST then SWAP inserted", () => {
	it("insert after first then rename the insert", () => {
		let cur = linesText(["A", "B"]);
		cur = applyPatch(cur, "INS.POST 1:\n+X");
		expect(cur).toBe(linesText(["A", "X", "B"]));
		cur = applyPatch(cur, "SWAP 2.=2:\n+X2");
		expect(cur).toBe(linesText(["A", "X2", "B"]));
	});
});
