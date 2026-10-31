import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { lineCount, linesText } from "./support/apply-patch";

/**
 * DEL ranges of various sizes from a fixed 20-line file.
 */

const SRC = linesText(Array.from({ length: 20 }, (_, i) => `L${i + 1}`));

function apply(diff: string): string {
	return applyEdits(SRC, parsePatch(diff).edits).text;
}

describe("DEL range sizes", () => {
	it("DEL 1..=k leaves 20-k lines for k=1..20", () => {
		for (let k = 1; k <= 20; k++) {
			const out = apply(`DEL 1.=${k}`);
			expect(lineCount(out)).toBe(20 - k);
			if (k < 20) {
				expect(out).toContain(`L${k + 1}`);
			}
		}
	});
});
