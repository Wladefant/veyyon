import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Sequential INS then SWAP pure chains.
 */

describe("INS then SWAP chain", () => {
	it("INS.HEAD then SWAP of new first line", () => {
		const mid = applyPatch(linesText(["A", "B"]), "INS.HEAD:\n+H");
		expect(mid).toBe(linesText(["H", "A", "B"]));
		const next = applyPatch(mid, "SWAP 1.=1:\n+H2");
		expect(next).toBe(linesText(["H2", "A", "B"]));
	});

	it("INS.TAIL then SWAP of new last line", () => {
		const mid = applyPatch(linesText(["A", "B"]), "INS.TAIL:\n+T");
		expect(mid).toBe(linesText(["A", "B", "T"]));
		const next = applyPatch(mid, "SWAP 3.=3:\n+T2");
		expect(next).toBe(linesText(["A", "B", "T2"]));
	});

	it("INS.POST 1 then SWAP of the inserted line", () => {
		const mid = applyPatch(linesText(["A", "B"]), "INS.POST 1:\n+X");
		expect(mid).toBe(linesText(["A", "X", "B"]));
		const next = applyPatch(mid, "SWAP 2.=2:\n+X2");
		expect(next).toBe(linesText(["A", "X2", "B"]));
	});

	it("INS.PRE 1 then body is shifted", () => {
		const mid = applyPatch(linesText(["A", "B"]), "INS.PRE 1:\n+Y");
		expect(mid).toBe(linesText(["Y", "A", "B"]));
	});
});
