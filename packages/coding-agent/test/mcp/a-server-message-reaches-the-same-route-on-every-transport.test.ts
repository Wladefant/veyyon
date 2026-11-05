/**
 * A message from an MCP server reaches the same route whichever transport carried it.
 *
 * WHY THIS SUITE EXISTS. The stdio, Streamable HTTP and legacy SSE transports each classified a
 * server's messages with their own copy of the same branches, and the copies drifted:
 * - a method with a null id reached `onNotification` over stdio and was dropped over HTTP and SSE;
 * - an error naming no request (`"id": null`, a parse error) failed the in-flight request over
 *   stdio and SSE, and over Streamable HTTP was dropped, so the request waited for its stream to
 *   end and reported that the server never answered;
 * - a frame that is not a JSON-RPC message was logged over stdio, dropped in silence over SSE, and
 *   over Streamable HTTP threw inside the stream reader and failed the request it rode on.
 *
 * WHAT CLASS THIS CLOSES. Every kind of message the router distinguishes, on every transport, driven
 * through the real transport against a real server: a subprocess for stdio and a local HTTP server
 * for the other two. The transport table is keyed by the config's `type` union, so a new transport
 * type fails the type check until it has a harness here.
 *
 * WHAT IT DOES NOT CATCH. Messages on the Streamable HTTP GET stream are covered only for an error
 * naming no request; the other kinds share that stream's routes with the response stream driven
 * here. A response whose id names no in-flight request is not driven.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { HttpTransport } from "@veyyon/coding-agent/mcp/transports/http";
import { LegacySseTransport } from "@veyyon/coding-agent/mcp/transports/sse";
import { StdioTransport } from "@veyyon/coding-agent/mcp/transports/stdio";
import type { MCPServerConfig, MCPTransport } from "@veyyon/coding-agent/mcp/types";
import { logger } from "@veyyon/utils";

/** Bounds every wait, so a message that never arrives fails the test instead of hanging it. */
const DEADLINE_MS = 3_000;
const encoder = new TextEncoder();

/** The placeholder a server replaces with the id of the `probe` request that carried the frames. */
const PROBE_ID = "$ID";
const DONE = { jsonrpc: "2.0", id: PROBE_ID, result: { done: true } };
const NOTE = { jsonrpc: "2.0", method: "test/note", params: { n: 1 } };
const ASK = { jsonrpc: "2.0", id: "server-ask-1", method: "test/ask", params: { q: 1 } };
const PARSE_ERROR = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
const IGNORED = "Ignored an unreadable message from an MCP server";

/** One connected transport and what its server and its owner observed. */
interface Wire {
	transport: MCPTransport;
	/** How a log line names this server. */
	server: string;
	/** Notifications the transport delivered to `onNotification`. */
	notifications: Array<[string, unknown]>;
	/** Replies to server requests that reached the server. */
	answers: unknown[];
}

type Harness = () => Promise<Wire>;

/** Every frame of a `probe` request's params, with the placeholder replaced by the request's id. */
function framesOf(probe: { id: string | number; params: { frames: unknown[] } }): unknown[] {
	return JSON.parse(JSON.stringify(probe.params.frames).replaceAll(`"${PROBE_ID}"`, JSON.stringify(probe.id)));
}

const opened: Array<() => Promise<void>> = [];

function observe(transport: MCPTransport, server: string): Wire {
	const wire: Wire = { transport, server, notifications: [], answers: [] };
	transport.onNotification = (method, params) => void wire.notifications.push([method, params]);
	return wire;
}

/**
 * A subprocess that writes each frame of a `probe` request to stdout, and reports each reply it is
 * sent as a `test/answered` notification, which is the only way a subprocess has to show it.
 */
const STDIO_SERVER = `
for await (const line of console) {
	const message = JSON.parse(line);
	if (message.method === "probe") {
		const frames = JSON.parse(JSON.stringify(message.params.frames).replaceAll('"${PROBE_ID}"', JSON.stringify(message.id)));
		for (const frame of frames) process.stdout.write(JSON.stringify(frame) + "\\n");
	} else if (message.method === undefined) {
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test/answered", params: { answer: message } }) + "\\n");
	}
}`;

async function overStdio(): Promise<Wire> {
	const transport = new StdioTransport({
		type: "stdio",
		command: process.execPath,
		args: ["-e", STDIO_SERVER],
		timeout: DEADLINE_MS,
	});
	const wire = observe(transport, process.execPath);
	transport.onNotification = (method, params) => {
		if (method === "test/answered") wire.answers.push((params as { answer: unknown }).answer);
		else wire.notifications.push([method, params]);
	};
	opened.push(() => transport.close());
	await transport.connect();
	return wire;
}

/** Streamable HTTP: the frames are the SSE response to the `probe` POST. */
async function overStreamableHttp(): Promise<Wire> {
	const answers: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as Record<string, unknown>;
			if (body.method === "probe") {
				const events = framesOf(body as never).map(frame => `data: ${JSON.stringify(frame)}\n\n`);
				return new Response(events.join(""), { headers: { "Content-Type": "text/event-stream" } });
			}
			if (body.method === undefined) answers.push(body);
			return new Response(null, { status: 202 });
		},
	});
	const url = `http://127.0.0.1:${server.port}/mcp`;
	const transport = new HttpTransport({ type: "http", url, timeout: DEADLINE_MS });
	opened.push(async () => {
		await transport.close();
		server.stop(true);
	});
	await transport.connect();
	const wire = observe(transport, url);
	wire.answers = answers;
	return wire;
}

/** Legacy HTTP+SSE: the frames arrive on the event stream once the `probe` POST is received. */
async function overLegacySse(): Promise<Wire> {
	const answers: unknown[] = [];
	let events: ReadableStreamDefaultController<Uint8Array> | undefined;
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method === "GET") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						events = controller;
						controller.enqueue(encoder.encode("event: endpoint\ndata: /mcp/messages\n\n"));
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			}
			const body = (await req.json()) as Record<string, unknown>;
			if (body.method === "probe") {
				for (const frame of framesOf(body as never)) {
					events?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(frame)}\n\n`));
				}
			} else if (body.method === undefined) {
				answers.push(body);
			}
			return new Response(null, { status: 202 });
		},
	});
	const url = `http://127.0.0.1:${server.port}/mcp/sse`;
	const transport = new LegacySseTransport({ type: "sse", url, timeout: DEADLINE_MS });
	opened.push(async () => {
		await transport.close();
		server.stop(true);
	});
	await transport.connect();
	const wire = observe(transport, url);
	wire.answers = answers;
	return wire;
}

/** One harness per MCP server type; a type added to the config union fails the type check here. */
const HARNESSES: Record<NonNullable<MCPServerConfig["type"]>, Harness> = {
	stdio: overStdio,
	http: overStreamableHttp,
	sse: overLegacySse,
};

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + DEADLINE_MS;
	while (!condition() && Date.now() < deadline) await Bun.sleep(5);
}

let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

beforeEach(() => {
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(async () => {
	while (opened.length > 0) await opened.pop()?.();
	vi.restoreAllMocks();
});

describe.each(Object.entries(HARNESSES))("a server message over %s", (_type, open) => {
	const probe = (wire: Wire, frames: unknown[]) => wire.transport.request("probe", { frames });

	it("delivers a notification to onNotification", async () => {
		const wire = await open();
		expect(await probe(wire, [NOTE, DONE])).toEqual({ done: true });
		expect(wire.notifications).toEqual([["test/note", { n: 1 }]]);
	});

	it("delivers a method with a null id as a notification", async () => {
		const wire = await open();
		expect(await probe(wire, [{ ...NOTE, id: null }, DONE])).toEqual({ done: true });
		expect(wire.notifications).toEqual([["test/note", { n: 1 }]]);
	});

	it("answers a server request back to the server", async () => {
		const wire = await open();
		wire.transport.onRequest = async (method, params) => ({ echo: method, params });
		expect(await probe(wire, [ASK, DONE])).toEqual({ done: true });
		await until(() => wire.answers.length > 0);
		expect(wire.answers).toEqual([
			{ jsonrpc: "2.0", id: "server-ask-1", result: { echo: "test/ask", params: { q: 1 } } },
		]);
	});

	it("routes every member of a batch", async () => {
		const wire = await open();
		expect(await probe(wire, [[NOTE, DONE]])).toEqual({ done: true });
		expect(wire.notifications).toEqual([["test/note", { n: 1 }]]);
	});

	it("fails the in-flight request with the code and message of an error naming no request", async () => {
		const wire = await open();
		await expect(probe(wire, [PARSE_ERROR])).rejects.toThrow("MCP error -32700: Parse error");
	});

	it("logs a frame that is not a JSON-RPC message, naming the server, and reads on", async () => {
		const wire = await open();
		expect(await probe(wire, [42, { jsonrpc: "2.0" }, DONE])).toEqual({ done: true });
		const ignored = warnings.filter(warning => warning.message === IGNORED);
		expect(ignored.map(({ fields }) => [fields.server, fields.line, fields.error])).toEqual([
			[wire.server, "42", "not a JSON-RPC request, response or notification"],
			[wire.server, '{"jsonrpc":"2.0"}', "not a JSON-RPC request, response or notification"],
		]);
	});
});

describe("the Streamable HTTP GET stream", () => {
	it("reports an error naming no request to onError", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method !== "GET") return new Response(null, { status: 202 });
				return new Response(`data: ${JSON.stringify(PARSE_ERROR)}\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const url = `http://127.0.0.1:${server.port}/mcp`;
		const transport = new HttpTransport({ type: "http", url, timeout: DEADLINE_MS });
		opened.push(async () => {
			await transport.close();
			server.stop(true);
		});
		const errors: string[] = [];
		transport.onError = error => void errors.push(error.message);
		await transport.connect();
		await transport.startSSEListener();
		await until(() => errors.length > 0);
		expect(errors).toEqual(["MCP error -32700: Parse error"]);
	});
});
