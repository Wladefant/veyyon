#!/usr/bin/env bun
/**
 * Subprocess smoke fixture for supervisor unexpected death reporting.
 *
 * Writes heartbeat metadata to disk, writes stderr bytes beyond the configured
 * rotation bound (including oversized chunks), and exits without writing an
 * exit tombstone file (.exited).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeartbeat } from "@veyyon/utils/session-heartbeat";

const args = process.argv.slice(2);
let heartbeatDir = "";
let totalStderrBytes = 2500;
let chunkSize = 600;
let exitCode = 42;

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--heartbeat-dir" && args[i + 1]) {
		heartbeatDir = args[++i];
	} else if (args[i] === "--bytes" && args[i + 1]) {
		totalStderrBytes = Number.parseInt(args[++i], 10);
	} else if (args[i] === "--chunk-size" && args[i + 1]) {
		chunkSize = Number.parseInt(args[++i], 10);
	} else if (args[i] === "--exit-code" && args[i + 1]) {
		exitCode = Number.parseInt(args[++i], 10);
	}
}

if (!heartbeatDir) {
	process.stderr.write("Missing required --heartbeat-dir\n");
	process.exit(1);
}

fs.mkdirSync(heartbeatDir, { recursive: true });

const pid = process.pid;
const now = new Date().toISOString();

const heartbeat: SessionHeartbeat = {
	pid,
	startIdentity: "smoke-boot:start",
	sessionId: "smoke-fixture-session",
	phase: "tool",
	startedAt: now,
	heartbeatAt: now,
	activeLanes: 1,
	lanes: 1,
	rssBytes: 104857600,
	freeMemBytes: 524288000,
	heapTotal: 50000000,
	heapUsed: 30000000,
	handleCount: 88,
	consoleLogPath: path.join(heartbeatDir, `${pid}.console.log`),
	consoleCtrlStatus: "installed",
	consoleCtrlInstalled: true,
	resourceHistory: [
		{
			at: now,
			rssBytes: 104857600,
			handleCount: 88,
		},
	],
};

fs.writeFileSync(path.join(heartbeatDir, `${pid}.json`), JSON.stringify(heartbeat));

// Write stderr beyond bound
let bytesWritten = 0;
while (bytesWritten < totalStderrBytes) {
	const currentChunkSize = Math.min(chunkSize, totalStderrBytes - bytesWritten);
	const chunk = Buffer.alloc(currentChunkSize, "E");
	process.stderr.write(chunk);
	bytesWritten += currentChunkSize;
}

// Exit abruptly without tombstone (.exited)
process.exit(exitCode);
