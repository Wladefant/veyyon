import { describe, expect, test } from "bun:test";
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "@veyyon/catalog/provider-models";

const BEDROCK_OPENAI_FIXTURE = {
	"amazon-bedrock": {
		models: Object.fromEntries(
			[
				"openai.gpt-5.4",
				"openai.gpt-5.5",
				"openai.gpt-5.6-luna",
				"openai.gpt-5.6-sol",
				"openai.gpt-5.6-terra",
				"openai.gpt-oss-120b-1:0",
			].map(id => [
				id,
				{
					name: id,
					tool_call: true,
					reasoning: true,
					limit: { context: 272_000, output: 128_000 },
					cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
					modalities: { input: ["text", "image"] },
				},
			]),
		),
	},
};

const BEDROCK_MANTLE_BASE_URL = "https://bedrock-mantle.us-east-1.api.aws/openai/v1";
const BEDROCK_RUNTIME_BASE_URL = "https://bedrock-runtime.us-east-1.amazonaws.com";

describe("Amazon Bedrock OpenAI routing", () => {
	test("routes GPT-5.4+ frontier models through Bedrock Mantle Responses", () => {
		const models = mapModelsDevToModels(BEDROCK_OPENAI_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS);
		const frontierModels = models.filter(model => model.id.startsWith("openai.gpt-5."));

		expect(frontierModels.map(model => model.id)).toEqual([
			"openai.gpt-5.4",
			"openai.gpt-5.5",
			"openai.gpt-5.6-luna",
			"openai.gpt-5.6-sol",
			"openai.gpt-5.6-terra",
		]);
		for (const model of frontierModels) {
			expect(model.api).toBe("openai-responses");
			expect(model.baseUrl).toBe(BEDROCK_MANTLE_BASE_URL);
		}
	});

	test("keeps GPT-OSS on the Bedrock Converse transport", () => {
		const models = mapModelsDevToModels(BEDROCK_OPENAI_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS);
		const model = models.find(candidate => candidate.id === "openai.gpt-oss-120b-1:0");

		expect(model?.api).toBe("bedrock-converse-stream");
		expect(model?.baseUrl).toBe(BEDROCK_RUNTIME_BASE_URL);
	});
});
