/**
 * After DEL line 1, line numbers shift: subsequent sequential SWAP must use
 * new indices.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits DEL then SWAP on shifted index", () => {
	it("DEL 1 then SWAP old L2 at new index 1", () => {
		let t = "a\nb\nc";
		t = applyPatch(t, "DEL 1");
		expect(t).toBe("b\nc");
		t = applyPatch(t, "SWAP 1.=1:\n+B");
		expect(t).toBe("B\nc");
	});

	it("DEL last then SWAP last remaining", () => {
		let t = "a\nb\nc";
		t = applyPatch(t, "DEL 3");
		expect(t).toBe("a\nb");
		t = applyPatch(t, "SWAP 2.=2:\n+B");
		expect(t).toBe("a\nB");
	});
});
