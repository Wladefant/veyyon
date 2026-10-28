import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * SWAP first and last lines of files of various sizes.
 */

describe("SWAP first and last", () => {
	it("SWAP first and last in one patch for n=3..15", () => {
		for (let n = 3; n <= 15; n++) {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const src = linesText(lines);
			const out = applyPatch(src, `SWAP 1.=1:\n+FIRST\nSWAP ${n}.=${n}:\n+LAST`);
			const result = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
			expect(result[0]).toBe("FIRST");
			expect(result[n - 1]).toBe("LAST");
			if (n > 2) {
				expect(result[1]).toBe("L2");
			}
		}
	});
});
