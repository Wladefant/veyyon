/**
 * WHY: a theme change reaches the transcript through `invalidate()`. The bash block built its `$ command`
 * header once and re-added that same `Text` on every redraw, so after a theme switch its header kept the old
 * theme's colours while the output and footer beside it took the new one. The eval block had the opposite
 * cost: it rebuilt and re-highlighted its header on every streamed chunk.
 *
 * The class closed here: after `invalidate()`, every execution block draws exactly what a block created
 * under the current theme draws. Both blocks are swept.
 *
 * Not caught: a third kind of execution block not added to `BLOCKS`, and how often the header is rebuilt
 * between invalidations, which changes no output.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/bash-execution";
import { EvalExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/eval-execution";
import { setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import type { TUI } from "@veyyon/tui";
import { requireTheme } from "../../../helpers/require-theme";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

type ExecutionBlock = BashExecutionComponent | EvalExecutionComponent;

const BLOCKS: Array<[string, () => ExecutionBlock]> = [
	["the bash block", () => new BashExecutionComponent("make build", ui)],
	["the eval block", () => new EvalExecutionComponent("total = sum(range(10))", ui)],
];

async function useTheme(name: string): Promise<void> {
	const theme = await requireTheme(name);
	setThemeInstance(theme);
}

/** A finished block, so no spinner frame differs between two draws. */
function finished(open: () => ExecutionBlock): ExecutionBlock {
	const block = open();
	block.appendOutput("built 3 targets\n");
	block.setComplete(0, false);
	return block;
}

afterEach(async () => {
	await useTheme("dark");
});

describe.each(BLOCKS)("%s", (_name, open) => {
	it("draws in the new theme after a theme change invalidates it", async () => {
		await useTheme("dark");
		const block = finished(open);
		const darkFrame = block.render(120);

		await useTheme("light");
		const lightFrame = finished(open).render(120);
		block.invalidate();

		// Non-vacuity: the two themes draw this block differently, header included.
		expect(lightFrame[0]).not.toBe(darkFrame[0]);
		expect(block.render(120)).toEqual(lightFrame);
	});
});
