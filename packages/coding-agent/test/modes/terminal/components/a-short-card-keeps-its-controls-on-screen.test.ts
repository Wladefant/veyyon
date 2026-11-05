/**
 * A card on a short terminal gives up its padding and its tip before the rows a person acts on.
 *
 * The ask dialog kept two rows of padding above and below its body on a 10-row terminal and sized
 * its option list to a five-row floor the card could not hold, so the card showed the question and
 * dropped every option under it. The plan review dropped its options the same way on a 12-row
 * terminal, and the MCP wizard its input row on an 11-row one. Each card now asks its plan for the
 * body rows it needs (`minBodyRows`) and fits its body to the rows the plan shows. The list cards
 * ask for their list the same way, so a short card spends its reserved footer row on one more row
 * of the list, with the cursor's row among those shown.
 *
 * Covered: the three cards whose controls were cut, at the heights they were cut, each list card at
 * a size where its request changes the rows it shows, and the copy card on a terminal too short for
 * a line under its preview heading, which gives the preview's rows to the list. Not covered: a
 * card's own floor at other heights, which `an-overlay-card-shows-every-body-row-it-builds` sweeps
 * as "no body row is dropped" without naming which rows a person needs.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "../../../../src/config/settings";
import { initTheme } from "../../../../src/theme/theme";
import { OVERLAY_SPECS } from "../../../helpers/overlay-specs";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
	await Settings.init({ inMemory: true });
});

/** The text of every row of one frame of the card `name` on a `width`x`rows` terminal. */
async function frameOf(name: string, width: number, rows: number): Promise<string> {
	const spec = OVERLAY_SPECS.find(candidate => candidate.name === name);
	if (!spec) throw new Error(`no overlay spec named ${name}`);
	const geometry = stubStdoutGeometry({ rows, columns: width });
	const card = await spec.create(rows);
	try {
		return card
			.render(width)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
	} finally {
		card.dispose?.();
		geometry.restore();
	}
}

describe("a short card keeps its controls on screen", () => {
	it("shows the ask dialog's question and every option on a 10-row terminal", async () => {
		const frame = await frameOf("AskDialogComponent", 80, 10);
		for (const text of ["Proceed?", "□ Yes", "□ No", "□ Other (type your own)"]) expect(frame).toContain(text);
	});

	it("shows the plan review's prompt and every option on a 12-row terminal", async () => {
		const frame = await frameOf("PlanReviewOverlay", 80, 12);
		for (const text of [
			"Plan mode - next step",
			"› Approve and execute",
			"Approve and compact context",
			"Approve and keep context",
			"Refine plan",
		]) {
			expect(frame).toContain(text);
		}
	});

	it("shows the MCP wizard's prompt and input row on an 11-row terminal", async () => {
		const frame = await frameOf("MCPAddWizard", 40, 11);
		expect(frame).toContain("Enter a unique name for this server:");
		expect(frame).toMatch(/│ > {2,}│/);
	});

	it("gives the copy card's rows to its list on a terminal with no row under the preview heading", async () => {
		const frame = await frameOf("CopySelectorComponent", 60, 7);
		expect(frame.match(/Item \d+/g)).toEqual(["Item 0", "Item 1", "Item 2"]);
		expect(frame).not.toContain("Preview");
	});

	/**
	 * Each list card, a size at which shedding its spare chrome gains it a list row, the pattern of
	 * its list rows, the rows of it the card shows there, and the text of the row under its cursor.
	 */
	const SHORT_LISTS = [
		{ card: "TreeSelectorComponent", width: 160, rows: 10, row: /turn \d+/, shown: 3, cursor: "turn 79" },
		{ card: "ModalSelectListComponent", width: 160, rows: 10, row: /Item \d+/, shown: 6, cursor: "Item 0" },
		{ card: "CopySelectorComponent", width: 80, rows: 9, row: /Item \d+|Preview \d+/, shown: 3, cursor: "Item 0" },
		{ card: "UserMessageSelectorComponent", width: 160, rows: 8, row: /Message \d+/, shown: 2, cursor: "Message 79" },
		{ card: "HistorySearchComponent", width: 100, rows: 10, row: /Prompt \d+/, shown: 4, cursor: "Prompt 0" },
		{ card: "ResetUsageSelectorComponent", width: 100, rows: 10, row: /Account \d+/, shown: 6, cursor: "Account 0" },
		{
			card: "SessionSelectorComponent",
			width: 160,
			rows: 8,
			row: /Session \d+|First message \d+/,
			shown: 2,
			cursor: "Session 0",
		},
	] as const;

	for (const { card, width, rows, row, shown, cursor } of SHORT_LISTS) {
		it(`shows ${shown} list rows of ${card} on a ${width}x${rows} terminal, the cursor's among them`, async () => {
			const lines = (await frameOf(card, width, rows)).split("\n");
			expect(lines.filter(line => row.test(line)).length).toBe(shown);
			expect(lines.some(line => line.includes(cursor))).toBe(true);
		});
	}
});
