import { describe, expect, it } from "bun:test";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models/descriptors";
import { xaiModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";

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
		const models = await options.fetchDynamicModels!();
		expect(models?.[0]?.api).toBe("openai-responses");
	});
});
