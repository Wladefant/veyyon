/**
 * WHY: the `/tree` and `/branch` pickers each armed an untracked 100 ms timer in
 * their constructor when handed an empty list, calling `onCancel` behind the
 * card's back. The card meanwhile drew its empty state ("No entries found"),
 * `dispose()` could not reach the timer, and an Escape inside the window
 * cancelled a second time. The class closed here: a picker constructed over
 * nothing schedules nothing and reports cancellation only when dismissed, once
 * per dismissal, for every picker that accepts an empty list. Navigation keys
 * on the empty list select nothing and keep the empty state drawn.
 *
 * Not caught: a timer armed later than construction (on first render or on
 * pointer motion) is covered by the pointer-band suites, not this one.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { TreeSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/tree-selector";
import { UserMessageSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/user-message-selector";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

interface EmptyPicker {
	name: string;
	emptyText: string;
	open(
		onSelect: (id: string) => void,
		onCancel: () => void,
	): { render(width: number): string[]; handleInput(data: string): void };
}

const PICKERS: EmptyPicker[] = [
	{
		name: "the session tree picker",
		emptyText: "No entries found",
		open: (onSelect, onCancel) => new TreeSelectorComponent([], null, onSelect, onCancel),
	},
	{
		name: "the branch picker",
		emptyText: "No user messages found",
		open: (onSelect, onCancel) => new UserMessageSelectorComponent([], onSelect, onCancel),
	},
];

function text(picker: { render(width: number): string[] }): string {
	return Bun.stripANSI(picker.render(100).join("\n"));
}

describe.each(PICKERS.map(picker => [picker.name, picker] as const))("%s over an empty list", (_name, spec) => {
	it("schedules no timer and stays open showing its empty state", () => {
		let cancelled = 0;
		const picker = spec.open(
			() => {},
			() => cancelled++,
		);

		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10_000);
		expect(cancelled).toBe(0);
		expect(text(picker)).toContain(spec.emptyText);
	});

	it("cancels once when dismissed with Escape", () => {
		let cancelled = 0;
		const picker = spec.open(
			() => {},
			() => cancelled++,
		);

		picker.handleInput("\x1b");
		vi.advanceTimersByTime(10_000);

		expect(cancelled).toBe(1);
	});

	it("selects nothing when navigated and confirmed", () => {
		const selected: string[] = [];
		const picker = spec.open(
			id => selected.push(id),
			() => {},
		);

		for (const key of ["\x1b[A", "\x1b[B", "\x1b[B", "\r", "\n"]) picker.handleInput(key);

		expect(selected).toEqual([]);
		expect(text(picker)).toContain(spec.emptyText);
	});
});
