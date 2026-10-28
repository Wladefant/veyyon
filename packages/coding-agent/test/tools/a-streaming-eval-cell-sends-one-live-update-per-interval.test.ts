/**
 * WHY: every live update an eval cell sends carries the whole visible tail, which the agent loop sanitizes and the
 * renderer redraws. The cell sent one per streamed chunk, so a loop printing a line per chunk paid the tail for every
 * line: 100k printed lines sanitized 9.2 GB and held the event loop for the whole 10 s run, and a real session froze
 * for 27 s.
 *
 * The class closed: whatever a cell streams (stdout chunks or status events) and however fast, it reaches the caller
 * as at most one update per LIVE_OUTPUT_INTERVAL_MS plus one per state change; the newest output always arrives; and
 * nothing arrives after the call settled, on the success path or the failure path.
 *
 * Not caught: a producer other than the eval tool. bash and ssh throttle in their OutputSink (`chunkThrottleMs`); a
 * new streaming tool that calls `onUpdate` per chunk is not swept here.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as evalIndex from "@veyyon/coding-agent/eval";
import type { ExecutorBackendExecOptions, ExecutorBackendResult } from "@veyyon/coding-agent/eval/backend";
import type { EvalToolDetails } from "@veyyon/coding-agent/eval/types";
import { LIVE_OUTPUT_INTERVAL_MS } from "@veyyon/coding-agent/session/streaming-output";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { EvalTool } from "@veyyon/coding-agent/tools/shell/eval";

type BackendOptions = Pick<ExecutorBackendExecOptions, "onChunk" | "onStatus">;

interface Update {
	text: string;
	status: string | undefined;
	cellOutput: string;
}

function makeSession(): ToolSession {
	return {
		cwd: "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

function backendResult(output: string): ExecutorBackendResult {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [],
	};
}

/** Prints `count` lines, one chunk each, and one status event per line, all on one stack. */
function burst(options: BackendOptions, label: string, count: number): void {
	for (let i = 0; i < count; i++) {
		options.onChunk(`${label} ${i}\n`);
		options.onStatus?.({ op: "log", message: `${label} ${i}` });
	}
}

function runCell(execute: (options: BackendOptions) => Promise<ExecutorBackendResult>) {
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((_code, options) => execute(options));
	const updates: Update[] = [];
	const settled = new EvalTool(makeSession()).execute(
		"call-burst",
		{ language: "js", code: "print-loop" },
		undefined,
		update => {
			const block = update.content[0];
			const cell = (update.details as EvalToolDetails | undefined)?.cells?.[0];
			updates.push({
				text: block?.type === "text" ? block.text : "",
				status: cell?.status,
				cellOutput: cell?.output ?? "",
			});
		},
	);
	return { updates, settled };
}

describe("a streaming eval cell", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends a burst of printed lines as its first line after a quiet interval and its last line", async () => {
		const { updates, settled } = runCell(async options => {
			burst(options, "first", 5000);
			await sleep(LIVE_OUTPUT_INTERVAL_MS * 6);
			burst(options, "second", 5000);
			await sleep(LIVE_OUTPUT_INTERVAL_MS * 6);
			return backendResult("done\n");
		});
		await settled;

		const lastLine = (text: string) => text.trimEnd().split("\n").at(-1) ?? "";
		// The first burst starts inside the interval the running announcement opened, so only its last line is
		// sent; the second starts after a quiet interval and is sent at once, then once more with its last line.
		expect(updates.map(update => [update.status, lastLine(update.cellOutput), lastLine(update.text)])).toEqual([
			["running", "", ""],
			["running", "first 4999", "first 4999"],
			["running", "second 0", "second 0"],
			["running", "second 4999", "second 4999"],
			["complete", "done", "done"],
		]);
	});

	it("sends nothing after it returns while an update was still waiting", async () => {
		const { updates, settled } = runCell(async options => {
			burst(options, "line", 100);
			return backendResult("line 99\n");
		});
		await settled;
		const delivered = updates.length;

		await sleep(LIVE_OUTPUT_INTERVAL_MS * 3);

		expect(updates).toHaveLength(delivered);
		expect(updates.at(-1)?.status).toBe("complete");
	});

	it("sends nothing after it fails while an update was still waiting", async () => {
		const { updates, settled } = runCell(async options => {
			burst(options, "line", 100);
			throw new Error("the kernel exited");
		});
		await expect(settled).rejects.toThrow("the kernel exited");
		const delivered = updates.length;

		await sleep(LIVE_OUTPUT_INTERVAL_MS * 3);

		expect(updates).toHaveLength(delivered);
	});
});
