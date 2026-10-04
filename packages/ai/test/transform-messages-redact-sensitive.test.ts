import { describe, expect, it } from "bun:test";
import { redactJsonFunctionCallArguments, transformMessages } from "@veyyon/ai/providers/transform-messages";
import type { Api, AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "@veyyon/ai/types";
import { normalizeSystemPrompts } from "@veyyon/ai/utils";

const makeModel = (api = "openai-responses", provider = "openai", compat?: Record<string, unknown>) =>
	({ api, provider, compat }) as unknown as Model<Api>;
const mkAssistant = (content: AssistantMessage["content"], api = "openai-responses", provider = "openai") =>
	({ role: "assistant", content, api, provider }) as unknown as AssistantMessage;

describe("transformMessages redact sensitive credentials", () => {
	it("redacts already-masked and real tokens from outbound messages and system prompts", () => {
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

		const lookalike = "sk-abcdefghijklmnopqrstuvwxyz";
		expect(transformMessages([{ role: "user", content: lookalike, timestamp: 0 }], makeModel())[0]).toMatchObject({
			role: "user",
			content: lookalike,
		});
		expect(normalizeSystemPrompts(["Token: gho_************************************"])).toEqual([
			"Token: [github_token_redacted]",
		]);
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

	it("redacts secret object keys avoiding silent collisions, preserves own __proto__, and drops thoughtSignature", () => {
		const k1 = "sk-proj-ABCdef1234567890ABCdef1234567890ABCdef1234567890ABCdef123456";
		const k2 = "sk-proj-XYZdef1234567890ABCdef1234567890ABCdef1234567890ABCdef123456";
		expect(() =>
			transformMessages(
				[mkAssistant([{ type: "toolCall", id: "c", name: "run", arguments: { [k1]: "v1", [k2]: "v2" } }])],
				makeModel(),
			),
		).toThrow(/Redacted property key collision/);

		const rawWithProto = JSON.parse(
			`{"__proto__":"harmless_proto_val","${k1}":"v1","token":"ghp_ABCdef1234567890ABCdef1234567890ABCdef"}`,
		);
		const toolMsg = mkAssistant([
			{ type: "toolCall", id: "c", name: "run", arguments: rawWithProto, thoughtSignature: "sig" },
		]);
		const toolBlock = (transformMessages([toolMsg], makeModel())[0] as AssistantMessage).content[0] as ToolCall;
		expect(toolBlock.thoughtSignature).toBeUndefined();
		expect(Object.hasOwn(toolBlock.arguments, "__proto__")).toBe(true);
		// biome-ignore lint/suspicious/noProto lint/complexity/useLiteralKeys: Testing explicit __proto__ property preservation
		expect(toolBlock.arguments["__proto__"]).toBe("harmless_proto_val");
		expect(toolBlock.arguments["[openai_token_redacted]"]).toBe("v1");
		expect(toolBlock.arguments.token).toBe("[github_token_redacted]");
		expect(JSON.stringify(toolBlock.arguments)).toContain('"__proto__":"harmless_proto_val"');
	});

	it("redacts native function_call arguments with JSON unicode escapes and handles invalid JSON", () => {
		const unicodeArgs = '{"token":"\\u0067hp_ABCdef1234567890ABCdef1234567890ABCdef"}';
		const { result: redactedUnicode } = redactJsonFunctionCallArguments(unicodeArgs);
		expect(JSON.parse(redactedUnicode)).toEqual({ token: "[github_token_redacted]" });

		const invalidJson = '{"token": incomplete ghp_ABCdef1234567890ABCdef1234567890ABCdef';
		const { result: redactedInvalid } = redactJsonFunctionCallArguments(invalidJson);
		expect(redactedInvalid).toBe('{"token": incomplete [github_token_redacted]');
	});
});
