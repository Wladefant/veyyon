import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Mixed ops in one patch on disjoint anchors.
 */

describe("mixed ops one patch", () => {
	it("SWAP first and DEL last in one patch", () => {
		const out = applyPatch(linesText(["A", "B", "C", "D"]), "SWAP 1.=1:\n+A2\nDEL 4.=4");
		expect(out).toContain("A2");
		expect(out.includes("D")).toBe(false);
		expect(out).toContain("B");
		expect(out).toContain("C");
	});

	it("INS.HEAD and SWAP last in one patch", () => {
		const out = applyPatch(linesText(["A", "B"]), "INS.HEAD:\n+H\nSWAP 2.=2:\n+B2");
		expect(out).toContain("H");
		expect(out).toContain("B2");
		// Original anchors: SWAP 2 is B before INS applies depending on order.
		expect(out.length).toBeGreaterThan(0);
	});
});
