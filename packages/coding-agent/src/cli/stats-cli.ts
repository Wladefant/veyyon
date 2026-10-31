/**
 * Stats CLI command handlers.
 *
 * Handles `veyyon stats` subcommand for viewing AI usage statistics.
 */

import type { StatsTextStyle } from "@veyyon/stats";
import chalk from "chalk";
import { openPath } from "../utils/open";

const TERMINAL_STYLE: StatsTextStyle = { heading: chalk.bold, dim: chalk.dim, accent: chalk.cyan };

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	json: boolean;
	summary: boolean;
}

// =============================================================================
// Argument Parser
// =============================================================================

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const {
		createSyncProgressReporter,
		formatStatsSummary,
		getDashboardStats,
		syncAllSessions,
		getTotalMessageCount,
		startServer,
		closeDb,
	} = await import("@veyyon/stats");

	// Sync session files first
	const progress = createSyncProgressReporter(process.stderr, TERMINAL_STYLE);
	process.stderr.write("Syncing session files...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	// stderr, like "Syncing…": in --json mode stdout must carry only the JSON
	// document or `veyyon stats -j | jq` fails to parse.
	process.stderr.write(`Synced ${processed} new entries from ${files} files (${total} total)\n\n`);

	if (cmd.json) {
		const stats = await getDashboardStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (cmd.summary) {
		console.log(formatStatsSummary(await getDashboardStats(), TERMINAL_STYLE));
		return;
	}

	// Start the dashboard server
	const { port } = await startServer(cmd.port);
	console.log(chalk.green(`Dashboard available at: http://localhost:${port}`));

	// Open browser
	const url = `http://localhost:${port}`;
	openPath(url);

	console.log("Press Ctrl+C to stop\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

// =============================================================================
// Help
// =============================================================================
