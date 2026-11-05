/**
 * WHY THIS SUITE EXISTS.
 *
 * A card whose height is still pinned to its floor sheds its padding, so a short terminal spends
 * its rows on the body rather than on blank space (`modalNeedsCompactPadding` in
 * `modal-geometry.ts`). The rule was reachable only through `sizingForArea`, which each card had to
 * call before `layoutModalCard`. The ask dialog and the plan review never called it: they laid
 * `MODAL_SIZING_LARGE` out as it is, and on a 30-row terminal each spent four rows and two columns
 * on padding every other large card had shed. `layoutModalCard` now applies the rule to whatever
 * sizing it is given; `modal-shell-height-is-monotonic.test.ts` defends that at the layout.
 *
 * THE CLASS.
 * Every card in `OVERLAY_SPECS`, at every swept height, paints a sizing the compact rule leaves
 * unchanged: `sizingForArea(card.sizing, card.areaHeight)` has the padding of `card.sizing`. The
 * layout each card really paints is read from `layoutModalCard`, through the card's own `render`.
 * The cards that lay out no card at all are pinned by exact equality, so a new card that bypasses
 * `layoutModalCard` turns the suite red until it is recorded here.
 *
 * WHAT IT DOES NOT CATCH.
 * A card the host mounts without an entry in `OVERLAY_SPECS` (the autoresearch screen, the debug
 * log and SSE viewers, the setup wizard, the pause screen). A card that sizes its frame by hand
 * after taking a compact layout. Widths other than 100 columns.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as modalGeometry from "../../../../src/modes/terminal/components/chrome/modal-geometry";
import { initTheme } from "../../../../src/theme/theme";
import { OVERLAY_SPECS, type OverlayCard } from "../../../helpers/overlay-specs";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
});

const WIDTH = 100;
/** Heights on both sides of every shipped sizing's compact boundary (SETTINGS 30, MEDIUM 32, LARGE 38). */
const HEIGHTS = [12, 20, 24, 28, 30, 31, 32, 33, 36, 38, 39, 44, 60];
/**
 * Cards that lay out no modal card: the advisor form draws its own frame, and the OAuth list is
 * embedded by its host. The theme, thinking, queue-mode, show-images and subcommand pickers are not
 * among them: they paint through `ModalSelectListComponent`, which does.
 */
const NO_MODAL_CARD = ["AdvisorConfigOverlayComponent", "OAuthSelectorComponent"];

/** Every card layout `name` paints on a terminal `rows` tall, in the order its render asked. */
async function layoutsAt(name: string, rows: number): Promise<modalGeometry.ModalCardLayout[]> {
	const spec = OVERLAY_SPECS.find(candidate => candidate.name === name);
	if (!spec) throw new Error(`no overlay spec named ${name}`);
	const layouts: modalGeometry.ModalCardLayout[] = [];
	const layout = modalGeometry.layoutModalCard;
	const spy = vi.spyOn(modalGeometry, "layoutModalCard").mockImplementation((...args) => {
		const card = layout(...args);
		if (card) layouts.push(card);
		return card;
	});
	const geometry = stubStdoutGeometry({ rows, columns: WIDTH });
	let card: OverlayCard | undefined;
	try {
		card = await spec.create(rows);
		card.render(WIDTH);
		return layouts;
	} finally {
		card?.dispose?.();
		geometry.restore();
		spy.mockRestore();
	}
}

describe("a card pinned to its floor sheds its padding", () => {
	it("paints a sizing the compact rule leaves unchanged, for every card and every height", async () => {
		const unconstructable: string[] = [];
		const padded: string[] = [];
		const painted = new Set<string>();
		for (const spec of OVERLAY_SPECS) {
			for (const rows of HEIGHTS) {
				let layouts: modalGeometry.ModalCardLayout[];
				try {
					layouts = await layoutsAt(spec.name, rows);
				} catch (err) {
					unconstructable.push(`${spec.name} at ${rows} rows: ${err}`);
					continue;
				}
				if (layouts.length > 0) painted.add(spec.name);
				for (const card of layouts) {
					const fitted = modalGeometry.sizingForArea(card.sizing, card.areaHeight);
					if (fitted.hPad !== card.sizing.hPad || fitted.vPad !== card.sizing.vPad) {
						padded.push(
							`${spec.name} at ${rows} rows: hPad ${card.sizing.hPad} vPad ${card.sizing.vPad}, the rule gives hPad ${fitted.hPad} vPad ${fitted.vPad}`,
						);
					}
				}
			}
		}
		expect(unconstructable).toEqual([]);
		expect(padded).toEqual([]);
		expect(OVERLAY_SPECS.map(spec => spec.name).filter(name => !painted.has(name))).toEqual(NO_MODAL_CARD);
	});
});
