/**
 * Zigzag: DEL 1, INS.TAIL marker, repeat — drains file into reverse markers.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits zigzag DEL INS pattern", () => {
	it("drain a,b,c via del1 + tail", () => {
		let t = "a\nb\nc";
		t = applyPatch(t, "DEL 1");
		t = applyPatch(t, "INS.TAIL:\n+A");
		t = applyPatch(t, "DEL 1");
		t = applyPatch(t, "INS.TAIL:\n+B");
		t = applyPatch(t, "DEL 1");
		t = applyPatch(t, "INS.TAIL:\n+C");
		expect(t).toBe("A\nB\nC");
	});
});
