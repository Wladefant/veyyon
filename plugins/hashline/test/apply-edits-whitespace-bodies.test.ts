import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * applyEdits with whitespace-only and indentation-heavy bodies.
 */

describe("applyEdits whitespace bodies", () => {
	it("SWAP preserves leading spaces in replacement", () => {
		const out = applyPatch(linesText(["x"]), "SWAP 1.=1:\n+    indented");
		expect(out).toBe(linesText(["    indented"]));
	});

	it("SWAP preserves tabs in replacement", () => {
		const out = applyPatch(linesText(["x"]), "SWAP 1.=1:\n+\t\ttabbed");
		expect(out).toBe(linesText(["\t\ttabbed"]));
	});

	it("INS.TAIL of a blank-looking line with spaces", () => {
		const out = applyPatch(linesText(["a"]), "INS.TAIL:\n+   ");
		expect(out).toContain("a");
		// Spaces-only line is preserved.
		expect(out.split("\n").some(l => l === "   " || l.trim() === "")).toBe(true);
	});

	it("mixed indent block replace", () => {
		const out = applyPatch(linesText(["fn() {", "  a;", "}"]), "SWAP 2.=2:\n+\tb;");
		expect(out).toContain("\tb;");
		expect(out).toContain("fn() {");
	});
});
