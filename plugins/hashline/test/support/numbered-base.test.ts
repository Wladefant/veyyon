/**
 * Contract for the numbered-base checks the edit suites run on every anchor.
 *
 * Why this suite exists: those suites compare each edit's output to the base
 * with one span replaced, computing the span from line offsets instead of
 * building the expected text. A wrong offset fails every suite on a correct
 * applier, and a check that accepts a wrong text passes every suite on a broken
 * one. This pins both: offsets against the joined base across the one- to
 * four-digit boundaries, and a rejection for each way a text can differ.
 */
import { describe, expect, it } from "bun:test";
import { expectSplicedBase, numberedLineStart, numberedLines } from "./numbered-base";

describe("numberedLineStart", () => {
	it("matches the offset of every line in the joined base across digit-width boundaries", () => {
		const lines = numberedLines(1200);
		let offset = 0;
		for (let i = 1; i <= lines.length; i++) {
			expect(numberedLineStart(i)).toBe(offset);
			offset += lines[i - 1].length + 1;
		}
	});
});

describe("expectSplicedBase", () => {
	const base = numberedLines(30).join("\n");
	const from = numberedLineStart(12);
	const to = numberedLineStart(13);

	it("accepts the base with the span replaced", () => {
		expectSplicedBase(base.slice(0, from) + base.slice(to), base, from, to, "");
		expectSplicedBase(`${base.slice(0, from)}X\n${base.slice(to)}`, base, from, to, "X\n");
	});

	it("rejects a text that differs from the splice in one character, one line, or its length", () => {
		const spliced = `${base.slice(0, from)}X\n${base.slice(to)}`;
		const variants = [
			spliced.replace("L5\n", "L6\n"),
			spliced.replace("L29", "L2X"),
			`${base.slice(0, from)}Y\n${base.slice(to)}`,
			base,
			`${spliced}\n`,
			spliced.slice(0, -1),
			`${base.slice(0, from)}X\n${base.slice(numberedLineStart(14))}`,
		];
		for (const text of variants) {
			expect(() => expectSplicedBase(text, base, from, to, "X\n")).toThrow();
		}
	});
});
