/**
 * Grow a mid range then DEL the grown body mid section: net file returns to
 * a known shape.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits grow then del net property", () => {
	it("expand mid then delete expansion restores outer", () => {
		const base = "a\nb\nc\nd\ne";
		let t = applyPatch(base, "SWAP 2.=4:\n+X\n+Y\n+Z\n+W");
		expect(t).toBe("a\nX\nY\nZ\nW\ne");
		t = applyPatch(t, "DEL 2.=5");
		expect(t).toBe("a\ne");
	});

	for (const bodyLen of [2, 4, 6]) {
		it(`grow line 1 to ${bodyLen} then DEL first ${bodyLen - 1}`, () => {
			const base = "ONLY";
			let t = applyPatch(base, `SWAP 1.=1:\n${Array.from({ length: bodyLen }, (_, i) => `+B${i}`).join("\n")}`);
			expect(t.split("\n")).toHaveLength(bodyLen);
			// del all but last
			const dels = Array.from({ length: bodyLen - 1 }, (_, i) => `DEL ${i + 1}`).join("\n");
			t = applyPatch(t, dels);
			expect(t).toBe(`B${bodyLen - 1}`);
		});
	}
});
