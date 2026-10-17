/**
 * WHY: a list whose descriptions are fixed-width columns (the Roster's State, Effort and Model
 * cells) pads each cell with spaces so the columns line up under a heading. `SelectList` flattened
 * every description to one line by collapsing each run of whitespace to one space, which took the
 * padding with it: every row's columns started wherever the previous cell happened to end.
 *
 * `tabularDescription` keeps runs of spaces and still turns every other whitespace character into
 * a space, swept over every BMP character `\s` matches, and the row draws a tab as spaces, so a
 * description cannot break its row. Without the option a description collapses as before. This
 * does not cover non-whitespace control characters, which neither mode removes, or how a host
 * picks its column widths.
 */
import { describe, expect, it } from "bun:test";
import { SelectList, type SelectListTheme } from "@veyyon/tui/components/select-list";
import type { BoxSymbols } from "@veyyon/utils/symbols";

const box: BoxSymbols = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	teeDown: "┬",
	teeUp: "┴",
	teeLeft: "┤",
	teeRight: "├",
	cross: "┼",
};

/** Identity paints: assertions read the row text, not the styling around it. */
const theme: SelectListTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
	symbols: {
		cursor: "→",
		inputCursor: "|",
		boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
		boxSharp: box,
		table: box,
		quoteBorder: "│",
		hrChar: "─",
		spinnerFrames: ["|", "/", "-", "\\"],
	},
};

const WIDTH = 100;

/** Two rows whose first cell differs in length and is padded to 12 columns. */
const items = [
	{ value: "a", label: "alpha", description: `${"on".padEnd(12)}model-one` },
	{ value: "b", label: "beta", description: `${"disabled".padEnd(12)}model-two` },
];

function rowOf(lines: readonly string[], label: string): string {
	const row = lines.find(line => line.includes(label));
	if (row === undefined) throw new Error(`no row for ${label}`);
	return row;
}

describe("a SelectList description", () => {
	it("keeps its padding in a tabular list, so the second column starts at one offset on every row", () => {
		const lines = new SelectList(items, 5, theme, { tabularDescription: true }).render(WIDTH);
		const first = rowOf(lines, "alpha").indexOf("model-one");
		const second = rowOf(lines, "beta").indexOf("model-two");
		expect(first).toBeGreaterThan(0);
		expect(second).toBe(first);
		expect(rowOf(lines, "alpha")).toContain(`on${" ".repeat(10)}model-one`);
	});

	it("collapses each run of spaces to one without the option", () => {
		const lines = new SelectList(items, 5, theme).render(WIDTH);
		expect(rowOf(lines, "alpha")).toContain("on model-one");
		expect(rowOf(lines, "beta")).toContain("disabled model-two");
	});

	it("still turns a line break and a tab into spaces in a tabular list, so the row stays one line", () => {
		const list = new SelectList([{ value: "a", label: "alpha", description: "first\nsecond\tthird" }], 5, theme, {
			tabularDescription: true,
		});
		const lines = list.render(WIDTH);
		const row = rowOf(lines, "alpha");
		expect(row).toMatch(/first second +third/);
		expect(row).not.toContain("\t");
		expect(lines.some(line => line.includes("second") && !line.includes("alpha"))).toBe(false);
	});

	// Every whitespace character the row cannot draw as one space in place: a vertical tab or form
	// feed moves the terminal's cursor, and a line or paragraph separator breaks the row.
	const OTHER_WHITESPACE = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).filter(
		char => /\s/.test(char) && char !== " " && char !== "\t",
	);

	it("turns every other whitespace character into one space in a tabular list", () => {
		expect(OTHER_WHITESPACE).toContain("\v");
		for (const char of OTHER_WHITESPACE) {
			const description = `first${char}second${char}${char}third`;
			const row = rowOf(
				new SelectList([{ value: "a", label: "alpha", description }], 5, theme, {
					tabularDescription: true,
				}).render(WIDTH),
				"alpha",
			);
			expect({ code: char.charCodeAt(0), row }).toEqual({
				code: char.charCodeAt(0),
				row: expect.stringContaining("first second third"),
			});
		}
	});
});
