import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * applyEdits with very long replacement lines.
 */

describe("applyEdits long line bodies", () => {
	it("SWAP with 5k-char line", () => {
		const long = "x".repeat(5000);
		const out = applyPatch(linesText(["short"]), `SWAP 1.=1:\n+${long}`);
		expect(out).toBe(linesText([long]));
		expect(out.length).toBe(5001);
	});

	it("INS.TAIL with 2k-char line", () => {
		const long = "y".repeat(2000);
		const out = applyPatch(linesText(["a"]), `INS.TAIL:\n+${long}`);
		expect(out).toBe(linesText(["a", long]));
	});
});
