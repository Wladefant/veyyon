import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Longer sequential pure edit chains.
 */

describe("SWAP DEL INS long sequence", () => {
	it("build file through a sequence of pure ops", () => {
		let cur = linesText(["seed"]);
		cur = applyPatch(cur, "INS.TAIL:\n+a");
		cur = applyPatch(cur, "INS.TAIL:\n+b");
		cur = applyPatch(cur, "SWAP 1.=1:\n+SEED");
		cur = applyPatch(cur, "DEL 2.=2");
		cur = applyPatch(cur, "INS.HEAD:\n+H");
		expect(cur).toBe(linesText(["H", "SEED", "b"]));
	});
});
