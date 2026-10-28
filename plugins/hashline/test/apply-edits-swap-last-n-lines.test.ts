import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * SWAP last N lines of a file with a single marker line.
 */

describe("SWAP last N lines", () => {
	it("collapses last k lines to one for k=1..10 on a 10-line file", () => {
		const n = 10;
		const src = linesText(Array.from({ length: n }, (_, i) => `L${i + 1}`));
		for (let k = 1; k <= n; k++) {
			const start = n - k + 1;
			const out = applyPatch(src, `SWAP ${start}.=${n}:\n+TAIL`);
			expect(lineCount(out)).toBe(n - k + 1);
			expect(out.trimEnd().endsWith("TAIL")).toBe(true);
			if (start > 1) {
				expect(out).toContain(`L${start - 1}`);
			}
		}
	});
});
