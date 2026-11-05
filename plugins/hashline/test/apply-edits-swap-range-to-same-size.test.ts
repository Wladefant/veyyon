import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * SWAP ranges replaced with same number of lines.
 */

describe("SWAP range same size", () => {
	it("replace 3 lines with 3 lines preserves total count", () => {
		const src = linesText(["A", "B", "C", "D", "E"]);
		const out = applyPatch(src, "SWAP 2.=4:\n+X\n+Y\n+Z");
		expect(lineCount(out)).toBe(5);
		expect(out).toBe(linesText(["A", "X", "Y", "Z", "E"]));
	});

	it("replace 2 lines with 2 lines", () => {
		const src = linesText(["A", "B", "C"]);
		const out = applyPatch(src, "SWAP 1.=2:\n+X\n+Y");
		expect(out).toBe(linesText(["X", "Y", "C"]));
	});
});
