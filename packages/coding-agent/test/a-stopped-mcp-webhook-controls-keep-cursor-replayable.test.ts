import { expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { MCPManager } from "../src/mcp/manager";

const EVENT = "orders/changed";
const ENV_KEY = "VEYYON_MCP_TEST_WEBHOOK_STOP_SECRET";
const SECRET_BYTES = Buffer.alloc(32, 29);
const SECRET = "whsec_" + SECRET_BYTES.toString("base64");
const MAX_WAIT_MS = 6_000;

async function within<T>(promise: Promise<T>, phase: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("Timed out waiting for " + phase)), MAX_WAIT_MS);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function availablePort(): Promise<number> {
	const probe = createServer();
	const started = once(probe, "listening");
	probe.listen(0, "127.0.0.1");
	await within(started, "port probe");
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("Port probe has no address");
	const closed = once(probe, "close");
	probe.close();
	await within(closed, "port probe close");
	return address.port;
}

interface WebhookFixture {
	manager: MCPManager;
	cursors: Array<string | null>;
	controls: string[];
	controlEntered: Promise<void>;
	controlFinished: Promise<void>;
	releaseControl(): void;
	ready: Promise<void>;
	subscribeCount(): number;
	send(body: Record<string, unknown>, id: string): Promise<Response>;
	close(): Promise<void>;
}

async function fixture(truncated: boolean, reentrantStop: boolean): Promise<WebhookFixture> {
	const port = await availablePort();
	const serverErrors: unknown[] = [];
	let count = 0;
	const server: Server = createServer((request, response) => {
		void (async () => {
			const json = JSON.parse(await text(request)) as { id?: string | number; method?: string };
			if (json.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			let result: Record<string, unknown>;
			switch (json.method) {
				case "initialize":
					result = {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {}, events: { listChanged: true } },
						serverInfo: { name: "webhook-stop-test", version: "1.0.0" },
					};
					break;
				case "tools/list":
					result = { tools: [] };
					break;
				case "events/list":
					result = { events: [{ name: EVENT, inputSchema: { type: "object" }, delivery: ["webhook"] }] };
					break;
				case "events/subscribe":
					count++;
					result = {
						id: "owned-hook",
						cursor: "initial",
						refreshBefore: null,
						...(truncated ? { truncated: true } : {}),
					};
					break;
				case "events/unsubscribe":
					result = {};
					break;
				default:
					response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
						jsonrpc: "2.0", id: json.id, error: { code: -32601, message: "Synthetic method not available" },
					}));
					return;
			}
			response.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ jsonrpc: "2.0", id: json.id, result }));
		})().catch(error => {
			serverErrors.push(error);
			if (!response.headersSent) response.writeHead(500).end();
			else response.destroy();
		});
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await within(listening, "fake MCP server");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fake MCP server has no address");
	const manager = new MCPManager(process.cwd());
	const cursors: Array<string | null> = [];
	const controls: string[] = [];
	const accepted = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	manager.setOnEvent(async () => "queued" as const);
	manager.setOnEventCursor((_server, _key, cursor) => {
		cursors.push(cursor);
		ready.resolve();
	});
	manager.setOnEventControl(async (_server, _key, control) => {
		controls.push(control.type);
		accepted.resolve();
		await release.promise;
		if (reentrantStop) await manager.stopEvents();
		finished.resolve();
		return "queued" as const;
	});
	const oldSecret = process.env[ENV_KEY];
	process.env[ENV_KEY] = SECRET;
	try {
		await within(manager.connectServers({
			"webhook-stop-server": {
				type: "http",
				url: "http://127.0.0.1:" + address.port + "/mcp",
				events: { enabled: true, subscriptions: [{
					name: EVENT, mode: "webhook",
					webhook: {
						callbackUrl: "https://callback.example.test/events/orders",
						secretRef: "$" + ENV_KEY,
						listenPort: port,
					},
				}] },
			},
		}, {}), "MCP connection");
	} catch (error) {
		if (oldSecret === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = oldSecret;
		const closed = once(server, "close");
		server.close();
		server.closeAllConnections();
		await within(closed, "failed fixture close");
		throw error;
	}
	return {
		manager, cursors, controls,
		controlEntered: accepted.promise,
		controlFinished: finished.promise,
		releaseControl: () => release.resolve(),
		ready: ready.promise,
		subscribeCount: () => count,
		async send(body, id) {
			const raw = JSON.stringify(body);
			const timestamp = String(Math.floor(Date.now() / 1000));
			const signature = createHmac("sha256", SECRET_BYTES).update(id + "." + timestamp + "." + raw).digest("base64");
			return fetch("http://127.0.0.1:" + port + "/events/orders", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-MCP-Subscription-Id": "owned-hook",
					"webhook-id": id,
					"webhook-timestamp": timestamp,
					"webhook-signature": "v1," + signature,
				},
				body: raw,
			});
		},
		async close() {
			release.resolve();
			try {
				await within(manager.disconnectAll(), "webhook manager close");
			} finally {
				if (oldSecret === undefined) delete process.env[ENV_KEY];
				else process.env[ENV_KEY] = oldSecret;
				if (server.listening) {
					const closed = once(server, "close");
					server.close();
					server.closeAllConnections();
					await within(closed, "fake MCP server close");
				}
			}
			expect(serverErrors).toEqual([]);
		},
	};
}

for (const scenario of ["active-gap", "stop-gap", "stop-terminated", "stop-truncated-subscribe", "reentrant-gap", "reentrant-truncated-subscribe"] as const) {
	it("preserves webhook control ownership for " + scenario, async () => {
		const truncated = scenario === "stop-truncated-subscribe" || scenario === "reentrant-truncated-subscribe";
		const reentrantStop = scenario === "reentrant-gap" || scenario === "reentrant-truncated-subscribe";
		const session = await fixture(truncated, reentrantStop);
		try {
			if (!truncated) {
				await within(session.ready, "webhook subscription initial cursor");
				expect(session.cursors).toEqual(["initial"]);
				const body = scenario === "stop-terminated"
					? { type: "terminated", error: { code: -32023, message: "authorization revoked" } }
					: { type: "gap", cursor: "after-gap" };
				// The signed receiver accepts before responding; hold its durable callback
				// while an independent shutdown races it.
				const delivery = session.send(body, "control-" + scenario).catch(() => undefined);
				await within(session.controlEntered, "signed webhook control acceptance");
				if (scenario === "reentrant-gap") {
					// The signed receiver callback itself awaits stop; this must not
					// depend on its own stream/lifecycle completion.
					session.releaseControl();
					await within(session.controlFinished, "reentrant signed webhook shutdown");
					await within(delivery, "reentrant signed webhook response");
					await delay(40);
					expect(session.cursors).toEqual(["initial"]);
					expect(session.manager.getActiveEventSubscriptionCount()).toBe(0);
					expect(session.subscribeCount()).toBe(1);
				} else if (scenario !== "active-gap") {
					const stopped = session.manager.stopEvents();
					session.releaseControl();
					await within(stopped, "stopped webhook manager");
					await within(delivery, "stopped webhook request completion");
					await delay(40);
					expect(session.cursors).toEqual(["initial"]);
					expect(session.manager.getActiveEventSubscriptionCount()).toBe(0);
					expect(session.subscribeCount()).toBe(1);
				} else {
					session.releaseControl();
					const response = await within(delivery, "active webhook request");
					expect(response?.status).toBe(202);
					expect(session.cursors).toEqual(["initial", "after-gap"]);
					expect(session.manager.getActiveEventSubscriptionCount()).toBe(1);
				}
			} else {
				// events/subscribe returned truncated=true, so its gap callback is held
				// before the initial cursor. Explicit stop must not publish that cursor.
				await within(session.controlEntered, "truncated subscribe control");
				expect(session.cursors).toEqual([]);
				const stop = reentrantStop ? session.controlFinished : session.manager.stopEvents();
				session.releaseControl();
				await within(stop, reentrantStop ? "reentrant truncated-subscribe shutdown" : "truncated subscription stop");
				await delay(20);
				expect(session.cursors).toEqual([]);
				expect(session.subscribeCount()).toBe(1);
				expect(session.manager.getActiveEventSubscriptionCount()).toBe(0);
			}
			expect(session.controls).toEqual([scenario === "stop-terminated" ? "terminated" : "gap"]);
		} finally {
			await session.close();
		}
	}, 20_000);
}
