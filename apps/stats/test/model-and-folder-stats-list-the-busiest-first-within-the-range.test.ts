/**
 * `veyyon stats` prints the first ten rows of the per-model and per-folder tables, so those tables
 * must come back with the busiest model and folder first, and every table must count only the
 * requests inside the selected range. The three aggregate queries share one implementation; these
 * tests pin its grouping, its order and its range against synced sessions.
 *
 * Not covered: ties in request count, whose order SQLite leaves unspecified.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { emptyUsage } from "@veyyon/catalog/models";
import { syncAllSessions } from "@veyyon/stats/aggregator";
import { getOverallStats, getStatsByFolder, getStatsByModel } from "@veyyon/stats/db";
import { DAY_MS, getSessionsDir } from "@veyyon/utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-busiest-first-");

const NOW = Date.now();
const OLD = NOW - 10 * DAY_MS;

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
			usage: { ...emptyUsage(), input: 10, output: 5, totalTokens: 15 },
		},
	};
}

async function writeSession(dirName: string, cwd: string, entries: Record<string, unknown>[]): Promise<void> {
	const dir = path.join(getSessionsDir(), dirName);
	await fs.mkdir(dir, { recursive: true });
	const header = { type: "session", version: 1, id: dirName, timestamp: new Date(OLD).toISOString(), cwd };
	await fs.writeFile(path.join(dir, "01.jsonl"), `${[header, ...entries].map(e => JSON.stringify(e)).join("\n")}\n`);
}

/** gpt-5.4 in /work/quiet: one recent request. gpt-5.5 in /work/busy: two recent and three old. */
async function seed(): Promise<void> {
	await writeSession("--work--quiet", "/work/quiet", [assistant("q1", "gpt-5.4", NOW)]);
	await writeSession("--work--busy", "/work/busy", [
		assistant("b1", "gpt-5.5", NOW),
		assistant("b2", "gpt-5.5", NOW),
		assistant("b3", "gpt-5.5", OLD),
		assistant("b4", "gpt-5.5", OLD),
		assistant("b5", "gpt-5.5", OLD),
	]);
	await syncAllSessions();
}

describe("aggregate stats tables", () => {
	it("list the model and the folder with the most requests first", async () => {
		await seed();

		expect(getStatsByModel().map(row => [row.model, row.totalRequests])).toEqual([
			["gpt-5.5", 5],
			["gpt-5.4", 1],
		]);
		const folders = getStatsByFolder().map(row => row.totalRequests);
		expect(folders).toEqual([5, 1]);
		expect(getOverallStats().totalRequests).toBe(6);
	});

	it("count only the requests at or after the range start", async () => {
		await seed();
		const cutoff = NOW - DAY_MS;

		expect(getOverallStats(cutoff).totalRequests).toBe(3);
		expect(getStatsByModel(cutoff).map(row => [row.model, row.totalRequests])).toEqual([
			["gpt-5.5", 2],
			["gpt-5.4", 1],
		]);
		expect(getStatsByFolder(cutoff).map(row => row.totalRequests)).toEqual([2, 1]);
	});
});
