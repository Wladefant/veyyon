/**
 * Palindrome-length content lines: reverse via sequential SWAPs.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits continue depth palindrome file ops", () => {
	it("reverse 5-line file via pairwise swap", () => {
		let t = "1\n2\n3\n4\n5";
		// swap 1↔5, 2↔4
		t = applyPatch(t, "SWAP 1.=1:\n+TMP");
		t = applyPatch(t, "SWAP 5.=5:\n+1");
		t = applyPatch(t, "SWAP 1.=1:\n+5");
		t = applyPatch(t, "SWAP 2.=2:\n+TMP2");
		t = applyPatch(t, "SWAP 4.=4:\n+2");
		t = applyPatch(t, "SWAP 2.=2:\n+4");
		expect(t).toBe("5\n4\n3\n2\n1");
	});
});
