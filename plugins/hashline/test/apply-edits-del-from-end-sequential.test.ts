import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * Delete from the end of the file repeatedly.
 */

describe("sequential DEL from end", () => {
	it("deleting last line repeatedly empties the file", () => {
		const n = 7;
		let cur = linesText(Array.from({ length: n }, (_, i) => `L${i + 1}`));
		for (let left = n; left >= 1; left--) {
			cur = applyPatch(cur, `DEL ${left}.=${left}`);
			expect(lineCount(cur)).toBe(left - 1);
		}
		expect(cur === "" || cur === "\n").toBe(true);
	});
});
