/**
 * Seeded walks for seeds 61..70: 30 ops each, no throw.
 */
import { describe, expect, it } from "bun:test";
import { lcgUint32 } from "@veyyon/utils/adversarial-strings";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits continue depth seeds 61 through 70", () => {
	for (let seed = 61; seed <= 70; seed++) {
		it(`seed=${seed}`, () => {
			const next = lcgUint32(seed);
			let t = "x\ny";
			for (let i = 0; i < 30; i++) {
				const n = t === "" ? 0 : t.split("\n").length;
				const op = next() % 4;
				if (n === 0 || op === 0) t = applyPatch(t, `INS.TAIL:\n+T${i}`);
				else if (op === 1) t = applyPatch(t, `INS.HEAD:\n+H${i}`);
				else if (op === 2) t = applyPatch(t, `DEL ${(next() % n) + 1}`);
				else {
					const line = (next() % n) + 1;
					t = applyPatch(t, `SWAP ${line}.=${line}:\n+S${i}`);
				}
			}
			expect(typeof t).toBe("string");
		});
	}
});
