import { describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
} from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const firstUser = { role: "user" as const, content: "Read the file", timestamp: 1_000 };
const context: Context = { messages: [firstUser] };

const sse = (events: unknown[]) =>
	new Response(`${events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")}\n`, {
		headers: { "content-type": "text/event-stream" },
	});
const createTruncatedPendingToolResponse = () =>
	new Response(
		`data: ${JSON.stringify({ type: "response.created", response: { id: "p", status: "in_progress" } })}\n\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_p", call_id: "c_p", name: "read", arguments: "", status: "in_progress" } })}\n\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_p","delta":`,
		{ headers: { "content-type": "text/event-stream" } },
	);

const createCompletedToolResponse = (id = "resp_retry", a = '{"path":"README.md"}') =>
	sse([
		{ type: "response.created", response: { id, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_r",
				call_id: "c_r",
				name: "read",
				arguments: "",
				status: "in_progress",
			},
		},
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_r", delta: a },
		{ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_r", arguments: a },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_r",
				call_id: "c_r",
				name: "read",
				arguments: a,
				status: "completed",
			},
		},
		{
			type: "response.completed",
			response: {
				id,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]);

const createCompletedTextResponse = (text: string, id: string) =>
	sse([
		{ type: "response.created", response: { id, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: `m_${id}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: `m_${id}`, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: `m_${id}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{ type: "response.completed", response: { id, status: "completed" } },
	]);

const parseBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;
const collect = async (s: AssistantMessageEventStream) => {
	const r: AssistantMessageEvent[] = [];
	for await (const e of s) r.push(e);
	return r;
};

describe("OpenAI Responses transient stream retry", () => {
	it("retries a truncated pending tool call with a fresh request and clean state", async () => {
		const sent: Array<Record<string, unknown>> = [];
		let attempt = 0;
		let payloadCalls = 0;
		const fetchMock = vi.fn(async (_i: unknown, init?: RequestInit) => {
			sent.push(parseBody(init));
			return ++attempt === 1
				? createTruncatedPendingToolResponse()
				: attempt === 2
					? createCompletedToolResponse()
					: createCompletedTextResponse("Follow-up", "resp_followup");
		}) as FetchImpl;
		const opts = {
			apiKey: "k",
			fetch: fetchMock,
			providerRetryWait: async () => {},
			providerSessionState: new Map<string, ProviderSessionState>(),
			sessionId: "s",
			statefulResponses: true,
			onPayload: (p: unknown) => {
				payloadCalls++;
				return { ...(p as Record<string, unknown>), metadata: { retry_test: "preserved" } };
			},
		};
		const s = streamOpenAIResponses(model, context, opts);
		const events = await collect(s);
		const result = await s.result();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(payloadCalls).toBe(1);
		expect(sent[0]?.metadata).toEqual({ retry_test: "preserved" });
		expect(sent[1]).toEqual(sent[0]);
		expect(result.stopReason).toBe("toolUse");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{ type: "toolCall", id: "c_r|fc_r", name: "read", arguments: { path: "README.md" } },
		]);
		expect(events.map(e => e.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
		const followup = await streamOpenAIResponses(
			model,
			{ messages: [firstUser, result, { role: "user", content: "more", timestamp: 1_001 }] },
			opts,
		).result();
		expect(followup.stopReason).toBe("stop");
		expect(sent[2]?.previous_response_id).toBe("resp_retry");
	});

	it("falls back to full transcript when a fresh stream retry finds a stale chain baseline", async () => {
		const sent: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_i: unknown, init?: RequestInit) => {
			sent.push(parseBody(init));
			switch (sent.length) {
				case 1:
					return createCompletedTextResponse("Baseline", "resp_baseline");
				case 2:
					return createTruncatedPendingToolResponse();
				case 3:
					return new Response(
						JSON.stringify({
							error: {
								message: "Previous response with id 'resp_baseline' not found.",
								type: "invalid_request_error",
								param: "previous_response_id",
								code: "previous_response_not_found",
							},
						}),
						{ status: 404, headers: { "content-type": "application/json" } },
					);
				case 4:
					return createCompletedTextResponse("Recovered", "resp_recovered");
				default:
					return createCompletedTextResponse("Follow-up", "resp_followup");
			}
		}) as FetchImpl;
		const opts = {
			apiKey: "k",
			fetch: fetchMock,
			providerRetryWait: async () => {},
			providerSessionState: new Map<string, ProviderSessionState>(),
			sessionId: "s2",
			statefulResponses: true,
		};
		const baseline = await streamOpenAIResponses(model, context, opts).result();
		const u2 = { role: "user" as const, content: "continue", timestamp: 1_001 };
		const s = streamOpenAIResponses(model, { messages: [firstUser, baseline, u2] }, opts);
		const events = await collect(s);
		const recovered = await s.result();
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(sent[1]?.previous_response_id).toBe("resp_baseline");
		expect(sent[2]).toEqual(sent[1]);
		expect(sent[3]?.previous_response_id).toBeUndefined();
		expect(sent[3]?.store).toBe(true);
		expect(recovered.responseId).toBe("resp_recovered");
		expect(events.map(e => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		const followup = await streamOpenAIResponses(
			model,
			{ messages: [firstUser, baseline, u2, recovered, { role: "user", content: "more", timestamp: 1_002 }] },
			opts,
		).result();
		expect(followup.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(sent[4]?.previous_response_id).toBe("resp_recovered");
	});

	it("does not retry after a tool argument delta was emitted", async () => {
		const sseWithDelta = sse([
			{ type: "response.created", response: { id: "p", status: "in_progress" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_p",
					call_id: "c_p",
					name: "read",
					arguments: "",
					status: "in_progress",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: "fc_p",
				delta: '{"path":"README.md"}',
			},
		]);
		const fetchMock = vi.fn(async () => sseWithDelta) as FetchImpl;
		const result = await streamOpenAIResponses(model, context, {
			apiKey: "k",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
	});

	it("bounds repeated pre-output stream corruption to one retry", async () => {
		const fetchMock = vi.fn(async () => createTruncatedPendingToolResponse()) as FetchImpl;
		const result = await streamOpenAIResponses(model, context, {
			apiKey: "k",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("error");
	});

	it("honors caller abort during the retry wait", async () => {
		const c = new AbortController();
		const fetchMock = vi.fn(async () => createTruncatedPendingToolResponse()) as FetchImpl;
		const s = streamOpenAIResponses(model, context, {
			apiKey: "k",
			fetch: fetchMock,
			signal: c.signal,
			providerRetryWait: async () => c.abort(),
		});
		const events = await collect(s);
		const result = await s.result();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("aborted");
		expect(events.map(e => e.type)).toEqual(["start", "error"]);
	});

	it("does not retry terminal failure", async () => {
		const fetchMock = vi.fn(async () =>
			sse([
				{
					type: "response.failed",
					response: { id: "f", status: "failed", error: { code: "invalid_request_error", message: "invalid" } },
				},
			]),
		) as FetchImpl;
		const result = await streamOpenAIResponses(model, context, {
			apiKey: "k",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
	});
});
