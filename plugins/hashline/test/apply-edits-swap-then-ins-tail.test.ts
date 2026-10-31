import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Sequential SWAP then INS.TAIL.
 */

describe("SWAP then INS.TAIL", () => {
	it("swap first then append", () => {
		let cur = linesText(["A", "B"]);
		cur = applyPatch(cur, "SWAP 1.=1:\n+A2");
		cur = applyPatch(cur, "INS.TAIL:\n+C");
		expect(cur).toBe(linesText(["A2", "B", "C"]));
	});

	it("swap last then append", () => {
		let cur = linesText(["A", "B"]);
		cur = applyPatch(cur, "SWAP 2.=2:\n+B2");
		cur = applyPatch(cur, "INS.TAIL:\n+C");
		expect(cur).toBe(linesText(["A", "B2", "C"]));
	});
});
