/**
 * Sequential INS.POST on the same logical place after prior insert shifts index.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits INS.POST then POST shifted sequential", () => {
	it("stack after b by always POSTing the current last insert", () => {
		let t = "a\nb\nc";
		// after b
		t = applyPatch(t, "INS.POST 2:\n+1");
		expect(t).toBe("a\nb\n1\nc");
		// insert after the new line 3
		t = applyPatch(t, "INS.POST 3:\n+2");
		expect(t).toBe("a\nb\n1\n2\nc");
		t = applyPatch(t, "INS.POST 4:\n+3");
		expect(t).toBe("a\nb\n1\n2\n3\nc");
	});
});
