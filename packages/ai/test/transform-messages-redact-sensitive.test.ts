import { describe, expect, it } from "bun:test";
import { convertCodexResponsesMessages } from "@veyyon/ai/providers/openai-codex-responses";
import { transformMessages } from "@veyyon/ai/providers/transform-messages";
import type { Api, AssistantMessage, Context, Message, Model, ToolCall, ToolResultMessage } from "@veyyon/ai/types";
import { normalizeSystemPrompts } from "@veyyon/ai/utils";
import { createCodexModel } from "./helpers";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const makeModel = (api = "openai-responses", provider = "openai", compat?: Record<string, unknown>): Model<Api> =>
	({
		api: api as Api,
		provider,
		id: "t",
		name: "t",
		baseUrl: "https://t",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: true,
		compat,
		cost: zeroCost,
	}) as unknown as Model<Api>;

const mkAssistant = (content: AssistantMessage["content"], api = "openai-responses", provider = "openai") =>
	({
		role: "assistant",
		content,
		api: api as Api,
		provider,
		model: "t",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...zeroCost, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	}) as unknown as AssistantMessage;

describe("transformMessages redact sensitive credentials", () => {
	it("redacts already-masked and real tokens from outbound messages", () => {
		const tc: ToolCall = {
			type: "toolCall",
			id: "x",
			name: "b",
			arguments: { c: "gho_************************************" },
		};
		const messages: Message[] = [
			{ role: "user", content: "Token: gho_************************************", timestamp: 0 },
			mkAssistant([{ type: "text", text: "Key: sk-proj-************************************" }, tc]),
			{
				role: "toolResult",
				toolCallId: "x",
				toolName: "b",
				content: [{ type: "text", text: "ghp_************************************" }],
				isError: false,
				timestamp: 0,
			},
		];
		const res = transformMessages(messages, makeModel());
		expect(res[0]).toMatchObject({ content: "Token: [github_token_redacted]" });
		expect((res[1] as AssistantMessage).content[0]).toMatchObject({ text: "Key: [openai_token_redacted]" });
		expect(((res[1] as AssistantMessage).content[1] as ToolCall).arguments).toEqual({ c: "[github_token_redacted]" });
		expect((res[2] as ToolResultMessage).content[0]).toMatchObject({ text: "[github_token_redacted]" });
	});

	it("drops thinking and tool thought signatures when redacting signed content", () => {
		const anthropicModel = makeModel("anthropic-messages", "anthropic", { signingEndpoint: true });
		const token = "sk-ABCdef1234567890ABCdef1234567890ABCdef1234567890ABCdef123456";
		const thinkingMsg = mkAssistant(
			[{ type: "thinking", thinking: `Use ${token}.`, thinkingSignature: "sig" }],
			"anthropic-messages",
			"anthropic",
		);
		expect(transformMessages([thinkingMsg], anthropicModel)[0]).toMatchObject({ role: "assistant", content: [] });

		const toolMsg = mkAssistant([
			{ type: "toolCall", id: "c", name: "run", arguments: { token }, thoughtSignature: "sig" },
		]);
		const toolBlock = (transformMessages([toolMsg], makeModel())[0] as AssistantMessage).content[0] as ToolCall;
		expect(toolBlock.arguments).toEqual({ token: "[openai_token_redacted]" });
		expect(toolBlock.thoughtSignature).toBeUndefined();
	});

	it("preserves non-credential lookalike and redacts system prompt & codex history", () => {
		const lookalike = "sk-abcdefghijklmnopqrstuvwxyz";
		expect(transformMessages([{ role: "user", content: lookalike, timestamp: 0 }], makeModel())[0]).toMatchObject({
			role: "user",
			content: lookalike,
		});
		expect(normalizeSystemPrompts(["Token: gho_************************************"])).toEqual([
			"Token: [github_token_redacted]",
		]);

		const model = createCodexModel("gpt-5.1-codex");
		const token = "sk-ABCdef1234567890ABCdef1234567890ABCdef1234567890ABCdef123456";
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: "f",
					timestamp: 0,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: model.provider,
						items: [{ type: "message", role: "user", content: [{ type: "input_text", text: token }] }],
					},
				} as Context["messages"][number],
			],
		};
		expect(convertCodexResponsesMessages(model, ctx)).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "[openai_token_redacted]" }] },
		]);
	});
});
