#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { getDashboardStats, getTotalMessageCount, syncAllSessions } from "./aggregator";
import { closeDb } from "./db";
import { startServer } from "./server";
import { createSyncProgressReporter, formatStatsSummary } from "./summary";

export {
	getDashboardStats,
	getToolDashboardStats,
	getTotalMessageCount,
	type SyncOptions,
	type SyncProgress,
	smokeTestSyncWorker,
	syncAllSessions,
} from "./aggregator";
export { closeDb } from "./db";
export { startServer } from "./server";
export * from "./summary";
export type {
	AggregatedStats,
	DashboardStats,
	FolderStats,
	MessageStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
	ToolDashboardStats,
	ToolModelStats,
	ToolTimeSeriesPoint,
	ToolUsageStats,
} from "./types";

/**
 * Main CLI entry point.
 */
async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			port: { type: "string", short: "p", default: "3847" },
			json: { type: "boolean", short: "j", default: false },
			sync: { type: "boolean", short: "s", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: true,
	});

	if (values.help) {
		console.log(`
veyyon-stats - AI Usage Statistics Dashboard

Usage:
  veyyon-stats [options]

Options:
  -p, --port <port>  Port for the dashboard server (default: 3847)
  -j, --json         Output stats as JSON and exit
  -s, --sync         Sync session files and show summary
  -h, --help         Show this help message

Examples:
  veyyon-stats              # Start dashboard server
  veyyon-stats --json       # Print stats as JSON
  veyyon-stats --port 8080  # Start on custom port
  veyyon-stats --sync       # Sync and show summary
`);
		return;
	}

	try {
		const progress = createSyncProgressReporter(process.stderr);
		process.stderr.write("Syncing session files...\n");
		const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
		progress.finish();
		const total = await getTotalMessageCount();
		// stderr, like "Syncing…": with --json stdout holds only the JSON document.
		process.stderr.write(`Synced ${processed} new entries from ${files} files (${total} total)\n\n`);

		if (values.json) {
			const stats = await getDashboardStats();
			console.log(JSON.stringify(stats, null, 2));
			return;
		}

		if (values.sync) {
			console.log(formatStatsSummary(await getDashboardStats()));
			return;
		}

		// Start server
		const port = parseInt(values.port || "3847", 10);
		const { port: actualPort, stop } = await startServer(port);
		console.log(`Dashboard available at: http://localhost:${actualPort}`);
		console.log("Press Ctrl+C to stop\n");

		// Keep process running
		process.on("SIGINT", () => {
			console.log("\nShutting down...");
			stop();
			process.exit(0);
		});
	} catch (error) {
		console.error("Error:", error);
		closeDb();
		process.exit(1);
	}
}

// Run if executed directly
if (import.meta.main) {
	main();
}
