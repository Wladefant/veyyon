import { describe, expect, test } from "bun:test";
import { filterModelsDevCatalogRows } from "../src/provider-models/models-dev-policies";
import type { ModelSpec } from "../src/types";

function createSpec(provider: string, id: string): ModelSpec {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.com/v1",
		contextWindow: 128_000,
		maxTokens: 8192,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("filterModelsDevCatalogRows", () => {
	test("filters Bedrock Mantle OpenAI models and unsupported Japan Opus 5 profile", () => {
		const models: ModelSpec[] = [
			createSpec("amazon-bedrock", "openai.gpt-5.4"),
			createSpec("amazon-bedrock", "openai.gpt-5.5"),
			createSpec("amazon-bedrock", "openai.gpt-5.6-luna"),
			createSpec("amazon-bedrock", "openai.gpt-5.6-sol"),
			createSpec("amazon-bedrock", "openai.gpt-5.6-terra"),
			createSpec("amazon-bedrock", "jp.anthropic.claude-opus-5"),
			createSpec("amazon-bedrock", "anthropic.claude-opus-5"),
			createSpec("amazon-bedrock", "us.anthropic.claude-opus-5"),
		];

		const filtered = filterModelsDevCatalogRows(models);
		expect(filtered.map(m => m.id)).toEqual(["anthropic.claude-opus-5", "us.anthropic.claude-opus-5"]);
	});

	test("filters Z.AI bracketed [1m] context-tier selectors while keeping base models", () => {
		const models: ModelSpec[] = [
			createSpec("zai", "glm-5.2[1m]"),
			createSpec("zai", "glm-5.2"),
			createSpec("zai", "glm-4.7-flash[1m]"),
			createSpec("zai", "glm-4.7-flash"),
		];

		const filtered = filterModelsDevCatalogRows(models);
		expect(filtered.map(m => m.id)).toEqual(["glm-5.2", "glm-4.7-flash"]);
	});

	test("filters Fireworks internal control-plane resource IDs", () => {
		const models: ModelSpec[] = [
			createSpec("fireworks", "accounts/fireworks/models/deepseek-v3"),
			createSpec("fireworks", "accounts/fireworks/routers/deepseek-r1"),
			createSpec("fireworks", "deepseek-ai/DeepSeek-V3"),
			createSpec("firepass", "accounts/fireworks/models/qwen2.5-72b"),
			createSpec("firepass", "qwen2.5-72b"),
		];

		const filtered = filterModelsDevCatalogRows(models);
		expect(filtered.map(m => m.id)).toEqual(["deepseek-ai/DeepSeek-V3", "qwen2.5-72b"]);
	});

	test("filters Xiaomi audio-only (TTS/ASR) IDs", () => {
		const models: ModelSpec[] = [
			createSpec("xiaomi", "mione-tts"),
			createSpec("xiaomi", "mione-asr"),
			createSpec("xiaomi", "mione-chat"),
			createSpec("xiaomi-token-plan-pro", "voice-tts-v1"),
			createSpec("xiaomi-token-plan-pro", "mione-chat-pro"),
		];

		const filtered = filterModelsDevCatalogRows(models);
		expect(filtered.map(m => m.id)).toEqual(["mione-chat", "mione-chat-pro"]);
	});

	test("passes standard provider models through untouched", () => {
		const models: ModelSpec[] = [
			createSpec("openai", "gpt-5.4"),
			createSpec("anthropic", "claude-sonnet-4"),
			createSpec("google", "gemini-3-flash"),
		];

		const filtered = filterModelsDevCatalogRows(models);
		expect(filtered.map(m => m.id)).toEqual(["gpt-5.4", "claude-sonnet-4", "gemini-3-flash"]);
	});
});
