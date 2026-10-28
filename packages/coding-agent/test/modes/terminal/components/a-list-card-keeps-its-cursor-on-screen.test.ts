/**
 * WHY THIS SUITE EXISTS.
 *
 * The hook selector windowed its options to twelve rows around the cursor, then the card clipped
 * that window to the rows it had, from the bottom. On a terminal eight to ten rows tall, with the
 * cursor forty options down, the clip took the cursor's own row: the card showed options, and the
 * one Enter would pick was not among them.
 *
 * THE CLASS.
 * Every list card in `CURSOR_MOVES`, with its cursor moved forty rows into a list of eighty, shows
 * the cursor's row at every swept terminal size. A card that windows its list by a fixed count and
 * lets the card clip the window fails here once the clip reaches the cursor. Every overlay spec
 * whose frame moves under the arrow keys is either swept here or listed in `NOT_SWEPT` with its
 * reason, so a new list card fails until someone records which it is.
 *
 * WHAT IT DOES NOT CATCH.
 * How many list rows a short card shows: a card can keep its cursor and still drop rows it had room
 * for. The copy card is one; its clip takes the preview pane under the tree. Row counts are pinned
 * by `a-short-card-keeps-its-controls-on-screen`. A list card whose fixture is too short to scroll.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "../../../../src/config/settings";
import { initTheme } from "../../../../src/theme/theme";
import { OVERLAY_SPECS } from "../../../helpers/overlay-specs";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const HEIGHTS = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 30];
const WIDTHS = [60, 80, 160];

/** Each list card, the key that moves its cursor forty rows from where it opens, and the row it lands on. */
const CURSOR_MOVES: readonly { card: string; key: string; cursor: RegExp }[] = [
	{ card: "AdvisorConfigOverlayComponent", key: DOWN, cursor: /\bAdvisor 41\b/ },
	{ card: "CopySelectorComponent", key: DOWN, cursor: /\bItem 40\b/ },
	{ card: "HistorySearchComponent", key: DOWN, cursor: /\bPrompt 40\b/ },
	{ card: "HookSelectorComponent", key: DOWN, cursor: /\bHook 40\b/ },
	{ card: "ModalSelectListComponent", key: DOWN, cursor: /\bItem 40\b/ },
	{ card: "ResetUsageSelectorComponent", key: DOWN, cursor: /\bAccount 40\b/ },
	{ card: "RollbackPickerComponent", key: DOWN, cursor: /\b1\.0\.40\b/ },
	{ card: "SessionSelectorComponent", key: DOWN, cursor: /\bSession 40\b/ },
	{ card: "SubcommandPickerComponent", key: DOWN, cursor: /\bsub40\b/ },
	{ card: "TreeSelectorComponent", key: UP, cursor: /\bturn 39\b/ },
	{ card: "ThemeSelectorComponent", key: DOWN, cursor: /\btheme-37\b/ },
	{ card: "UserMessageSelectorComponent", key: UP, cursor: /\bMessage 39\b/ },
];

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
	await Settings.init({ inMemory: true });
});

/** Cards whose frame moves under the arrow keys and that `CURSOR_MOVES` leaves out, with the reason. */
const NOT_SWEPT = [
	// Three options, each shown at the height `a-short-card-keeps-its-controls-on-screen` pins.
	"AskDialogComponent",
	// Its list is the workspace's extensions, so no fixture label marks the cursor's row.
	"ExtensionDashboard",
	// The arrows move a text caret, not a list cursor.
	"HookEditorComponent",
	// An embedded list: the host that embeds it sizes it, not a card plan.
	"OAuthSelectorComponent",
	// Four options, each shown at the height `a-short-card-keeps-its-controls-on-screen` pins.
	"PlanReviewOverlay",
	// Its rows are the settings registry, not a fixture, so no fixture label marks the cursor's row.
	"SettingsSelectorComponent",
];

/** The frames of the card `name` on a `width`x`rows` terminal before and after forty presses of `key`. */
async function framesAroundMove(
	name: string,
	key: string,
	width: number,
	rows: number,
): Promise<{ before: string; after: string }> {
	const spec = OVERLAY_SPECS.find(candidate => candidate.name === name);
	if (!spec) throw new Error(`no overlay spec named ${name}`);
	const geometry = stubStdoutGeometry({ rows, columns: width });
	const component = await spec.create(rows);
	const frame = () =>
		component
			.render(width)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
	try {
		const before = frame();
		if (!("handleInput" in component) || typeof component.handleInput !== "function")
			return { before, after: before };
		for (let step = 0; step < 40; step++) component.handleInput(key);
		return { before, after: frame() };
	} finally {
		component.dispose?.();
		geometry.restore();
	}
}

describe("a list card keeps its cursor on screen", () => {
	for (const { card, key, cursor } of CURSOR_MOVES) {
		it(`shows the row under ${card}'s cursor at every swept size`, async () => {
			const hidden: string[] = [];
			for (const rows of HEIGHTS) {
				for (const width of WIDTHS) {
					const { after } = await framesAroundMove(card, key, width, rows);
					if (!cursor.test(after)) hidden.push(`${width}x${rows}`);
				}
			}
			expect(hidden).toEqual([]);
		});
	}

	it("sweeps every card whose frame moves under the arrow keys, or lists why not", async () => {
		const moving: string[] = [];
		for (const spec of OVERLAY_SPECS) {
			for (const key of [DOWN, UP]) {
				const { before, after } = await framesAroundMove(spec.name, key, 80, 30);
				if (before !== after) {
					moving.push(spec.name);
					break;
				}
			}
		}
		const swept = new Set(CURSOR_MOVES.map(move => move.card));
		expect(moving.filter(name => !swept.has(name))).toEqual(NOT_SWEPT);
		expect([...swept].filter(name => !moving.includes(name))).toEqual([]);
	});
});
