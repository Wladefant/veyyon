/**
 * WHY THIS SUITE EXISTS.
 *
 * A card's body is painted against the plan `planModalChrome` makes for it, and `renderModalShell`
 * drops every body row past `plan.maxBodyRows` with no error and no marker. Two cards built bodies
 * longer than their plan on ordinary terminals. The settings card listed every category tab in its
 * sidebar, so on an 80x24 or a 100x30 terminal the last tab (Plugins) was cut off the card and could
 * be selected but never seen. The plan review sized its region against `minModalChromeRows`, the
 * chrome's floor, so on a narrow terminal whose footer chips wrap past `footerLines` the region rule
 * and the option rows fell off the bottom of the card.
 *
 * THE CLASS.
 * Every overlay card in `OVERLAY_SPECS` that paints through `renderModalShell`, at every terminal
 * from 20 rows up and at widths from 30 to 240 columns, hands the shell no more body rows than the
 * plan it paints with shows. `renderModalShell` is observed through its module export, so a card
 * added to `OVERLAY_SPECS` is swept without an edit here, and a card that stops painting through the
 * shell turns the exemption list red.
 *
 * WHAT IT DOES NOT CATCH.
 * Terminals under 20 rows, where several cards keep a floor of body rows taller than the card (the
 * model picker keeps one down to 18 rows, the ask dialog and the plan review to 14). A card the
 * host mounts without an entry in `OVERLAY_SPECS`. A body row that is present but blank.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "../../../../src/config/settings";
import * as modalShell from "../../../../src/modes/terminal/components/chrome/modal-shell";
import { initTheme } from "../../../../src/theme/theme";
import { OVERLAY_SPECS, type OverlayCard } from "../../../helpers/overlay-specs";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";

/** Cards that do not paint through `renderModalShell`: the advisor form draws its own frame, and the OAuth list is embedded by its host. */
const NOT_SHELL_PAINTED = ["AdvisorConfigOverlayComponent", "OAuthSelectorComponent"];
const HEIGHTS = [20, 21, 22, 23, 24, 30, 40, 60];
const WIDTHS = [30, 40, 60, 80, 100, 160, 240];

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
	it("hands the shell no more body rows than its plan shows, for every card, height and width", async () => {
		const unconstructable: string[] = [];
		const dropped: string[] = [];
		const painted = new Set<string>();
		for (const spec of OVERLAY_SPECS) {
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
					for (const call of frameCalls) {
						if (call.bodyRows > call.maxBodyRows) {
							dropped.push(
								`${spec.name} at ${width}x${rows}: ${call.bodyRows} body rows, ${call.maxBodyRows} shown`,
							);
						}
					}
				}
			}
		}
		expect(unconstructable).toEqual([]);
		expect(dropped).toEqual([]);
		expect(OVERLAY_SPECS.map(spec => spec.name).filter(name => !painted.has(name))).toEqual(NOT_SHELL_PAINTED);
	});
});
