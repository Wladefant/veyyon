import { describe, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import {
	convertResponsesAssistantMessage,
	SYNTHETIC_REASONING_REPLAY_PLACEHOLDER,
} from "@veyyon/ai/providers/openai-shared";
import { createOpenAIResponsesHistoryPayload } from "@veyyon/ai/utils";
import type { AssistantMessage, Context, Model } from "@veyyon/ai/types";
import { Effort } from "@veyyon/catalog/effort";
import { buildModel } from "@veyyon/catalog/build";

interface WireItem {
	type?: string;
	id?: string;
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
}

interface WirePayload {
	input?: WireItem[];
}

function capture(model: Model<"openai-responses">, context: Context): Promise<WirePayload> {
	const { promise, resolve } = Promise.withResolvers<WirePayload>();
	const controller = new AbortController();
	controller.abort();
	streamOpenAIResponses(model, context, {
		apiKey: "sk-test",
		reasoning: Effort.XHigh,
		signal: controller.signal,
		onPayload: payload => resolve(payload as WirePayload),
	});
	return promise;
}

const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const deepseek = buildModel({
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "openai-responses",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High], defaultLevel: Effort.High },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
});

describe("DeepSeek Responses reasoning replay", () => {
	it("substitutes a non-empty placeholder for an empty-text thinking block, preserving upstream id", () => {
		const prior: AssistantMessage = {
			role: "assistant", api: "openai-responses", provider: "opencode-go", model: "deepseek-v4-flash",
			stopReason: "stop", usage, timestamp: 1,
			content: [{ type: "thinking", thinking: "", itemId: "rs_upstream" }, { type: "text", text: "Edited bar.ts." }],
		};
		const items = convertResponsesAssistantMessage(prior, deepseek, 0, new Set(), true, undefined, false, true, undefined, true) as WireItem[];
		const reasoning = items.filter(item => item.type === "reasoning");
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0]!.id).toBe("rs_upstream");
		expect(reasoning[0]!.content?.[0]?.text).toBe(SYNTHETIC_REASONING_REPLAY_PLACEHOLDER);
	});

	it("preserves real surviving thinking text instead of the placeholder", async () => {
		const prior: AssistantMessage = {
			role: "assistant", api: "openai-responses", provider: "opencode-go", model: "deepseek-v4-flash",
			stopReason: "stop", usage, timestamp: 1,
			content: [{ type: "thinking", thinking: "Inspect bar.ts." }, { type: "text", text: "Edited." }],
		};
		const payload = await capture(deepseek, { messages: [{ role: "user", content: "Edit", timestamp: 1 }, prior, { role: "user", content: "Test", timestamp: 2 }] });
		const reasoning = (payload.input ?? []).filter(item => item.type === "reasoning");
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0]!.content?.[0]?.text).toBe("Inspect bar.ts.");
	});

	it("adds required reasoning before native history from a custom DeepSeek Responses model", async () => {
		const custom = buildModel({
			id: "deepseek-flash", name: "DeepSeek Flash", api: "openai-responses", provider: "custom-deepseek",
			baseUrl: "https://api.deepseek.com", reasoning: true, thinking: { mode: "effort", efforts: [Effort.Low, Effort.High], defaultLevel: Effort.High },
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_000,
		});
		const prior: AssistantMessage = {
			role: "assistant", api: custom.api, provider: custom.provider, model: custom.id, stopReason: "stop", usage, timestamp: 1,
			content: [{ type: "text", text: "Done." }],
			providerPayload: createOpenAIResponsesHistoryPayload(custom.provider, [
				{ role: "user", content: [{ type: "input_text", text: "Inspect and edit." }] },
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Inspecting." }], status: "completed" },
				{ type: "function_call", call_id: "call_read", name: "read", arguments: "{}" },
				{ type: "function_call_output", call_id: "call_read", output: "contents" },
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Edited." }], status: "completed" },
			], false),
		};
		const payload = await capture(custom, { messages: [{ role: "user", content: "Edit", timestamp: 1 }, prior, { role: "user", content: "Test", timestamp: 2 }] });
		const input = payload.input ?? [];
		const reasoning = input.filter(item => item.type === "reasoning");
		expect(reasoning).toHaveLength(2);
		for (const item of reasoning) expect(item.content?.[0]?.text).toBe(SYNTHETIC_REASONING_REPLAY_PLACEHOLDER);
		expect(input.map(item => item.type ?? item.role)).toEqual(["user", "reasoning", "message", "function_call", "function_call_output", "reasoning", "message", "user"]);
	});
});
