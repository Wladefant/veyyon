import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Two non-adjacent 2-line SWAPs in one patch.
 */

describe("two nonadjacent pair SWAPs", () => {
	it("swaps 1-2 and 5-6 in a 6-line file", () => {
		const src = linesText(["1", "2", "3", "4", "5", "6"]);
		const out = applyPatch(src, "SWAP 1.=2:\n+A\n+B\nSWAP 5.=6:\n+E\n+F");
		expect(out).toBe(linesText(["A", "B", "3", "4", "E", "F"]));
	});
});
