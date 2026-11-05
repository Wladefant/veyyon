/**
 * WHY: an MCP server that rejects an expired credential with 401 or 403 is answered by refreshing
 * the credential and sending the message once more. Each transport sends three kinds of JSON-RPC
 * POST: a request, a notification, and the reply to a server-to-client request. The Streamable HTTP
 * transport retried its requests only, so a notification sent with an expired token failed outright,
 * and its reply path merged refreshed headers into the configuration object instead of the
 * transport's own copy. Every failure but the request's also dropped the server's auth challenge.
 *
 * The class closed: for both HTTP transports and every POST kind, a rejected credential is refreshed
 * once and the message is sent again with the refreshed headers; a rejection with nothing to refresh
 * is not retried, and the error a caller receives includes the server's `WWW-Authenticate` challenge.
 *
 * WHAT IT DOES NOT CATCH: a POST kind added to a transport is not discovered; `KINDS` lists the ones
 * driven here. The SSE listener's GET and the closing DELETE carry no JSON-RPC message and are not
 * retried.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { HttpTransport } from "@veyyon/coding-agent/mcp/transports/http";
import { LegacySseTransport } from "@veyyon/coding-agent/mcp/transports/sse";
import type { JsonRpcMessage } from "@veyyon/coding-agent/mcp/types";

const STALE = "Bearer stale";
const FRESH = "Bearer fresh";
const CHALLENGE = 'Bearer realm="mcp", error="invalid_token"';
const DEADLINE_MS = 2_000;
const QUESTION = { jsonrpc: "2.0", id: "server-question-1", method: "ping" };
const encoder = new TextEncoder();

type Kind = "request" | "notification" | "reply";
const KINDS: readonly Kind[] = ["request", "notification", "reply"];

function kindOf(message: JsonRpcMessage): Kind {
	if ("method" in message) return "id" in message ? "request" : "notification";
	return "reply";
}

function sseFrame(message: unknown): Uint8Array {
	return encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

/** What the server saw and what the client's credential hook did. */
interface Exchange {
	/** The Authorization header of each POST of the kind under test, in order. */
	authorizations: Array<string | null>;
	refreshes: number;
}

interface Scenario {
	/** The POST kind the server rejects. */
	kind: Kind;
	/** The status the server rejects the credential with. */
	status: 401 | 403;
	/** Whether the server keeps rejecting after a refresh. */
	alwaysReject: boolean;
	/** What the credential hook returns. */
	refreshed: Record<string, string> | null;
}

interface Harness {
	name: string;
	/** Serve `scenario`, connect a transport and drive one message of its kind. */
	drive(scenario: Scenario, exchange: Exchange): Promise<void>;
}

let server: Bun.Server<undefined> | undefined;
let closeTransport: (() => Promise<void>) | undefined;

afterEach(async () => {
	await closeTransport?.();
	closeTransport = undefined;
	server?.stop(true);
	server = undefined;
});

/** Whether `scenario` rejects this POST, recording it when it is of the kind under test. */
function judge(scenario: Scenario, exchange: Exchange, kind: Kind, req: Request): Response | undefined {
	if (kind !== scenario.kind) return undefined;
	exchange.authorizations.push(req.headers.get("Authorization"));
	if (!scenario.alwaysReject && exchange.authorizations.length > 1) return undefined;
	return new Response("token expired", { status: scenario.status, headers: { "WWW-Authenticate": CHALLENGE } });
}

/** The reply is sent in the background, so its arrival is awaited, bounded. */
async function repliesWithin(exchange: Exchange, count: number): Promise<void> {
	const deadline = Date.now() + DEADLINE_MS;
	while (exchange.authorizations.length < count && Date.now() < deadline) await Bun.sleep(5);
	// A retry that should not happen has the same window to show up.
	await Bun.sleep(50);
}

const streamableHttp: Harness = {
	name: "streamable HTTP",
	async drive(scenario, exchange) {
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const message = (await req.json()) as JsonRpcMessage;
				const kind = kindOf(message);
				const rejection = judge(scenario, exchange, kind, req);
				if (rejection) return rejection;
				if (kind === "request" && "id" in message) {
					return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
				}
				if (kind === "notification" && scenario.kind === "reply") {
					return new Response(`data: ${JSON.stringify(QUESTION)}\n\n`, {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				return new Response(null, { status: 202 });
			},
		});
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			headers: { Authorization: STALE },
			timeout: DEADLINE_MS,
		});
		transport.onAuthError = async () => {
			exchange.refreshes++;
			return scenario.refreshed;
		};
		transport.onRequest = async () => ({});
		closeTransport = () => transport.close();
		await transport.connect();
		if (scenario.kind === "request") await transport.request("tools/list");
		else await transport.notify("notifications/initialized");
		if (scenario.kind === "reply") await repliesWithin(exchange, scenario.alwaysReject ? 1 : 2);
	},
};

const legacySse: Harness = {
	name: "legacy HTTP+SSE",
	async drive(scenario, exchange) {
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
							controller.enqueue(encoder.encode("event: endpoint\ndata: /mcp/messages\n\n"));
							if (scenario.kind === "reply") controller.enqueue(sseFrame(QUESTION));
						},
					});
					return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
				}
				const message = (await req.json()) as JsonRpcMessage;
				const kind = kindOf(message);
				const rejection = judge(scenario, exchange, kind, req);
				if (rejection) return rejection;
				if (kind === "request" && "id" in message) {
					stream?.enqueue(sseFrame({ jsonrpc: "2.0", id: message.id, result: {} }));
				}
				return new Response(null, { status: 202 });
			},
		});
		const transport = new LegacySseTransport({
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			headers: { Authorization: STALE },
			timeout: DEADLINE_MS,
		});
		transport.onAuthError = async () => {
			exchange.refreshes++;
			return scenario.refreshed;
		};
		transport.onRequest = async () => ({});
		closeTransport = () => transport.close();
		await transport.connect();
		if (scenario.kind === "request") await transport.request("tools/list");
		else if (scenario.kind === "notification") await transport.notify("notifications/initialized");
		else await repliesWithin(exchange, scenario.alwaysReject ? 1 : 2);
	},
};

const HARNESSES: readonly Harness[] = [streamableHttp, legacySse];

describe("a rejected MCP credential", () => {
	for (const harness of HARNESSES) {
		for (const kind of KINDS) {
			for (const status of [401, 403] as const) {
				it(`is refreshed once after HTTP ${status} and the ${kind} sent again with it over ${harness.name}`, async () => {
					const exchange: Exchange = { authorizations: [], refreshes: 0 };

					await harness.drive(
						{ kind, status, alwaysReject: false, refreshed: { Authorization: FRESH } },
						exchange,
					);

					expect(exchange).toEqual({ authorizations: [STALE, FRESH], refreshes: 1 });
				});
			}
		}

		for (const kind of KINDS.filter(kind => kind !== "reply")) {
			it(`fails the ${kind} over ${harness.name} with the server's challenge when nothing refreshes`, async () => {
				const exchange: Exchange = { authorizations: [], refreshes: 0 };

				const outcome = harness.drive({ kind, status: 401, alwaysReject: true, refreshed: null }, exchange);

				await expect(outcome).rejects.toThrow(`HTTP 401: token expired [WWW-Authenticate: ${CHALLENGE}]`);
				expect(exchange).toEqual({ authorizations: [STALE], refreshes: 1 });
			});
		}
	}
});
