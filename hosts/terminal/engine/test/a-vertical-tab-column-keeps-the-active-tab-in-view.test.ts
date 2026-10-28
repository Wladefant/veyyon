/**
 * A vertical tab column given fewer rows than it has tabs.
 *
 * The settings card drew its category sidebar with one row per tab, whatever the card had room
 * for, and the shell drops a body row past the card's height. On an 80x24 terminal the last
 * category was cut off: it could be selected from the keyboard and was never on screen.
 * `renderVertical(width, cursor, maxRows)` shows a window of at most `maxRows` tabs that follows
 * the active tab, and `tabAt` answers rows of that window.
 *
 * Covered: every row budget against every active tab, the window moving only as far as the active
 * tab needs in both directions, hit-testing inside a scrolled window, and row budgets a bad layout
 * can produce. Not covered: a host that renders the column and then clips it itself.
 */
import { describe, expect, it } from "bun:test";
import { type Tab, TabBar, type TabBarTheme } from "@veyyon/tui/components/tab-bar";

const PLAIN_THEME: TabBarTheme = {
	label: t => t,
	activeTab: t => t,
	inactiveTab: t => t,
	hint: t => t,
};

const TABS: Tab[] = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, label: `Tab ${i}` }));
const WIDTH = 12;
const CURSOR = "> ";

/** The labels of the rows a column shows, in order. */
function labels(rows: readonly string[]): string[] {
	return rows.map(row => row.slice(CURSOR.length).trimEnd());
}

/** Render the column with `active` selected; the bar keeps its scroll across calls. */
function column(bar: TabBar, active: number, maxRows?: number): readonly string[] {
	bar.setActiveIndex(active);
	return bar.renderVertical(WIDTH, CURSOR, maxRows);
}

describe("a vertical tab column keeps the active tab in view", () => {
	it("shows at most maxRows tabs and always the active one, for every budget and every active tab", () => {
		for (let maxRows = 1; maxRows <= TABS.length + 1; maxRows++) {
			const bar = new TabBar("", TABS, PLAIN_THEME);
			for (const order of [TABS.keys(), [...TABS.keys()].reverse()]) {
				for (const active of order) {
					const rows = column(bar, active, maxRows);
					expect(rows.length).toBe(Math.min(maxRows, TABS.length));
					expect(rows.filter(row => row.startsWith(CURSOR))).toEqual([`${CURSOR}Tab ${active}`.padEnd(WIDTH)]);
				}
			}
		}
	});

	it("moves the window only as far as the active tab needs", () => {
		const bar = new TabBar("", TABS, PLAIN_THEME);
		const firstShown = (active: number) => labels(column(bar, active, 4))[0];
		expect([0, 1, 2, 3, 4, 5, 9].map(firstShown)).toEqual([
			"Tab 0",
			"Tab 0",
			"Tab 0",
			"Tab 0",
			"Tab 1",
			"Tab 2",
			"Tab 6",
		]);
		// Walking back up, the window holds until the active tab passes its top row.
		expect([8, 7, 6, 5, 0].map(firstShown)).toEqual(["Tab 6", "Tab 6", "Tab 6", "Tab 5", "Tab 0"]);
	});

	it("hit-tests the rows of the window it shows", () => {
		const bar = new TabBar("", TABS, PLAIN_THEME);
		const rows = column(bar, 7, 3);
		expect(labels(rows)).toEqual(["Tab 5", "Tab 6", "Tab 7"]);
		expect(rows.map((_, row) => bar.tabAt(row, 0)?.id)).toEqual(["t5", "t6", "t7"]);
		expect(bar.tabAt(3, 0)).toBeUndefined();
	});

	it("fills a grown budget with the tabs above a scrolled window", () => {
		const bar = new TabBar("", TABS, PLAIN_THEME);
		expect(labels(column(bar, 9, 3))).toEqual(["Tab 7", "Tab 8", "Tab 9"]);
		expect(labels(column(bar, 9, 6))).toEqual(["Tab 4", "Tab 5", "Tab 6", "Tab 7", "Tab 8", "Tab 9"]);
	});

	it("shows every tab when no budget is given or the budget is unbounded", () => {
		const bar = new TabBar("", TABS, PLAIN_THEME);
		expect(labels(column(bar, 9))).toEqual(TABS.map(tab => tab.label));
		expect(labels(column(bar, 9, Number.POSITIVE_INFINITY))).toEqual(TABS.map(tab => tab.label));
	});

	it("shows the active tab alone for a budget under one row", () => {
		for (const maxRows of [0, -1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
			const bar = new TabBar("", TABS, PLAIN_THEME);
			expect(labels(column(bar, 6, maxRows))).toEqual(["Tab 6"]);
		}
	});
});
