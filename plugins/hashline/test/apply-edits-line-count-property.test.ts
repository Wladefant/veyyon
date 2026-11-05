import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * Line-count properties after SWAP/DEL/INS.
 */

describe("applyEdits line-count property", () => {
	it("single-line SWAP preserves line count", () => {
		for (let n = 1; n <= 20; n++) {
			const src = linesText(Array.from({ length: n }, (_, i) => `L${i}`));
			for (let k = 1; k <= n; k++) {
				const out = applyPatch(src, `SWAP ${k}.=${k}:\n+X`);
				expect(lineCount(out)).toBe(n);
			}
		}
	});

	it("DEL N.=N reduces line count by 1", () => {
		for (let n = 1; n <= 15; n++) {
			const src = linesText(Array.from({ length: n }, (_, i) => `L${i}`));
			const out = applyPatch(src, "DEL 1.=1");
			expect(lineCount(out)).toBe(n - 1);
		}
	});

	it("INS.TAIL with one line increases count by 1", () => {
		for (let n = 0; n <= 10; n++) {
			const src = n === 0 ? "" : linesText(Array.from({ length: n }, (_, i) => `L${i}`));
			const out = applyPatch(src || "\n", "INS.TAIL:\n+X");
			// empty edge may differ; for n>=1 exact
			if (n >= 1) {
				expect(lineCount(out)).toBe(n + 1);
			}
		}
	});
});
