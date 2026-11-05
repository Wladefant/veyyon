import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * Expand the last line into many lines.
 */

describe("SWAP expand last line", () => {
	it("expands last line to k lines for k=1..8", () => {
		const src = linesText(["A", "B", "C"]);
		for (let k = 1; k <= 8; k++) {
			const body = Array.from({ length: k }, (_, i) => `+L${i}`).join("\n");
			const out = applyPatch(src, `SWAP 3.=3:\n${body}`);
			expect(lineCount(out)).toBe(2 + k);
			expect(out.startsWith("A\nB\n")).toBe(true);
		}
	});
});
