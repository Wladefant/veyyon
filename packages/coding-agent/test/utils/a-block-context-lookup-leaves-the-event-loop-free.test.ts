import { describe, expect, it } from "bun:test";
import { findBlockContextLines } from "@veyyon/coding-agent/utils/block-context";

/**
 * WHY: the read tool and the edit preview ask tree-sitter for the block an off-window line belongs
 * to, and that parse is a whole-source scan: 50 ms for a 0.5 MB TypeScript file, 150 ms at 3.5 MB.
 * It ran on the event loop, so every partial read of a large file froze keystrokes and redraws for
 * the length of the parse. The lookup now resolves a Promise the native thread pool fulfils.
 *
 * The class this closes is "the boundary parse holds the event loop", pinned at the one choke point
 * every caller passes through (`findBlockContextLines`; the read tool's line entries and both diff
 * renderers call it): the loop must turn while the parse is pending, and the answer must be the one
 * the parse produces. A synchronous native call finishes before a queued `setImmediate` can run, so
 * it reads as zero turns.
 *
 * What it does not catch: the lexical fallback a source with a syntax error takes still scans on the
 * event loop (13 ms at 3.5 MB), and a parse that finishes before the loop's first check phase would
 * read as zero turns; the source is sized so the parse takes tens of milliseconds.
 */

/** A TypeScript source of about `bytes` bytes made of small functions, each a multi-line block. */
function largeSource(bytes: number): string[] {
	const lines: string[] = [];
	let size = 0;
	for (let n = 0; size < bytes; n++) {
		const unit = [
			`export function unit${n}(value: number): number {`,
			`\tconst a = value + ${n};`,
			"\treturn a;",
			"}",
		];
		lines.push(...unit);
		for (const line of unit) size += line.length + 1;
	}
	return lines;
}

/** Run `lookup` and count the event-loop check phases that ran while it was pending. */
async function turnsWhilePending<T>(lookup: () => Promise<T>): Promise<{ value: T; turns: number }> {
	let turns = 0;
	let pending = true;
	const tick = () => {
		if (!pending) return;
		turns++;
		setImmediate(tick);
	};
	setImmediate(tick);
	try {
		return { value: await lookup(), turns };
	} finally {
		pending = false;
	}
}

describe("a block-context lookup leaves the event loop free", () => {
	it("turns the event loop while it parses a large source and answers with the parsed boundary", async () => {
		const lines = largeSource(1024 * 1024);
		// The window shows the opener of a function in the middle; its closer is three lines down.
		const opener = Math.floor(lines.length / 8) * 4 + 1;
		const { value, turns } = await turnsWhilePending(() =>
			findBlockContextLines(lines, [opener], { path: "large.ts", text: lines.join("\n") }),
		);

		expect(value).toEqual(new Map([[opener + 3, "}"]]));
		expect(turns).toBeGreaterThan(0);
	});
});
