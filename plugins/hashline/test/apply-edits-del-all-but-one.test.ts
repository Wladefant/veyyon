import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * DEL ranges that leave exactly one line.
 */

describe("DEL leave one line", () => {
	it("DEL 2.=N leaves first line", () => {
		const src = linesText(["A", "B", "C", "D"]);
		const out = applyPatch(src, "DEL 2.=4");
		expect(out).toBe(linesText(["A"]));
	});

	it("DEL 1.=N-1 leaves last line", () => {
		const src = linesText(["A", "B", "C", "D"]);
		const out = applyPatch(src, "DEL 1.=3");
		expect(out).toBe(linesText(["D"]));
	});
});
