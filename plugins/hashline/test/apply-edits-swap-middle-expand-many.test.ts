import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * Expand middle of file with multi-line SWAP for several sizes.
 */

describe("SWAP middle expand many", () => {
	it("replaces middle line with k lines for k=1..10", () => {
		const src = linesText(["A", "B", "C"]);
		for (let k = 1; k <= 10; k++) {
			const body = Array.from({ length: k }, (_, i) => `+M${i}`).join("\n");
			const out = applyPatch(src, `SWAP 2.=2:\n${body}`);
			expect(lineCount(out)).toBe(2 + k);
			expect(out.startsWith("A\n")).toBe(true);
			expect(out.endsWith("C\n") || out.includes("\nC\n") || out.trimEnd().endsWith("C")).toBe(true);
		}
	});
});
