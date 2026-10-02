import { describe, expect, it, vi } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import type { AssistantMessageEventStream, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildHttp400DumpPayload } from "@veyyon/ai/utils/http-inspector";
import { getBundledModel } from "@veyyon/catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const u1 = { role: "user" as const, content: "hello", timestamp: 1 };
const context: Context = { messages: [u1] };
const sse = (e: unknown[]) =>
	new Response(`${e.map(x => `data: ${JSON.stringify(x)}\n\n`).join("")}\n`, {
		headers: { "content-type": "text/event-stream" },
	});
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
			item: { type: "message", id: `m_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
		},
		{ type: "response.completed", response: { id, status: "completed" } },
	]);
const truncStream = () =>
	new Response(
		`data: {"type":"response.created","response":{"id":"p","status":"in_progress"}}\n\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m_p","role":"assistant","status":"in_progress","content":[]}}\n\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"m_p","delta":`,
		{ headers: { "content-type": "text/event-stream" } },
	);
const body = (i?: RequestInit) => JSON.parse(String(i?.body)) as Record<string, unknown>;
const collect = async (s: AssistantMessageEventStream) => {
	const r = [];
	for await (const e of s) r.push(e);
	return r;
};

describe("OpenAI Responses prepared request cache", () => {
	it("rebuilds wire body on reasoning effort fallback without re-invoking onPayload", async () => {
		const sent: Array<Record<string, unknown>> = [];
		let onPayloadCount = 0;
		const fetchMock = vi.fn(async (_i: unknown, init?: RequestInit) => {
			sent.push(body(init));
			if (sent.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							message: "Invalid reasoning_effort 'high': supported values are 'low', 'medium'",
							type: "invalid_request_error",
							code: "invalid_reasoning_effort",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return textResp("Recovered after fallback", "resp_fallback");
		}) as FetchImpl;

		const s = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			onPayload: async payload => {
				onPayloadCount++;
				(payload as Record<string, unknown>).hooked = true;
				return payload;
			},
		});

		await collect(s);
		const result = await s.result();
		expect(result.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(onPayloadCount).toBe(1);
		expect((sent[0]?.reasoning as Record<string, unknown> | undefined)?.effort ?? sent[0]?.reasoning_effort).toBe("high");
		expect(sent[0]?.hooked).toBe(true);
		expect((sent[1]?.reasoning as Record<string, unknown> | undefined)?.effort ?? sent[1]?.reasoning_effort).toBe("medium");
		expect(sent[1]?.hooked).toBe(true);
	});

	it("preserves exact sent payload in HTTP 400/413 error diagnostics including onPayload mutation", async () => {
		const finalizeSpy = vi.spyOn(AIError, "finalize");
		try {
			const fetchMock = vi.fn(async () => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Bad request rejected by provider",
							type: "invalid_request_error",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}) as FetchImpl;

			const s = streamOpenAIResponses(model, context, {
				apiKey: "test-key",
				fetch: fetchMock,
				onPayload: async payload => {
					(payload as Record<string, unknown>).custom_field = "mutated_400";
					return payload;
				},
			});

			await collect(s);
			const result = await s.result();
			expect(result.stopReason).toBe("error");
			expect(finalizeSpy).toHaveBeenCalled();
			const finalizeOpts = finalizeSpy.mock.calls.at(-1)?.[1];
			expect(finalizeOpts?.rawRequestDump?.body).toMatchObject({ custom_field: "mutated_400" });
			const dumpPayload = buildHttp400DumpPayload(finalizeOpts!.rawRequestDump!, new Error("400"), "test");
			expect(dumpPayload.body).toMatchObject({ custom_field: "mutated_400" });
		} finally {
			finalizeSpy.mockRestore();
		}
	});

	it("reuses cached wire body across transient stream retries without re-invoking onPayload", async () => {
		const sent: Array<Record<string, unknown>> = [];
		let onPayloadCount = 0;
		const fetchMock = vi.fn(async (_i: unknown, init?: RequestInit) => {
			sent.push(body(init));
			return sent.length === 1 ? truncStream() : textResp("Retried successfully", "resp_ok");
		}) as FetchImpl;

		const s = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
			onPayload: async payload => {
				onPayloadCount++;
				(payload as Record<string, unknown>).custom_retry_token = "tag_123";
				return payload;
			},
		});

		await collect(s);
		const result = await s.result();
		expect(result.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(onPayloadCount).toBe(1);
		expect(sent[0]?.custom_retry_token).toBe("tag_123");
		expect(sent[1]).toEqual(sent[0]);
	});
});
