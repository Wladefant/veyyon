// WHY: Cached endpoint/wire routing can outlive catalog corrections. The upgraded namespace must
// refetch legacy rows and never restore another account or endpoint's catalog; offline discovery is not covered.
import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "../src/model-manager";
import { githubCopilotModelManagerOptions } from "../src/provider-models/openai-compat";
import type { Api, ModelSpec } from "../src/types";

it("refetches stale routing namespaces and isolates credential and endpoint scopes", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-cache-"));
	try {
		const cacheDbPath = path.join(directory, "models.db");
		const poisoned: ModelSpec<Api> = {
			id: "grok-4.6",
			name: "stale",
			provider: "github-copilot",
			api: "openai-completions",
			baseUrl: "https://stale.example",
			contextWindow: 1000,
			maxTokens: 100,
			input: ["text"],
			reasoning: false,
			requestModelId: "wrong-wire-id",
		};
		const baseUrl = "https://api.githubcopilot.com";
		const apiKey = "fake-copilot-key";
		for (const cacheProviderId of [
			"github-copilot",
			`github-copilot:models-v1:${Bun.hash(`${apiKey}\0${baseUrl}`).toString(36)}`,
		]) {
			await createModelManager({
				...githubCopilotModelManagerOptions({ apiKey, baseUrl }),
				cacheDbPath,
				cacheProviderId,
				fetchDynamicModels: async () => [poisoned],
			}).refresh("online");
		}
		let requests = 0;
		const discover = async (key: string, endpoint: string, id: string) => {
			const manager = createModelManager({
				...githubCopilotModelManagerOptions({
					apiKey: key,
					baseUrl: endpoint,
					fetch: async () => {
						requests++;
						return new Response(JSON.stringify({ data: [{ id, name: "fresh" }] }), {
							headers: { "Content-Type": "application/json" },
						});
					},
				}),
				cacheDbPath,
			});
			return (await manager.refresh("online-if-uncached")).models;
		};
		const models = await discover(apiKey, baseUrl, "grok-4.6");
		expect(requests).toBe(1);
		const model = models.find(candidate => candidate.id === "grok-4.6");
		expect(model?.api).toBe("openai-responses");
		expect(model?.baseUrl).toBe(baseUrl);
		expect(model?.requestModelId).toBeUndefined();
		await discover(apiKey, baseUrl, "grok-4.6");
		expect(requests).toBe(1);
		await discover("other-fake-key", baseUrl, "grok-4.6");
		expect(requests).toBe(2);
		await discover(apiKey, "https://enterprise.example", "grok-4.6");
		expect(requests).toBe(3);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
