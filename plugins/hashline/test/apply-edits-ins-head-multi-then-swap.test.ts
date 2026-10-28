import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Multi-line INS.HEAD then SWAP of one of the inserted lines.
 */

describe("INS.HEAD multi then SWAP", () => {
	it("inserts two lines then renames the first", () => {
		let cur = linesText(["body"]);
		cur = applyPatch(cur, "INS.HEAD:\n+H1\n+H2");
		expect(cur).toBe(linesText(["H1", "H2", "body"]));
		cur = applyPatch(cur, "SWAP 1.=1:\n+H1x");
		expect(cur).toBe(linesText(["H1x", "H2", "body"]));
	});
});
