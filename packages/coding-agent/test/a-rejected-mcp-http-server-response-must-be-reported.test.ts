import { describe, expect, it, spyOn } from "bun:test";
import { createServer, type Server } from "node:http";
import { logger } from "@veyyon/utils";
import { HttpTransport } from "../src/mcp/transports/http";

const FAKE_RESPONSE_BODY = "FAKE_PEER_REJECTION_BODY_NEVER_LOG";

interface PostedReply {
	body: Record<string, unknown>;
	refreshHeader: string | null;
}

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + phase)), 4_000);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function withDisposableServer<T>(
	statuses: number[],
	run: (transport: HttpTransport, posts: PostedReply[]) => Promise<T>,
): Promise<T> {
	const posts: PostedReply[] = [];
	const server: Server = createServer((request, response) => {
		if (request.url !== "/mcp") {
			response.writeHead(404).end();
			return;
		}
		if (request.method === "GET") {
			response.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
			});
			response.write("data: " + JSON.stringify({
				jsonrpc: "2.0",
				id: 7183,
				method: "sampling/createMessage",
				params: { source: "synthetic" },
			}) + "\n\n");
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		void (async () => {
			let raw = "";
			for await (const chunk of request) {
				raw += Buffer.from(chunk).toString("utf8");
				if (raw.length > 64 * 1024) throw new Error("Oversized fake POST");
			}
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("Expected an object-shaped JSON-RPC response");
			}
			posts.push({
				body: parsed as Record<string, unknown>,
				refreshHeader: typeof request.headers["x-test-refresh"] === "string"
					? request.headers["x-test-refresh"]
					: null,
			});
			const status = statuses[Math.min(posts.length - 1, statuses.length - 1)]!;
			response.writeHead(status, { "Content-Type": "text/plain" }).end(FAKE_RESPONSE_BODY);
		})().catch(() => {
			if (!response.headersSent) response.writeHead(400).end();
			else response.end();
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await bounded(listening.promise, "disposable HTTP server listen");
	const address = server.address();
	if (!address || typeof address === "string") {
		server.closeAllConnections();
		server.close();
		throw new Error("No disposable HTTP listener port");
	}
	const transport = new HttpTransport({
		type: "http",
		url: "http://127.0.0.1:" + address.port + "/mcp",
		timeout: 1_500,
	});
	try {
		await transport.connect();
		return await run(transport, posts);
	} finally {
		try {
			await bounded(transport.close(), "HTTP transport cleanup");
		} finally {
			server.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await bounded(closed.promise, "disposable HTTP server close");
		}
	}
}

function warningCapture() {
	const reported = Promise.withResolvers<{ message: string; details: Record<string, unknown> }>();
	const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
	const warn = spyOn(logger, "warn").mockImplementation((message, details) => {
		if (message !== "Could not deliver a response to an MCP server request; the server is still waiting for it") return;
		const entry = { message, details: details ?? {} };
		warnings.push(entry);
		reported.resolve(entry);
	});
	return { reported: reported.promise, warnings, warn };
}

// WHY: HTTP fetch resolves for 5xx; the server has not acknowledged our
// JSON-RPC response merely because the TCP POST completed. Exercise the
// actual server-to-client SSE request handler and its real response POST,
// not a direct call to the private #sendServerResponse method.
describe("MCP HTTP server-to-client response delivery rejection", () => {
	it("reports an initial HTTP 503 response exactly once without logging the peer body", async () => {
		const capture = warningCapture();
		try {
			await withDisposableServer([503], async (transport, posts) => {
				transport.onRequest = async () => ({ synthetic: true });
				await bounded(transport.startSSEListener(), "GET SSE server request");
				const report = await bounded(capture.reported, "HTTP 503 delivery warning");
				expect(posts).toHaveLength(1);
				expect(posts[0]?.body).toMatchObject({
					jsonrpc: "2.0",
					id: 7183,
					result: { synthetic: true },
				});
				expect(report.details).toMatchObject({
					requestId: 7183,
					responseKind: "result",
					server: transport.url,
				});
				expect(String(report.details.error)).toContain("HTTP 503");
				expect(JSON.stringify(capture.warnings)).not.toContain(FAKE_RESPONSE_BODY);
				expect(capture.warnings).toHaveLength(1);
			});
		} finally {
			capture.warn.mockRestore();
		}
	}, 15_000);

	it("reports the final 502 after one permitted 401 auth refresh but does not auto-resend", async () => {
		const capture = warningCapture();
		try {
			await withDisposableServer([401, 502], async (transport, posts) => {
				let refreshes = 0;
				transport.onAuthError = async () => {
					refreshes++;
					return { "X-Test-Refresh": "synthetic" };
				};
				transport.onRequest = async () => ({ synthetic: true });
				await bounded(transport.startSSEListener(), "GET SSE request with auth refresh");
				const report = await bounded(capture.reported, "final HTTP 502 delivery warning");
				expect(refreshes).toBe(1);
				expect(posts).toHaveLength(2);
				expect(posts.map(post => post.refreshHeader)).toEqual([null, "synthetic"]);
				expect(posts[1]?.body).toEqual(posts[0]?.body);
				expect(report.details).toMatchObject({ requestId: 7183, responseKind: "result" });
				expect(String(report.details.error)).toContain("HTTP 502");
				expect(JSON.stringify(capture.warnings)).not.toContain(FAKE_RESPONSE_BODY);
				expect(capture.warnings).toHaveLength(1);
			});
		} finally {
			capture.warn.mockRestore();
		}
	}, 15_000);
});
