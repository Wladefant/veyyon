/**
 * Renderer suites load their theme with `requireTheme`. When a theme stops shipping, those suites fail at
 * the lookup with the theme's name, instead of passing `undefined` into a renderer and failing later with
 * an unrelated `TypeError`. This does not check that any particular theme keeps shipping.
 */
import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@veyyon/coding-agent/theme/theme";
import { requireTheme } from "./helpers/require-theme";

describe("requireTheme", () => {
	it("returns the theme the build ships under that name", async () => {
		const expected = await getThemeByName("light");
		expect((await requireTheme("light")).getAllThemeColorHexes()).toEqual(expected?.getAllThemeColorHexes() ?? []);
		expect((await requireTheme("dark")).getAllThemeColorHexes()).not.toEqual(expected?.getAllThemeColorHexes());
	});

	it("throws naming the theme when the build ships none by that name", async () => {
		await expect(requireTheme("no-such-theme")).rejects.toThrow("No theme is named no-such-theme");
	});
});
