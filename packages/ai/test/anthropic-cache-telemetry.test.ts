import { afterEach, describe, expect, it, vi } from "bun:test";
import nodeCrypto from "node:crypto";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { AnthropicApiError, AnthropicMessages } from "@veyyon/ai/providers/anthropic-client";
import type { CacheRequestRecord, Context, Model, ModelSpec, Tool, Usage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { isRecord } from "@veyyon/utils/type-guards";

const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);

const CONTEXT: Context = {
	systemPrompt: ["You are a test assistant."],
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
};

type MockAnthropicEvent = Record<string, unknown>;

function cacheRequestsFor(usage: Usage): CacheRequestRecord[] {
	if (!usage.cacheRequests) throw new Error("Expected cache request telemetry");
	return usage.cacheRequests;
}

function clearMessageCacheControls(payload: unknown): Record<string, unknown> {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) {
		throw new Error("Expected an Anthropic message payload");
	}
	for (const message of payload.messages) {
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (isRecord(block)) delete block.cache_control;
		}
	}
	return payload;
}

function createMockRequest(events: MockAnthropicEvent[], requestId = "req_mock") {
	const response = new Response(null, { status: 200, headers: { "request-id": requestId } });
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

function createEvents(
	options: {
		text?: string;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		cacheCreation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
	} = {},
) {
	const events: Array<Record<string, unknown>> = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				model: "claude-sonnet-4-5",
				usage: {
					input_tokens: options.inputTokens ?? 10,
					output_tokens: 0,
					cache_read_input_tokens: options.cacheReadTokens ?? 0,
					cache_creation_input_tokens: options.cacheWriteTokens ?? 0,
					...(options.cacheCreation !== undefined ? { cache_creation: options.cacheCreation } : {}),
				},
			},
		},
	];
	if (options.text !== "") {
		events.push(
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: options.text ?? "Hello" } },
			{ type: "content_block_stop", index: 0 },
		);
	}
	events.push({
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: {
			output_tokens: options.text === "" ? (options.outputTokens ?? 0) : (options.outputTokens ?? 5),
		},
	});
	return events;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Anthropic cache telemetry", () => {
	it("records 1h requested TTL telemetry for requests with 1h retention", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createEvents({ cacheReadTokens: 10, cacheWriteTokens: 20 }), "req_1h") as never,
		);

		const before = Date.now();
		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			cacheRetention: "long",
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();
		const after = Date.now();

		const requests = cacheRequestsFor(result.usage);
		expect(requests).toHaveLength(1);
		const req = requests[0]!;
		expect(req.requestedTtl).toBe("1h");
		expect(req.model).toBe("claude-sonnet-4-5");
		expect(req.requestId).toBe("req_1h");
		expect(req.requestStartedAt).toBeGreaterThanOrEqual(before);
		expect(req.requestStartedAt).toBeLessThanOrEqual(after);
		expect(typeof req.prefixHash).toBe("string");
		expect(req.prefixHash).toHaveLength(64);
		expect(req.cacheRead).toBe(10);
		expect(req.cacheWrite).toBe(20);
	});

	it("records none requested TTL when caching is declined", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createEvents(), "req_none") as never,
		);

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			cacheRetention: "none",
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		const requests = cacheRequestsFor(result.usage);
		expect(requests).toHaveLength(1);
		const req = requests[0]!;
		expect(req.requestedTtl).toBe("none");
		expect(req.requestedTtls).toBeUndefined();
		expect(req.requestId).toBe("req_none");
	});

	it("captures optional split and handles omitted split safely", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementationOnce(
			() =>
				createMockRequest(
					createEvents({
						cacheReadTokens: 50,
						cacheWriteTokens: 300,
						cacheCreation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
					}),
					"req_split",
				) as never,
		);

		const s1 = streamAnthropic(MODEL, CONTEXT, { apiKey: "sk-ant-test", cacheRetention: "long" });
		for await (const _ of s1) {
			// drain
		}
		const res1 = await s1.result();
		const req1 = cacheRequestsFor(res1.usage)[0]!;
		expect(req1.cacheRead).toBe(50);
		expect(req1.cacheWrite).toBe(300);
		expect(req1.cttl).toEqual({ ephemeral5m: 100, ephemeral1h: 200 });

		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementationOnce(
			() =>
				createMockRequest(
					createEvents({
						cacheReadTokens: 40,
						cacheWriteTokens: 100,
						cacheCreation: null,
					}),
					"req_nosplit",
				) as never,
		);

		const s2 = streamAnthropic(MODEL, CONTEXT, { apiKey: "sk-ant-test", cacheRetention: "long" });
		for await (const _ of s2) {
			// drain
		}
		const res2 = await s2.result();
		const req2 = cacheRequestsFor(res2.usage)[0]!;
		expect(req2.cacheRead).toBe(40);
		expect(req2.cacheWrite).toBe(100);
		expect(req2.cttl).toBeUndefined();
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementationOnce(
			() =>
				createMockRequest(
					createEvents({
						cacheReadTokens: 60,
						cacheWriteTokens: 250,
						cacheCreation: { ephemeral_5m_input_tokens: 250, ephemeral_1h_input_tokens: 0 },
					}),
					"req_zero_split",
				) as never,
		);

		const s3 = streamAnthropic(MODEL, CONTEXT, { apiKey: "sk-ant-test", cacheRetention: "long" });
		for await (const _ of s3) {
			// drain
		}
		const res3 = await s3.result();
		const req3 = cacheRequestsFor(res3.usage);
		expect(req3?.[0]?.cacheRead).toBe(60);
		expect(req3?.[0]?.cacheWrite).toBe(250);
		expect(req3?.[0]?.cttl).toEqual({ ephemeral5m: 250, ephemeral1h: 0 });
	});

	it("produces stable prefixHash on repeat and distinct prefixHash on change", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createEvents()) as never,
		);

		const tool1: Tool = {
			name: "query_db",
			description: "Query database",
			parameters: { type: "object", properties: { sql: { type: "string" } } },
		};
		const toolModified: Tool = {
			name: "query_db",
			description: "Query database with MODIFIED schema",
			parameters: { type: "object", properties: { query: { type: "string" } } },
		};

		const contextWithTools: Context = {
			...CONTEXT,
			tools: [tool1],
		};

		const s1 = streamAnthropic(MODEL, contextWithTools, { apiKey: "sk-ant-test" });
		for await (const _ of s1) {
			// drain
		}
		const res1 = await s1.result();
		const hash1 = cacheRequestsFor(res1.usage);

		const s2 = streamAnthropic(MODEL, contextWithTools, { apiKey: "sk-ant-test" });
		for await (const _ of s2) {
			// drain
		}
		const res2 = await s2.result();
		const hash2 = cacheRequestsFor(res2.usage);

		expect(hash1?.[0]?.prefixHash).toBeDefined();
		expect(hash1?.[0]?.prefixHash).toBe(hash2?.[0]?.prefixHash);

		const contextToolChanged: Context = {
			...CONTEXT,
			tools: [toolModified],
		};
		const s3 = streamAnthropic(MODEL, contextToolChanged, { apiKey: "sk-ant-test" });
		for await (const _ of s3) {
			// drain
		}
		const res3 = await s3.result();
		const hash3 = cacheRequestsFor(res3.usage);

		expect(hash3?.[0]?.prefixHash).toBeDefined();
		expect(hash3?.[0]?.prefixHash).not.toBe(hash1?.[0]?.prefixHash);

		const contextSystemChanged: Context = {
			...contextWithTools,
			systemPrompt: ["Different system prompt content"],
		};
		const s4 = streamAnthropic(MODEL, contextSystemChanged, { apiKey: "sk-ant-test" });
		for await (const _ of s4) {
			// drain
		}
		const res4 = await s4.result();
		const hash4 = cacheRequestsFor(res4.usage);

		expect(hash4?.[0]?.prefixHash).toBeDefined();
		expect(hash4?.[0]?.prefixHash).not.toBe(hash1?.[0]?.prefixHash);
		expect(hash4?.[0]?.prefixHash).not.toBe(hash3?.[0]?.prefixHash);
	});

	it("keeps outgoing request body unchanged on wire", async () => {
		let capturedParams: Record<string, unknown> | undefined;
		let capturedOptions: Record<string, unknown> | undefined;
		let serializedInOnPayload: string | undefined;

		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown, options?: unknown) => {
			capturedParams = params as Record<string, unknown>;
			capturedOptions = options as Record<string, unknown>;
			return createMockRequest(createEvents()) as never;
		});

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			onPayload: payload => {
				serializedInOnPayload = JSON.stringify(payload);
				return payload;
			},
		});
		for await (const _ of s) {
			// drain
		}
		await s.result();

		expect(capturedParams).toBeDefined();
		expect(capturedOptions?.serializedBody).toBeDefined();
		if (typeof serializedInOnPayload !== "string") {
			throw new Error("Provider did not serialize the onPayload request");
		}
		expect(capturedOptions?.serializedBody).toBe(serializedInOnPayload);
		expect(JSON.stringify(capturedParams)).toBe(serializedInOnPayload);
		expect(capturedParams?.model).toBe("claude-sonnet-4-5");
		expect(capturedParams?.stream).toBe(true);
		expect(capturedParams?.cacheRequests).toBeUndefined();
		expect(capturedParams?.telemetry).toBeUndefined();
	});

	it("computes prefixHash over exact wire body with patched OAuth cch attestation", async () => {
		let capturedOptions: Record<string, unknown> | undefined;

		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((_params: unknown, options?: unknown) => {
			capturedOptions = options as Record<string, unknown>;
			return createMockRequest(createEvents()) as never;
		});

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
		});
		for await (const _ of s) {
			// drain
		}
		const res = await s.result();

		const req = cacheRequestsFor(res.usage)[0];
		expect(req).toBeDefined();
		expect(typeof req?.prefixHash).toBe("string");

		// When isOAuth is true, Anthropic injects the billing header into system[0].
		// serializedBody passed to client contains the placeholder before fetch-time attestation.
		const serializedWire = capturedOptions?.serializedBody as string | undefined;
		expect(serializedWire).toBeDefined();
		expect(serializedWire).toContain("cch=00000");

		// createAnthropicCacheRequestRecord patches cch so prefixHash matches the wire attestation,
		// differing from a hash computed over the unpatched cch=00000 placeholder body.
		const unpatchedParsed = JSON.parse(serializedWire!);
		const unpatchedPrefixHash = nodeCrypto
			.createHash("sha256")
			.update(JSON.stringify({ system: unpatchedParsed.system, tools: unpatchedParsed.tools }))
			.digest("hex");
		expect(req?.prefixHash).not.toBe(unpatchedPrefixHash);
		expect(req?.prefixHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("contains no prompt text, tool bodies, or secrets in telemetry records", async () => {
		const SECRET_PHRASE = "SECRET_SUPER_CONFIDENTIAL_PROMPT_12345";
		const sensitiveContext: Context = {
			systemPrompt: [`System with ${SECRET_PHRASE}`],
			messages: [{ role: "user", content: `User message with ${SECRET_PHRASE}`, timestamp: 1 }],
			tools: [
				{
					name: "confidential_tool",
					description: `Tool with ${SECRET_PHRASE}`,
					parameters: { type: "object", properties: { key: { type: "string" } } },
				},
			],
		};

		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createEvents()) as never,
		);

		const s = streamAnthropic(MODEL, sensitiveContext, { apiKey: "sk-ant-test" });
		for await (const _ of s) {
			// drain
		}
		const res = await s.result();

		const requests = cacheRequestsFor(res.usage);
		const telemetryJson = JSON.stringify(requests);
		expect(telemetryJson).not.toContain(SECRET_PHRASE);
		expect(telemetryJson).not.toContain("confidential_tool");
		expect(telemetryJson).not.toContain("sk-ant-test");
	});

	it("handles mixed TTLs without silently collapsing to a single TTL", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createEvents()) as never,
		);

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			onPayload: payload => {
				const request = clearMessageCacheControls(payload);
				request.system = [
					{ type: "text", text: "sys1", cache_control: { type: "ephemeral", ttl: "1h" } },
					{ type: "text", text: "sys2", cache_control: { type: "ephemeral" } },
				];
				return request;
			},
		});
		for await (const _ of s) {
			// drain
		}
		const res = await s.result();

		const requests = cacheRequestsFor(res.usage);
		expect(requests).toHaveLength(1);
		const req = requests[0]!;
		expect(req.requestedTtl).toBe("mixed");
		expect(req.requestedTtls).toEqual(["1h", "5m"]);
	});
	it("observes top-level cache_control in onPayload replacement payload", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createEvents()) as never,
		);

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			cacheRetention: "none",
			onPayload: payload => {
				const request = clearMessageCacheControls(payload);
				request.cache_control = { type: "ephemeral", ttl: "1h" };
				return request;
			},
		});
		for await (const _ of s) {
			// drain
		}
		const res = await s.result();
		const reqs = cacheRequestsFor(res.usage);
		const req = reqs[0];
		expect(req).toBeDefined();
		expect(req?.requestedTtl).toBe("1h");
		expect(req?.requestedTtls).toEqual(["1h"]);
	});

	it("preserves earlier attempt records across retries without aggregate pollution", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt++;
			if (attempt === 1) {
				const stream = {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "message_start",
							message: {
								id: "msg_attempt_1",
								model: "claude-sonnet-4-5",
								usage: {
									input_tokens: 100,
									output_tokens: 0,
									cache_read_input_tokens: 30,
									cache_creation_input_tokens: 70,
								},
							},
						};
						throw new Error("Temporary network glitch");
					},
				};
				const response = new Response(null, { status: 200, headers: { "request-id": "req_attempt_1" } });
				return {
					async withResponse() {
						return { data: stream, response, request_id: "req_attempt_1" };
					},
				} as never;
			}
			return createMockRequest(
				createEvents({ cacheReadTokens: 10, cacheWriteTokens: 20, text: "Success on attempt 2" }),
				"req_attempt_2",
			) as never;
		});

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
		for await (const _ of s) {
			// drain
		}
		const res = await s.result();

		const requests = cacheRequestsFor(res.usage);
		expect(requests).toHaveLength(2);

		const req1 = requests[0]!;
		expect(req1.requestId).toBe("req_attempt_1");
		expect(req1.cacheRead).toBe(30);
		expect(req1.cacheWrite).toBe(70);

		const req2 = requests[1]!;
		expect(req2.requestId).toBe("req_attempt_2");
		expect(req2.cacheRead).toBe(10);
		expect(req2.cacheWrite).toBe(20);

		expect(req2.cacheRead).not.toBe(40);
	});
	it("retains cacheRequests across outer empty-completion retries", async () => {
		let callCount = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return createMockRequest(
					createEvents({ cacheReadTokens: 50, cacheWriteTokens: 100, text: "" }),
					"req_empty_1",
				) as never;
			}
			return createMockRequest(
				createEvents({ cacheReadTokens: 20, cacheWriteTokens: 30, text: "Success after empty" }),
				"req_success_2",
			) as never;
		});

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
		for await (const _ of s) {
			// drain
		}
		const res = await s.result();

		const reqs = cacheRequestsFor(res.usage);
		expect(reqs?.[0]?.requestId).toBe("req_empty_1");
		expect(reqs?.[0]?.cacheRead).toBe(50);
		expect(reqs?.[1]?.requestId).toBe("req_success_2");
		expect(reqs?.[1]?.cacheRead).toBe(20);
	});
	it("extracts requestId from AnthropicApiError and records start time at dispatch", async () => {
		let attempt = 0;
		const beforeDispatch = Date.now();
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt++;
			if (attempt === 1) {
				return {
					async withResponse() {
						const headers = new Headers({ "request-id": "req_api_err_1" });
						throw new AnthropicApiError(500, "500 Internal Server Error", headers);
					},
				} as never;
			}
			return createMockRequest(
				createEvents({ cacheReadTokens: 15, cacheWriteTokens: 25, text: "Success on attempt 2" }),
				"req_success_attempt_2",
			) as never;
		});

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
		for await (const _ of s) {
			// drain
		}
		const res = await s.result();
		const afterDispatch = Date.now();

		const requests = cacheRequestsFor(res.usage);
		expect(requests).toHaveLength(2);

		const req1 = requests[0]!;
		expect(req1.requestId).toBe("req_api_err_1");
		expect(req1.requestStartedAt).toBeGreaterThanOrEqual(beforeDispatch);
		expect(req1.requestStartedAt).toBeLessThanOrEqual(afterDispatch);

		const req2 = requests[1]!;
		expect(req2.requestId).toBe("req_success_attempt_2");
		expect(req2.requestStartedAt).toBeGreaterThanOrEqual(req1.requestStartedAt);
		expect(req2.requestStartedAt).toBeLessThanOrEqual(afterDispatch);
		expect(req2.cacheRead).toBe(15);
		expect(req2.cacheWrite).toBe(25);
	});
});
