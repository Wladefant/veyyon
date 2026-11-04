/**
 * An extension widget set through `ctx.ui.setWidget` is drawn above the editor unless it asks for below, a key set
 * again replaces its widget, and clearing (or setting `undefined`) disposes what it removes.
 *
 * WHY THIS SUITE EXISTS. The widget table had no test: placement, the line cap, the blank-line spacer, replacement
 * by key, disposal and the empty-container spacer could each regress with the suite green. A widget that is replaced
 * without being disposed keeps its timers and listeners running for the rest of the session.
 *
 * Subject: `modes/terminal/controllers/hook-widgets.ts`, driven through `ExtensionUiController.setHookWidget` and
 * `ExtensionUiController.clearHookWidgets`.
 *
 * NOT CAUGHT. Where the interactive mode mounts the two containers relative to the editor, and how a factory widget
 * renders itself.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/terminal/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { type Component, Container, Spacer, Text } from "@veyyon/tui";

const WIDTH = 40;

interface Harness {
	controller: ExtensionUiController;
	above: Container;
	below: Container;
	renders: () => number;
}

function harness(): Harness {
	const above = new Container();
	const below = new Container();
	let renders = 0;
	const ctx = {
		ui: { requestRender: () => renders++ },
		hookWidgetContainerAbove: above,
		hookWidgetContainerBelow: below,
	} as unknown as InteractiveModeContext;
	return { controller: new ExtensionUiController(ctx), above, below, renders: () => renders };
}

function rows(container: Container): string[] {
	return container.render(WIDTH).map(row => Bun.stripANSI(row).trimEnd());
}

/** A factory widget that records whether it was disposed. */
function disposable(label: string): { factory: () => Component; disposed: () => boolean } {
	let disposed = false;
	const component: Component = {
		render: () => [label],
		invalidate: () => {},
		dispose: () => {
			disposed = true;
		},
	};
	return { factory: () => component, disposed: () => disposed };
}

beforeAll(async () => {
	await initTheme(false);
});

describe("an extension widget is drawn where it was placed", () => {
	it("draws a line widget above the editor after a spacer, and nothing below", () => {
		const { controller, above, below, renders } = harness();
		controller.setHookWidget("status", ["first", "second"]);

		expect(rows(above)).toEqual(["", " first", " second"]);
		expect(rows(below)).toEqual([]);
		expect(renders()).toBe(1);
	});

	it("draws a belowEditor widget below the editor with no leading spacer, leaving one spacer above", () => {
		const { controller, above, below } = harness();
		controller.setHookWidget("footer", ["under"], { placement: "belowEditor" });

		expect(rows(below)).toEqual([" under"]);
		expect(rows(above)).toEqual([""]);
	});

	it("keeps a blank line as a row and caps a line widget at ten lines with a truncation note", () => {
		const { controller, above } = harness();
		const lines = Array.from({ length: 12 }, (_, index) => (index === 1 ? "   " : `line ${index}`));
		controller.setHookWidget("long", lines);

		expect(rows(above)).toEqual([
			"",
			" line 0",
			"",
			" line 2",
			" line 3",
			" line 4",
			" line 5",
			" line 6",
			" line 7",
			" line 8",
			" line 9",
			" ... (widget truncated)",
		]);
	});

	it("replaces the widget under a key, disposing the old one, even when the new one moves below", () => {
		const { controller, above, below } = harness();
		const first = disposable("one");
		controller.setHookWidget("panel", first.factory);
		expect(rows(above)).toEqual(["", "one"]);

		controller.setHookWidget("panel", ["two"], { placement: "belowEditor" });

		expect(first.disposed()).toBe(true);
		expect(rows(above)).toEqual([""]);
		expect(rows(below)).toEqual([" two"]);
	});

	it("removes and disposes a widget set to undefined, leaving the other keys", () => {
		const { controller, above } = harness();
		const removed = disposable("gone");
		controller.setHookWidget("a", removed.factory);
		controller.setHookWidget("b", ["kept"]);

		controller.setHookWidget("a", undefined);

		expect(removed.disposed()).toBe(true);
		expect(rows(above)).toEqual(["", " kept"]);
	});

	it("disposes every widget on clear and leaves only the spacer above the editor", () => {
		const { controller, above, below } = harness();
		const top = disposable("top");
		const bottom = disposable("bottom");
		controller.setHookWidget("top", top.factory);
		controller.setHookWidget("bottom", bottom.factory, { placement: "belowEditor" });

		controller.clearHookWidgets();

		expect([top.disposed(), bottom.disposed()]).toEqual([true, true]);
		expect(rows(above)).toEqual([""]);
		expect(rows(below)).toEqual([]);
		// The spacer is the container's only child, not a leftover widget that renders empty.
		expect(above.children).toEqual([expect.any(Spacer)]);
		expect(below.children.some(child => child instanceof Text)).toBe(false);
	});
});
