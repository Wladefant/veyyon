/**
 * WHY THIS SUITE EXISTS.
 *
 * Each list card computed its own step past the end of its list: a nested ternary per arrow key, a
 * modular `(index + delta + count) % count`, or a second copy of the ternary in its wheel handler.
 * The cards now share `wrapIndex`, and no suite pinned what a card does at an end: a step that
 * clamped where the card wrapped, or wrapped onto the wrong row, left every suite green.
 *
 * THE CLASS.
 * Every overlay card whose frame moves under the arrow keys declares in `AT_THE_END` what one press
 * of the arrow that steps past the end it opens on does: the cursor lands on the far end and the
 * opposite arrow brings it back, focus leaves the list, or nothing moves. A card missing from the
 * table and from `NOT_SWEPT` fails, so a new list card fails until someone records which it is.
 *
 * WHAT IT DOES NOT CATCH.
 * The mouse wheel, which several cards route through the same step. Page keys. A card that opens
 * mid-list. The cards in `NOT_SWEPT`.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../../src/config/settings";
import { initTheme } from "../../../../src/theme/theme";
import {
	cardsMovedByArrows,
	ARROW_DOWN as DOWN,
	framesAroundKeys,
	ARROW_UP as UP,
} from "../../../helpers/list-card-frames";

const WIDTH = 100;
const ROWS = 30;

type AtTheEnd =
	/** One press of `key` changes nothing. */
	| { card: string; key: string; stays: true }
	/** One press of `key` shows `lands`; the opposite arrow then shows `back`, the row the card opened on. */
	| { card: string; key: string; lands: RegExp; back: RegExp };

/** Each list card, the arrow that steps past the end it opens on, and what that press does. */
const AT_THE_END: readonly AtTheEnd[] = [
	// Up from the first advisor moves to the card's Close action.
	{ card: "AdvisorConfigOverlayComponent", key: UP, lands: /Close the editor/, back: /› Advisor 1\b/ },
	{ card: "AskDialogComponent", key: UP, stays: true },
	{ card: "CopySelectorComponent", key: UP, lands: /› Item 79\b/, back: /› Item 0\b/ },
	{ card: "ExtensionDashboard", key: UP, stays: true },
	{ card: "HistorySearchComponent", key: UP, stays: true },
	{ card: "HookSelectorComponent", key: UP, stays: true },
	{ card: "ModalSelectListComponent", key: UP, lands: /› Item 79\b/, back: /› Item 0\b/ },
	// Two sidebar sections under the fixture registry, opening on the second.
	{ card: "ModelHubComponent", key: DOWN, lands: /› \* Default & fallbacks\b/, back: /›\s+All models\b/ },
	{ card: "QueueModeSelectorComponent", key: UP, lands: /› one-at-a-time\b/, back: /› all\b/ },
	{
		card: "ResetUsageSelectorComponent",
		key: UP,
		lands: /› OpenAI Codex Account 79\b/,
		back: /› OpenAI Codex Account 0\b/,
	},
	{ card: "RollbackPickerComponent", key: UP, lands: /› 1\.0\.79\b/, back: /› 1\.0\.0\b/ },
	{ card: "SessionSelectorComponent", key: UP, stays: true },
	{ card: "ShowImagesSelectorComponent", key: UP, lands: /› No\b/, back: /› Yes\b/ },
	{ card: "SubcommandPickerComponent", key: UP, lands: /› sub79\b/, back: /› sub0\b/ },
	{ card: "ThemeSelectorComponent", key: UP, lands: /› theme-79\b/, back: /› dark\b/ },
	{ card: "TreeSelectorComponent", key: DOWN, lands: /› • user: turn 0\b/, back: /› • user: turn 79\b/ },
	{ card: "UserMessageSelectorComponent", key: DOWN, lands: /› Message 0\b/, back: /› Message 79\b/ },
];

/** Cards whose frame moves under the arrow keys and that `AT_THE_END` leaves out, with the reason. */
const NOT_SWEPT = [
	// The arrows move a text caret, not a list cursor.
	"HookEditorComponent",
	// Its rows are the provider registry, not a fixture, so no fixture label marks the far end.
	"OAuthSelectorComponent",
	// Up from its first action moves focus into the plan body, which marks no row.
	"PlanReviewOverlay",
	// Its rows are the settings registry, not a fixture, so no fixture label marks the far end.
	"SettingsSelectorComponent",
];

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
	await Settings.init({ inMemory: true });
});

describe("a list card steps past an end as declared", () => {
	for (const end of AT_THE_END) {
		if ("stays" in end) {
			it(`leaves ${end.card} unchanged when the arrow steps past the end it opens on`, async () => {
				const { before, after } = await framesAroundKeys(end.card, [end.key], WIDTH, ROWS);
				expect(after).toBe(before);
			});
			continue;
		}
		it(`steps ${end.card} past the end it opens on and back`, async () => {
			const opposite = end.key === UP ? DOWN : UP;
			const { before, after } = await framesAroundKeys(end.card, [end.key], WIDTH, ROWS);
			expect({ before: end.lands.test(before), after: end.lands.test(after) }).toEqual({
				before: false,
				after: true,
			});
			const { after: returned } = await framesAroundKeys(end.card, [end.key, opposite], WIDTH, ROWS);
			expect({ before: end.back.test(before), returned: end.back.test(returned) }).toEqual({
				before: true,
				returned: true,
			});
		});
	}

	it("declares every card whose frame moves under the arrow keys, or lists why not", async () => {
		const moving = await cardsMovedByArrows();
		const declared = new Set(AT_THE_END.map(end => end.card));
		expect(moving.filter(name => !declared.has(name))).toEqual(NOT_SWEPT);
		expect([...declared].filter(name => !moving.includes(name))).toEqual([]);
	});
});
