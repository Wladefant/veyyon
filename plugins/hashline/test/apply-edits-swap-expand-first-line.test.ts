import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * Expand the first line into many lines.
 */

describe("SWAP expand first line", () => {
	it("expands first line to k lines for k=1..8", () => {
		const src = linesText(["A", "B", "C"]);
		for (let k = 1; k <= 8; k++) {
			const body = Array.from({ length: k }, (_, i) => `+F${i}`).join("\n");
			const out = applyPatch(src, `SWAP 1.=1:\n${body}`);
			expect(lineCount(out)).toBe(2 + k);
			expect(out).toContain("B");
			expect(out).toContain("C");
		}
	});
});
