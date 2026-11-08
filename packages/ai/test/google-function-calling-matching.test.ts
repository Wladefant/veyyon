import { describe, expect, it } from "bun:test";

import { buildRequest } from "@veyyon/ai/providers/google-gemini-cli";
import { convertMessages, GoogleResponseBlocks } from "@veyyon/ai/providers/google-shared";

import type { AssistantMessage, Context, Model, ToolCall } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";

import { emptyUsage } from "@veyyon/catalog/models";

function createGoogleModel<
	T extends "google-generative-ai" | "google-vertex" | "google-gemini-cli" = "google-generative-ai",
>(
	id: string,
	api: T = "google-generative-ai" as T,
	provider = api === "google-vertex"
		? "google-vertex"
		: api === "google-gemini-cli"
			? "google-antigravity"
			: "google",
): Model<T> {
	return buildModel({
		id,
		name: id,
		api,
		provider: api === "google-vertex" ? "google-vertex" : "google",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

function contextWithToolResult(toolName = "stale_tool_name"): Context {
	return {
		messages: [
			{
				role: "user",
				content: "Call the tool",
				timestamp: 1000,
			},
			{
				role: "assistant",
				provider: "google-generative-ai",
				api: "google-generative-ai",
				model: "gemini-2.5-flash",
				content: [
					{
						type: "toolCall",
						id: "call_12345_abc",
						name: "actual_tool_name",
						arguments: { query: "pi" },
					},
				],
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: 2000,
			},
			{
				role: "toolResult",
				toolCallId: "call_12345_abc",
				toolName,
				isError: false,
				content: [
					{
						type: "text",
						text: "Tool result text",
					},
				],
				timestamp: 3000,
			},
		],
	};
}

function functionCallAndResponse(
	model: Model<"google-generative-ai" | "google-vertex" | "google-gemini-cli">,
	context: Context,
) {
	const contents = convertMessages(model, context);
	const functionCall = contents.find(c => c.role === "model")?.parts?.find(part => part.functionCall)?.functionCall;
	const functionResponse = contents
		.find(c => c.role === "user" && c.parts?.some(part => part.functionResponse))
		?.parts?.find(part => part.functionResponse)?.functionResponse;

	return { functionCall, functionResponse };
}

describe("Google GenerateContent function response matching", () => {
	it("uses emitted functionCall IDs and names for direct Gemini 3 functionResponse parts", () => {
		const model = createGoogleModel("gemini-3.5-flash");
		const { functionCall, functionResponse } = functionCallAndResponse(model, contextWithToolResult());

		expect(functionCall?.id).toBe("call_12345_abc");
		expect(functionResponse?.id).toBe("call_12345_abc");
		expect(functionCall?.name).toBe("actual_tool_name");
		expect(functionResponse?.name).toBe("actual_tool_name");
		expect(functionResponse?.name).toBe(functionCall?.name);
	});

	it("omits unsupported Part IDs for Vertex Gemini 3.5 GenerateContent", () => {
		const model = createGoogleModel("gemini-3.5-flash", "google-vertex");
		const { functionCall, functionResponse } = functionCallAndResponse(model, contextWithToolResult());

		expect(functionCall?.id).toBeUndefined();
		expect(functionResponse?.id).toBeUndefined();
		expect(functionResponse?.name).toBe(functionCall?.name);
	});

	it("keeps multimodal tool output inside Gemini 3 functionResponse parts", () => {
		const context = contextWithToolResult("actual_tool_name");
		const toolResult = context.messages[2];
		if (toolResult.role !== "toolResult") throw new Error("expected tool result fixture");
		toolResult.content.push({
			type: "image",
			mimeType: "image/png",
			data: "base64-image-data",
		});

		const model = createGoogleModel("gemini-3.5-flash");
		const { functionResponse } = functionCallAndResponse(model, context);

		expect(functionResponse?.parts).toEqual([
			{
				inlineData: {
					mimeType: "image/png",
					data: "base64-image-data",
				},
			},
		]);
	});

	it("keeps Claude call IDs on non-Vertex Google-compatible endpoints", () => {
		const model = createGoogleModel("claude-sonnet-4-5");
		const { functionCall, functionResponse } = functionCallAndResponse(
			model,
			contextWithToolResult("actual_tool_name"),
		);

		expect(functionCall?.id).toBe("call_12345_abc");
		expect(functionResponse?.id).toBe("call_12345_abc");
		expect(functionResponse?.name).toBe(functionCall?.name);
	});
	it("preserves tool-call IDs for Antigravity gpt-oss-120b on both functionCall and matching functionResponse", () => {
		const model = createGoogleModel("gpt-oss-120b", "google-gemini-cli", "google-antigravity");
		const { functionCall, functionResponse } = functionCallAndResponse(
			model,
			contextWithToolResult("actual_tool_name"),
		);

		expect(functionCall?.id).toBe("call_12345_abc");
		expect(functionResponse?.id).toBe("call_12345_abc");
		expect(functionCall?.name).toBe("actual_tool_name");
		expect(functionResponse?.name).toBe("actual_tool_name");
		expect(functionResponse?.name).toBe(functionCall?.name);
	});

	it("generates non-empty fallback ID for missing or empty tool-call IDs and replays matched IDs for gpt-oss-120b", () => {
		const model = createGoogleModel("gpt-oss-120b", "google-gemini-cli", "google-antigravity");

		for (const incomingId of [undefined, ""]) {
			const output: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [],
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: 2000,
			};
			const stream = new AssistantMessageEventStream();
			const blocks = new GoogleResponseBlocks(output, stream, false);

			blocks.appendFunctionCall(
				{
					id: incomingId,
					name: "actual_tool_name",
					args: { query: "pi" },
				},
				undefined,
			);

			const toolCall = output.content[0] as ToolCall;
			expect(toolCall).toBeDefined();
			expect(toolCall.type).toBe("toolCall");
			expect(toolCall.id).toBeDefined();
			expect(typeof toolCall.id).toBe("string");
			expect(toolCall.id.length).toBeGreaterThan(0);
			expect(toolCall.name).toBe("actual_tool_name");

			const context: Context = {
				messages: [
					{
						role: "user",
						content: "Call the tool",
						timestamp: 1000,
					},
					output,
					{
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: "actual_tool_name",
						isError: false,
						content: [
							{
								type: "text",
								text: "Tool result text",
							},
						],
						timestamp: 3000,
					},
				],
			};

			const { functionCall, functionResponse } = functionCallAndResponse(model, context);
			expect(functionCall?.id).toBe(toolCall.id);
			expect(functionResponse?.id).toBe(toolCall.id);
			expect(functionCall?.name).toBe("actual_tool_name");
			expect(functionResponse?.name).toBe("actual_tool_name");

			const ccaRequest = buildRequest(model, context, "test-project", {}, true);
			const ccaCall = ccaRequest.request.contents
				.find(c => c.role === "model")
				?.parts?.find(part => part.functionCall)?.functionCall;
			const ccaResponse = ccaRequest.request.contents
				.find(c => c.role === "user" && c.parts?.some(part => part.functionResponse))
				?.parts?.find(part => part.functionResponse)?.functionResponse;
			expect(ccaCall?.id).toBe(toolCall.id);
			expect(ccaResponse?.id).toBe(toolCall.id);
		}
	});
});
