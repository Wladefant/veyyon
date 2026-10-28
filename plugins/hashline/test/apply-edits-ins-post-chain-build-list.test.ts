import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./support/apply-patch";

/**
 * Build a list by repeatedly INS.POST on the last line.
 */

describe("INS.POST chain build list", () => {
	it("appending after last line 10 times grows by 10", () => {
		let cur = linesText(["start"]);
		for (let i = 1; i <= 10; i++) {
			const last = lineCount(cur);
			cur = applyPatch(cur, `INS.POST ${last}:\n+item${i}`);
		}
		const lines = cur.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(lines[0]).toBe("start");
		expect(lines).toHaveLength(11);
		expect(lines[10]).toBe("item10");
	});
});
