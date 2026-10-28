/**
 * WHY: once its output passed the spill window, `OutputSink` cut its tail back to the window on every chunk, which
 * encodes and decodes the whole window per chunk. A cell printing 100k lines spent 2 s of one event-loop turn in
 * those cuts, twice over, because eval output passes through two sinks.
 *
 * The class closed: however a stream is chunked, the sink encodes its window at most once per window of input, and
 * what `dump()` returns is still exactly the last window of bytes, never splitting a character. `replace()` text is
 * kept whole until a later push overflows it.
 *
 * Not caught: the artifact file. Its own head and tail caps are pinned by the artifact suites.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { OutputSink } from "@veyyon/coding-agent/session/streaming-output";
import * as byteTruncate from "@veyyon/utils/byte-truncate";

const WINDOW = 1000;

/** The longest suffix of `text` that encodes to at most `maxBytes` UTF-8 bytes. */
function lastBytes(text: string, maxBytes: number): string {
	const encoded = Buffer.from(text, "utf-8");
	let start = Math.max(0, encoded.length - maxBytes);
	while (start < encoded.length && (encoded.readUInt8(start) & 0xc0) === 0x80) start++;
	return encoded.subarray(start).toString("utf-8");
}

function lines(label: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${label} ${i}\n`);
}

describe("an output sink fed a long stream of small chunks", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const [name, label] of [
		["ASCII", "line"],
		["multibyte", "行の日本語 é"],
	] as const) {
		it(`returns exactly the last window of a ${name} stream and encodes it once per window of input`, async () => {
			const cuts = vi.spyOn(byteTruncate, "truncateTailBytes");
			const chunks = lines(label, 20_000);
			const sink = new OutputSink({ spillThreshold: WINDOW });
			for (const chunk of chunks) sink.push(chunk);
			const summary = await sink.dump();

			const stream = chunks.join("");
			expect(summary.output).toBe(lastBytes(stream, WINDOW));
			expect(summary.outputBytes).toBe(Buffer.byteLength(summary.output, "utf-8"));
			expect(summary.truncated).toBe(true);
			expect(cuts.mock.calls.length).toBeLessThanOrEqual(Math.ceil(Buffer.byteLength(stream, "utf-8") / WINDOW));
		});
	}

	it("keeps replaced text whole, even over the window, when nothing is pushed after it", async () => {
		const sink = new OutputSink({ spillThreshold: WINDOW });
		for (const chunk of lines("before", 500)) sink.push(chunk);
		const replacement = lines("minimized", 300).join("");
		sink.replace(replacement);

		expect((await sink.dump()).output).toBe(replacement);
	});

	it("keeps the last window of replaced text and what was pushed after it", async () => {
		const sink = new OutputSink({ spillThreshold: WINDOW });
		const replacement = lines("minimized", 300).join("");
		sink.replace(replacement);
		sink.push("[raw output: artifact://7]\n");

		expect((await sink.dump()).output).toBe(lastBytes(`${replacement}[raw output: artifact://7]\n`, WINDOW));
	});
});
