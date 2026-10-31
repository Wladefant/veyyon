/**
 * WHY THIS SUITE EXISTS.
 *
 * A card's body is painted against the plan `planModalChrome` makes for it, and `renderModalShell`
 * drops every body row past `plan.maxBodyRows` with no error and no marker. Cards built bodies
 * longer than their plan. The settings card listed every category tab in its sidebar, so on an
 * 80x24 or a 100x30 terminal the last tab (Plugins) was cut off the card and could be selected but
 * never seen. The plan review sized its region against the chrome's floor rather than its plan, so
 * on a narrow terminal whose footer chips wrap past `footerLines` the option rows fell off the
 * bottom of the card. On short terminals the ask dialog, the plan review, the model picker, the
 * tree, the transcript viewer and the MCP wizard kept a floor of body rows taller than the card
 * while it still spent rows on padding and a tip: the ask dialog on a 10-row terminal showed its
 * question and none of its options. The list cards sized their lists by a fixed count of rows: the
 * branch picker by ten messages of three rows each, the select-list cards by twelve items, the
 * history and reset pickers by ten rows, and the resume picker by the terminal's height less a
 * fixed guess at its chrome, so a long list ran past the card's bottom border on any terminal
 * shorter than that count, and the resume picker dropped sessions at every height.
 *
 * THE CLASS.
 * Every overlay card in `OVERLAY_SPECS` that paints through `renderModalShell`, at widths from 30
 * to 240 columns, hands the shell no more body rows than the plan it paints with shows, from 14
 * rows up for every card and from a pinned lower height for each card that holds lower. The table
 * is compared by equality, so a card that starts dropping rows at a height it held turns the suite
 * red, and so does a card that newly holds lower until the table records it. Every list fixture in
 * `OVERLAY_SPECS` holds more entries than the tallest swept terminal has rows, so a card that sizes
 * its list by its own content rather than by its plan drops rows here. `renderModalShell` is
 * observed through its module export, so a card added to `OVERLAY_SPECS` is swept without an edit
 * here, and a card that stops painting through the shell turns the exemption list red.
 *
 * WHAT IT DOES NOT CATCH.
 * Terminals under 8 rows. The heights in the table below 14 are where a card's fixed rows outgrow
 * it once its decoration is gone (the MCP wizard, the model picker and the plan review at 30
 * columns, the agent dashboard's empty-state text). A card the host mounts without an entry in
 * `OVERLAY_SPECS`. A body row that is present but blank. The empty state of a list card, since its
 * fixture is a long list.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "../../../../src/config/settings";
import * as modalShell from "../../../../src/modes/terminal/components/chrome/modal-shell";
import { initTheme } from "../../../../src/theme/theme";
import { OVERLAY_SPECS, type OverlayCard } from "../../../helpers/overlay-specs";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";

/** Cards that do not paint through `renderModalShell`: the advisor form draws its own frame, and the OAuth list is embedded by its host. */
const NOT_SHELL_PAINTED = ["AdvisorConfigOverlayComponent", "OAuthSelectorComponent"];
const HEIGHTS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 30, 40, 60];
const WIDTHS = [30, 40, 60, 80, 100, 160, 240];

/**
 * The lowest swept terminal height from which each card shows every body row it builds, at every
 * width. A card that holds from the first swept height is not listed. Raising a card's height here
 * is a regression; lowering one is a fix that updates this table.
 */
const SHORTEST_HELD_HEIGHT: Readonly<Record<string, number>> = {
	AccountManagerComponent: 9,
	AgentDashboard: 12,
	AgentTranscriptViewer: 9,
	MCPAddWizard: 14,
	ModelPickerComponent: 14,
	MoveOverlay: 9,
	PlanReviewOverlay: 13,
	SessionSelectorComponent: 12,
	TreeSelectorComponent: 11,
	UserMessageSelectorComponent: 10,
};

interface ShellCall {
	bodyRows: number;
	maxBodyRows: number;
}

const paint = modalShell.renderModalShell;
const calls: ShellCall[] = [];
const shellSpy = spyOn(modalShell, "renderModalShell").mockImplementation((plan, content) => {
	calls.push({ bodyRows: content.body.length, maxBodyRows: plan.maxBodyRows });
	return paint(plan, content);
});

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	shellSpy.mockRestore();
});

/** The shell calls one frame of `spec` makes on a `width`x`rows` terminal. */
async function shellCallsAt(name: string, width: number, rows: number): Promise<ShellCall[]> {
	const spec = OVERLAY_SPECS.find(candidate => candidate.name === name);
	if (!spec) throw new Error(`no overlay spec named ${name}`);
	const geometry = stubStdoutGeometry({ rows, columns: width });
	let card: OverlayCard | undefined;
	calls.length = 0;
	try {
		card = await spec.create(rows);
		card.render(width);
		return [...calls];
	} finally {
		card?.dispose?.();
		geometry.restore();
	}
}

describe("an overlay card shows every body row it builds", () => {
	it("hands the shell no more body rows than its plan shows, from each card's pinned height up", async () => {
		const unconstructable: string[] = [];
		const painted = new Set<string>();
		const shortestHeld: Record<string, number> = {};
		for (const spec of OVERLAY_SPECS) {
			let highestDropped: number | undefined;
			for (const rows of HEIGHTS) {
				for (const width of WIDTHS) {
					let frameCalls: ShellCall[];
					try {
						frameCalls = await shellCallsAt(spec.name, width, rows);
					} catch (err) {
						unconstructable.push(`${spec.name} at ${width}x${rows}: ${err}`);
						continue;
					}
					if (frameCalls.length > 0) painted.add(spec.name);
					if (frameCalls.some(call => call.bodyRows > call.maxBodyRows)) highestDropped = rows;
				}
			}
			if (highestDropped !== undefined) {
				shortestHeld[spec.name] = HEIGHTS[HEIGHTS.indexOf(highestDropped) + 1] ?? Number.POSITIVE_INFINITY;
			}
		}
		expect(unconstructable).toEqual([]);
		expect(shortestHeld).toEqual(SHORTEST_HELD_HEIGHT);
		expect(OVERLAY_SPECS.map(spec => spec.name).filter(name => !painted.has(name))).toEqual(NOT_SHELL_PAINTED);
	});
});
