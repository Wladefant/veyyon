import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Collapse entire file to one line via SWAP 1.=N.
 */

describe("SWAP all lines to one", () => {
	it("collapses n-line files for n=1..15", () => {
		for (let n = 1; n <= 15; n++) {
			const src = linesText(Array.from({ length: n }, (_, i) => `L${i}`));
			const out = applyPatch(src, `SWAP 1.=${n}:\n+ONLY`);
			expect(out).toBe(linesText(["ONLY"]));
		}
	});
});
