import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Sequential INS.HEAD stacks in reverse order.
 */

describe("sequential INS.HEAD many", () => {
	it("prepending 1..10 stacks newest at top", () => {
		let cur = linesText(["0"]);
		for (let i = 1; i <= 10; i++) {
			cur = applyPatch(cur, `INS.HEAD:\n+${i}`);
		}
		const lines = cur.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(lines[0]).toBe("10");
		expect(lines[lines.length - 1]).toBe("0");
		expect(lines).toHaveLength(11);
		expect(lines).toEqual(["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "0"]);
	});
});
