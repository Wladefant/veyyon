import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Blank lines in the middle of a file are preserved when editing elsewhere.
 */

describe("applyEdits preserves blank lines", () => {
	it("SWAP first leaves interior blank intact", () => {
		const src = linesText(["A", "", "C"]);
		const out = applyPatch(src, "SWAP 1.=1:\n+A2");
		expect(out).toBe(linesText(["A2", "", "C"]));
	});

	it("DEL last leaves interior blank intact", () => {
		const src = linesText(["A", "", "C"]);
		const out = applyPatch(src, "DEL 3.=3");
		expect(out).toBe(linesText(["A", ""]));
	});

	it("INS.TAIL after file with trailing blank structure", () => {
		const src = linesText(["A", ""]);
		const out = applyPatch(src, "INS.TAIL:\n+Z");
		expect(out).toContain("A");
		expect(out).toContain("Z");
	});
});
