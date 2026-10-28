/**
 * Regression test for issue #1592: an MCP stdio server that exits immediately
 * after completing initialize + tools/list must not trigger an unbounded
 * respawn loop.
 *
 * The reporter's agent forked 66 487 PHP child processes in ~7 minutes
 * (~158 spawns/sec) before macOS force-rebooted. The crashing fixture below
 * models that pathology: each spawn answers the handshake and exits cleanly,
 * which fires `transport.onClose` → `reconnectServer` with no rate limiter
 * in the unpatched build.
 *
 * The contract this test defends: per-server crash bursts are capped so that
 * even a fast-crashing stdio server stays well below the OS process budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { once } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@veyyon/coding-agent/mcp/client";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import type { MCPServerConnection, MCPStdioServerConfig, MCPTransport } from "@veyyon/coding-agent/mcp/types";
import { attachFaultSink, type Fault, removeSyncWithRetries } from "@veyyon/utils";
import { driveFakeTime, installFakeTime } from "./helpers/fake-time";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "crash-after-init-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCP reconnect storm (issue #1592)", () => {
	let workDir: string;
	let spawnLog: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-mcp-storm-"));
		spawnLog = path.join(workDir, "spawns.log");
		fs.writeFileSync(spawnLog, "");
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	/** Milliseconds from the first spawn to each spawn, one entry per server process started. */
	function spawnOffsetsMs(): number[] {
		const text = fs.readFileSync(spawnLog, "utf8");
		const times = text
			.split("\n")
			.filter(line => line.trim().length > 0)
			.map(line => Number(line.split(" ")[1]));
		return times.map(time => time - (times[0] ?? time));
	}

	it("stops respawning after a burst of immediate exits", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { VEYYON_TEST_SPAWN_LOG: spawnLog },
		};

		const faults: Fault[] = [];
		const detach = attachFaultSink(fault => {
			if (fault.source === "mcp") faults.push(fault);
		});
		try {
			await manager.connectServers({ crashy: config }, {});
			// Wait for the circuit breaker to trip rather than blind-sleeping a
			// fixed budget. During the storm `getConnectionStatus` is always
			// "connected" or "connecting" (`#pendingReconnections` is set
			// synchronously before any await in `#doReconnect`); it only reports
			// "disconnected" once `#tripReconnectBreaker` opens, tears down the
			// stale connection, and detaches `onClose` so no further spawns fire.
			// That makes the terminal state a race-free signal: poll for it and
			// return the instant the storm is capped instead of waiting out a
			// fixed 3s. Generous deadline stays well under the 15s test timeout.
			const deadline = Date.now() + 10_000;
			while (manager.getConnectionStatus("crashy") !== "disconnected" && Date.now() < deadline) {
				await Bun.sleep(5);
			}

			const offsets = spawnOffsetsMs();
			const spawns = offsets.length;
			// `RECONNECT_BURST_LIMIT` (5) is the per-server reconnect cap inside
			// the burst window. The initial connect from `connectServers` adds
			// one more spawn. On the "initialize + tools/list succeed, then
			// exit" path the inner retry-with-backoff in `#doReconnect` never
			// fires, so the steady-state ceiling is
			// `1 + RECONNECT_BURST_LIMIT + 1` ≈ 7 spawns. 10 leaves room for
			// scheduling jitter without weakening the bound.
			expect(spawns).toBeLessThanOrEqual(10);
			// Sanity check: we did spawn at least once. If the fixture never ran
			// the regression target is wrong and the test is meaningless.
			expect(spawns).toBeGreaterThan(0);

			// Once the breaker trips, the stale connection must be torn down so
			// `getConnectionStatus`/`waitForConnection` cannot hand callers a
			// dead transport. Tools stay registered in the manager's tool list
			// so the user can recover via `/mcp reconnect`.
			// On failure the received object shows when each server started and
			// what reached the fault surface, which separates a storm that
			// stalled from one that ran slowly.
			expect({
				status: manager.getConnectionStatus("crashy"),
				offsets,
				faults: faults.map(fault => fault.text),
			}).toMatchObject({ status: "disconnected" });

			// The suspension used to be a file-log line only, so the tools stayed
			// listed and every call failed with no word on the surface about why.
			const suspended = faults.filter(fault => fault.text.includes("automatic reconnects are suspended"));
			expect(suspended).toHaveLength(1);
			expect(suspended[0]?.text).toContain('MCP server "crashy" exited');
			expect(suspended[0]?.text).toContain("/mcp reconnect crashy");
		} finally {
			detach();
			await manager.disconnectAll();
		}
	}, 15_000);
});

/**
 * WHY: a transport close that lands while the reconnection which produced that
 * transport is still settling used to join the pending reconnection instead of
 * starting a new one. The pending reconnection then returned the closed
 * connection, the manager kept it registered, `getConnectionStatus` reported
 * "connected", and nothing reconnected it or tripped the crash breaker. A
 * transport whose close does not fail an in-flight request reaches that
 * ordering: the event stream of a streamable-HTTP server can end while the
 * tool list of a reconnection is in flight, and the list is still answered.
 *
 * The class closed: every close of a registered connection leads to either a
 * reconnect or the breaker, whatever the reconnection state at the moment of
 * the close, and a close of a connection a reconnection already replaced
 * starts nothing. Not caught here: a defect that unregisters a live
 * connection without closing it, since no close ever arrives for it.
 */
describe("MCP close while a reconnection settles", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	/**
	 * Every connect yields a fresh in-process connection; the returned list holds
	 * them at the position of the connect that started them. `beforeConnect` runs
	 * ahead of each connect with that position.
	 */
	function standInConnections(beforeConnect?: (index: number) => Promise<void>): MCPServerConnection[] {
		const connections: MCPServerConnection[] = [];
		let connects = 0;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async (name, config) => {
			const index = connects++;
			await beforeConnect?.(index);
			let open = true;
			const transport: MCPTransport = {
				get connected() {
					return open;
				},
				request: async () => {
					throw new Error("the stand-in server answers no request beyond the handshake");
				},
				notify: async () => {},
				close: async () => {
					open = false;
				},
			};
			const connection: MCPServerConnection = {
				name,
				config,
				transport,
				serverInfo: { name: "crash-after-init", version: "1.0.0" },
				capabilities: { tools: {} },
			};
			connections[index] = connection;
			return connection;
		});
		return connections;
	}

	/** A transport's close: the transport reports itself closed, then `onClose` fires. */
	async function endTransport(connection: MCPServerConnection): Promise<void> {
		await connection.transport.close();
		connection.transport.onClose?.();
	}

	const config: MCPStdioServerConfig = { type: "stdio", command: "crash-after-init" };

	it("keeps reconnecting a server whose event stream ends before its reconnection returns", async () => {
		// A streamable-HTTP server that ends every open event stream when it is
		// asked for its tool list and answers the list 30ms later, so the close
		// of each connection lands while the reconnection that produced it is
		// still waiting for that list.
		const streams = new Set<http.ServerResponse>();
		let initializes = 0;
		const server = http.createServer((request, response) => {
			if (request.method === "GET") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.write(": open\n\n");
				streams.add(response);
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(200).end();
				return;
			}
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const message: { id?: number | string; method: string } = JSON.parse(
					Buffer.concat(chunks).toString("utf8"),
				);
				if (message.id === undefined) {
					response.writeHead(202).end();
					return;
				}
				const answer = (body: { result: unknown } | { error: { code: number; message: string } }) => {
					response
						.writeHead(200, { "Content-Type": "application/json" })
						.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }));
				};
				if (message.method === "initialize") {
					initializes++;
					answer({
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "stream-ends-on-list", version: "1.0.0" },
						},
					});
					return;
				}
				if (message.method === "tools/list") {
					for (const stream of streams) stream.end();
					streams.clear();
					setTimeout(() => answer({ result: { tools: [] } }), 30);
					return;
				}
				answer({ error: { code: -32601, message: `no method ${message.method}` } });
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("the test server has no TCP address");

		const manager = new MCPManager(os.tmpdir());
		const faults: Fault[] = [];
		const detach = attachFaultSink(fault => {
			if (fault.source === "mcp") faults.push(fault);
		});
		try {
			await manager.connectServers({ ending: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` } }, {});
			// Six connections at 30ms each settle in well under a second; the
			// deadline sits under the test timeout so a stall fails on the status.
			const deadline = Date.now() + 3_000;
			while (manager.getConnectionStatus("ending") !== "disconnected" && Date.now() < deadline) {
				await Bun.sleep(5);
			}

			expect(manager.getConnectionStatus("ending")).toBe("disconnected");
			// The initial connection plus `RECONNECT_BURST_LIMIT` (5) reconnects;
			// the sixth reconnect request trips the breaker instead of connecting.
			expect(initializes).toBe(6);
			const suspended = faults.filter(fault => fault.text.includes("automatic reconnects are suspended"));
			expect(suspended).toHaveLength(1);
		} finally {
			detach();
			await manager.disconnectAll();
			server.closeAllConnections();
			server.close();
		}
	}, 10_000);

	it("starts no second reconnect for a connection its reconnection already replaced", async () => {
		const connections = standInConnections();
		// The initial connection ends after its tool list; the first reconnection
		// ends before its tool list is answered, so that attempt fails and the
		// reconnection retries after its backoff; the retry stays up.
		vi.spyOn(mcpClient, "listTools").mockImplementation(async connection => {
			const index = connections.indexOf(connection);
			if (index === 0) {
				await endTransport(connection);
				return [];
			}
			if (index === 1) {
				await endTransport(connection);
				throw new Error("the stand-in server exited before answering tools/list");
			}
			return [];
		});

		installFakeTime();
		const manager = new MCPManager(os.tmpdir());
		try {
			await driveFakeTime(manager.connectServers({ crashy: config }, {}));
			await driveFakeTime(
				(async () => {
					while (manager.getConnectionStatus("crashy") !== "connected" || connections.length < 3) {
						await Bun.sleep(10);
					}
				})(),
			);
			// Any reconnect the replaced connection's close still owed would have
			// started by now: the retry's own backoff is 500ms.
			await driveFakeTime(Bun.sleep(5_000));

			expect(connections).toHaveLength(3);
			expect(manager.getConnection("crashy")).toBe(connections[2]);
			expect(connections[2]?.transport.connected).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("starts no reconnect for an initial connection a manual reconnect superseded", async () => {
		// The initial connect is held until the manual reconnect has registered
		// its own connection, so the initial connection lands unregistered.
		const initialHeld = Promise.withResolvers<void>();
		const connections = standInConnections(async index => {
			if (index === 0) await initialHeld.promise;
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		const manager = new MCPManager(os.tmpdir());
		try {
			const initial = manager.connectServers({ crashy: config }, {});
			const manual = await manager.reconnectServer("crashy", { manual: true });
			initialHeld.resolve();
			await initial;
			const [superseded, registered] = connections;
			expect(manual).toBe(registered);
			expect(manager.getConnection("crashy")).toBe(registered);

			if (!superseded) throw new Error("the initial connect produced no connection");
			await endTransport(superseded);
			await Bun.sleep(5);

			expect(connections).toHaveLength(2);
			expect(manager.getConnection("crashy")).toBe(registered);
			expect(registered?.transport.connected).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	});
});
