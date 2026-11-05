/**
 * Sequential double HEAD then double TAIL: exact sandwich growth.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits double HEAD then double TAIL", () => {
	it("from body", () => {
		let t = "BODY";
		t = applyPatch(t, "INS.HEAD:\n+H1");
		t = applyPatch(t, "INS.HEAD:\n+H0");
		t = applyPatch(t, "INS.TAIL:\n+T0");
		t = applyPatch(t, "INS.TAIL:\n+T1");
		expect(t).toBe("H0\nH1\nBODY\nT0\nT1");
	});

	it("from empty", () => {
		let t = "";
		t = applyPatch(t, "INS.HEAD:\n+A");
		t = applyPatch(t, "INS.TAIL:\n+B");
		t = applyPatch(t, "INS.HEAD:\n+0");
		t = applyPatch(t, "INS.TAIL:\n+Z");
		expect(t).toBe("0\nA\nB\nZ");
	});
});
