import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { linesText } from "./support/apply-patch";

/**
 * Identity SWAP matrix: each line replaced with itself.
 */

describe("SWAP line to self matrix", () => {
	it("identity SWAP for every line in n=1..12 files", () => {
		for (let n = 1; n <= 12; n++) {
			const lines = Array.from({ length: n }, (_, i) => `L${i}`);
			const src = linesText(lines);
			for (let k = 1; k <= n; k++) {
				const out = applyEdits(src, parsePatch(`SWAP ${k}.=${k}:\n+${lines[k - 1]}`).edits).text;
				expect(out).toBe(src);
			}
		}
	});
});
