/**
 * Contract for the text helpers the apply-edits suites build inputs and read results through.
 *
 * Why this suite exists: hundreds of suites count and build lines through these, so a wrong
 * count passes a suite whose patch dropped or duplicated a line. This pins the boundaries a
 * stress seed can reach: the empty file, the lone newline, and a missing final newline.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch, lineCount, linesText } from "./apply-patch";

describe("lineCount", () => {
	it("counts an empty file and a lone newline as holding no lines", () => {
		expect(lineCount("")).toBe(0);
		expect(lineCount("\n")).toBe(0);
	});

	it("counts the last line whether or not it ends in a newline", () => {
		expect(lineCount("a\nb\n")).toBe(2);
		expect(lineCount("a\nb")).toBe(2);
		expect(lineCount("a\n\nb\n")).toBe(3);
	});
});

describe("linesText", () => {
	it("terminates every line, including the last, with one newline", () => {
		expect(linesText(["a", "b"])).toBe("a\nb\n");
		expect(linesText([""])).toBe("\n");
	});
});

describe("applyPatch", () => {
	it("returns the text the patch produces", () => {
		expect(applyPatch(linesText(["a", "b", "c"]), "DEL 2")).toBe(linesText(["a", "c"]));
	});
});
