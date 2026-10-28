/**
 * WHY: the bash and eval blocks draw through one `ExecutionBlockComponent`, which each configures with a header,
 * a sanitizer, a line clamp and (bash only) a mask of raw sixel lines. A branch of that shared block that stops
 * running changes what every composer-run command or cell shows, and none of these branches is reached by the
 * suites that stream into a block or rebuild it from a session.
 *
 * The class closed here: for every execution block, the footer states how the run ended with a signal ranked
 * above a cancel, the collapsed block shows the tail and counts the rest while the expanded one shows all of it,
 * an empty final output draws no output row, the final output reaches the screen sanitized, and under sixel
 * passthrough a bash block draws every line, leaves the image rows unstyled and unclamped, and states no hidden
 * count. `BLOCKS` is swept for every contract that both kinds share.
 *
 * Not caught: a third kind of execution block not added to `BLOCKS`, and what a sixel image looks like once a
 * terminal decodes it; this compares the bytes handed to the terminal.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { BashExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/bash-execution";
import { EvalExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/eval-execution";
import {
	EXECUTION_MAX_DISPLAY_COLUMNS,
	EXECUTION_PREVIEW_LINES,
} from "@veyyon/coding-agent/modes/terminal/components/transcript/execution-shared";
import { setThemeInstance, theme } from "@veyyon/coding-agent/theme/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, type TUI } from "@veyyon/tui";
import { formatMoreLines } from "@veyyon/utils/format";
import { requireTheme } from "../../../helpers/require-theme";
import { useFullColor } from "../../../helpers/theme-assertions";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
const WIDTH = 120;
const SIXEL = "\x1bPqabc\x1b\\";

type ExecutionBlock = BashExecutionComponent | EvalExecutionComponent;

const BLOCKS: Array<[string, () => ExecutionBlock]> = [
	["the bash block", () => new BashExecutionComponent("make build", ui)],
	["the eval block", () => new EvalExecutionComponent("total = sum(range(10))", ui)],
];

beforeAll(async () => {
	const dark = await requireTheme("dark");
	setThemeInstance(dark);
});

const rows = (count: number): string =>
	Array.from({ length: count }, (_, index) => `row ${String(index).padStart(2, "0")}`).join("\n");

const plainFrame = (block: ExecutionBlock): string[] =>
	block.render(WIDTH).map(line => stripVTControlCharacters(line).trimEnd());

/** Runs `body` with a sixel terminal and both passthrough switches on, restoring all three after. */
function withSixelPassthrough(body: () => void): void {
	const protocol = TERMINAL.imageProtocol;
	const forced = process.env.VEYYON_FORCE_IMAGE_PROTOCOL;
	const allowed = process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH;
	process.env.VEYYON_FORCE_IMAGE_PROTOCOL = "sixel";
	process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH = "1";
	setTerminalImageProtocol(ImageProtocol.Sixel);
	try {
		body();
	} finally {
		setTerminalImageProtocol(protocol);
		if (forced === undefined) delete process.env.VEYYON_FORCE_IMAGE_PROTOCOL;
		else process.env.VEYYON_FORCE_IMAGE_PROTOCOL = forced;
		if (allowed === undefined) delete process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH;
		else process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH = allowed;
	}
}

describe.each(BLOCKS)("%s", (_name, open) => {
	it("states a signal that ended the run, above the cancel that sent it", () => {
		const killed = open();
		killed.setComplete(undefined, true, { signal: "SIGTERM" });
		const cancelled = open();
		cancelled.setComplete(undefined, true);

		expect(plainFrame(killed).join("\n")).toContain("(killed by signal SIGTERM)");
		expect(plainFrame(killed).join("\n")).not.toContain("(cancelled)");
		// Non-vacuity: without the signal the same cancel reads as one.
		expect(plainFrame(cancelled).join("\n")).toContain("(cancelled)");
	});

	it("shows the tail and counts the rest collapsed, and every line expanded", () => {
		const total = EXECUTION_PREVIEW_LINES + 10;
		const block = open();
		block.setComplete(0, false, { output: rows(total) });
		const hint = formatMoreLines(total - EXECUTION_PREVIEW_LINES);

		const collapsed = plainFrame(block).join("\n");
		expect(collapsed).toContain(`row ${total - 1}`);
		expect(collapsed).not.toContain("row 00");
		expect(collapsed).toContain(hint);

		block.setExpanded(true);
		const expanded = plainFrame(block).join("\n");
		expect(expanded).toContain("row 00");
		expect(expanded).toContain(`row ${total - 1}`);
		expect(expanded).not.toContain(hint);

		block.setExpanded(false);
		expect(plainFrame(block).join("\n")).toBe(collapsed);
	});

	it("draws no output row when the final output replaces a streamed one with nothing", () => {
		const emptied = open();
		emptied.appendOutput("partial line\n");
		emptied.setComplete(0, false, { output: "" });
		const silent = open();
		silent.setComplete(0, false);

		expect(emptied.render(WIDTH)).toEqual(silent.render(WIDTH));
	});

	it("draws the final output with its control sequences removed", () => {
		const block = open();
		block.setComplete(0, false, { output: "plain \x1b[31mred\x1b[0m\x07 \x1b]0;title\x07end" });

		const frame = block.render(WIDTH).join("\n");
		expect(block.getOutput()).not.toMatch(/[\x07\x1b]/);
		expect(frame).not.toContain("\x07");
		expect(frame).not.toContain("\x1b]0;");
		expect(stripVTControlCharacters(frame)).toContain("plain red end");
	});
});

describe("the bash block under sixel passthrough", () => {
	useFullColor();

	it("draws every line, the image row unstyled, and states no hidden count", () => {
		withSixelPassthrough(() => {
			const total = EXECUTION_PREVIEW_LINES + 10;
			const block = new BashExecutionComponent("plot", ui);
			block.setComplete(0, false, { output: `${rows(total)}\n${SIXEL}\nafter` });

			const frame = block.render(WIDTH).join("\n");
			const plain = stripVTControlCharacters(frame);
			expect(plain).toContain("row 00");
			expect(plain).toContain("after");
			expect(plain).not.toContain(formatMoreLines(total + 2 - EXECUTION_PREVIEW_LINES));
			expect(frame).toContain(SIXEL);
			expect(frame).not.toContain(theme.fg("muted", SIXEL));
			// Non-vacuity: the text rows beside it are still drawn muted.
			expect(frame).toContain(theme.fg("muted", "after"));
		});
	});

	it("keeps an image's data rows whole however wide they are, and still clamps a text row", () => {
		withSixelPassthrough(() => {
			const dataRow = `#1${"~".repeat(EXECUTION_MAX_DISPLAY_COLUMNS + 1000)}`;
			const wideText = "x".repeat(EXECUTION_MAX_DISPLAY_COLUMNS + 1000);
			const block = new BashExecutionComponent("plot", ui);
			block.setComplete(0, false, { output: `\x1bPq#0;2;0;0;0\n${dataRow}\n-\x1b\\\n${wideText}` });

			const kept = block.getOutput().split("\n");
			expect(kept[1]).toBe(dataRow);
			expect(kept[3]).toContain("visible columns omitted");
		});
	});
});
