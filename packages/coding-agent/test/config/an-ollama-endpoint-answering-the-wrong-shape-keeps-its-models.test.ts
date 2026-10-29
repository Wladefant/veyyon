/**
 * WHY: a provider configured with `discovery.type: ollama` read `/api/tags` as `payload.models ?? []` and
 * each entry as `item.model || item.name`. A body of `null` or an entry of `null` threw a `TypeError`
 * whose message named neither the endpoint nor the field, and the catalog's own Ollama readers parsed
 * the same two endpoints with different rules.
 *
 * THE CLASS: the configured reader disagreeing with the catalog readers on an Ollama body. It now reads
 * through the catalog's `provider-models/ollama-native.ts`; the catalog suite
 * `an-ollama-answer-of-the-wrong-shape-strips-metadata-not-the-catalog.test.ts` sweeps the shapes for the
 * catalog providers, and this suite holds the configured reader to the same answers.
 *
 * WHAT IT DOES NOT CATCH: the 150ms and 250ms probe deadlines, which a fetch that answers at once never
 * reaches.
 */
import { describe, expect, test } from "bun:test";
import {
	DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	type DiscoveryContext,
	type DiscoveryProviderConfig,
	discoverOllamaModels,
} from "@veyyon/coding-agent/config/model-discovery";

const ENDPOINT = "http://ollama.example:11434";
const MODEL = "probe-model";

function context(tags: unknown, show: unknown): DiscoveryContext {
	return {
		fetch: async input => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const body = url === `${ENDPOINT}/api/tags` ? tags : url === `${ENDPOINT}/api/show` ? show : undefined;
			if (body === undefined) throw new Error(`unexpected URL ${url}`);
			return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
		},
		getBearerApiKeyResolver: async () => undefined,
	};
}

const CONFIG: DiscoveryProviderConfig = {
	provider: "local-ollama",
	api: "openai-completions",
	baseUrl: ENDPOINT,
	discovery: { type: "ollama" },
};

describe("configured Ollama discovery", () => {
	test("a wrong /api/show body keeps the model with default metadata", async () => {
		const shows: unknown[] = [
			null,
			[],
			"ok",
			{ capabilities: 5 },
			{ capabilities: "vision thinking" },
			{ model_info: { "probe.context_length": 0 } },
			{ model_info: "probe" },
			{ parameters: 5 },
		];
		for (const show of shows) {
			const label = JSON.stringify(show);
			const models = await discoverOllamaModels(CONFIG, context({ models: [{ name: MODEL }] }, show));
			expect(
				models.map(model => model.id),
				label,
			).toEqual([MODEL]);
			expect(models[0]?.reasoning, label).toBe(false);
			expect(models[0]?.input, label).toEqual(["text"]);
			expect(models[0]?.contextWindow, label).toBe(DISCOVERY_DEFAULT_CONTEXT_WINDOW);
		}
	});

	test("a wrong /api/tags body fails naming the endpoint, not as a TypeError", async () => {
		for (const tags of [null, [], 5, { models: {} }, { models: MODEL }]) {
			const discovery = discoverOllamaModels(CONFIG, context(tags, {}));
			await expect(discovery, JSON.stringify(tags)).rejects.toThrow(
				`${ENDPOINT}/api/tags answered without a \`models\` list`,
			);
		}
	});

	test("an /api/tags entry that names no model is skipped and the rest are kept", async () => {
		const tags = { models: [null, 5, MODEL, { name: "" }, { model: "a" }, { name: "b" }, { model: "", name: "c" }] };
		const models = await discoverOllamaModels(CONFIG, context(tags, {}));
		expect(models.map(model => model.id)).toEqual(["a", "b", "c"]);
	});

	test("a well-formed /api/show is read as the catalog reads it", async () => {
		for (const capabilities of [
			["completion", "Thinking", "vision"],
			{ completion: true, thinking: true, image: true, tools: false },
		]) {
			const show = {
				capabilities,
				parameters: "temperature 0.6\nnum_ctx 4096\n",
				model_info: { "probe.context_length": 262_144 },
			};
			const models = await discoverOllamaModels(CONFIG, context({ models: [{ name: MODEL }] }, show));
			const label = JSON.stringify(capabilities);
			expect(models[0]?.reasoning, label).toBe(true);
			expect(models[0]?.input, label).toEqual(["text", "image"]);
			expect(models[0]?.contextWindow, label).toBe(4096);
			expect(models[0]?.maxTokens, label).toBe(4096);
		}
	});
});
