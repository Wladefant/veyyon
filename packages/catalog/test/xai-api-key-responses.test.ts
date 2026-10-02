import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@veyyon/catalog/model-manager";
import { getBundledModels } from "@veyyon/catalog/models";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models/descriptors";
import { xaiModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";
import type { ModelSpec } from "@veyyon/catalog/types";

const XAI_RESPONSES_SPEC: ModelSpec<"openai-responses"> = {
	id: "grok-4.5",
	name: "Grok 4.5",
	api: "openai-responses",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
	contextWindow: 500_000,
	maxTokens: 500_000,
};
const XAI_COMPLETIONS_SPEC: ModelSpec<"openai-completions"> = {
	...XAI_RESPONSES_SPEC,
	api: "openai-completions",
};

describe("paid xai (XAI_API_KEY) Responses contract", () => {
	it("registers xai on the catalog Responses discovery path", async () => {
		const entry = CATALOG_PROVIDERS.find(provider => provider.id === "xai");
		expect(entry, "xai catalog descriptor").toBeDefined();
		expect(entry!.defaultModel).toBe("grok-4.5");
		expect(entry!.envVars).toContain("XAI_API_KEY");
		const options = xaiModelManagerOptions({
			apiKey: "test-key",
			fetch: async () => Response.json({ data: [{ id: "grok-4.5" }] }),
		});
		expect(options.providerId).toBe("xai");
		expect(options.fetchDynamicModels, "live /v1/models overlay").toBeTypeOf("function");
		expect(options.dropCachedModelIdsOnStaticMismatch).toEqual(getBundledModels("xai").map(model => model.id));
		expect(options.dropCachedModelIdsOnStaticMismatch).toContain("grok-4.5");
		const models = await options.fetchDynamicModels!();
		expect(models?.[0]?.api).toBe("openai-responses");
	});

	it("drops stale Chat Completions cache rows so Responses takes effect immediately", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-catalog-xai-completions-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		try {
			await resolveProviderModels(
				{
					providerId: "xai",
					staticModels: [XAI_COMPLETIONS_SPEC],
					fetchDynamicModels: async () => [XAI_COMPLETIONS_SPEC],
					cacheDbPath: dbPath,
				},
				"online",
			);

			let fetches = 0;
			const migrated = await resolveProviderModels(
				{
					...xaiModelManagerOptions(),
					staticModels: [XAI_RESPONSES_SPEC],
					fetchDynamicModels: async () => {
						fetches += 1;
						return [XAI_RESPONSES_SPEC];
					},
					cacheDbPath: dbPath,
				},
				"online-if-uncached",
			);

			// Stale cache row must be evicted so static Responses spec wins without a fetch.
			expect(fetches).toBe(0);
			const grok = migrated.models.find(model => model.id === "grok-4.5");
			expect(grok?.api).toBe("openai-responses");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
