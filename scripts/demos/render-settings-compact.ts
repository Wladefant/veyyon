/**
 * Print the real `/settings` surface at a compact width and height.
 *
 * Usage:
 *
 *     bun scripts/demos/render-settings-compact.ts --width 70 --height 14 --down 10
 */
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/terminal/components/selectors/settings-selector";
import { renderDemo } from "./render-args";

await renderDemo(
	({ width, flag, theme }) => {
		const downCount = Number(flag("down", "10"));
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
		for (let step = 0; step < downCount; step++) selector.handleInput("\x1b[B");
		return selector.render(width);
	},
	{ settings: true, defaultHeight: 14 },
);
