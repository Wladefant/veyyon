import { describe, expect, test } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel, getBundledModels } from "@veyyon/catalog/models";
import { streamBedrock } from "../src/providers/amazon-bedrock";
import type { Context, Model, SimpleStreamOptions } from "../src/types";

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
	const { promise, resolve, reject } = Promise.withResolvers<ToolChoicePayload>();
	const stream = streamBedrock(model, context, {
		region: "us-east-1",
		bearerToken: "fake-bedrock-test-token",
		fetch: async () => new Response("", { status: 400 }),
		...options,
		onPayload: payload => {
			resolve(payload as ToolChoicePayload);
			return undefined;
		},
	});
	void stream.result().catch(reject);
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

	// Sweep every bundled Bedrock Sonnet identity, including regional aliases.
	// New generations require an explicit forced-choice decision below.
	test("honors forced-choice support across the bundled Sonnet registry", async () => {
		const models = getBundledModels("amazon-bedrock").filter(model => model.id.includes("sonnet"));
		expect(models.length).toBeGreaterThan(0);
		let unsupported = 0;
		for (const model of models) {
			expect(model.api).toBe("bedrock-converse-stream");
			const generation = model.id.match(/claude-(\d+)/)?.[1] ?? model.id.match(/sonnet-(\d+)/)?.[1];
			expect(["3", "4", "5"]).toContain(generation);
			const rejectsForcedChoice = model.id.includes("sonnet-5-5");
			if (rejectsForcedChoice) unsupported++;
			for (const toolChoice of ["any", { type: "tool", name: "echo" }] as const) {
				const payload = await capture(bedrockModel(model.id), { toolChoice, reasoning: Effort.Low });
				expect(payload.toolConfig?.toolChoice).toEqual(
					rejectsForcedChoice ? { auto: {} } : toolChoice === "any" ? { any: {} } : { tool: { name: "echo" } },
				);
				if (rejectsForcedChoice) expect(payload.additionalModelRequestFields?.thinking).toBeDefined();
				else expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
			}
		}
		expect(unsupported).toBeGreaterThan(0);
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
