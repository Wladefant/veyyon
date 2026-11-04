import { describe, expect, it, spyOn } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logger } from "@veyyon/utils";
import { HttpTransport } from "../src/mcp/transports/http";

type SSEFrame = unknown;

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + phase)), 4_000);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function withLiveSSE<T>(
	frames: SSEFrame[],
	run: (transport: HttpTransport, sendFrame: (frame: SSEFrame) => void) => Promise<T>,
	onPost?: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<T> {
	let liveSSE: ServerResponse | null = null;
	const sendFrame = (frame: SSEFrame): void => {
		if (!liveSSE || liveSSE.destroyed) throw new Error("Disposable GET SSE connection is not open");
		liveSSE.write("data: " + JSON.stringify(frame) + "\n\n");
	};
	const server: Server = createServer((request, response) => {
		if (request.method !== "GET" || request.url !== "/mcp") {
			if (request.method === "POST" && onPost) {
				onPost(request, response);
				return;
			}
			response.writeHead(202).end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
		});
		response.flushHeaders();
		liveSSE = response;
		for (const frame of frames) sendFrame(frame);
		// Keep the real GET listener open; losing it before the valid frame is
		// delivered is a failure, not a normal end-of-stream.
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await bounded(listening.promise, "disposable SSE fixture listen");
	const address = server.address();
	if (!address || typeof address === "string") {
		server.closeAllConnections();
		server.close();
		throw new Error("Disposable SSE server did not bind an IPv4 loopback port");
	}
	const transport = new HttpTransport({
		type: "http",
		url: "http://127.0.0.1:" + address.port + "/mcp",
		timeout: 1_500,
	});
	try {
		await transport.connect();
		return await run(transport, sendFrame);
	} finally {
		try {
			await bounded(transport.close(), "client transport cleanup");
		} finally {
			server.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await bounded(closed.promise, "disposable SSE server close");
		}
	}
}

// WHY: persistent HTTP GET event listeners must validate *every* untrusted
// decoded SSE value. A null or scalar JSON frame must not crash the decoder
// and discard the legitimate notification queued behind it on the same socket.
// These are real HttpTransport callbacks over a disposable node:http server,
// not mocks of the production dispatch method.
describe("MCP persistent HTTP SSE frame validation", () => {
	it("skips null and scalar JSON frames while retaining a subsequent valid notification", async () => {
		await withLiveSSE(
			[null, 42, { jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { source: "fixture" } }],
			async transport => {
				const received = Promise.withResolvers<void>();
				const notices: Array<{ method: string; params: unknown }> = [];
				const errors: string[] = [];
				transport.onError = error => errors.push(error.message);
				transport.onNotification = (method, params) => {
					notices.push({ method, params });
					received.resolve();
				};
				await bounded(transport.startSSEListener(), "SSE GET connection");
				await bounded(received.promise, "notification after malformed frames");
				expect(notices).toEqual([{ method: "notifications/tools/list_changed", params: { source: "fixture" } }]);
				expect(errors).toEqual([]);
			},
		);
	}, 15_000);

	it("never invokes a client request for invalid-version SSE batch elements", async () => {
		await withLiveSSE(
			[
				[
					{ jsonrpc: "1.0", id: 71, method: "sampling/createMessage", params: { ignored: true } },
					{ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { source: "batch" } },
					{ jsonrpc: "2.0", id: 72, method: "sampling/createMessage", params: { accepted: true } },
				],
			],
			async transport => {
				const gotNotification = Promise.withResolvers<void>();
				const gotRequest = Promise.withResolvers<void>();
				const requests: unknown[] = [];
				const notifications: unknown[] = [];
				transport.onNotification = (method, params) => {
					notifications.push({ method, params });
					gotNotification.resolve();
				};
				transport.onRequest = async (method, params) => {
					requests.push({ method, params });
					gotRequest.resolve();
					return { synthetic: true };
				};
				await bounded(transport.startSSEListener(), "SSE GET batch connection");
				await bounded(Promise.all([gotNotification.promise, gotRequest.promise]), "valid batch members");
				expect(requests).toEqual([{ method: "sampling/createMessage", params: { accepted: true } }]);
				expect(notifications).toEqual([
					{ method: "notifications/tools/list_changed", params: { source: "batch" } },
				]);
			},
		);
	}, 15_000);

	// A JSON-RPC batch contains flat message objects, not recursively nested
	// arrays. A malformed nested member must not reach callbacks, and ignoring
	// it must not discard a valid flat sibling or the next SSE event.
	it("rejects nested SSE batch envelopes without dropping valid later frames", async () => {
		const method = "notifications/tools/list_changed";
		await withLiveSSE(
			[
				[
					[[[{ jsonrpc: "2.0", method, params: { source: "nested-invalid" } }]]],
					{ jsonrpc: "2.0", method, params: { source: "flat-valid" } },
				],
				{ jsonrpc: "2.0", method, params: { source: "next-event" } },
			],
			async transport => {
				const received: Array<{ method: string; params: unknown }> = [];
				const errors: string[] = [];
				const nextEventReceived = Promise.withResolvers<void>();
				transport.onError = error => errors.push(error.message);
				transport.onNotification = (name, params) => {
					received.push({ method: name, params });
					if ((params as { source?: string })?.source === "next-event") nextEventReceived.resolve();
				};
				await bounded(transport.startSSEListener(), "SSE GET nested-batch connection");
				await bounded(nextEventReceived.promise, "notification after malformed nested batch");
				expect(received).toEqual([
					{ method, params: { source: "flat-valid" } },
					{ method, params: { source: "next-event" } },
				]);
				expect(errors).toEqual([]);
			},
		);
	}, 15_000);

	// A single server-controlled SSE frame must not fan out thousands of
	// concurrent client callbacks or diagnostics. This probes the actual
	// transport over a loopback GET while all request handlers remain pending.
	it("bounds oversized and repeated flat SSE batches without losing the next notification", async () => {
		const makeRequest = (id: number) => ({
			jsonrpc: "2.0",
			id,
			method: "roots/list",
			params: {},
		});
		const oversized = Array.from({ length: 300 }, (_, index) => makeRequest(1_000 + index));
		const bursts = Array.from({ length: 5 }, (_, burst) =>
			Array.from({ length: 16 }, (_, index) => makeRequest(burst * 16 + index)),
		);
		const next = {
			jsonrpc: "2.0",
			method: "notifications/tools/list_changed",
			params: { source: "after-flood" },
		};
		await withLiveSSE([oversized, ...bursts, Array.from({ length: 128 }, () => null), next], async transport => {
			const gate = Promise.withResolvers<void>();
			const reachedCapacity = Promise.withResolvers<void>();
			const receivedNext = Promise.withResolvers<void>();
			const errors: string[] = [];
			let started = 0;
			const notifications: unknown[] = [];
			transport.onError = error => errors.push(error.message);
			transport.onRequest = async () => {
				started++;
				if (started === 32) reachedCapacity.resolve();
				await gate.promise;
				return { roots: [] };
			};
			transport.onNotification = (method, params) => {
				notifications.push({ method, params });
				if ((params as { source?: string })?.source === "after-flood") receivedNext.resolve();
			};
			try {
				await bounded(transport.startSSEListener(), "SSE admission fixture GET");
				await bounded(
					Promise.all([reachedCapacity.promise, receivedNext.promise]),
					"bounded SSE requests and recovery",
				);
				// Let any already-scheduled unbounded callbacks run before the oracle.
				await Promise.resolve();
				expect(started).toBe(32);
				expect(notifications).toEqual([
					{ method: "notifications/tools/list_changed", params: { source: "after-flood" } },
				]);
				expect(errors).toEqual([]);
			} finally {
				gate.resolve();
			}
		});
	}, 15_000);

	it("returns correlated overload errors without admitting more handlers", async () => {
		const release = Promise.withResolvers<void>();
		const atCapacity = Promise.withResolvers<void>();
		const receivedNext = Promise.withResolvers<void>();
		const busyReplies: unknown[] = [];
		let started = 0;
		const makeRequest = (id: number) => ({ jsonrpc: "2.0", id, method: "roots/list", params: {} });
		await withLiveSSE(
			[],
			async (transport, sendFrame) => {
				transport.onRequest = async () => {
					if (++started === 32) atCapacity.resolve();
					await release.promise;
					return { roots: [] };
				};
				transport.onNotification = () => receivedNext.resolve();
				try {
					await bounded(transport.startSSEListener(), "overload fixture GET");
					sendFrame(Array.from({ length: 32 }, (_, index) => makeRequest(index)));
					await bounded(atCapacity.promise, "overload handler capacity");
					sendFrame([makeRequest(32), makeRequest(33)]);
					sendFrame({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
					await bounded(receivedNext.promise, "notification after correlated overload replies");
					expect(started).toBe(32);
					expect(busyReplies).toEqual([
						{ jsonrpc: "2.0", id: 32, error: { code: -32000, message: "Server busy" } },
						{ jsonrpc: "2.0", id: 33, error: { code: -32000, message: "Server busy" } },
					]);
				} finally {
					release.resolve();
				}
			},
			(request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", chunk => {
					body += chunk;
				});
				request.on("end", () => {
					const reply = JSON.parse(body) as { error?: unknown };
					if (!reply.error) {
						response.writeHead(202).end();
						return;
					}
					busyReplies.push(reply);
					response.writeHead(202).end();
				});
			},
		);
	}, 15_000);

	// Capacity must recover after admitted server requests have finished.
	// Otherwise one bad server-side burst can permanently starve future
	// legitimate requests on the same healthy GET SSE connection.
	it("recovers per-transport request admission after pending responses settle", async () => {
		const makeRequest = (id: number) => ({
			jsonrpc: "2.0",
			id,
			method: "roots/list",
			params: {},
		});
		await withLiveSSE([], async (transport, sendFrame) => {
			const release = Promise.withResolvers<void>();
			const firstCapacity = Promise.withResolvers<void>();
			const admittedAfterRelease = Promise.withResolvers<void>();
			const observedCapacityBarrier = Promise.withResolvers<void>();
			let started = 0;
			const errors: string[] = [];
			transport.onError = error => errors.push(error.message);
			transport.onNotification = (_method, params) => {
				if ((params as { source?: string })?.source === "capacity-fence") observedCapacityBarrier.resolve();
			};
			transport.onRequest = async () => {
				started++;
				if (started === 32) firstCapacity.resolve();
				if (started > 32) admittedAfterRelease.resolve();
				if (started <= 32) await release.promise;
				return { roots: [] };
			};
			try {
				await bounded(transport.startSSEListener(), "SSE recovery fixture GET");
				sendFrame(Array.from({ length: 32 }, (_, index) => makeRequest(index)));
				await bounded(firstCapacity.promise, "32 pending SSE request handlers");
				sendFrame(makeRequest(99));
				// The next ordered SSE notification is a real transport
				// barrier. It prevents the capacity assertion passing merely
				// because the over-budget request has not reached the client.
				sendFrame({
					jsonrpc: "2.0",
					method: "notifications/tools/list_changed",
					params: { source: "capacity-fence" },
				});
				await bounded(observedCapacityBarrier.promise, "over-capacity SSE frame processed");
				expect(started).toBe(32);
				release.resolve();

				// Await real loopback response POST completion indirectly by a
				// bounded series of candidate frames; a permanently stuck
				// admission counter will never permit any of them.
				for (let index = 0; index < 30 && started === 32; index++) {
					sendFrame(makeRequest(100 + index));
					await Promise.race([
						admittedAfterRelease.promise,
						new Promise<void>(resolve => setTimeout(resolve, 40)),
					]);
				}
				await bounded(admittedAfterRelease.promise, "SSE request admission after settled responses");
				expect(started).toBeGreaterThan(32);
				expect(errors).toEqual([]);
			} finally {
				release.resolve();
			}
		});
	}, 15_000);

	// Oversized valid requests cannot disappear while the connection remains
	// healthy. Closing with a static error accounts for the rejected batch
	// without starting one callback or response POST for every request.
	it.each([257, 300])("fails the transport for an oversized batch of %i valid requests", async count => {
		await withLiveSSE([], async (transport, sendFrame) => {
			const closed = Promise.withResolvers<void>();
			const errors: string[] = [];
			let requests = 0;
			transport.onClose = closed.resolve;
			transport.onError = error => errors.push(error.message);
			transport.onRequest = async () => {
				requests++;
				return { roots: [] };
			};
			await bounded(transport.startSSEListener(), "oversized request fixture GET");
			sendFrame(Array.from({ length: count }, (_, id) => ({ jsonrpc: "2.0", id, method: "roots/list" })));
			await bounded(closed.promise, "explicit oversized batch transport failure");
			expect(errors).toEqual(["MCP HTTP SSE batch exceeds the 256-member limit"]);
			expect(transport.connected).toBe(false);
			expect(requests).toBe(0);
		});
	}, 15_000);

	// Reject an oversized frame as a whole, including valid messages inside
	// that frame, while keeping the immediately adjacent legal-size frame
	// and a later event usable on the exact same open connection.

	it("enforces the flat SSE batch member budget at both edges", async () => {
		const notification = (source: string) => ({
			jsonrpc: "2.0",
			method: "notifications/tools/list_changed",
			params: { source },
		});
		const warnings: string[] = [];
		const warnSpy = spyOn(logger, "warn").mockImplementation(message => warnings.push(String(message)));
		try {
			await withLiveSSE(
				[
					[...Array.from({ length: 255 }, () => null), notification("at-limit")],
					[...Array.from({ length: 256 }, () => null), notification("over-limit")],
					notification("later"),
				],
				async transport => {
					const received: string[] = [];
					const next = Promise.withResolvers<void>();
					const errors: string[] = [];
					transport.onError = error => errors.push(error.message);
					transport.onNotification = (_method, params) => {
						const source = (params as { source?: string })?.source;
						if (source) received.push(source);
						if (source === "later") next.resolve();
					};
					await bounded(transport.startSSEListener(), "SSE batch boundary GET");
					await bounded(next.promise, "SSE following batch boundary frame");
					expect(received).toEqual(["at-limit", "later"]);
					expect(errors).toEqual([]);
				},
			);
		} finally {
			warnSpy.mockRestore();
		}
		expect(
			warnings.filter(
				message =>
					message === "Skipping invalid MCP HTTP SSE batch member" ||
					message === "Skipping oversized MCP HTTP SSE message batch",
			),
		).toEqual(["Skipping invalid MCP HTTP SSE batch member", "Skipping oversized MCP HTTP SSE message batch"]);
	}, 15_000);
});
