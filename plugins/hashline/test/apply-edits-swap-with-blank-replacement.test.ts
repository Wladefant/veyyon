import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * SWAP introducing blank lines in the middle of a file.
 */

describe("SWAP introducing blank lines", () => {
	it("replaces middle with blank-containing block", () => {
		const out = applyPatch(linesText(["A", "B", "C"]), "SWAP 2.=2:\n+\n+X\n+");
		expect(out).toContain("A");
		expect(out).toContain("X");
		expect(out).toContain("C");
	});

	it("replaces a line with only spaces", () => {
		const out = applyPatch(linesText(["A", "B"]), "SWAP 1.=1:\n+   ");
		const lines = out.split("\n");
		expect(lines[0]).toBe("   ");
		expect(out).toContain("B");
	});
});
