import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Delete all lines one by one from the front.
 */

describe("sequential DEL from front", () => {
	it("deleting line 1 repeatedly empties an N-line file", () => {
		for (const n of [1, 3, 5, 10]) {
			let cur = linesText(Array.from({ length: n }, (_, i) => `L${i}`));
			for (let i = 0; i < n; i++) {
				cur = applyPatch(cur, "DEL 1.=1");
			}
			expect(cur === "" || cur === "\n").toBe(true);
		}
	});
});
