import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * SWAP multi-line block to multi-line block of different sizes.
 */

describe("SWAP block to block", () => {
	it("2 lines → 4 lines", () => {
		const out = applyPatch(linesText(["A", "B", "C", "D"]), "SWAP 2.=3:\n+W\n+X\n+Y\n+Z");
		expect(out).toBe(linesText(["A", "W", "X", "Y", "Z", "D"]));
	});

	it("4 lines → 2 lines", () => {
		const out = applyPatch(linesText(["A", "B", "C", "D", "E", "F"]), "SWAP 2.=5:\n+X\n+Y");
		expect(out).toBe(linesText(["A", "X", "Y", "F"]));
	});

	it("3 lines → 3 lines", () => {
		const out = applyPatch(linesText(["A", "B", "C", "D"]), "SWAP 1.=3:\n+X\n+Y\n+Z");
		expect(out).toBe(linesText(["X", "Y", "Z", "D"]));
	});
});
