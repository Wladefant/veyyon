/**
 * The theme baked colours as 24-bit SGR for every terminal it did not know to be limited, while the
 * terminal capability model (`getTerminalInfo(...).trueColor`, which markdown swatches and every
 * other encoder read) said otherwise. macOS Terminal.app sets no `COLORTERM`, cannot draw
 * `38;2;r;g;b`, and showed the theme as unreadable colours. The class is "two detectors answer the
 * colour-depth question differently"; this suite pins the theme to the capability model for the
 * env shapes that reach each branch. It does not cover terminals that lie about their depth.
 */
import { describe, expect, it } from "bun:test";
import { colorToAnsi, detectColorMode } from "@veyyon/coding-agent/theme/color";
import { getTerminalInfo } from "@veyyon/tui/terminal-capabilities";
import { detectTerminalId } from "@veyyon/utils/terminal-emulator";

describe("the theme colour depth follows the terminal capability model", () => {
	it("emits 256-colour SGR for macOS Terminal.app", () => {
		const mode = detectColorMode({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" });

		expect(mode).toBe("256color");
		expect(colorToAnsi("#f5e0ac", mode)).toBe("\x1b[38;5;223m");
	});

	it("agrees with the capability model for every env shape", () => {
		const envs: NodeJS.ProcessEnv[] = [
			{ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" },
			{ TERM: "xterm-256color" },
			{ TERM: "dumb" },
			{},
			{ COLORTERM: "truecolor", TERM: "xterm-256color" },
			{ COLORTERM: "24bit" },
			{ KITTY_WINDOW_ID: "1" },
			{ TERM_PROGRAM: "WarpTerminal" },
			{ TERM_PROGRAM: "vscode" },
		];
		for (const env of envs) {
			const trueColor = getTerminalInfo(detectTerminalId(env), process.platform, env).trueColor;
			expect(detectColorMode(env), JSON.stringify(env)).toBe(trueColor ? "truecolor" : "256color");
		}
	});

	it("keeps Windows Terminal on truecolor though it sets no colour marker", () => {
		expect(detectColorMode({ WT_SESSION: "00000000-0000-0000-0000-000000000000" })).toBe("truecolor");
	});
});
