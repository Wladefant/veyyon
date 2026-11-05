/**
 * Regression: an MCP response that never reached the server must be reported.
 *
 * Both the streamable-HTTP and the SSE transport answer server-to-client
 * requests (sampling, elicitation) by POSTing a JSON-RPC response back. Both
 * swallowed a failed POST, one of them under the comment "best-effort response
 * delivery", and both discarded the status of a POST the server answered with
 * an error.
 *
 * It is not best-effort from the server's side. The server asked a question, we
 * did the work to answer it, and then dropped the answer. The server waits on a
 * reply that never comes, so the operator sees an MCP tool that hangs, with
 * nothing anywhere connecting the hang to the send that failed (Law 10). Two
 * transports had the identical swallow, so the report has one owner and cannot
 * drift into describing the same failure two ways.
 *
 * WHAT THIS DOES NOT CATCH. A send that throws without the server answering at
 * all (a reset connection) is reported through the same catch as a refused one,
 * but no case here resets a connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { HttpTransport } from "@veyyon/coding-agent/mcp/transports/http";
import { reportUndeliveredServerResponse } from "@veyyon/coding-agent/mcp/transports/server-response-delivery";
import { LegacySseTransport } from "@veyyon/coding-agent/mcp/transports/sse";
import type { JsonRpcMessage } from "@veyyon/coding-agent/mcp/types";
import { logger } from "@veyyon/utils";

describe("reportUndeliveredServerResponse", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const report = (over: Partial<Parameters<typeof reportUndeliveredServerResponse>[0]> = {}): void =>
		reportUndeliveredServerResponse({
			url: "https://mcp.example.test/rpc",
			requestId: 42,
			kind: "result",
			cause: new Error("fetch failed: ECONNRESET"),
			...over,
		});

	it("says the server is still waiting, which is the consequence the operator needs", () => {
		// "Failed to POST response" describes our side. What matters to the reader
		// is that something downstream is now stuck.
		report();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe(
			"Could not deliver a response to an MCP server request; the server is still waiting for it",
		);
	});

	it("names the server by URL, so a config with several is unambiguous", () => {
		report({ url: "https://other.example.test/rpc" });

		expect(warnings[0]?.fields.server).toBe("https://other.example.test/rpc");
	});

	it("names the JSON-RPC id, which is what ties the report to the stuck request", () => {
		report({ requestId: 99 });

		expect(warnings[0]?.fields.requestId).toBe(99);
	});

	it("carries a string id unchanged, since JSON-RPC allows either", () => {
		// Coercing it to a number would silently mangle ids from servers that use
		// strings, and the report would then point at a request that does not exist.
		report({ requestId: "req-7a" });

		expect(warnings[0]?.fields.requestId).toBe("req-7a");
	});

	it("distinguishes an undelivered error response from an undelivered result", () => {
		// They fail the same way and mean different things: a lost error response
		// means the server never learned its request was rejected.
		report({ kind: "error" });

		expect(warnings[0]?.fields.responseKind).toBe("error");
	});

	it("reports the underlying cause, not just that delivery failed", () => {
		// A connection reset and a timeout need different responses from the
		// operator, so the distinction has to survive into the log.
		report({ cause: new Error("The operation timed out") });

		expect(String(warnings[0]?.fields.error)).toContain("The operation timed out");
	});

	it("survives a thrown value that is not an Error", () => {
		// `fetch` and its abort paths can reject with a plain string or a
		// DOMException. Reporting must not itself throw on the way to reporting.
		report({ cause: "aborted" });

		expect(warnings).toHaveLength(1);
		expect(String(warnings[0]?.fields.error)).toContain("aborted");
	});

	it("tells the operator what to do, since the symptom they see is only a hang", () => {
		report();

		expect(String(warnings[0]?.fields.fix)).toContain("/mcp");
	});

	it("reports at warn, not debug, because a capability is actually lost", () => {
		// The original swallow is one demotion away from returning. Pinning the
		// level means that demotion fails here rather than silently shipping.
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

		report();

		expect(warnings).toHaveLength(1);
		expect(debug).not.toHaveBeenCalled();
	});
});

/**
 * The owner being correct is not enough: both transports have to reach it.
 *
 * Each transport is driven against a local server that asks the client a
 * question and then answers the client's reply with a chosen status. A reply
 * the server refused is reported once, naming the server and the id it is
 * waiting on; a reply the server accepted is not reported.
 */
describe("both transports report an answer the server did not accept", () => {
	const QUESTION_ID = "server-question-1";
	const QUESTION = { jsonrpc: "2.0", id: QUESTION_ID, method: "ping" };
	const REPORT_DEADLINE_MS = 2_000;
	const encoder = new TextEncoder();

	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
	let server: Bun.Server<undefined> | undefined;
	let closeTransport: (() => Promise<void>) | undefined;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(async () => {
		await closeTransport?.();
		closeTransport = undefined;
		server?.stop(true);
		server = undefined;
		vi.restoreAllMocks();
	});

	interface Asked {
		/** The server's URL, as the transport was configured with it. */
		url: string;
		/** Resolves with the reply the client posted to the question. */
		reply: Promise<JsonRpcMessage>;
	}

	/** Streamable HTTP: the question rides on the response to a notification the client sends. */
	async function askOverStreamableHttp(answerStatus: number): Promise<Asked> {
		const reply = Promise.withResolvers<JsonRpcMessage>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as JsonRpcMessage;
				if ("method" in body && !("id" in body)) {
					return new Response(`data: ${JSON.stringify(QUESTION)}\n\n`, {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				reply.resolve(body);
				return new Response("answer refused", { status: answerStatus });
			},
		});
		const url = `http://127.0.0.1:${server.port}/mcp`;
		const transport = new HttpTransport({ type: "http", url, timeout: REPORT_DEADLINE_MS });
		transport.onRequest = async () => ({});
		closeTransport = () => transport.close();
		await transport.connect();
		await transport.notify("notifications/initialized");
		return { url, reply: reply.promise };
	}

	/** Legacy HTTP+SSE: the question arrives on the event stream, right after the endpoint event. */
	async function askOverLegacySse(answerStatus: number): Promise<Asked> {
		const reply = Promise.withResolvers<JsonRpcMessage>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("event: endpoint\ndata: /mcp/messages\n\n"));
							controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(QUESTION)}\n\n`));
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
				}
				reply.resolve((await req.json()) as JsonRpcMessage);
				return new Response("answer refused", { status: answerStatus });
			},
		});
		const url = `http://127.0.0.1:${server.port}/mcp/sse`;
		const transport = new LegacySseTransport({ type: "sse", url, timeout: REPORT_DEADLINE_MS });
		transport.onRequest = async () => ({});
		closeTransport = () => transport.close();
		await transport.connect();
		return { url, reply: reply.promise };
	}

	/** Every transport that answers server requests over HTTP. A new one belongs here. */
	const TRANSPORTS = [
		{ name: "streamable HTTP", ask: askOverStreamableHttp },
		{ name: "legacy HTTP+SSE", ask: askOverLegacySse },
	];

	/** Wait for the report, bounded so a missing one fails rather than hangs. */
	async function reportsWithin(deadlineMs: number): Promise<void> {
		const deadline = Date.now() + deadlineMs;
		while (warnings.length === 0 && Date.now() < deadline) await Bun.sleep(5);
	}

	for (const transport of TRANSPORTS) {
		for (const status of [400, 401, 500]) {
			it(`${transport.name} reports a reply the server answered with HTTP ${status}`, async () => {
				const asked = await transport.ask(status);
				const reply = await asked.reply;
				expect(reply).toMatchObject({ jsonrpc: "2.0", id: QUESTION_ID });

				await reportsWithin(REPORT_DEADLINE_MS);

				expect(warnings).toHaveLength(1);
				expect(warnings[0]?.message).toBe(
					"Could not deliver a response to an MCP server request; the server is still waiting for it",
				);
				expect(warnings[0]?.fields).toMatchObject({ server: asked.url, requestId: QUESTION_ID });
				expect(String(warnings[0]?.fields.error)).toContain(`HTTP ${status}: answer refused`);
			});
		}

		it(`${transport.name} reports nothing for a reply the server accepted`, async () => {
			const asked = await transport.ask(202);
			await asked.reply;

			await reportsWithin(200);

			expect(warnings).toEqual([]);
		});
	}
});
