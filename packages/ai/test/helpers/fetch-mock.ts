import type { FetchImpl } from "../../src/types";

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;

/** Wrap a fetch handler as a {@link FetchImpl}, normalizing sync `Response` returns. */
export function mockFetch(fn: FetchHandler): FetchImpl {
	return async (input, init) => fn(input, init);
}

/** A 200 `text/event-stream` response holding one `data:` frame per event: a string is sent as is, anything else as JSON. */
export function sseResponse(events: readonly unknown[], headers: Record<string, string> = {}): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

/** A fetch that answers every request with a fresh {@link sseResponse} of `events`. */
export function sseFetch(events: readonly unknown[]): FetchImpl {
	return mockFetch(() => sseResponse(events));
}

/** A chat-completions stream that answers "ok" and stops. */
export function chatCompletionsOkSse(): Response {
	const chunk = (delta: unknown, finishReason: string | null) => ({
		id: "x",
		object: "chat.completion.chunk",
		created: 0,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	});
	return sseResponse([chunk({ content: "ok" }, null), chunk({}, "stop"), "[DONE]"]);
}

/** A Responses API stream holding one completed response with a one-token usage. */
export function responsesCompletedSse(): Response {
	return sseResponse([
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]);
}

/** A Google generateContent stream that answers "ok" and stops. */
export function googleOkSse(): Response {
	return sseResponse([
		{
			candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		},
	]);
}
