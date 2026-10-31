/**
 * Seeded walks for seeds 201..250: 15 ops each, no throw.
 */
import { describe, expect, it } from "bun:test";
import { lcgUint32 } from "@veyyon/utils/adversarial-strings";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits past 5000 seeds 201 through 250", () => {
	for (let seed = 201; seed <= 250; seed++) {
		it(`seed=${seed}`, () => {
			const next = lcgUint32(seed);
			let t = "m\nn";
			for (let i = 0; i < 15; i++) {
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
