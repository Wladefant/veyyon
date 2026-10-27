import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { AnthropicMessages } from "@veyyon/ai/providers/anthropic-client";
import type { Context, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

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
	return [
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
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: options.text ?? "Hello" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				output_tokens: options.outputTokens ?? 5,
			},
		},
	];
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Anthropic cache telemetry", () => {
	it("records 1h requested TTL telemetry for requests with 1h retention", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() =>
			createMockRequest(createEvents({ cacheReadTokens: 10, cacheWriteTokens: 20 }), "req_1h") as never,
		);

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			cacheRetention: "long",
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		const usage = result.usage as Record<string, any>;
		expect(usage.cacheRequests).toBeDefined();
		expect(usage.cacheRequests).toHaveLength(1);
		const req = usage.cacheRequests[0];
		expect(req.requestedTtl).toBe("1h");
		expect(req.model).toBe("claude-sonnet-4-5");
		expect(req.requestId).toBe("req_1h");
		expect(req.requestStartedAt).toBeGreaterThan(0);
		expect(typeof req.prefixHash).toBe("string");
		expect(req.prefixHash).toHaveLength(64);
		expect(req.cacheRead).toBe(10);
		expect(req.cacheWrite).toBe(20);
	});

	it("records none requested TTL when caching is declined", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() =>
			createMockRequest(createEvents(), "req_none") as never,
		);

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			cacheRetention: "none",
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		const usage = result.usage as Record<string, any>;
		expect(usage.cacheRequests).toBeDefined();
		expect(usage.cacheRequests).toHaveLength(1);
		const req = usage.cacheRequests[0];
		expect(req.requestedTtl).toBe("none");
		expect(req.requestedTtls).toBeUndefined();
		expect(req.requestId).toBe("req_none");
	});

	it("captures optional split and handles omitted split safely", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementationOnce(() =>
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
		const req1 = (res1.usage as Record<string, any>).cacheRequests?.[0];
		expect(req1.cacheRead).toBe(50);
		expect(req1.cacheWrite).toBe(300);
		expect(req1.cttl).toEqual({ ephemeral5m: 100, ephemeral1h: 200 });

		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementationOnce(() =>
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
		const req2 = (res2.usage as Record<string, any>).cacheRequests?.[0];
		expect(req2.cacheRead).toBe(40);
		expect(req2.cacheWrite).toBe(100);
		expect(req2.cttl).toBeUndefined();
	});

	it("produces stable prefixHash on repeat and distinct prefixHash on change", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() =>
			createMockRequest(createEvents()) as never,
		);

		const s1 = streamAnthropic(MODEL, CONTEXT, { apiKey: "sk-ant-test" });
		for await (const _ of s1) {
			// drain
		}
		const res1 = await s1.result();
		const hash1 = (res1.usage as Record<string, any>).cacheRequests?.[0]?.prefixHash;

		const s2 = streamAnthropic(MODEL, CONTEXT, { apiKey: "sk-ant-test" });
		for await (const _ of s2) {
			// drain
		}
		const res2 = await s2.result();
		const hash2 = (res2.usage as Record<string, any>).cacheRequests?.[0]?.prefixHash;

		expect(hash1).toBeDefined();
		expect(hash1).toBe(hash2);

		const modifiedContext: Context = {
			systemPrompt: ["Different system prompt content"],
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const s3 = streamAnthropic(MODEL, modifiedContext, { apiKey: "sk-ant-test" });
		for await (const _ of s3) {
			// drain
		}
		const res3 = await s3.result();
		const hash3 = (res3.usage as Record<string, any>).cacheRequests?.[0]?.prefixHash;

		expect(hash3).toBeDefined();
		expect(hash3).not.toBe(hash1);
	});

	it("keeps outgoing request body unchanged on wire", async () => {
		let capturedParams: Record<string, any> | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			capturedParams = params as Record<string, any>;
			return createMockRequest(createEvents()) as never;
		});

		const s = streamAnthropic(MODEL, CONTEXT, { apiKey: "sk-ant-test" });
		for await (const _ of s) {
			// drain
		}
		await s.result();

		expect(capturedParams).toBeDefined();
		expect(capturedParams?.cacheRequests).toBeUndefined();
		expect(capturedParams?.telemetry).toBeUndefined();
		expect(capturedParams?.model).toBe("claude-sonnet-4-5");
		expect(Array.isArray(capturedParams?.messages)).toBe(true);
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

		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() =>
			createMockRequest(createEvents()) as never,
		);

		const s = streamAnthropic(MODEL, sensitiveContext, { apiKey: "sk-ant-test" });
		for await (const _ of s) {
			// drain
		}
		const res = await s.result();

		const usage = res.usage as Record<string, any>;
		expect(usage.cacheRequests).toBeDefined();
		const telemetryJson = JSON.stringify(usage.cacheRequests);
		expect(telemetryJson).not.toContain(SECRET_PHRASE);
		expect(telemetryJson).not.toContain("confidential_tool");
		expect(telemetryJson).not.toContain("sk-ant-test");
	});

	it("handles mixed TTLs without silently collapsing to a single TTL", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() =>
			createMockRequest(createEvents()) as never,
		);

		const s = streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-test",
			onPayload: payload => {
				payload.system = [
					{ type: "text", text: "sys1", cache_control: { type: "ephemeral", ttl: "1h" } },
					{ type: "text", text: "sys2", cache_control: { type: "ephemeral" } },
				];
				for (const m of payload.messages ?? []) {
					if (Array.isArray(m.content)) {
						for (const b of m.content) {
							delete b.cache_control;
						}
					}
				}
				return payload;
			},
		});
		for await (const _ of s) {
			// drain
		}
		const res = await s.result();

		const usage = res.usage as Record<string, any>;
		expect(usage.cacheRequests).toBeDefined();
		const req = usage.cacheRequests[0];
		expect(req.requestedTtl).toBe("mixed");
		expect(req.requestedTtls).toEqual(["1h", "5m"]);
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

		const usage = res.usage as Record<string, any>;
		expect(usage.cacheRequests).toBeDefined();
		expect(usage.cacheRequests.length).toBe(2);

		const req1 = usage.cacheRequests[0];
		expect(req1.requestId).toBe("req_attempt_1");
		expect(req1.cacheRead).toBe(30);
		expect(req1.cacheWrite).toBe(70);

		const req2 = usage.cacheRequests[1];
		expect(req2.requestId).toBe("req_attempt_2");
		expect(req2.cacheRead).toBe(10);
		expect(req2.cacheWrite).toBe(20);

		expect(req2.cacheRead).not.toBe(40);
	});
});
