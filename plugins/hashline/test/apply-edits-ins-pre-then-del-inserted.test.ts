/**
 * INS.PRE then DEL the inserted line at the same index: restores original.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits INS.PRE then DEL inserted", () => {
	const base = "a\nb\nc\nd\ne";
	for (let anchor = 1; anchor <= 5; anchor++) {
		it(`PRE ${anchor} then DEL insert`, () => {
			let t = applyPatch(base, `INS.PRE ${anchor}:\n+INSERTED`);
			expect(t.split("\n")[anchor - 1]).toBe("INSERTED");
			t = applyPatch(t, `DEL ${anchor}`);
			expect(t).toBe(base);
		});
	}
});
