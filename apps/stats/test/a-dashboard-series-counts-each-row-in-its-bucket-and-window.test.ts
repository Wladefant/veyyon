/**
 * WHY: the dashboard's five bucketed series (requests, model usage, model performance, cost and
 * tool calls) share one query builder. A wrong bucket expression, a dropped `GROUP BY` column or a
 * cutoff that reads `null` as "the default window" would still return rows, so each series is
 * checked against hand-counted buckets for all three cutoff forms: omitted (the default window),
 * `null` (every row) and a number (rows at or after it).
 *
 * Not caught: the dashboard's choice of which cutoff to pass for a named range; `db-range.test.ts`
 * covers that path for the aggregate stats.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { emptyUsage } from "@veyyon/catalog/models";
import {
	getCostTimeSeries,
	getModelPerformanceSeries,
	getModelTimeSeries,
	getTimeSeries,
	getToolTimeSeries,
	initDb,
	insertMessageStats,
	insertToolCalls,
} from "@veyyon/stats/db";
import type { MessageStats, ToolCallStats } from "@veyyon/stats/types";
import { DAY_MS } from "@veyyon/utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-series-");

const HOUR_MS = 60 * 60 * 1000;
// Three days back, on a bucket boundary, so every default window below includes it.
const DAY0 = Math.floor(Date.now() / DAY_MS) * DAY_MS - 3 * DAY_MS;
const DAY1 = DAY0 + DAY_MS;
// Older than every default window, so only a `null` cutoff reads it.
const OLD = DAY0 - 40 * DAY_MS;

interface Seed {
	entryId: string;
	model: string;
	timestamp: number;
	error?: boolean;
	ttft: number;
	tokens: number;
	cost: number;
}

const SEEDS: Seed[] = [
	{ entryId: "old", model: "m1", timestamp: OLD, ttft: 900, tokens: 1, cost: 1 },
	{ entryId: "d0-a", model: "m1", timestamp: DAY0, error: true, ttft: 100, tokens: 10, cost: 0.5 },
	{ entryId: "d0-b", model: "m1", timestamp: DAY0 + HOUR_MS, ttft: 300, tokens: 20, cost: 0.25 },
	{ entryId: "d0-c", model: "m2", timestamp: DAY0 + 2 * HOUR_MS, ttft: 60, tokens: 4, cost: 0.125 },
	{ entryId: "d1-a", model: "m2", timestamp: DAY1, ttft: 50, tokens: 5, cost: 2 },
];

/**
 * Rows in bucket order, with rows sharing a bucket sorted by `key`: the series return buckets oldest
 * first and give rows inside one bucket no order.
 */
function inBuckets<T extends { timestamp: number }>(rows: T[], key: (row: T) => string): T[] {
	const timestamps = rows.map(row => row.timestamp);
	expect(timestamps).toEqual(timestamps.toSorted((a, b) => a - b));
	return rows.toSorted((a, b) => a.timestamp - b.timestamp || key(a).localeCompare(key(b)));
}

function message(seed: Seed): MessageStats {
	return {
		sessionFile: "/repo/session.jsonl",
		entryId: seed.entryId,
		folder: "/repo",
		model: seed.model,
		provider: "openai",
		api: "openai-responses",
		timestamp: seed.timestamp,
		duration: 1000,
		ttft: seed.ttft,
		stopReason: seed.error ? "error" : "stop",
		errorMessage: seed.error ? "boom" : null,
		usage: {
			...emptyUsage(),
			output: 10,
			totalTokens: seed.tokens,
			cost: { ...emptyUsage().cost, total: seed.cost },
		},
		agentType: "main",
	};
}

function toolCall(seed: Seed, toolName: string, index: number): ToolCallStats {
	return {
		sessionFile: "/repo/session.jsonl",
		entryId: seed.entryId,
		toolCallId: `${seed.entryId}-${index}`,
		folder: "/repo",
		toolName,
		model: seed.model,
		provider: "openai",
		timestamp: seed.timestamp,
		agentType: "main",
		callsInTurn: 1,
		argsChars: 2,
	};
}

beforeEach(async () => {
	await initDb();
	insertMessageStats(SEEDS.map(message));
	insertToolCalls([
		toolCall(SEEDS[0], "read", 0),
		toolCall(SEEDS[1], "read", 0),
		toolCall(SEEDS[1], "grep", 1),
		toolCall(SEEDS[2], "read", 0),
		toolCall(SEEDS[4], "read", 0),
	]);
});

describe("dashboard series", () => {
	it("count requests, errors, tokens and cost per bucket inside the default window", () => {
		expect(getTimeSeries(24 * 7, undefined, DAY_MS)).toEqual([
			{ timestamp: DAY0, requests: 3, errors: 1, tokens: 34, cost: 0.875 },
			{ timestamp: DAY1, requests: 1, errors: 0, tokens: 5, cost: 2 },
		]);
	});

	it("read every row for a null cutoff and only rows at or after a numeric one", () => {
		expect(inBuckets(getModelTimeSeries(14, null), row => row.model)).toEqual([
			{ timestamp: OLD, model: "m1", provider: "openai", requests: 1 },
			{ timestamp: DAY0, model: "m1", provider: "openai", requests: 2 },
			{ timestamp: DAY0, model: "m2", provider: "openai", requests: 1 },
			{ timestamp: DAY1, model: "m2", provider: "openai", requests: 1 },
		]);
		expect(inBuckets(getModelTimeSeries(14, DAY0 + HOUR_MS), row => row.model)).toEqual([
			{ timestamp: DAY0, model: "m1", provider: "openai", requests: 1 },
			{ timestamp: DAY0, model: "m2", provider: "openai", requests: 1 },
			{ timestamp: DAY1, model: "m2", provider: "openai", requests: 1 },
		]);
	});

	it("split a bucket by model and average its latency", () => {
		expect(inBuckets(getModelPerformanceSeries(14, undefined), row => row.model)).toEqual([
			{ timestamp: DAY0, model: "m1", provider: "openai", requests: 2, avgTtft: 200, avgTokensPerSecond: 10 },
			{ timestamp: DAY0, model: "m2", provider: "openai", requests: 1, avgTtft: 60, avgTokensPerSecond: 10 },
			{ timestamp: DAY1, model: "m2", provider: "openai", requests: 1, avgTtft: 50, avgTokensPerSecond: 10 },
		]);
	});

	it("bucket cost by day and model across its 90-day default window", () => {
		const series = inBuckets(getCostTimeSeries(90, undefined), row => row.model);
		expect(series.map(point => [point.timestamp, point.model, point.requests, point.cost])).toEqual([
			[OLD, "m1", 1, 1],
			[DAY0, "m1", 2, 0.75],
			[DAY0, "m2", 1, 0.125],
			[DAY1, "m2", 1, 2],
		]);
		expect(getCostTimeSeries(30, undefined).map(point => point.timestamp)).toEqual([DAY0, DAY0, DAY1]);
	});

	it("count tool calls per bucket and tool", () => {
		expect(inBuckets(getToolTimeSeries(14, undefined), row => row.tool)).toEqual([
			{ timestamp: DAY0, tool: "grep", calls: 1, errors: 0 },
			{ timestamp: DAY0, tool: "read", calls: 2, errors: 0 },
			{ timestamp: DAY1, tool: "read", calls: 1, errors: 0 },
		]);
	});
});
