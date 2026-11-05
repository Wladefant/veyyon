import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * SWAP first N lines of a file with a single marker line.
 */

describe("SWAP first N lines", () => {
	it("collapses first k lines to one for k=1..10 on a 10-line file", () => {
		const src = linesText(Array.from({ length: 10 }, (_, i) => `L${i + 1}`));
		for (let k = 1; k <= 10; k++) {
			const out = applyPatch(src, `SWAP 1.=${k}:\n+HEAD`);
			expect(lineCount(out)).toBe(10 - k + 1);
			expect(out.startsWith("HEAD\n")).toBe(true);
			if (k < 10) {
				expect(out).toContain(`L${k + 1}`);
			}
		}
	});
});
