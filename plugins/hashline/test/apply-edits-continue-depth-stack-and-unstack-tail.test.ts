/**
 * Stack k TAIL inserts then unstack with DEL last repeated k times.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits continue depth stack and unstack TAIL", () => {
	for (const k of [3, 7, 12]) {
		it(`k=${k}`, () => {
			const base = "CORE";
			let t = base;
			for (let i = 0; i < k; i++) t = applyPatch(t, `INS.TAIL:\n+T${i}`);
			expect(t.split("\n")).toHaveLength(k + 1);
			for (let i = 0; i < k; i++) {
				const n = t.split("\n").length;
				t = applyPatch(t, `DEL ${n}`);
			}
			expect(t).toBe(base);
		});
	}
});
