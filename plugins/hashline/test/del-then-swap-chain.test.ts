import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Sequential pure apply chains: DEL then SWAP on the new text.
 */

describe("DEL then SWAP chain", () => {
	it("delete middle then swap first of remainder", () => {
		const mid = applyPatch(linesText(["A", "B", "C", "D"]), "DEL 2.=3");
		expect(mid).toBe(linesText(["A", "D"]));
		const next = applyPatch(mid, "SWAP 1.=1:\n+A2");
		expect(next).toBe(linesText(["A2", "D"]));
	});

	it("delete first then swap new first", () => {
		const mid = applyPatch(linesText(["A", "B", "C"]), "DEL 1.=1");
		expect(mid).toBe(linesText(["B", "C"]));
		const next = applyPatch(mid, "SWAP 1.=1:\n+B2");
		expect(next).toBe(linesText(["B2", "C"]));
	});

	it("delete last then swap last remaining", () => {
		const mid = applyPatch(linesText(["A", "B", "C"]), "DEL 3.=3");
		expect(mid).toBe(linesText(["A", "B"]));
		const next = applyPatch(mid, "SWAP 2.=2:\n+B2");
		expect(next).toBe(linesText(["A", "B2"]));
	});

	it("repeated single-line DEL shrinks the file to empty", () => {
		let cur = linesText(["A", "B", "C"]);
		for (let i = 0; i < 3; i++) {
			cur = applyPatch(cur, "DEL 1.=1");
		}
		expect(cur === "" || cur === "\n").toBe(true);
	});
});
