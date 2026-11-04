import { describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import type { AssistantMessageEventStream, Context, FetchImpl, Model, ProviderSessionState } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const u1 = { role: "user" as const, content: "read", timestamp: 1 };
const context: Context = { messages: [u1] };
const sse = (e: unknown[]) =>
	new Response(`${e.map(x => `data: ${JSON.stringify(x)}\n\n`).join("")}\n`, {
		headers: { "content-type": "text/event-stream" },
	});
const truncTool = () =>
	new Response(
		`data: {"type":"response.created","response":{"id":"p","status":"in_progress"}}\n\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_p","call_id":"c_p","name":"read","arguments":"","status":"in_progress"}}\n\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_p","delta":`,
		{ headers: { "content-type": "text/event-stream" } },
	);
const toolResp = (id = "resp_retry") =>
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
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_r", delta: '{"path":"a"}' },
		{ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_r", arguments: '{"path":"a"}' },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_r",
				call_id: "c_r",
				name: "read",
				arguments: '{"path":"a"}',
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
const textResp = (text: string, id: string) =>
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
const body = (i?: RequestInit) => JSON.parse(String(i?.body)) as Record<string, unknown>;
const collect = async (s: AssistantMessageEventStream) => {
	const r = [];
	for await (const e of s) r.push(e);
	return r;
};

describe("OpenAI Responses transient stream retry", () => {
	it("retries a truncated pending tool call with a fresh request and clean state", async () => {
		const sent: Array<Record<string, unknown>> = [];
		let a = 0;
		const fetchMock = vi.fn(async (_i: unknown, init?: RequestInit) => {
			sent.push(body(init));
			return ++a === 1 ? truncTool() : a === 2 ? toolResp() : textResp("Follow-up", "resp_f");
		}) as FetchImpl;
		const opts = {
			apiKey: "k",
			fetch: fetchMock,
			providerRetryWait: async () => {},
			providerSessionState: new Map<string, ProviderSessionState>(),
			sessionId: "s",
			statefulResponses: true,
		};
		const s = streamOpenAIResponses(model, context, opts);
		const events = await collect(s);
		const result = await s.result();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sent[1]).toEqual(sent[0]);
		expect(result.stopReason).toBe("toolUse");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{ type: "toolCall", id: "c_r|fc_r", name: "read", arguments: { path: "a" } },
		]);
		expect(events.map(e => e.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
		const followup = await streamOpenAIResponses(
			model,
			{ messages: [u1, result, { role: "user", content: "m", timestamp: 2 }] },
			opts,
		).result();
		expect(followup.stopReason).toBe("stop");
		expect(sent[2]?.previous_response_id).toBe("resp_retry");
	});

	it("falls back to full transcript when a fresh stream retry finds a stale chain baseline", async () => {
		const sent: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_i: unknown, init?: RequestInit) => {
			sent.push(body(init));
			switch (sent.length) {
				case 1:
					return textResp("Baseline", "resp_base");
				case 2:
					return truncTool();
				case 3:
					return new Response(
						JSON.stringify({
							error: {
								message: "not found",
								type: "invalid_request_error",
								param: "previous_response_id",
								code: "previous_response_not_found",
							},
						}),
						{ status: 404, headers: { "content-type": "application/json" } },
					);
				case 4:
					return textResp("Recovered", "resp_rec");
				default:
					return textResp("Follow-up", "resp_f");
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
		const s = streamOpenAIResponses(
			model,
			{ messages: [u1, baseline, { role: "user", content: "c", timestamp: 2 }] },
			opts,
		);
		const events = await collect(s);
		const recovered = await s.result();
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(sent[1]?.previous_response_id).toBe("resp_base");
		expect(sent[2]).toEqual(sent[1]);
		expect(sent[3]?.previous_response_id).toBeUndefined();
		expect(sent[3]?.store).toBe(true);
		expect(recovered.responseId).toBe("resp_rec");
		expect(events.map(e => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		const followup = await streamOpenAIResponses(
			model,
			{
				messages: [
					u1,
					baseline,
					{ role: "user", content: "c", timestamp: 2 },
					recovered,
					{ role: "user", content: "m", timestamp: 3 },
				],
			},
			opts,
		).result();
		expect(followup.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(sent[4]?.previous_response_id).toBe("resp_rec");
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
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_p", delta: '{"path":"a"}' },
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
		const fetchMock = vi.fn(async () => truncTool()) as FetchImpl;
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
		const fetchMock = vi.fn(async () => truncTool()) as FetchImpl;
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
