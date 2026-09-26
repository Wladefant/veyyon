import "./warm-natives"; // load the native addon under the real platform before any process.platform mock
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@veyyon/tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/4863, reported on WSL.
//
// On a ConPTY host (native Windows, or Linux whose stdout crosses wslhost) a full paint over a
// large transcript is bounded by `#truncateLargeConptyFrame`: rows above the retained tail collapse
// into an "older lines hidden" marker. That bound is wanted for the INITIAL session resume, where a
// multi-megabyte synchronized frame stalls conhost (issue #2115, pinned by the sibling suite). It
// must not reach a user-driven replay: Ctrl+O (`app.tools.expand`) calls `resetDisplay()` to review
// the whole session, and a bounded replay there drops every row the operator expanded to read.
//
// WHAT IT DOES NOT CATCH. Whether the bound is right for some third kind of paint this file never
// reaches; the gate is asserted at its two ends, first paint and user-driven paint.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");
const originalWslDistroName = process.env.WSL_DISTRO_NAME;

/** ~880 KiB of committed rows at 110 bytes each: past the 512 KiB truncate threshold. */
class LargeContent implements Component {
	#lines: string[];

	constructor(lineCount: number) {
		this.#lines = [];
		for (let i = 0; i < lineCount; i++) {
			this.#lines.push(`row ${i.toString().padStart(5, "0")}: ${"x".repeat(100)}`);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

/** A terminal that records every paint instead of only keeping the last screen. */
function recordingTerminal(): { term: VirtualTerminal; paints: string[] } {
	const term = new VirtualTerminal(80, 24, 20_000);
	const paints: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		paints.push(data);
		realWrite(data);
	});
	return { term, paints };
}

describe("issue #4863: a user-driven full paint must not truncate the session on ConPTY", () => {
	afterEach(() => {
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		if (originalWslDistroName === undefined) delete process.env.WSL_DISTRO_NAME;
		else process.env.WSL_DISTRO_NAME = originalWslDistroName;
		vi.restoreAllMocks();
	});

	it("bounds the initial resume replay and never the expand that follows it", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const { term, paints } = recordingTerminal();
		const tui = new TUI(term);
		tui.addChild(new LargeContent(8000));

		try {
			tui.start({ clearScrollback: true });
			await term.waitForRender();

			// The resume replay stays bounded: that is issue #2115, and the fix must not unbind it.
			const resumePaint = paints.join("");
			expect(resumePaint).toContain("older lines hidden");
			expect(Buffer.byteLength(resumePaint, "utf8")).toBeLessThan(128 * 1024);

			// The operator presses Ctrl+O; the host replays the transcript at its expanded heights.
			paints.length = 0;
			tui.resetDisplay();
			await term.waitForRender();

			const expandedPaint = paints.join("");
			expect(expandedPaint).not.toContain("older lines hidden");
			expect(expandedPaint).toContain("row 00000");
			// The first committed row is back in native scrollback, not merely absent from the frame.
			expect(term.getScrollBuffer().some(line => line.includes("row 00000"))).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("keeps the whole transcript on an expand under WSL, the reporter's host", async () => {
		// Reporter's environment: `isConPTYHosted()` is true on linux when a WSL marker is set,
		// because stdout still crosses into ConPTY at the wslhost boundary.
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		const { term, paints } = recordingTerminal();
		const tui = new TUI(term);
		tui.addChild(new LargeContent(8000));

		try {
			tui.start();
			await term.waitForRender();

			paints.length = 0;
			tui.resetDisplay();
			await term.waitForRender();

			const expandedPaint = paints.join("");
			expect(expandedPaint).not.toContain("older lines hidden");
			expect(expandedPaint).toContain("row 00000");
			// The reporter's session was long enough that the dropped rows were the ones they expanded to read.
			expect(term.getScrollBuffer().some(line => line.includes("row 00000"))).toBe(true);
		} finally {
			tui.stop();
		}
	});
});
