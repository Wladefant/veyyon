/**
 * The terminal side of a stats run: the progress line drawn while session files sync, and the
 * summary printed after. `veyyon stats` and the standalone `veyyon-stats` entry point both print
 * these, each with its own styling.
 */
import {
	formatCostTiered as formatCost,
	formatDuration,
	formatNumber,
	formatPercent,
	normalizePremiumRequests,
} from "@veyyon/utils";
import { truncateToWidth } from "@veyyon/utils/width";
import type { SyncProgress } from "./aggregator";
import type { DashboardStats } from "./types";

/** Styling applied to the headings, the session file name and the file counter. */
export interface StatsTextStyle {
	heading(text: string): string;
	dim(text: string): string;
	accent(text: string): string;
}

const unstyled = (text: string): string => text;

export const PLAIN_STATS_STYLE: StatsTextStyle = { heading: unstyled, dim: unstyled, accent: unstyled };

/** Rows of the per-model and per-folder tables the summary prints. */
const SUMMARY_TABLE_ROWS = 10;

/** The summary, one line per `\n`-separated row, ending with an empty row. */
export function formatStatsSummary(stats: DashboardStats, style: StatsTextStyle = PLAIN_STATS_STYLE): string {
	const { overall, byModel, byFolder } = stats;
	const lines = [
		style.heading("\n=== AI Usage Statistics ===\n"),
		style.heading("Overall:"),
		`  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`,
		`  Error Rate: ${formatPercent(overall.errorRate)}`,
		`  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`,
		`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`,
		`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`,
		`  Cache Rate: ${formatPercent(overall.cacheRate)}`,
		`  Total Cost: ${formatCost(overall.totalCost)}`,
		`  Premium Requests: ${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`,
		`  Avg Duration: ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`,
		`  Avg TTFT: ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`,
	];
	if (overall.avgTokensPerSecond !== null) lines.push(`  Avg Tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);

	if (byModel.length > 0) {
		lines.push(style.heading("\nBy Model:"));
		for (const m of byModel.slice(0, SUMMARY_TABLE_ROWS)) {
			lines.push(
				`  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost)}, ${formatPercent(m.cacheRate)} cache`,
			);
		}
	}

	if (byFolder.length > 0) {
		lines.push(style.heading("\nBy Folder:"));
		for (const f of byFolder.slice(0, SUMMARY_TABLE_ROWS)) {
			lines.push(`  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost)}`);
		}
	}

	lines.push("");
	return lines.join("\n");
}

/** A session file's path below the sessions directory, or the whole path outside it. */
function shortenSessionFile(file: string): string {
	const marker = "/sessions/";
	const idx = file.indexOf(marker);
	return idx >= 0 ? file.slice(idx + marker.length) : file;
}

export interface SyncProgressReporter {
	onProgress(event: SyncProgress): void;
	/** Erases the progress line. */
	finish(): void;
}

/** The part of a terminal stream the progress line writes to. */
export interface ProgressStream {
	readonly isTTY?: boolean;
	readonly columns?: number;
	write(text: string): unknown;
}

/**
 * A single-line progress bar on `stream`, redrawn at most every 33 ms and always for the last file.
 * Draws nothing when `stream` is not a terminal.
 */
export function createSyncProgressReporter(
	stream: ProgressStream,
	style: StatsTextStyle = PLAIN_STATS_STYLE,
): SyncProgressReporter {
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = style.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = style.accent(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}
