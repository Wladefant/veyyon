import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Sequential INS.TAIL builds a list in order.
 */

describe("sequential INS.TAIL many", () => {
	it("appending 1..20 builds ascending list", () => {
		let cur = linesText(["0"]);
		for (let i = 1; i <= 20; i++) {
			cur = applyPatch(cur, `INS.TAIL:\n+${i}`);
		}
		const lines = cur.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(lines).toEqual(Array.from({ length: 21 }, (_, i) => String(i)));
	});
});
