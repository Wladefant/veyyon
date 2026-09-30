// Regression coverage for gateways (OpenRouter, Vercel AI Gateway, …) that
// report upstream model failures as a bare `finish_reason: "error"` — e.g.
// Gemini MALFORMED_FUNCTION_CALL behind an OpenAI-compat endpoint. Such a turn
// must be retried rather than stopping with a pinned error banner.
//
// This asserted the wording (`provider.?returned.?error`) rather than the
// verdict, which is what let the wording carry the decision: the provider
// phrased its message to suit a regex in another module, and the three
// providers that phrased it differently walled on the identical failure. The
// assertion is now the flag the turn domain actually reads, and the string it
// checks is the one the owner mints.
import { describe, expect, it } from "bun:test";
import { Flag } from "@veyyon/ai/error/flag";
import { classify } from "@veyyon/ai/error/flags";
import { providerFinishErrorMessage } from "@veyyon/ai/error/provider";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";

/** Raised on a turn the turn domain is willing to send again. */
function turnRetries(message: string | undefined): boolean {
	return (classify(new Error(message ?? "")) & Flag.ProviderFinishError) !== 0;
}

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					const data = typeof event === "string" ? event : JSON.stringify(event);
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));
				}
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return mockFetch as typeof fetch;
}

function completionChunk(extra: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-error-finish",
		object: "chat.completion.chunk",
		created: 0,
		model: completionsModel.id,
		...extra,
	};
}

describe("finish_reason: error", () => {
	it("maps to a retryable error message", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(providerFinishErrorMessage("error"));
		expect(turnRetries(result.errorMessage)).toBe(true);
	}, 10_000);

	it("stays an error even when the stream carried tool calls", async () => {
		// The user-visible failure mode: the model garbles a tool call, the
		// gateway ends the stream with `finish_reason: "error"`. Tool-call
		// promotion (stop → toolUse) must not paper over the error finish.
		const fetchMock = createSseFetch([
			completionChunk({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: '{"pattern":"x"}' },
								},
							],
						},
					},
				],
			}),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(providerFinishErrorMessage("error"));
		expect(turnRetries(result.errorMessage)).toBe(true);
	}, 10_000);
});

describe("finish_reason: insufficient_system_resource", () => {
	// DeepSeek interrupts the generation mid-stream when its inference system
	// runs out of resources. The turn is a server-side capacity failure, so it
	// must be retried like the bare `error` finish, not pinned as a fatal error.
	it("maps to a retryable error message", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "insufficient_system_resource" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(providerFinishErrorMessage("insufficient_system_resource"));
		expect(turnRetries(result.errorMessage)).toBe(true);
	}, 10_000);
});

describe("in-band SSE error envelope", () => {
	it("surfaces a queue-full error carried inside a successful HTTP stream", async () => {
		const fetchMock = createSseFetch([
			{
				error: {
					object: "error",
					message: "The request queue is full.",
					type: "SERVICE_UNAVAILABLE",
					param: null,
					code: 503,
				},
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(503);
		expect(result.errorMessage).toContain("The request queue is full.");
	}, 10_000);

	it("does not replay after content precedes an in-band error", async () => {
		let attempts = 0;
		const baseFetch = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Partial" } }] }),
			{
				error: {
					message: "Request timed out in the queue.",
					type: "REQUEST_TIMEOUT",
				},
			},
			"[DONE]",
		]);
		const fetchMock: FetchImpl = async (input, init) => {
			attempts++;
			return baseFetch(input, init);
		};

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(408);
		expect(result.content).toEqual([{ type: "text", text: "Partial" }]);
	}, 10_000);
});
