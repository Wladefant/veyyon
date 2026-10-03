import { describe, expect, it } from "bun:test";
import { convertCodexResponsesMessages } from "@veyyon/ai/providers/openai-codex-responses";
import type { AssistantMessage, Context } from "@veyyon/ai/types";
import { createCodexModel } from "./helpers";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("convertCodexResponsesMessages history credential redaction", () => {
	it("redacts codex user history payload", () => {
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

	it("sanitizes native assistant payload in append and splice while preserving reasoning", () => {
		const model = createCodexModel("gpt-5.1-codex");
		const token = "ghp_ABCdef1234567890ABCdef1234567890ABCdef";
		const mkMsg = (dt: boolean): AssistantMessage =>
			({
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "text", text: token }],
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: model.provider,
					dt,
					items: [
						{ type: "reasoning", encrypted_content: "enc_data", id: "r_1" },
						{ type: "message", role: "assistant", content: [{ type: "output_text", text: `key: ${token}` }] },
						{ type: "function_call", name: "f", call_id: "call_1", arguments: `{"t":"${token}"}` },
					],
				},
				usage: { ...zeroCost, totalTokens: 0, cost: { ...zeroCost, total: 0 } },
				stopReason: "stop",
				timestamp: 0,
			}) as unknown as AssistantMessage;

		const resAppend = convertCodexResponsesMessages(model, { messages: [mkMsg(true)] });
		expect(resAppend[0]).toEqual({ type: "reasoning", encrypted_content: "enc_data" });
		expect(resAppend[1]).toEqual({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "key: [github_token_redacted]" }],
		});
		expect(resAppend[2]).toEqual({
			type: "function_call",
			call_id: "call_1",
			name: "f",
			arguments: '{"t":"[github_token_redacted]"}',
		});

		const resSplice = convertCodexResponsesMessages(model, {
			messages: [{ role: "user", content: "hi", timestamp: 0 }, mkMsg(false)],
		});
		expect(resSplice.length).toBe(3);
		expect(resSplice[0]).toEqual({ type: "reasoning", encrypted_content: "enc_data" });
		expect(resSplice[1]).toEqual({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "key: [github_token_redacted]" }],
		});
		expect(resSplice[2]).toEqual({
			type: "function_call",
			call_id: "call_1",
			name: "f",
			arguments: '{"t":"[github_token_redacted]"}',
		});
	});
});
