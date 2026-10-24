/**
 * WHY THIS SUITE EXISTS.
 *
 * The host mounts an overlay card with `maxHeight: "100%"`, and the overlay stack cuts a card
 * taller than the terminal down to the terminal (`clipOverlayRows` in the engine). A
 * bottom-anchored card loses its title row and close glyph; a top-anchored one loses its footer
 * chips and key hints. The model hub and the model picker floored their height at 16 rows; the ask
 * dialog, the plan review, the login dialog, the extension dashboard, the session picker and every
 * list card built on `ModalSelectListComponent` floored it at 14; the advisor configuration both
 * floored it at 14 and kept three body rows on any screen. A terminal shorter than the floor showed
 * a clipped card.
 *
 * THE CLASS.
 * Every overlay card, at every terminal height, renders at most as many rows as the terminal has.
 * The sweep covers every card in `OVERLAY_SPECS`, whose names `a-card-first-frame-is-settled`
 * pins by exact equality, at every height from one row to a tall window, with the host's terminal
 * and `process.stdout` both reporting that height.
 *
 * WHAT IT DOES NOT CATCH.
 * A card the host mounts without an entry in `OVERLAY_SPECS`: the autoresearch screen, the debug
 * log and SSE viewers, the setup wizard and the pause screen are mounted as overlays and are not
 * in the list. A card that fits the screen but drops its own footer from inside its frame: the body
 * budget is `planModalChrome`'s contract, defended in `modal-chrome-budget-has-one-owner.test.ts`.
 * Widths other than 100 columns.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "../../../../src/theme/theme";
import { OVERLAY_SPECS, type OverlayCard } from "../../../helpers/overlay-specs";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
});

const WIDTH = 100;
/** Every height up to a short split pane, then ordinary windows. */
const HEIGHTS = [...Array.from({ length: 24 }, (_, index) => index + 1), 30, 40, 60];
/**
 * Cards whose height is set by the host that embeds them rather than by the terminal. The setup
 * wizard's Sign-in tab sizes the provider list with `setMaxVisible`, and nothing mounts the
 * selector as an overlay.
 */
const HOST_SIZED = ["OAuthSelectorComponent"];

/** Build `name` for a terminal `rows` tall and return its first frame. */
async function frameAt(name: string, rows: number): Promise<readonly string[]> {
	const spec = OVERLAY_SPECS.find(candidate => candidate.name === name);
	if (!spec) throw new Error(`no overlay spec named ${name}`);
	const geometry = stubStdoutGeometry({ rows, columns: WIDTH });
	let card: OverlayCard | undefined;
	try {
		card = await spec.create(rows);
		return card.render(WIDTH);
	} finally {
		card?.dispose?.();
		geometry.restore();
	}
}

describe("an overlay card is never taller than the terminal", () => {
	it("renders at most as many rows as the terminal has, for every card and every height", async () => {
		const unconstructable: string[] = [];
		const overflows: string[] = [];
		for (const spec of OVERLAY_SPECS.filter(candidate => !HOST_SIZED.includes(candidate.name))) {
			for (const rows of HEIGHTS) {
				let frame: readonly string[];
				try {
					frame = await frameAt(spec.name, rows);
				} catch (err) {
					unconstructable.push(`${spec.name} at ${rows} rows: ${err}`);
					continue;
				}
				if (frame.length > rows) overflows.push(`${spec.name}: ${frame.length} rows on a ${rows}-row terminal`);
			}
		}
		expect(unconstructable).toEqual([]);
		expect(overflows).toEqual([]);
	});

	it("exempts only cards that are still in the overlay list", () => {
		expect(HOST_SIZED.filter(name => OVERLAY_SPECS.some(spec => spec.name === name))).toEqual(HOST_SIZED);
	});

	/**
	 * Fitting the screen by painting nothing would pass the sweep above. The cards that used to
	 * floor their height still draw their title or their close chip on a terminal below the old
	 * floor, in the rows the overlay keeps whichever end the host anchors the card to: the first
	 * `rows` for a top-anchored card, the last `rows` for a bottom-anchored one.
	 */
	it.each([
		["ModelHubComponent", "Models"],
		["ModelPickerComponent", "esc close"],
		["AskDialogComponent", "Proceed?"],
		["PlanReviewOverlay", "Plan"],
		["LoginDialogComponent", "GitHub"],
		["ThemeSelectorComponent", "esc"],
		["AdvisorConfigOverlayComponent", "Advisor configuration"],
	])("%s still paints %p on a 12-row terminal", async (name, text) => {
		const rows = 12;
		const frame = (await frameAt(name, rows)).map(line => stripVTControlCharacters(line));
		expect(frame.slice(0, rows).join("\n")).toContain(text);
		expect(frame.slice(-rows).join("\n")).toContain(text);
	});
});
