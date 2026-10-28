/**
 * WHY: the `!` command block accepted one streamed chunk per 50 ms window and discarded the rest. The output
 * sink upstream already coalesces a command's output into one chunk per 50 ms window, so the block dropped
 * whole windows, including the last one before a command went quiet: a build announcing a long step showed a
 * stale preview until it exited, and the next accepted chunk was glued onto the line before the gap, drawing
 * lines the command never printed. Dropped windows were missing from the "earlier lines dropped" count. Both
 * the bash and the eval block also spread every line of a chunk into one `push` call, so a single coalesced
 * window of about a million lines overflowed the call stack.
 *
 * The class closed here: what an execution block keeps and counts is a function of the text streamed, never
 * of how it was chunked or when the block was drawn. Every execution block streams one text through every
 * chunking and draw cadence and is compared against the text itself: the last EXECUTION_STREAMING_LINE_CAP
 * lines, and every line before them counted as dropped.
 *
 * Not caught: SIXEL images cut by the streaming cap (the cap cut them before this change too), and a memory
 * bound on held chunks between draws, which changes no output.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/bash-execution";
import { EvalExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/eval-execution";
import {
	EXECUTION_STREAMING_LINE_CAP,
	StreamedOutputLines,
} from "@veyyon/coding-agent/modes/terminal/components/transcript/execution-shared";
import { setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import type { TUI } from "@veyyon/tui";
import { requireTheme } from "../../../helpers/require-theme";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

beforeEach(async () => {
	const theme = await requireTheme("dark");
	setThemeInstance(theme);
});

type ExecutionBlock = BashExecutionComponent | EvalExecutionComponent;

const BLOCKS: Array<[string, () => ExecutionBlock]> = [
	["the bash block", () => new BashExecutionComponent("cmd", ui)],
	["the eval block", () => new EvalExecutionComponent("print()", ui)],
];

function numbered(count: number, trailingNewline: boolean): string {
	const text = Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
	return trailingNewline ? `${text}\n` : text;
}

function chunked(text: string, size: number): string[] {
	const chunks: string[] = [];
	for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
	return chunks;
}

/** What a block must keep and count after streaming `text`, derived from the text alone. */
function expected(text: string): { kept: string; dropped: number } {
	const lines = text.split("\n");
	const dropped = Math.max(0, lines.length - EXECUTION_STREAMING_LINE_CAP);
	return { kept: lines.slice(dropped).join("\n"), dropped };
}

function droppedOnFooter(block: ExecutionBlock): number {
	const footer = Bun.stripANSI(block.render(120).join("\n"));
	const match = footer.match(/… (\d+) earlier lines dropped while streaming/);
	return match ? Number(match[1]) : 0;
}

const TEXTS: Array<[string, string]> = [
	["a few lines", numbered(5, true)],
	["exactly the cap", numbered(EXECUTION_STREAMING_LINE_CAP, false)],
	["one past the cap", numbered(EXECUTION_STREAMING_LINE_CAP + 1, false)],
	["a flood with a trailing newline", numbered(5_000, true)],
	["a flood ending mid-line", numbered(5_000, false)],
	["a flood larger than one fold holds", numbered(150_000, true)],
	// One coalesced output window this large overflowed the call stack when its lines were spread into a block.
	["a window of a million lines", numbered(1_000_000, true)],
];
const CHUNK_SIZES = [1, 7, 64, 1_000, Number.POSITIVE_INFINITY];
/** Appends per stream a case may cost; a text this outgrows is streamed only in the larger chunk sizes. */
const MAX_APPENDS = 100_000;

describe.each(BLOCKS)("%s", (_blockName, open) => {
	describe.each(TEXTS)("streaming %s", (_name, text) => {
		const want = expected(text);

		it.each(CHUNK_SIZES.filter(size => text.length / size <= MAX_APPENDS).map(size => [size] as const))(
			"keeps the same tail and drop count in chunks of %p, drawn after every chunk or only at the end",
			size => {
				const chunks = Number.isFinite(size) ? chunked(text, size) : [text];
				for (const drawEveryChunk of [false, true]) {
					const block = open();
					for (const chunk of chunks) {
						block.appendOutput(chunk);
						if (drawEveryChunk) block.render(120);
					}
					block.setComplete(0, false);

					expect(block.getOutput()).toBe(want.kept);
					expect(droppedOnFooter(block)).toBe(want.dropped);
				}
			},
		);
	});

	it("draws the line printed last, before the run goes quiet, without waiting for another chunk", () => {
		const block = open();
		block.appendOutput("compiling\n");
		block.render(120);
		block.appendOutput("linking (this takes a while)\n");

		expect(Bun.stripANSI(block.render(120).join("\n"))).toContain("linking (this takes a while)");
	});

	it("keeps every line of a burst in order instead of joining the lines on either side of a gap", () => {
		const block = open();
		for (let index = 0; index < 10; index++) block.appendOutput(`step ${index}\n`);

		expect(block.getOutput()).toBe(`${Array.from({ length: 10 }, (_, index) => `step ${index}`).join("\n")}\n`);
	});

	it("replaces streamed chunks that were never drawn with the final output", () => {
		const block = open();
		block.appendOutput("streamed but never drawn\n");
		block.setComplete(0, false, { output: "final" });

		expect(block.getOutput()).toBe("final");
	});

	it("reports nothing dropped once the final output replaces a stream that dropped lines", () => {
		const block = open();
		block.appendOutput(numbered(5_000, true));
		block.render(120);
		block.setComplete(0, false, { output: "final" });

		expect(block.getOutput()).toBe("final");
		expect(droppedOnFooter(block)).toBe(0);
	});
});

describe("the streamed lines an execution block reads", () => {
	it("counts the lines dropped by chunks it has not folded yet when the count is read first", () => {
		const output = new StreamedOutputLines(lines => lines);
		output.push(numbered(EXECUTION_STREAMING_LINE_CAP + 40, false));

		expect(output.dropped()).toBe(40);
		expect(output.lines()[0]).toBe("line 40");
	});
});
