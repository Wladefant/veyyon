/**
 * INS.POST then DEL the inserted line by its new index: restores original.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits INS.POST then DEL inserted", () => {
	const base = "a\nb\nc\nd\ne";
	for (let anchor = 1; anchor <= 5; anchor++) {
		it(`POST ${anchor} then DEL insert`, () => {
			let t = applyPatch(base, `INS.POST ${anchor}:\n+INSERTED`);
			expect(t.split("\n")[anchor]).toBe("INSERTED");
			t = applyPatch(t, `DEL ${anchor + 1}`);
			expect(t).toBe(base);
		});
	}
});
