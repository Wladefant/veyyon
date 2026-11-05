/**
 * `veyyon stats --summary` and the standalone `veyyon-stats --sync` print one summary, and both draw
 * one progress line while they sync. The standalone entry point used to carry its own copy of both,
 * and that copy printed "Synced N new entries" on stdout, so `veyyon-stats --json | jq` failed to
 * parse. These tests pin the summary's rows, its row cap and its styling, the progress line's
 * terminal behavior, and that the standalone `--json` stdout is one JSON document.
 *
 * Not covered: the dashboard server path, and the exact glyph `truncateToWidth` ends a clipped line
 * with.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getDashboardStats, syncAllSessions } from "@veyyon/stats/aggregator";
import { closeDb } from "@veyyon/stats/db";
import { createSyncProgressReporter, formatStatsSummary, type StatsTextStyle } from "@veyyon/stats/summary";
import { getSessionsDir } from "@veyyon/utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-summary-");

const run = promisify(execFile);
const ENTRY = path.join(import.meta.dirname, "../src/index.ts");
const NOW = Date.now();

function assistant(id: string, model: string, timestamp: number): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model,
			stopReason: "stop",
			timestamp,
			duration: 1000,
			ttft: 250,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
		},
	};
}

/** Model `model-<i>` in folder `/work/f<i>` with `i + 1` requests, for i in 0..count-1. */
async function seed(count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		const dir = path.join(getSessionsDir(), `--work--f${i}`);
		await fs.mkdir(dir, { recursive: true });
		const header = {
			type: "session",
			version: 1,
			id: `s${i}`,
			timestamp: new Date(NOW).toISOString(),
			cwd: `/work/f${i}`,
		};
		const entries = Array.from({ length: i + 1 }, (_, j) => assistant(`m${i}-${j}`, `model-${i}`, NOW - j * 1000));
		await fs.writeFile(
			path.join(dir, "01.jsonl"),
			`${[header, ...entries].map(e => JSON.stringify(e)).join("\n")}\n`,
		);
	}
	await syncAllSessions({ workers: 1 });
}

function rowsUnder(summary: string, heading: string): string[] {
	const lines = summary.split("\n");
	const start = lines.indexOf(heading);
	if (start < 0) return [];
	const rows: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.startsWith("  ")) break;
		rows.push(line);
	}
	return rows;
}

describe("the stats summary", () => {
	it("lists the ten busiest models and folders, busiest first", async () => {
		await seed(12);
		const summary = formatStatsSummary(await getDashboardStats());

		const models = rowsUnder(summary, "By Model:");
		expect(models).toHaveLength(10);
		expect(models[0]).toStartWith("  model-11: 12 reqs");
		expect(models[9]).toStartWith("  model-2: 3 reqs");
		const folders = rowsUnder(summary, "By Folder:");
		expect(folders).toHaveLength(10);
		expect(folders[0]).toStartWith("  /work/f11: 12 reqs");
		expect(summary).toContain("  Requests: 78 (0 errors)");
		expect(summary).toContain("  Avg Duration: 1.0s");
		expect(summary).toContain("  Avg Tokens/s: 50.0");
	});

	it("leaves out empty tables and marks timings it has no requests for", async () => {
		const summary = formatStatsSummary(await getDashboardStats());

		expect(summary).not.toContain("By Model:");
		expect(summary).not.toContain("By Folder:");
		expect(summary).not.toContain("Avg Tokens/s");
		expect(summary).toContain("  Avg Duration: -");
		expect(summary).toContain("  Avg TTFT: -");
	});

	it("applies the style to the headings and to nothing else", async () => {
		await seed(1);
		const style: StatsTextStyle = { heading: t => `<${t}>`, dim: t => t, accent: t => t };
		const stats = await getDashboardStats();

		const expected = formatStatsSummary(stats)
			.replace("\n=== AI Usage Statistics ===\n", "<\n=== AI Usage Statistics ===\n>")
			.replace("Overall:", "<Overall:>")
			.replace("\nBy Model:", "<\nBy Model:>")
			.replace("\nBy Folder:", "<\nBy Folder:>");
		expect(formatStatsSummary(stats, style)).toBe(expected);
	});
});

interface FakeTerminal {
	isTTY: boolean;
	columns: number;
	writes: string[];
	write(text: string): boolean;
}

function terminal(isTTY: boolean, columns = 80): FakeTerminal {
	return {
		isTTY,
		columns,
		writes: [],
		write(text) {
			this.writes.push(text);
			return true;
		},
	};
}

describe("the sync progress line", () => {
	it("draws nothing on a stream that is not a terminal", () => {
		const stream = terminal(false);
		const progress = createSyncProgressReporter(stream);
		progress.onProgress({ current: 1, total: 1, processed: 1, sessionFile: "/x/sessions/a.jsonl" });
		progress.finish();
		expect(stream.writes).toEqual([]);
	});

	it("draws the counter and the file below the sessions directory, then erases the line", () => {
		const stream = terminal(true);
		const progress = createSyncProgressReporter(stream);
		progress.onProgress({ current: 2, total: 2, processed: 5, sessionFile: "/home/u/sessions/--p--/01.jsonl" });
		progress.finish();
		const line = "[2/2] 100%  --p--/01.jsonl";
		expect(stream.writes).toEqual([`\r${line}`, `\r${" ".repeat(line.length)}\r`]);
	});

	it("keeps the line inside the terminal width", () => {
		const stream = terminal(true, 20);
		const progress = createSyncProgressReporter(stream);
		progress.onProgress({ current: 1, total: 1, processed: 1, sessionFile: `/s/sessions/${"x".repeat(60)}.jsonl` });
		expect(Bun.stringWidth(stream.writes[0]?.slice(1) ?? "")).toBeLessThanOrEqual(19);
	});

	it("skips a redraw inside 33 ms but always draws the last file", () => {
		const stream = terminal(true);
		const progress = createSyncProgressReporter(stream);
		const event = { total: 3, processed: 0, sessionFile: "/s/sessions/a.jsonl" };
		progress.onProgress({ ...event, current: 1 });
		progress.onProgress({ ...event, current: 2 });
		progress.onProgress({ ...event, current: 3 });
		expect(stream.writes.map(write => write.trimEnd().split(" ")[0])).toEqual(["\r[1/3]", "\r[3/3]"]);
	});
});

describe("the standalone stats entry point", () => {
	it("prints only the JSON document on stdout with --json", async () => {
		await seed(2);
		closeDb();
		const { stdout } = await run(process.execPath, [ENTRY, "--json"], { env: process.env });
		expect(JSON.parse(stdout).overall.totalRequests).toBe(3);
	});

	it("prints the shared summary with --sync", async () => {
		await seed(2);
		closeDb();
		const { stdout } = await run(process.execPath, [ENTRY, "--sync"], { env: process.env });
		expect(stdout).toBe(`${formatStatsSummary(await getDashboardStats())}\n`);
	});
});
