import { expect, test } from "bun:test";
import { type RequestBody, transformRequestBody } from "@veyyon/ai/providers/openai-codex/request-transformer";
import { convertCodexResponsesMessages } from "@veyyon/ai/providers/openai-codex-responses";
import type { Context } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { canonicalizeToolCallIds } from "@veyyon/kernel/session/canonicalize-tool-call-ids";

const model = buildModel({
	id: "chatgpt-web/medium",
	name: "ChatGPT Web Medium",
	api: "openai-codex-responses",
	provider: "chatgpt-web",
	baseUrl: "http://127.0.0.1:17841/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
});
const callId = "call_ozG7dm-09SNkyw841whpirK1In6qFn7p";
const itemId = "fc_4d987a3d805145498f4c5eb9ff083064";
const args = { path: "nonce.txt" };

for (const delta of [false, true]) {
	test(`native Responses ${delta ? "delta" : "snapshot"} history preserves call/result pairing`, async () => {
		const user = { role: "user" as const, content: "Read nonce.txt", timestamp: 1 };
		const nativeCall = {
			type: "function_call",
			id: itemId,
			call_id: callId,
			name: "read",
			arguments: JSON.stringify(args),
			status: "completed",
		};
		const context: Context = {
			messages: [
				user,
				{
					role: "assistant",
					content: [{ type: "toolCall", id: `${callId}|${itemId}`, name: "read", arguments: args }],
					api: "openai-codex-responses",
					provider: "chatgpt-web",
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "chatgpt-web",
						dt: delta,
						items: delta
							? [nativeCall]
							: [
									{ type: "message", role: "user", content: [{ type: "input_text", text: user.content }] },
									nativeCall,
								],
					},
				},
				{
					role: "toolResult",
					toolCallId: `${callId}|${itemId}`,
					toolName: "read",
					content: [{ type: "text", text: "NONCE_test" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		const before = JSON.stringify(context);
		let counter = 0;
		const map = new Map<string, string>();
		const allocate = () => `tc_${++counter}`;
		const messages = canonicalizeToolCallIds(context.messages, map, allocate);
		const input = convertCodexResponsesMessages(model, { ...context, messages });
		const body: RequestBody = { model: model.id, input };
		await transformRequestBody(body, model);
		expect(body.input?.filter(item => item.type === "function_call")).toHaveLength(1);
		expect(body.input?.filter(item => item.type === "function_call_output")).toEqual([
			{ type: "function_call_output", call_id: callId, output: "NONCE_test" },
		]);
		expect(JSON.stringify(body.input)).not.toContain("stale-tool-result");
		expect(JSON.stringify(context)).toBe(before);
		expect(canonicalizeToolCallIds(context.messages, map, allocate)).toBe(context.messages);
	});
}
