import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * SWAP adjacent pairs across a file.
 */

describe("SWAP adjacent line pairs", () => {
	it("swaps each adjacent pair sequentially", () => {
		// Start: 1 2 3 4
		// Swap 1-2 → A B 3 4
		// Swap 3-4 → A B C D
		let cur = linesText(["1", "2", "3", "4"]);
		cur = applyPatch(cur, "SWAP 1.=2:\n+A\n+B");
		expect(cur).toBe(linesText(["A", "B", "3", "4"]));
		cur = applyPatch(cur, "SWAP 3.=4:\n+C\n+D");
		expect(cur).toBe(linesText(["A", "B", "C", "D"]));
	});
});
