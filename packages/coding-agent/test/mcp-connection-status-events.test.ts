import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@veyyon/coding-agent/mcp/startup-events";
import type { MCPServerConfig, MCPServerConnection } from "@veyyon/coding-agent/mcp/types";
import { removeSyncWithRetries } from "@veyyon/utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const BUN_EXEC = process.execPath;

/** The message `validateServerConfig` gives a stdio server with no command: what
 * `/mcp list` shows and the operator's next step, so the test pins it whole. */
function noCommandError(name: string): string {
	return (
		`Server "${name}" is a stdio server with no "command" to spawn. Fix: add the executable, for example ` +
		'`"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]`. ' +
		'If this is a remote server, set `"type": "http"` and give it a "url" instead.'
	);
}

interface StatusRecorder {
	events: McpConnectionStatusEvent[];
	/** Resolve on the first event the matcher accepts — recorded before or after this call. */
	next(match: (event: McpConnectionStatusEvent) => boolean): Promise<void>;
	stop(): void;
}

/**
 * Record status events and await the one a case is about. Every transition here
 * is produced by a real subprocess, so the event is the signal: a polled budget
 * is a guess at how long a spawn takes, and no guess is "enough" on a loaded host.
 */
function recordStatus(manager: MCPManager): StatusRecorder {
	const events: McpConnectionStatusEvent[] = [];
	const waiters = new Set<{ match: (event: McpConnectionStatusEvent) => boolean; resolve: () => void }>();
	const stop = manager.addConnectionStatusListener(event => {
		events.push(event);
		for (const waiter of [...waiters]) {
			if (!waiter.match(event)) continue;
			waiters.delete(waiter);
			waiter.resolve();
		}
	});
	return {
		events,
		next(match) {
			if (events.some(match)) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.add({ match, resolve });
			return promise;
		},
		stop,
	};
}

describe("MCPManager connection status events", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-mcp-status-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("emits connecting, connected, and failed updates for startup status", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const connected = Promise.withResolvers<void>();
		const success: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};
		const invalid: MCPServerConfig = { type: "stdio", command: "" };

		try {
			const result = await manager.connectServers({ alpha: success, broken: invalid }, {}, event => {
				events.push(event);
				if (event.type === "connected" && event.serverName === "alpha") connected.resolve();
			});

			// A config error is decided before any spawn, so it is already in the
			// returned result.
			expect(result.errors.get("broken")).toBe(noCommandError("broken"));
			// A spawn is not: `connectServers` stops waiting after
			// STARTUP_TOOL_WAIT_MS and serves deferred tools, so on a loaded host it
			// returns with `alpha` still connecting. The event is the signal — a poll
			// would need a budget, and that budget is the flake.
			await connected.promise;
			expect(manager.getConnectionStatus("alpha")).toBe("connected");
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["alpha", "broken"] },
				{
					type: "failed",
					serverName: "broken",
					error: noCommandError("broken"),
					// A server from veyyon's own config — not imported from another tool.
					foreign: false,
				},
				{ type: "connected", serverName: "alpha" },
			]);
		} finally {
			await manager.disconnectAll();
		}
	}, 30_000);

	it("reports a dropped transport and the reconnect that restores it", async () => {
		const manager = new MCPManager(workDir);
		const witness = recordStatus(manager);
		const released = recordStatus(manager);
		const config: MCPServerConfig = { type: "stdio", command: BUN_EXEC, args: [FIXTURE_PATH] };

		try {
			await manager.connectServers({ alpha: config }, {});
			// `connectServers` returns after STARTUP_TOOL_WAIT_MS even with the spawn
			// still in flight, so the transport to drop may not exist yet.
			await manager.waitForConnection("alpha");
			// Startup belongs to the `onStatus` caller; this subscriber exists for what
			// happens after that caller has already returned.
			expect(witness.events).toEqual([]);

			// The unsubscribe is the disposal contract: a surface that is gone must not
			// keep being told, and the manager must not hold it alive. Released before the
			// drop, so the whole cycle below plays out with only the witness attached.
			released.stop();

			manager.getConnection("alpha")?.transport.onClose?.();
			await witness.next(event => event.type === "connected");

			expect(witness.events).toEqual([
				{ type: "connecting", serverNames: ["alpha"] },
				{ type: "connected", serverName: "alpha" },
			]);
			expect(manager.getConnectionStatus("alpha")).toBe("connected");
			// Neither event above reached the recorder that left: a `stop()` that did not
			// detach would have handed it both.
			expect(released.events).toEqual([]);
		} finally {
			witness.stop();
			released.stop();
			await manager.disconnectAll();
		}
	}, 30_000);

	it("reports a reconnect that runs out of attempts, and keeps the reason for /mcp list", async () => {
		const manager = new MCPManager(workDir);
		// The fixture is copied into the work dir so it can be deleted under a live
		// connection: every respawn then fails before the handshake, which is the only
		// deterministic way to reach the give-up branch.
		const copy = path.join(workDir, "server.ts");
		fs.copyFileSync(FIXTURE_PATH, copy);
		const status = recordStatus(manager);
		const config: MCPServerConfig = { type: "stdio", command: BUN_EXEC, args: [copy] };

		try {
			await manager.connectServers({ alpha: config }, {});
			await manager.waitForConnection("alpha");
			fs.rmSync(copy);

			manager.getConnection("alpha")?.transport.onClose?.();
			await status.next(event => event.type === "failed");

			const failed = status.events.find(event => event.type === "failed");
			expect(failed?.serverName).toBe("alpha");
			// The zone counts the failure and points at `/mcp list` for the reason, so
			// the two surfaces have to be saying the same thing.
			expect(manager.getLastError("alpha")).toBe(failed?.error);
			expect(status.events.some(event => event.type === "connected")).toBe(false);
		} finally {
			status.stop();
			await manager.disconnectAll();
		}
	}, 30_000);

	it("reports the crash breaker suspending a server", async () => {
		const manager = new MCPManager(workDir);
		const status = recordStatus(manager);
		const config: MCPServerConfig = { type: "stdio", command: BUN_EXEC, args: [FIXTURE_PATH] };

		try {
			await manager.connectServers({ alpha: config }, {});
			await manager.waitForConnection("alpha");

			// A flapping server: `reconnectServer` is what the transport's `onClose` calls,
			// and every automatic call counts against the burst window, so the sixth is
			// refused rather than attempted. Awaiting each attempt is what stops the calls
			// deduping into one another, and it is what keeps them inside the window.
			const attempts: Array<MCPServerConnection | null> = [];
			for (let cycle = 0; cycle < 6; cycle++) {
				attempts.push(await manager.reconnectServer("alpha"));
			}

			// Five reconnects, then the breaker: a suspension is a refusal to connect, not
			// a failed connect.
			expect(attempts.slice(0, 5).filter(result => result !== null)).toHaveLength(5);
			expect(attempts[5]).toBeNull();

			// The suspension reaches the surface, not only the file log. `/mcp list` reads
			// `getLastError`, so a suspension it cannot explain would send the operator to
			// a list that says only "disconnected".
			const failed = status.events.filter(event => event.type === "failed");
			expect(failed).toHaveLength(1);
			expect(failed[0]?.serverName).toBe("alpha");
			expect(failed[0]?.error).toContain("suspended");
			expect(manager.getLastError("alpha")).toBe(failed[0]?.error);
			expect(manager.getConnectionStatus("alpha")).toBe("disconnected");
		} finally {
			status.stop();
			await manager.disconnectAll();
		}
	}, 90_000);
});
