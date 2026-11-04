/**
 * WHY: `Loader.start()` armed a fresh interval without clearing the one the constructor had already armed, so a
 * loader started again kept two timers and `stop()` cleared only the newer one; the orphan repainted the loader
 * for the life of the process. The class closed here: however many times a loader is started, it holds one
 * timer, and one `stop()` leaves none.
 *
 * Not caught: a timer armed by a subclass outside `start()`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { TUI } from "@veyyon/tui";
import { Loader } from "@veyyon/tui/components/loader";

afterEach(() => {
	vi.useRealTimers();
});

function openLoader(): { loader: Loader; writes: () => number } {
	let writes = 0;
	const ui = {
		requestDirectWrite: () => {
			writes++;
		},
		requestComponentRender: () => {},
	};
	const loader = new Loader(
		ui as unknown as TUI,
		text => text,
		text => text,
		"Working",
		["0", "1", "2", "3"],
	);
	return { loader, writes: () => writes };
}

describe("a loader started again", () => {
	it("holds one timer however many times it is started", () => {
		vi.useFakeTimers();
		const { loader } = openLoader();
		loader.start();
		loader.start();

		expect(vi.getTimerCount()).toBe(1);
		loader.stop();
	});

	it("leaves no timer after one stop", () => {
		vi.useFakeTimers();
		const { loader, writes } = openLoader();
		loader.start();
		loader.stop();
		const before = writes();
		vi.advanceTimersByTime(5_000);

		expect(vi.getTimerCount()).toBe(0);
		expect(writes()).toBe(before);
	});

	it("animates again when started after a stop", () => {
		vi.useFakeTimers();
		const { loader } = openLoader();
		loader.stop();
		loader.start();
		vi.advanceTimersByTime(5_000);

		expect(vi.getTimerCount()).toBe(1);
		expect(loader.render(20).join("\n")).not.toContain("0 Working");
		loader.stop();
	});
});
