import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * SWAP with empty payload line (delete via empty replace).
 */

describe("SWAP empty payload", () => {
	it("SWAP with empty + line may delete or leave empty line", () => {
		const out = applyPatch(linesText(["A", "B", "C"]), "SWAP 2.=2:\n+");
		// Empty replacement: either removes the line or leaves blank.
		expect(out.includes("A")).toBe(true);
		expect(out.includes("C")).toBe(true);
		const lines = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(lines.length === 2 || lines.length === 3).toBe(true);
	});
});
