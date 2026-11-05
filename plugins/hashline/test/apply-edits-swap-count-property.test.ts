import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { lineCount, linesText } from "./support/apply-patch";

/**
 * After k single-line SWAPs in one patch, line count is unchanged.
 */

describe("SWAP count property", () => {
	it("k disjoint single-line SWAPs preserve length for n=10..30", () => {
		for (const n of [10, 15, 20, 30]) {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const src = linesText(lines);
			// Swap first k odd lines.
			const k = Math.floor(n / 2);
			const hunks = Array.from({ length: k }, (_, i) => {
				const line = i * 2 + 1;
				return `SWAP ${line}.=${line}:\n+X${line}`;
			}).join("\n");
			const out = applyEdits(src, parsePatch(hunks).edits).text;
			expect(lineCount(out)).toBe(n);
		}
	});
});
