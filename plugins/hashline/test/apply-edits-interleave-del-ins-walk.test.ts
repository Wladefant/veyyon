/**
 * Walk: for each original line, DEL it and INS.HEAD a marker — adversarial
 * sequential rewrites.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits interleave DEL INS walk", () => {
	it("replace all via del first + head insert chain", () => {
		let t = "a\nb\nc";
		t = applyPatch(t, "DEL 1");
		t = applyPatch(t, "INS.HEAD:\n+A");
		t = applyPatch(t, "DEL 2");
		t = applyPatch(t, "INS.POST 1:\n+B");
		t = applyPatch(t, "DEL 3");
		t = applyPatch(t, "INS.TAIL:\n+C");
		expect(t).toBe("A\nB\nC");
	});
});
