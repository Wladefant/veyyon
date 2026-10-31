import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * SWAP expands and shrinks ranges (1→N and N→1).
 */

describe("SWAP expand and shrink", () => {
	it("1→3 expand", () => {
		const out = applyPatch(linesText(["A", "B", "C"]), "SWAP 2.=2:\n+X\n+Y\n+Z");
		expect(lineCount(out)).toBe(5);
		expect(out).toBe(linesText(["A", "X", "Y", "Z", "C"]));
	});

	it("3→1 shrink", () => {
		const out = applyPatch(linesText(["A", "B", "C", "D"]), "SWAP 2.=4:\n+MID");
		expect(lineCount(out)).toBe(2);
		expect(out).toBe(linesText(["A", "MID"]));
	});

	it("2→2 same count", () => {
		const out = applyPatch(linesText(["A", "B", "C"]), "SWAP 1.=2:\n+X\n+Y");
		expect(lineCount(out)).toBe(3);
		expect(out).toBe(linesText(["X", "Y", "C"]));
	});

	it("full file 5→1", () => {
		const out = applyPatch(linesText(["A", "B", "C", "D", "E"]), "SWAP 1.=5:\n+ALL");
		expect(out).toBe(linesText(["ALL"]));
	});
});
