import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { streamBedrock } from "../src/providers/amazon-bedrock";
import type { Context, Model, SimpleStreamOptions } from "../src/types";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";

const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;
const originalRegion = process.env.AWS_REGION;

beforeAll(() => {
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
	process.env.AWS_REGION = "us-east-1";
});

afterAll(() => {
	if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
	else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
	if (originalRegion === undefined) delete process.env.AWS_REGION;
	else process.env.AWS_REGION = originalRegion;
});

const context: Context = {
	systemPrompt: ["be terse"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
	tools: [
		{
			name: "echo",
			description: "Echo text",
			parameters: { type: "object", properties: { t: { type: "string" } } },
		},
	],
};

interface ToolChoicePayload {
	toolConfig?: { toolChoice?: Record<string, unknown> };
	additionalModelRequestFields?: { thinking?: unknown };
}

async function capture(
	model: Model<"bedrock-converse-stream">,
	options: SimpleStreamOptions,
): Promise<ToolChoicePayload> {
	const { promise, resolve } = Promise.withResolvers<ToolChoicePayload>();
	const stream = streamBedrock(model, context, {
		fetch: async () => new Response("", { status: 400 }),
		...options,
		onPayload: payload => {
			resolve(payload as ToolChoicePayload);
			return undefined;
		},
	});
	void stream.result().catch(() => {});
	return promise;
}

function bedrockModel(id: string): Model<"bedrock-converse-stream"> {
	const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", id);
	if (!model) throw new Error(`missing bundled model ${id}`);
	return model;
}

describe("Bedrock forced tool choice", () => {
	// Opus 5.5 rejects `toolChoice: {any}` / `{tool}` with 400 "tool_choice: type
	// \"tool\" and \"any\" are not supported for this model" regardless of thinking.
	test("downgrades forced choice to auto for Opus 5.5 and keeps thinking", async () => {
		const model = bedrockModel("us.anthropic.claude-opus-5-5");
		const anyPayload = await capture(model, { toolChoice: "any", reasoning: Effort.Low });
		expect(anyPayload.toolConfig?.toolChoice).toEqual({ auto: {} });
		expect(anyPayload.additionalModelRequestFields?.thinking).toBeDefined();

		const namedPayload = await capture(model, { toolChoice: { type: "tool", name: "echo" }, reasoning: Effort.Low });
		expect(namedPayload.toolConfig?.toolChoice).toEqual({ auto: {} });
	});

	test("still forces the tool on Opus 5, dropping thinking instead", async () => {
		const payload = await capture(bedrockModel("us.anthropic.claude-opus-5"), {
			toolChoice: "any",
			reasoning: Effort.Low,
		});
		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
		expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
	});
});
