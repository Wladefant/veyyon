/**
 * A streamed Markdown holds a few copies of its text while it streams, and once sealed holds what one
 * render of the same text holds.
 *
 * THE DEFECT. The streaming lexer re-lexes only the tail past the frozen prefix, and the tail was a
 * slice of the frame's text. A slice shares the buffer it was cut from, and so does every token marked
 * cuts from it. A provider builds its text by appending, so every frame reads a new buffer, and the
 * tokens frozen on each frame held that frame's whole text: one 206,000-character answer held 76 MiB.
 * Sealing changed nothing: the frozen tokens, the frozen rows and the text of the last settled
 * exposure stayed for the life of the block.
 *
 * THE CLASS. A string a Markdown keeps from a stream frame beyond what its current text and rows
 * need: a token, a row, a prefix, an exposure. Every block shape the streaming lexer freezes on is
 * streamed one chunk per frame into a buffer of its own, and the string bytes one instance holds
 * afterwards are bounded against the same text rendered once: while streaming, by a few copies of the
 * text; once sealed, by half a copy. The closing paragraph keeps arriving for several frames after the
 * last block freezes, so the frame that froze last is never the frame that sealed. The measurement
 * runs in `fixtures/markdown-stream-retention.ts`, in a process of its own, because the figure is the
 * process's extra memory and the files a parallel run shares a process with add to it.
 *
 * WHAT IT DOES NOT CATCH. JSC counts only out-of-line string storage as extra memory, so a retained
 * string short enough to live inline passes. A sealed block that keeps less than half a copy of its
 * text passes; the bound sits above the variation of a full collection.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { type RetentionReport, SHAPE_NAMES } from "./fixtures/markdown-stream-retention";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "markdown-stream-retention.ts");

/** Every shape is measured by one fixture run, which takes several seconds. */
const MEASURE_TIMEOUT_MS = 120_000;

let report: RetentionReport | undefined;

function measured(shape: string): RetentionReport[string] {
	if (!report) {
		const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8", timeout: MEASURE_TIMEOUT_MS });
		if (run.status !== 0) throw new Error(`fixture failed (${run.status}): ${run.stderr}`);
		report = JSON.parse(run.stdout) as RetentionReport;
	}
	const arms = report[shape];
	if (!arms) throw new Error(`fixture measured no ${shape}`);
	return arms;
}

describe("a streamed Markdown holds what its text needs", () => {
	it.each(SHAPE_NAMES.map(name => [name] as const))(
		"%s: while it streams, a few copies of the text",
		shape => {
			expect(measured(shape).streaming).toBeLessThan(6);
		},
		MEASURE_TIMEOUT_MS,
	);

	it.each(SHAPE_NAMES.map(name => [name] as const))(
		"%s: once sealed, what one render of the text holds",
		shape => {
			expect(measured(shape).sealed).toBeLessThan(0.5);
		},
		MEASURE_TIMEOUT_MS,
	);
});
