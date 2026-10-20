/**
 * WHY: `LineMap` pairs the lines of two versions of a text. Recovery uses it to
 * move an anchor from the version a tag names onto the live file, and the
 * patcher uses it to carry displayed lines from the version an edit was applied
 * to onto the edited text. It finds the unchanged head and tail by comparing
 * the texts in blocks and diffs only the changed middle, where a full diff of
 * every line ran before. A wrong pairing moves an anchor onto a different line,
 * or marks a line displayed that the model never saw.
 *
 * Each property compares the map with a full line diff over random texts drawn
 * from a three-word alphabet, so repeated lines, empty lines and a trailing
 * newline on either side are common. A second family edits texts of 700-char
 * lines, some differing only in their last character, so the head and tail are
 * compared in blocks that span lines and a difference falls inside a block.
 *
 * Not caught: which of several equally long pairings is chosen when lines
 * repeat; any pairing that keeps content and order and is as long as a full
 * diff's passes.
 */
import { describe, expect, it } from "bun:test";
import { LineMap, lineCount } from "@veyyon/hashline/line-map";
import { diffArrays } from "diff";
import fc from "fast-check";

const lineArb = fc.constantFrom("a", "b", "c", "");
const textArb = fc.array(lineArb, { maxLength: 14 }).map(lines => lines.join("\n"));

const LONG = "a".repeat(700);
const longLineArb = fc.constantFrom(LONG, `${LONG.slice(1)}b`, `b${LONG.slice(1)}`, "c", "");
/** A text of long lines and the same text with a run of its lines replaced. */
const editedLongArb = fc
	.record({
		base: fc.array(longLineArb, { maxLength: 10 }),
		at: fc.nat(),
		remove: fc.nat({ max: 3 }),
		insert: fc.array(longLineArb, { maxLength: 3 }),
	})
	.map(({ base, at, remove, insert }) => {
		const edited = [...base];
		edited.splice(at % (base.length + 1), remove, ...insert);
		return [base.join("\n"), edited.join("\n")] as const;
	});

function pairs(map: LineMap, previous: string): Array<[number, number]> {
	const found: Array<[number, number]> = [];
	for (let line = 1; line <= lineCount(previous); line++) {
		const current = map.get(line);
		if (current !== undefined) found.push([line, current]);
	}
	return found;
}

function commonLines(previous: string, current: string): number {
	let count = 0;
	for (const change of diffArrays(previous.split("\n"), current.split("\n"))) {
		if (!change.added && !change.removed) count += change.value.length;
	}
	return count;
}

/** Asserts every property of the map against a full diff of `previous` and `current`. */
function expectMatchesFullDiff(previous: string, current: string): void {
	const previousLines = previous.split("\n");
	const currentLines = current.split("\n");
	const map = new LineMap(previous, current);
	const found = pairs(map, previous);
	let last = 0;
	for (const [from, to] of found) {
		expect(currentLines[to - 1]).toBe(previousLines[from - 1]);
		expect(to).toBeGreaterThan(last);
		last = to;
	}
	expect(found.length).toBe(commonLines(previous, current));
	expect([...found.map(([, to]) => to), ...map.written()].sort((x, y) => x - y)).toEqual(
		Array.from({ length: currentLines.length }, (_, i) => i + 1),
	);
}

describe("a line map pairs unchanged lines like a full diff", () => {
	it("pairs only lines with equal content, in order", () => {
		fc.assert(
			fc.property(textArb, textArb, (previous, current) => {
				const previousLines = previous.split("\n");
				const currentLines = current.split("\n");
				let last = 0;
				for (const [from, to] of pairs(new LineMap(previous, current), previous)) {
					expect(currentLines[to - 1]).toBe(previousLines[from - 1]);
					expect(to).toBeGreaterThan(last);
					last = to;
				}
			}),
			{ numRuns: 2000 },
		);
	});

	it("pairs as many lines as a full diff of every line", () => {
		fc.assert(
			fc.property(textArb, textArb, (previous, current) => {
				expect(pairs(new LineMap(previous, current), previous).length).toBe(commonLines(previous, current));
			}),
			{ numRuns: 2000 },
		);
	});

	it("reports every unpaired line of the current text as written, ascending", () => {
		fc.assert(
			fc.property(textArb, textArb, (previous, current) => {
				const map = new LineMap(previous, current);
				const paired = pairs(map, previous).map(([, to]) => to);
				const written = [...map.written()];
				expect(written).toEqual([...written].sort((x, y) => x - y));
				expect([...paired, ...written].sort((x, y) => x - y)).toEqual(
					Array.from({ length: lineCount(current) }, (_, i) => i + 1),
				);
			}),
			{ numRuns: 2000 },
		);
	});

	it("pairs only equal lines in order and accounts for every current line under any diff budget", () => {
		fc.assert(
			fc.property(textArb, textArb, fc.nat({ max: 60 }), (previous, current, budget) => {
				const previousLines = previous.split("\n");
				const currentLines = current.split("\n");
				const map = new LineMap(previous, current, budget);
				const found = pairs(map, previous);
				let last = 0;
				for (const [from, to] of found) {
					expect(currentLines[to - 1]).toBe(previousLines[from - 1]);
					expect(to).toBeGreaterThan(last);
					last = to;
				}
				expect([...found.map(([, to]) => to), ...map.written()].sort((x, y) => x - y)).toEqual(
					Array.from({ length: currentLines.length }, (_, i) => i + 1),
				);
			}),
			{ numRuns: 2000 },
		);
	});

	it("matches the unbounded map within its diff budget and reads a middle past it as rewritten", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
		const previous = `${lines.join("\n")}\n`;
		// Lines 10 to 90 change every tenth line: a middle of 81 lines on each side and 18 edits.
		const current = `${lines.map((line, i) => (i >= 9 && i < 90 && i % 10 === 9 ? `${line}!` : line)).join("\n")}\n`;
		const unbounded = new LineMap(previous, current);
		const within = new LineMap(previous, current, 18 * 162);
		expect(pairs(within, previous)).toEqual(pairs(unbounded, previous));
		expect(within.written()).toEqual(unbounded.written());

		const past = new LineMap(previous, current, 17 * 162);
		expect(pairs(past, previous)).toEqual([
			...Array.from({ length: 9 }, (_, i): [number, number] => [i + 1, i + 1]),
			...Array.from({ length: 11 }, (_, i): [number, number] => [i + 91, i + 91]),
		]);
		expect(past.written()).toEqual(Array.from({ length: 81 }, (_, i) => i + 10));
	});

	it("matches a full diff on long texts compared in blocks", () => {
		fc.assert(
			fc.property(editedLongArb, ([previous, current]) => expectMatchesFullDiff(previous, current)),
			{ numRuns: 2000 },
		);
	});

	it("matches a full diff when one character differs, at every offset of a text spanning compare blocks", () => {
		const previous = Array.from({ length: 22 }, () => "x".repeat(99)).join("\n");
		for (let at = 0; at < previous.length; at++) {
			expectMatchesFullDiff(previous, `${previous.slice(0, at)}y${previous.slice(at + 1)}`);
		}
	});

	it("pairs every line with itself when the texts are equal", () => {
		const text = "one\ntwo\n\nthree\n";
		const map = new LineMap(text, text);
		expect(pairs(map, text)).toEqual([
			[1, 1],
			[2, 2],
			[3, 3],
			[4, 4],
			[5, 5],
		]);
		expect(map.written()).toEqual([]);
	});

	it("shifts the unchanged tail past an insertion and drops a removed line", () => {
		const map = new LineMap("one\ntwo\nthree\nfour", "one\nNEW\nNEW2\ntwo\nfour");
		expect(pairs(map, "one\ntwo\nthree\nfour")).toEqual([
			[1, 1],
			[2, 4],
			[4, 5],
		]);
		expect(map.written()).toEqual([2, 3]);
	});

	it("answers undefined for a line outside the previous text", () => {
		const map = new LineMap("one\ntwo", "one\ntwo\nthree");
		for (const line of [0, -1, 1.5, 3, Number.NaN]) expect(map.get(line)).toBeUndefined();
	});

	it("counts the segments of split, including an empty last one", () => {
		for (const text of ["", "a", "a\n", "a\nb", "\n\n"]) expect(lineCount(text)).toBe(text.split("\n").length);
	});
});
