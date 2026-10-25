/**
 * WHY: a streaming tool (bash, eval, ssh, the interactive shell) keeps a head window and a tail window of its
 * output and elides the middle, and its result disagreed with itself five ways:
 *
 *   - the notice derived its line ranges by splitting the kept lines evenly, while the windows are cut by bytes
 *     and hold different numbers of lines, so it named lines the output did not show;
 *   - the windows were cut on byte boundaries, so the head's last line and the tail's first line were fragments
 *     counted as whole lines;
 *   - elision was detected by comparing totals, which per-line column caps skew, so a cut tail could go unreported
 *     and the head and tail were joined as if they were adjacent;
 *   - the windows were sized from the head and tail settings rather than the inline budget, so the body overran
 *     the budget and bash cut it a second time, saving the window as a second artifact under a notice that
 *     described the first cut;
 *   - a head window left with room for less than the next character stayed open, so a later, smaller chunk
 *     filled it and was shown ahead of output that had already gone to the tail.
 *
 * The class closed: for any stream, chunking and window, every line the body shows is a whole line of the stream
 * at the number the notice states, the counts reconcile with the body and the stream, and the body fits the window
 * it was sized for; the windows fit the budget with room for the marker; bash and eval return that body under one
 * notice and one artifact.
 *
 * Not caught: eval trims the whitespace around a cell's stdout and folds test bookkeeping lines, so its ranges
 * describe the stream rather than the trimmed text; a window holding no whole line shows a fragment of the one line
 * longer than it, which is all of that line there is to show; ssh and the interactive shell are covered only
 * through the window resolver they share.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import {
	formatMiddleElisionMarker,
	MIDDLE_ELISION_MAX_BYTES,
	OutputSink,
	type OutputSummary,
} from "@veyyon/coding-agent/session/streaming-output";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { inlineBudgetFor } from "@veyyon/coding-agent/tools/core/output-artifact";
import {
	outputMeta,
	resolveOutputSinkWindow,
	wrapToolWithMetaNotice,
} from "@veyyon/coding-agent/tools/core/output-meta";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import { EvalTool } from "@veyyon/coding-agent/tools/shell/eval";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { makeToolSession } from "./helpers/tool-session";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// `executeBash` initializes the global Settings singleton itself.
useIsolatedGlobalSettings();

const makeArtifactDir = useTrackedTempDirs("streamed-result-lines-");

afterAll(async () => {
	await disposeAllVmContexts();
});

const bytes = (text: string): number => Buffer.byteLength(text, "utf-8");

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One, two, three and four byte characters, so a byte cut can land inside any of them. */
const FILLER = ["a", "b", " ", "é", "中", "😀"];

/**
 * Lines tagged with their own number, so a line shows where it came from, among empty lines, so a window can start
 * or end at one. The last line is always tagged: the end of the output is text.
 */
function makeStream(seed: number, lines: number, maxFill: number, trailingNewline: boolean): string {
	const rand = mulberry32(seed);
	const out: string[] = [];
	for (let i = 1; i <= lines; i++) {
		if (i < lines && rand() < 0.15) {
			out.push("");
			continue;
		}
		const fill = Math.floor(rand() * (maxFill + 1));
		let line = `L${i}:`;
		for (let k = 0; k < fill; k++) line += FILLER[Math.floor(rand() * FILLER.length)];
		out.push(line);
	}
	return out.join("\n") + (trailingNewline ? "\n" : "");
}

interface SinkWindow {
	head: number;
	tail: number;
}

/** Pushes `stream` in chunks of `chunkSize` code points: a decoder never splits a character across chunks. */
async function sinkOver(stream: string, chunkSize: number, window: SinkWindow, maxColumns = 0): Promise<OutputSummary> {
	const sink = new OutputSink({ headBytes: window.head, spillThreshold: window.tail, maxColumns });
	const points = Array.from(stream);
	for (let i = 0; i < points.length; i += chunkSize) sink.push(points.slice(i, i + chunkSize).join(""));
	return sink.dump();
}

/**
 * Asserts each shown line is line `first + j` of the stream, whole. A window holding no whole line shows part of
 * the one line longer than the window: the head's only line, or the tail's first line with at most the stream's
 * final empty line after it. Returns whether such a fragment was shown.
 */
function expectWholeLines(
	shown: string[],
	first: number,
	source: string[],
	edge: "head" | "tail",
	windowBytes: number,
): boolean {
	let fragment = false;
	for (let j = 0; j < shown.length; j++) {
		const n = first + j;
		const line = shown[j];
		const whole = source[n - 1];
		if (line === whole) continue;
		const sole =
			edge === "head" ? shown.length === 1 : j === 0 && shown.length <= 2 && shown.slice(1).every(l => l === "");
		const partOf = edge === "head" ? whole.startsWith(line) : whole.endsWith(line);
		expect({ n, line, sole, partOf }).toEqual({ n, line, sole: true, partOf: true });
		// The line, with the break in front of it, did not fit the window (less a character the cut split).
		expect(bytes(whole) + 1).toBeGreaterThan(windowBytes - 4);
		fragment = true;
	}
	return fragment;
}

function expectSummaryShowsTheStream(summary: OutputSummary, stream: string, window: SinkWindow): void {
	const source = stream.split("\n");
	const total = source.length;
	expect(summary.totalLines).toBe(total);
	expect(summary.totalBytes).toBe(bytes(stream));
	expect(summary.outputBytes).toBe(bytes(summary.output));
	const shown = summary.output.length > 0 ? summary.output.split("\n") : [];
	expect(summary.outputLines).toBe(shown.length);
	const truncation = outputMeta().truncationFromSummary(summary, { direction: "tail" }).get()?.truncation;

	if (summary.elidedBytes !== undefined) {
		const headLines = summary.headLines ?? -1;
		const tailLines = summary.tailLines ?? -1;
		expect(shown.length).toBe(headLines + 1 + tailLines);
		expect(shown[headLines]).toBe(formatMiddleElisionMarker(summary.elidedLines ?? -1, summary.elidedBytes));
		const head = shown.slice(0, headLines);
		const tail = shown.slice(headLines + 1);
		const headFragment = expectWholeLines(head, 1, source, "head", window.head);
		const tailFragment = expectWholeLines(tail, total - tailLines + 1, source, "tail", window.tail);
		// The last generated line is tagged, so the end of the output is text the tail must show some of.
		expect(tail.some(line => line !== "")).toBe(true);
		// One line longer than both windows shows its start and its end, so the two windows' lines are one line.
		const overlap = headLines + tailLines - total;
		expect({ overlap, headFragment, tailFragment }).toEqual(
			overlap > 0 ? { overlap: 1, headFragment: true, tailFragment: true } : { overlap, headFragment, tailFragment },
		);
		const elidedLines = Math.max(0, total - headLines - tailLines);
		expect(summary.elidedLines).toBe(elidedLines);
		const kept = bytes(head.join("\n")) + (headFragment ? 0 : 1) + bytes(tail.join("\n"));
		expect(summary.elidedBytes).toBe(bytes(stream) - kept);
		expect(summary.outputBytes).toBeLessThanOrEqual(window.head + window.tail + MIDDLE_ELISION_MAX_BYTES);
		expect(truncation).toMatchObject({
			direction: "middle",
			totalLines: total,
			headRange: { start: 1, end: headLines },
			tailRange: tailLines > 0 ? { start: total - tailLines + 1, end: total } : undefined,
			elidedLines,
			elidedBytes: summary.elidedBytes,
		});
		return;
	}
	if (!summary.truncated) {
		expect(summary.output).toBe(stream);
		expect(truncation).toBeUndefined();
		return;
	}
	// Only a sink with no head window keeps the tail alone.
	expect(window.head).toBe(0);
	expectWholeLines(shown, total - shown.length + 1, source, "tail", window.tail);
	expect(shown.some(line => line !== "")).toBe(true);
	expect(summary.outputBytes).toBeLessThanOrEqual(window.tail);
	expect(truncation?.shownRange).toEqual({ start: total - shown.length + 1, end: total });
}

describe("an output sink states the lines it shows", () => {
	const windows: SinkWindow[] = [
		{ head: 0, tail: 64 },
		{ head: 0, tail: 700 },
		{ head: 40, tail: 60 },
		{ head: 300, tail: 200 },
		{ head: 2000, tail: 3000 },
	];
	for (const window of windows) {
		it(`shows whole numbered lines under a ${window.head}B head and ${window.tail}B tail`, async () => {
			for (const lines of [1, 3, 40, 300]) {
				for (const maxFill of [0, 12, 90, 500]) {
					for (const trailingNewline of [true, false]) {
						const stream = makeStream(
							lines * 7919 + maxFill * 31 + Number(trailingNewline),
							lines,
							maxFill,
							trailingNewline,
						);
						for (const chunkSize of [1, 7, 333, Number.POSITIVE_INFINITY]) {
							if (chunkSize === 1 && stream.length > 20_000) continue;
							const label = `${lines} lines, fill ${maxFill}, trailing ${trailingNewline}, chunk ${chunkSize}`;
							try {
								expectSummaryShowsTheStream(await sinkOver(stream, chunkSize, window), stream, window);
							} catch (error) {
								throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
							}
						}
					}
				}
			}
		});
	}

	/**
	 * A column cap adds an ellipsis per capped line, so the capped stream is longer than the raw total less the
	 * dropped bytes. A tail cut by those extra bytes must still be reported, not joined to the head as if adjacent.
	 */
	it("reports a tail cut that only the column cap's ellipses made necessary", async () => {
		const maxColumns = 40;
		const stream = Array.from({ length: 20 }, (_, i) => `L${i + 1}:${"a".repeat(100)}`).join("\n");
		const capped = (line: string): string => `${line.slice(0, maxColumns - 3)}…`;
		const window = { head: 200, tail: 590 };
		const summary = await sinkOver(stream, Number.POSITIVE_INFINITY, window, maxColumns);

		expect(summary.elidedBytes).toBeGreaterThan(0);
		const headLines = summary.headLines ?? -1;
		const tailLines = summary.tailLines ?? -1;
		const shown = summary.output.split("\n");
		expect(shown.slice(0, headLines)).toEqual(stream.split("\n").slice(0, headLines).map(capped));
		expect(shown[headLines]).toBe(formatMiddleElisionMarker(summary.elidedLines ?? -1, summary.elidedBytes ?? -1));
		expect(shown.slice(headLines + 1)).toEqual(
			stream
				.split("\n")
				.slice(20 - tailLines)
				.map(capped),
		);
		expect(summary.elidedLines).toBe(20 - headLines - tailLines);
		expect(outputMeta().truncationFromSummary(summary, { direction: "tail" }).get()?.truncation).toMatchObject({
			direction: "middle",
			headRange: { start: 1, end: headLines },
			tailRange: { start: 20 - tailLines + 1, end: 20 },
		});
	});
});

describe("a sink window fits the inline budget", () => {
	const numbered = `${Array.from({ length: 20_000 }, (_, i) => String(i + 1)).join("\n")}\n`;

	it("leaves the marker room inside every budget and keeps the configured head and tail when they fit", async () => {
		for (const budget of [MIDDLE_ELISION_MAX_BYTES + 2, 1024, 12_800, 51_200, 400_000]) {
			for (const headKb of [0, 1, 2.5, 20, 200]) {
				for (const tailKb of [1, 20, 200]) {
					const settings = Settings.isolated({
						"tools.artifactHeadBytes": headKb,
						"tools.artifactTailBytes": tailKb,
					});
					const window = resolveOutputSinkWindow(settings, budget);
					const label = `budget ${budget}, head ${headKb}KB, tail ${tailKb}KB`;
					const reserve = headKb > 0 ? MIDDLE_ELISION_MAX_BYTES : 0;
					const room = budget - reserve;
					const fits = (headKb + tailKb) * 1024 <= room;
					const summary = await sinkOver(numbered, Number.POSITIVE_INFINITY, {
						head: window.headBytes,
						tail: window.spillThreshold,
					});
					expect({
						label,
						headKept: window.headBytes > 0,
						withinBudget: window.headBytes + window.spillThreshold + reserve <= budget,
						headWithinSetting: window.headBytes <= headKb * 1024,
						tailWithinSetting: window.spillThreshold <= tailKb * 1024,
						usesTheRoom: fits
							? window.headBytes === headKb * 1024 && window.spillThreshold === tailKb * 1024
							: window.headBytes + window.spillThreshold >= room - 1,
						bodyWithinBudget: bytes(summary.output) <= budget,
					}).toEqual({
						label,
						headKept: headKb > 0,
						withinBudget: true,
						headWithinSetting: true,
						tailWithinSetting: true,
						usesTheRoom: true,
						bodyWithinBudget: true,
					});
				}
			}
		}
	});
});

interface Allocated {
	id: string;
	path: string;
}

/** A session at its first turn, where the inline budget is held tightest, recording every artifact it hands out. */
function artifactSession(dir: string): { session: ToolSession; allocated: Allocated[] } {
	const allocated: Allocated[] = [];
	const session = makeToolSession({
		cwd: dir,
		getSessionId: () => "streamed-result-lines",
		getTurnIndex: () => 0,
		allocateOutputArtifact: async (kind: string) => {
			const id = `${kind}-${allocated.length + 1}`;
			const entry = { id, path: path.join(dir, `${id}.txt`) };
			allocated.push(entry);
			return entry;
		},
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		}),
		getClientBridge: () => undefined,
	});
	return { session, allocated };
}

const NOTICE =
	/\n\n\[Showing lines 1-(\d+) and (\d+)-(\d+) of (\d+); ([\d,]+) middle lines? \([^)]*\) elided\.[^\]]*artifact:\/\/([^\s\]]+)[^\]]*\]$/;

/**
 * Asserts `text` is a head of the numbers 1.., the marker, and a tail ending at `count`, under one notice whose ranges
 * are those lines, within `budget`, pointing at the one artifact, which holds the whole stream.
 */
async function expectOneWindowOfNumbers(text: string, budget: number, allocated: Allocated[], count: number) {
	const notice = NOTICE.exec(text);
	if (!notice) throw new Error(`no middle-elision notice ends the result: ${JSON.stringify(text.slice(-400))}`);
	const [, headEnd, tailStart, tailEnd, totalLines, elided, artifactId] = notice;
	const body = text.slice(0, notice.index);
	expect(bytes(body)).toBeLessThanOrEqual(budget);

	const head = Number(headEnd);
	const first = Number(tailStart);
	const total = Number(totalLines);
	// `count` numbers and a final line break: the stream's last line is the empty one after it.
	expect([Number(tailEnd), total]).toEqual([count + 1, count + 1]);
	expect(Number(elided.replaceAll(",", ""))).toBe(first - head - 1);

	const shown = body.split("\n");
	expect(shown.slice(0, head)).toEqual(Array.from({ length: head }, (_, i) => String(i + 1)));
	expect(shown[head]).toMatch(/^\[…[\d,]+ln elided…\]$/);
	const tail = Array.from({ length: total - first + 1 }, (_, i) => (first + i <= count ? String(first + i) : ""));
	// The empty last line may be trimmed with the whitespace around the output.
	expect([tail, tail.slice(0, -1)]).toContainEqual(shown.slice(head + 1));

	expect(allocated.map(entry => entry.id)).toEqual([artifactId]);
	const full = await fs.readFile(allocated[0].path, "utf-8");
	expect(full).toBe(`${Array.from({ length: count }, (_, i) => String(i + 1)).join("\n")}\n`);
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

describe("a streaming tool returns one window under one notice", () => {
	it("bash returns whole lines at the numbers its notice states, inside the budget, with one artifact", async () => {
		const { session, allocated } = artifactSession(makeArtifactDir());
		const tool = wrapToolWithMetaNotice(new BashTool(session));
		const result = await tool.execute("call-seq", { command: "seq 1 200000", timeout: 60 });

		await expectOneWindowOfNumbers(textOf(result), inlineBudgetFor(session), allocated, 200_000);
	}, 30_000);

	it("eval returns whole lines at the numbers its notice states, inside the budget, with one artifact", async () => {
		const { session, allocated } = artifactSession(makeArtifactDir());
		const tool = wrapToolWithMetaNotice(new EvalTool(session));
		// Printed in pieces, so the stream reaches the sinks as many chunks.
		const code =
			"for (let start = 1; start <= 200000; start += 25000) print(Array.from({ length: 25000 }, (_, i) => start + i).join('\\n'))";
		const result = await tool.execute("call-print", { language: "js", code });

		await expectOneWindowOfNumbers(textOf(result), inlineBudgetFor(session), allocated, 200_000);
	}, 30_000);

	/**
	 * The sink's window is priced when the command starts and the result when it ends. A threshold lowered in
	 * between cuts the body again; the cut points at the artifact the sink already saved instead of saving a second,
	 * and the exit code after it is not cut.
	 */
	it("bash cut to a threshold lowered mid-run points at the one artifact it saved", async () => {
		const { session, allocated } = artifactSession(makeArtifactDir());
		const tool = wrapToolWithMetaNotice(new BashTool(session));
		let lowered = false;
		const result = await tool.execute(
			"call-lowered",
			{ command: "seq 1 200000; sleep 0.5; exit 3", timeout: 60 },
			undefined,
			() => {
				if (lowered) return;
				lowered = true;
				session.settings.set("tools.artifactSpillThreshold", 2);
			},
		);
		const text = textOf(result);

		expect(lowered).toBe(true);
		const referenced = new Set(Array.from(text.matchAll(/artifact:\/\/([^\s\]]+)/g), match => match[1]));
		expect(allocated.map(entry => entry.id)).toEqual([...referenced]);
		// The cut keeps the new budget, ends with the footer naming the sink's artifact, and the exit code follows.
		const footer = /\n?\[raw output: artifact:\/\/([^\]]+)\]\n\nCommand exited with code 3$/.exec(text);
		expect(footer?.[1]).toBe(allocated[0]?.id);
		expect(bytes(text.slice(0, footer?.index))).toBeLessThanOrEqual(inlineBudgetFor(session));
	}, 30_000);
});
