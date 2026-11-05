import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { lineCount, linesText } from "./support/apply-patch";

/**
 * DEL middle ranges of various widths from a 15-line file.
 */

const SRC = linesText(Array.from({ length: 15 }, (_, i) => `L${i + 1}`));

function apply(diff: string): string {
	return applyEdits(SRC, parsePatch(diff).edits).text;
}

describe("DEL middle range sizes", () => {
	it("DEL starting at 5 with width w leaves 15-w lines", () => {
		for (let w = 1; w <= 10; w++) {
			const end = 4 + w;
			const out = apply(`DEL 5.=${end}`);
			expect(lineCount(out)).toBe(15 - w);
			expect(out).toContain("L4");
			if (end < 15) {
				expect(out).toContain(`L${end + 1}`);
			}
		}
	});
});
