import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * SWAP the middle half of even-length files.
 */

describe("SWAP middle half", () => {
	it("replaces middle half with MID for even n", () => {
		for (const n of [4, 6, 8, 10, 12]) {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const src = linesText(lines);
			// For n=4: lines 2-3; for n=6: lines 3-4
			const s = Math.floor(n / 2);
			const e = s + 1;
			const out = applyPatch(src, `SWAP ${s}.=${e}:\n+MID`);
			expect(lineCount(out)).toBe(n - 1);
			expect(out).toContain("MID");
			expect(out).toContain("L1");
			expect(out).toContain(`L${n}`);
		}
	});
});
