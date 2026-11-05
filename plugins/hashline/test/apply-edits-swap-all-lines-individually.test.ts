import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Sequentially SWAP every line in a file one at a time.
 */

describe("sequential SWAP of every line", () => {
	it("each line becomes Xi after i sequential SWAPs", () => {
		const n = 8;
		let cur = linesText(Array.from({ length: n }, (_, i) => `L${i + 1}`));
		for (let i = 1; i <= n; i++) {
			cur = applyPatch(cur, `SWAP ${i}.=${i}:\n+X${i}`);
		}
		const result = cur.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(result).toEqual(Array.from({ length: n }, (_, i) => `X${i + 1}`));
	});
});
