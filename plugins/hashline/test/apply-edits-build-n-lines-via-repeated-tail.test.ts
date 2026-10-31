/**
 * Build an n-line file from empty via n sequential INS.TAIL.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits build n lines via repeated TAIL", () => {
	for (const n of [1, 5, 10, 20]) {
		it(`n=${n}`, () => {
			let t = "";
			for (let i = 1; i <= n; i++) {
				t = applyPatch(t, `INS.TAIL:\n+L${i}`);
			}
			expect(t.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `L${i + 1}`));
		});
	}
});
