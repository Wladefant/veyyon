import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { lineCount, linesText } from "./support/apply-patch";

/**
 * SWAP start..=end for all ranges in a 5-line file with single-line replacement.
 */

const SRC = linesText(["1", "2", "3", "4", "5"]);

function apply(diff: string): string {
	return applyEdits(SRC, parsePatch(diff).edits).text;
}

describe("SWAP range endpoint matrix", () => {
	it("SWAP s..=e with one line leaves 6-(e-s) lines", () => {
		for (let s = 1; s <= 5; s++) {
			for (let e = s; e <= 5; e++) {
				const out = apply(`SWAP ${s}.=${e}:\n+X`);
				const expected = 5 - (e - s);
				expect(lineCount(out)).toBe(expected);
				expect(out).toContain("X");
			}
		}
	});
});
