/**
 * WHY: a history message the OpenAI-compatible converter drops must leave the wire exactly as if it
 * had never been in the history.
 *
 * The converter drops a user or developer turn with no text and an assistant turn with no text, no
 * tool calls and no reasoning. It also tracks the previous role, because a provider that requires an
 * assistant turn between a tool result and the next user turn (Mistral) gets a synthetic one. When
 * a dropped message still updated the previous role, a dropped assistant turn after a tool result
 * suppressed the synthetic turn and the next user turn followed the tool result directly, which that
 * provider rejects. When the synthetic turn was pushed before learning the user turn would be
 * dropped, the next user turn earned a second one, and two assistant turns went out back to back.
 *
 * The class: any per-message bookkeeping a dropped message performs. The invariant is checked as an
 * equality against the history with the message removed, for every droppable shape, after every
 * kind of preceding turn, on a provider with and without the synthetic-turn requirement.
 *
 * What it does not catch: a message the converter emits in reduced form rather than dropping.
 */
import { describe, expect, it } from "bun:test";
import { convertMessages } from "@veyyon/ai/providers/openai-completions";
import type { AssistantMessage, Message, Model, ToolResultMessage, Usage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function openAIModel(provider: string, id: string, baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	}) as Model<"openai-completions">;
}

const models = [
	openAIModel("mistral", "mistral-large-latest", "https://api.mistral.ai/v1"),
	openAIModel("openrouter", "gpt-4o-mini", "https://openrouter.ai/api/v1"),
];

function assistant(content: AssistantMessage["content"], model: Model<"openai-completions">): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0,
	};
}

function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 0,
	};
}

/** Each shape the converter drops, as it appears in a persisted history. */
const droppable: { shape: string; make: (model: Model<"openai-completions">) => Message }[] = [
	{ shape: "a blank user string", make: () => ({ role: "user", content: "   ", timestamp: 0 }) },
	{
		shape: "a user turn of blank text parts",
		make: () => ({ role: "user", content: [{ type: "text", text: " \n" }], timestamp: 0 }),
	},
	{ shape: "a blank developer turn", make: () => ({ role: "developer", content: "", timestamp: 0 }) },
	{
		shape: "an assistant turn of blank text",
		make: model => assistant([{ type: "text", text: "  " }], model),
	},
	{ shape: "an empty assistant turn", make: model => assistant([], model) },
];

/** Each kind of turn the dropped message can follow. */
const preceding: { after: string; make: (model: Model<"openai-completions">) => Message[] }[] = [
	{
		after: "a tool result",
		make: model => [
			{ role: "user", content: "read the file", timestamp: 0 },
			assistant([{ type: "toolCall", id: "call_read_1", name: "read", arguments: { path: "a.ts" } }], model),
			toolResult("call_read_1"),
		],
	},
	{ after: "a user turn", make: () => [{ role: "user", content: "hello", timestamp: 0 }] },
	{
		after: "an assistant turn",
		make: model => [
			{ role: "user", content: "hello", timestamp: 0 },
			assistant([{ type: "text", text: "hi" }], model),
		],
	},
];

const next: Message = { role: "user", content: "continue", timestamp: 0 };

describe("a message the OpenAI-compatible converter drops leaves no trace on the wire", () => {
	for (const model of models) {
		for (const dropped of droppable) {
			for (const before of preceding) {
				it(`${model.provider}: ${dropped.shape} after ${before.after}`, () => {
					const history = before.make(model);
					const withDropped = convertMessages(
						model,
						{ messages: [...history, dropped.make(model), next] },
						model.compat,
					);
					const without = convertMessages(model, { messages: [...history, next] }, model.compat);

					expect(withDropped).toEqual(without);
				});
			}
		}
	}

	it("inserts the synthetic assistant turn exactly once between a tool result and the next user turn", () => {
		const model = models[0]!;
		const history = preceding[0]!.make(model);
		const wire = convertMessages(model, { messages: [...history, next] }, model.compat);

		expect(wire.map(param => param.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
	});
});
