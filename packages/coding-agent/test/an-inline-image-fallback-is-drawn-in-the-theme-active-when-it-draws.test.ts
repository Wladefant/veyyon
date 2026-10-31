/**
 * WHY THIS SUITE EXISTS. Every inline image in the transcript shares `TOOL_OUTPUT_IMAGE_THEME`, so an
 * image a transcript keeps holds no closure of its own. Sharing one object is correct only while it
 * reads the theme when it draws: an object that captured the theme active when the module loaded would
 * draw every image's fallback text in the launch theme after the user switched.
 *
 * WHAT IT DOES NOT CATCH. Whether a rendered image re-draws after a theme change; that is the render
 * cache's contract.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TOOL_OUTPUT_IMAGE_THEME } from "@veyyon/coding-agent/theme/image-theme";
import { setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { requireTheme } from "./helpers/require-theme";

const dark = await requireTheme("dark");
const light = await requireTheme("light");
let policyBefore: AnsiPolicy;

beforeAll(() => {
	policyBefore = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterAll(() => {
	setAnsiPolicy(policyBefore);
	setThemeInstance(dark);
});

describe("an inline image fallback is drawn in the theme active when it draws", () => {
	it("follows a theme switch made after the image theme was created", () => {
		const text = "[image/png 640x480]";
		expect(dark.fg("toolOutput", text)).not.toBe(light.fg("toolOutput", text));

		setThemeInstance(dark);
		expect(TOOL_OUTPUT_IMAGE_THEME.fallbackColor(text)).toBe(dark.fg("toolOutput", text));

		setThemeInstance(light);
		expect(TOOL_OUTPUT_IMAGE_THEME.fallbackColor(text)).toBe(light.fg("toolOutput", text));
	});
});
