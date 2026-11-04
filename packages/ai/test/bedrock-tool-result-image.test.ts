import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function model(id: string, extra: Record<string, unknown> = {}): Model<"bedrock-converse-stream"> {
	return buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
		...extra,
	});
}

function assistant(target: Model<"bedrock-converse-stream">): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "/tmp/t8.png" } }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: target.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_read",
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: PNG_DATA, mimeType: "image/png" },
		],
		isError: false,
		timestamp: 2,
		...overrides,
	};
}

interface WireContentBlock {
	text?: string;
	image?: { format: string; source: { bytes: string } };
	toolResult?: {
		toolUseId: string;
		status: "success" | "error";
		content: WireContentBlock[];
	};
}

interface WireUserMessage {
	role: string;
	content: WireContentBlock[];
}

interface CapturedPayload {
	messages: WireUserMessage[];
}

async function capturePayload(
	target: Model<"bedrock-converse-stream">,
	tr: ToolResultMessage = toolResult(),
): Promise<CapturedPayload> {
	const context: Context = {
		messages: [{ role: "user", content: "Read the image.", timestamp: 0 }, assistant(target), tr],
	};
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	void streamBedrock(target, context, {
		bearerToken: "test-token",
		signal: controller.signal,
		onPayload: payload => resolve(payload as unknown as CapturedPayload),
	});
	return promise;
}

function finalUserContent(payload: CapturedPayload): WireContentBlock[] {
	const lastMessage = payload.messages.at(-1);
	if (!lastMessage || !Array.isArray(lastMessage.content)) {
		throw new Error("Expected final message with content array");
	}
	return lastMessage.content;
}

describe("Bedrock tool-result image placement", () => {
	it("keeps Claude tool-result images nested when not an error", async () => {
		const payload = await capturePayload(model("global.anthropic.claude-opus-5"));
		const content = finalUserContent(payload);
		const toolResultBlock = content[0]?.toolResult;
		expect(toolResultBlock).toBeDefined();

		const nestedContent = toolResultBlock?.content ?? [];
		expect(nestedContent.some(block => block.image !== undefined)).toBe(true);
		expect(content.slice(1).some(block => block.image !== undefined)).toBe(false);
	});

	it("hoists images out of an error toolResult for Claude (text-only error content)", async () => {
		// Bedrock Claude rejects an error toolResult carrying a non-text block:
		// "all content must be type `text` if `is_error` is true" (issue #12809).
		const errorResult = toolResult({
			content: [
				{ type: "text", text: "TypeError: boom" },
				{ type: "image", data: PNG_DATA, mimeType: "image/png" },
			],
			isError: true,
		});
		const payload = await capturePayload(model("global.anthropic.claude-opus-5"), errorResult);
		const content = finalUserContent(payload);
		const toolResultBlock = content[0]?.toolResult;
		expect(toolResultBlock).toBeDefined();
		expect(toolResultBlock?.status).toBe("error");

		const nestedContent = toolResultBlock?.content ?? [];
		// Error content must be text-only; the image is hoisted to a sibling block.
		expect(nestedContent.every(block => block.text !== undefined)).toBe(true);
		expect(nestedContent.some(block => block.text === "(see attached image)")).toBe(true);
		expect(content.slice(1).some(block => block.image !== undefined)).toBe(true);
	});

	it("hoists images when requiresToolResultImageHoisting is configured on the model", async () => {
		const hoistingModel = model("custom-model", { requiresToolResultImageHoisting: true });
		const payload = await capturePayload(hoistingModel);
		const content = finalUserContent(payload);
		const toolResultBlock = content[0]?.toolResult;
		expect(toolResultBlock).toBeDefined();

		const nestedContent = toolResultBlock?.content ?? [];
		expect(nestedContent.some(block => block.image !== undefined)).toBe(false);
		expect(nestedContent.some(block => block.text === "(see attached image)")).toBe(true);
		expect(content.slice(1).some(block => block.image !== undefined)).toBe(true);
	});
});
