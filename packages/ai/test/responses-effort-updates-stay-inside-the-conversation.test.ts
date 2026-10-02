// WHY: A changing request-level effort breaks prompt-cache prefixes. Drive the real
// stream and transcript replay; the external HTTP endpoint is the only fake boundary.
import { expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import type { OpenAIResponsesOptions } from "../src/providers/openai-responses";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, FetchImpl, Model, ProviderSessionState } from "../src/types";

interface WireItem {
	type?: string;
	role?: string;
	reasoning?: { effort: string };
}
interface WireRequest {
	reasoning?: { effort?: string };
	input: WireItem[];
}
const model = buildModel({
	id: "gpt-6-astra",
	name: "Astra",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
});
function endpoint(requests: WireRequest[]): FetchImpl {
	return async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)) as WireRequest);
		const item = {
			type: "message",
			id: "fake-message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "answer" }],
		};
		const events = [
			{ type: "response.output_item.added", item: { ...item, content: [] } },
			{ type: "response.output_text.delta", delta: "answer" },
			{ type: "response.output_item.done", item },
			{
				type: "response.completed",
				response: { id: "fake-response", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
			},
		];
		return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	};
}
async function turn(
	selected: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions,
): Promise<void> {
	const response = await streamOpenAIResponses(selected, context, options).result();
	expect(response.stopReason).toBe("stop");
	context.messages.push(response);
}

it("keeps the request prefix pinned while replaying successive effort updates", async () => {
	const requests: WireRequest[] = [];
	const states = new Map<string, ProviderSessionState>();
	const context: Context = { messages: [{ role: "user", content: "first", timestamp: 0 }] };
	const options: OpenAIResponsesOptions = {
		apiKey: "fake-key",
		sessionId: "fake-session",
		providerSessionState: states,
		statefulResponses: false,
		fetch: endpoint(requests),
	};
	for (const effort of ["low", "high", "medium"] as const) {
		if (requests.length)
			context.messages.push({ role: "user", content: `turn ${requests.length}`, timestamp: requests.length });
		await turn(model, context, { ...options, reasoning: effort });
	}
	expect(requests.map(request => request.reasoning?.effort)).toEqual(["low", "low", "low"]);
	expect(requests.map(request => request.input.filter(item => item.type === "configuration_update"))).toEqual([
		[],
		[{ type: "configuration_update", reasoning: { effort: "high" } }],
		[
			{ type: "configuration_update", reasoning: { effort: "high" } },
			{ type: "configuration_update", reasoning: { effort: "medium" } },
		],
	]);
	expect(requests[1].input.at(-2)?.type).toBe("configuration_update");
	expect(requests[1].input.at(-1)?.role).toBe("user");
	for (const state of states.values()) state.close();
	context.messages.push({ role: "user", content: "after reset", timestamp: 4 });
	await turn(model, context, { ...options, reasoning: "high" });
	expect(requests[3].reasoning?.effort).toBe("high");
	expect(requests[3].input.filter(item => item.type === "configuration_update")).toEqual([]);
});

it("drops a transition-free baseline when the provider session closes", async () => {
	const requests: WireRequest[] = [];
	const states = new Map<string, ProviderSessionState>();
	const context: Context = { messages: [{ role: "user", content: "first", timestamp: 0 }] };
	const options: OpenAIResponsesOptions = {
		apiKey: "fake-key",
		sessionId: "reset-session",
		providerSessionState: states,
		statefulResponses: false,
		fetch: endpoint(requests),
	};
	await turn(model, context, { ...options, reasoning: "low" });
	for (const state of states.values()) state.close();
	context.messages.push({ role: "user", content: "after close", timestamp: 1 });
	await turn(model, context, { ...options, reasoning: "high" });
	expect(requests.map(request => request.reasoning?.effort)).toEqual(["low", "high"]);
	expect(requests.flatMap(request => request.input.filter(item => item.type === "configuration_update"))).toEqual([]);
	for (const state of states.values()) state.close();
});

it("does not emit updates without the capability, a routing session or provider state", async () => {
	for (const mode of ["unsupported", "no-session", "no-state"] as const) {
		const requests: WireRequest[] = [];
		const context: Context = { messages: [{ role: "user", content: "first", timestamp: 0 }] };
		const selected =
			mode === "unsupported" ? { ...model, compat: { ...model.compat, supportsConfigurationUpdate: false } } : model;
		const options: OpenAIResponsesOptions = {
			apiKey: "fake-key",
			statefulResponses: false,
			fetch: endpoint(requests),
			sessionId: mode === "no-session" ? undefined : "fake-session",
			providerSessionState: mode === "no-state" ? undefined : new Map(),
		};
		await turn(selected, context, { ...options, reasoning: "low" });
		context.messages.push({ role: "user", content: "second", timestamp: 1 });
		await turn(selected, context, { ...options, reasoning: "high" });
		expect(requests.map(request => request.reasoning?.effort)).toEqual(["low", "high"]);
		expect(requests.flatMap(request => request.input.filter(item => item.type === "configuration_update"))).toEqual(
			[],
		);
	}
});
