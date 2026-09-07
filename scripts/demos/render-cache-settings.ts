/**
 * Print the real `/settings` surface filtered to the prompt-cache group.
 *
 * The differential this exists for is off-vs-on of **Block On Cache Rejection**:
 * with reporting on and blocking off (the defaults) the group shows both rows and
 * the toggle reads off; with blocking on it reads on. Rendering the REAL
 * `SettingsSelectorComponent` is the point — a mock-up of the rows would agree
 * with a setting that was never wired.
 *
 * Usage:
 *
 *     bun scripts/demos/render-cache-settings.ts --block on --width 92 --height 18
 */
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/terminal/components/selectors/settings-selector";
import { renderDemo } from "./render-args";

await renderDemo(
	({ width, flag, theme }) => {
		// Seeded through the real settings store rather than by pressing the toggle, so
		// the capture cannot pass while the keybinding is broken and cannot depend on
		// where the cursor happens to land.
		Settings.instance.set("cache.reportRejection", true);
		Settings.instance.set("cache.blockOnRejection", flag("block", "off") === "on");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: [theme, "light"],
				availablePersonalities: ["default"],
				providers: ["anthropic"],
				cwd: process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		// Type-to-search narrows to the two rows, which keeps the frame stable as
		// unrelated settings are added above them.
		for (const character of "cache rejection") selector.handleInput(character);
		return selector.render(width);
	},
	{ settings: true, defaultHeight: 18 },
);
