/**
 * Codex sends `x-codex-secondary-window-minutes: 0` for an account that has no secondary window.
 * That placeholder used to be cached as a "1 hour" window with no reset clock, whose required drain
 * (1.0) outranked every real 7-day window, so every new session landed on the account that had
 * served last.
 */
import { describe, expect, it } from "bun:test";
import { computeWindowRequiredDrain } from "../src/auth-storage/usage-ranking";
import type { UsageReport } from "../src/usage";
import { codexRankingStrategy, parseCodexRateLimitHeaders } from "../src/usage/openai-codex";

const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);
const WEEK_MS = 7 * 24 * 3600 * 1000;

const headers = {
	"x-codex-primary-used-percent": "44",
	"x-codex-primary-window-minutes": "10080",
	"x-codex-primary-reset-at": String(Math.floor((NOW + WEEK_MS) / 1000)),
	"x-codex-secondary-used-percent": "0",
	"x-codex-secondary-window-minutes": "0",
};

function secondaryDrain(report: UsageReport): number {
	const { secondary } = codexRankingStrategy.findWindowLimits(report, {});
	return computeWindowRequiredDrain(secondary, NOW, WEEK_MS);
}

describe("a zero-length codex header window", () => {
	it("is not reported as a window", () => {
		const report = parseCodexRateLimitHeaders(headers, NOW)!;
		expect(report.limits.map(limit => limit.id)).toEqual(["openai-codex:primary"]);
	});

	it("does not outrank a sibling with a real 7-day window, even from a report cached before the fix", () => {
		const real: UsageReport = {
			provider: "openai-codex",
			fetchedAt: NOW,
			limits: [
				{
					id: "openai-codex:primary",
					label: "7 days",
					scope: { provider: "openai-codex", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 days", durationMs: WEEK_MS, resetsAt: NOW + WEEK_MS },
					amount: { used: 0, limit: 100, remaining: 100, usedFraction: 0, remainingFraction: 1, unit: "percent" },
					status: "ok",
				},
			],
		};
		const poisoned: UsageReport = {
			...real,
			limits: [
				...real.limits,
				{
					id: "openai-codex:secondary",
					label: "1 hour",
					scope: { provider: "openai-codex", windowId: "1h", shared: true },
					window: { id: "1h", label: "1 hour", durationMs: 0 },
					amount: { used: 0, limit: 100, remaining: 100, usedFraction: 0, remainingFraction: 1, unit: "percent" },
					status: "ok",
				},
			],
		};
		expect(secondaryDrain(poisoned)).toBe(secondaryDrain(real));
	});
});
