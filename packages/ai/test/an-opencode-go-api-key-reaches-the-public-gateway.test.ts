import { Database } from "bun:sqlite";
import { describe, expect, it, vi } from "bun:test";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import * as envApiKeyModule from "@veyyon/ai/env-api-key";
import * as aiStream from "@veyyon/ai/stream";
import type { Api, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { getBundledModels } from "@veyyon/catalog/models";
import { opencodeGoModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";

const GATEWAY = "https://opencode.ai/zen/go";
const CONTEXT: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const OPENCODE_GO_ORG_HEADER = "x-opencode-org-id";
const GATEWAY_PATH: Readonly<Record<string, string>> = {
	"openai-completions": "/v1/chat/completions",
	"openai-responses": "/v1/responses",
	"anthropic-messages": "/v1/messages",
};
const MODELS_PATH = `${new URL(GATEWAY).pathname}/v1/models`;

interface RecordedRequest {
	url: string;
	headers: Headers;
}

function bundledModelPerApi(): Map<Api, Model<Api>> {
	const models = new Map<Api, Model<Api>>();
	for (const model of getBundledModels("opencode-go")) {
		if (!models.has(model.api)) models.set(model.api, model);
	}
	return models;
}

function wireApis(): Map<Api, Model<Api>> {
	const models = bundledModelPerApi();
	if (models.size === 0) throw new Error("OpenCode Go bundles no wire models");
	const unarmed = [...models.keys()].filter(api => GATEWAY_PATH[api] === undefined);
	expect(unarmed).toEqual([]);
	return models;
}

function recordingFetch(sent: RecordedRequest[], modelsDev: Response = Response.json({ data: [] })): FetchImpl {
	return async (input, init) => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		const url = new URL(request.url);
		if (url.origin === "https://models.dev") return modelsDev.clone();
		sent.push({ url: `${url.origin}${url.pathname}`, headers: request.headers });
		if (url.pathname === MODELS_PATH) return Response.json({ data: [{ id: "listed-model" }] });
		return Response.json({ error: { message: "stubbed request ended" } }, { status: 400 });
	};
}

async function exerciseModel(model: Model<Api>, apiKey: string, fetch: FetchImpl): Promise<void> {
	await aiStream.stream(model, CONTEXT, { apiKey, fetch }).result();
}

/**
 * WHY: the deleted mixed Console suite kept API-key gateway cases, but its combined Console login flow
 * obscured them. These cases prove the real stream and model-discovery paths send API keys to the public
 * gateway without organization routing; they do not prove that the live gateway accepts those requests.
 */
describe("an OpenCode Go API key reaches the public gateway", () => {
	it("routes every bundled wire API key request to the public gateway without an organization", async () => {
		const sent: RecordedRequest[] = [];
		const fetch = recordingFetch(sent);
		for (const [api, model] of wireApis()) {
			const mark = sent.length;
			await exerciseModel(model, "sk-go-key", fetch);
			expect({
				api,
				requests: sent.slice(mark).map(request => ({
					url: request.url,
					credential:
						request.headers.get("authorization")?.replace(/^Bearer /, "") ?? request.headers.get("x-api-key"),
					org: request.headers.get(OPENCODE_GO_ORG_HEADER),
				})),
			}).toEqual({
				api,
				requests: [{ url: `${GATEWAY}${GATEWAY_PATH[api]}`, credential: "sk-go-key", org: null }],
			});
		}
	});

	it("routes a key already stored under the provider ID to the public gateway without an organization", async () => {
		const envKeySpy = vi.spyOn(envApiKeyModule, "getEnvApiKey").mockReturnValue(undefined);
		const db = new Database(":memory:");
		const store = new SqliteAuthCredentialStore(db);
		const authStorage = new AuthStorage(store);
		const sent: RecordedRequest[] = [];
		try {
			await authStorage.set("opencode-go", [{ type: "api_key", key: "sk-go-stored", source: "login" }]);
			const apiKey = await authStorage.getApiKey("opencode-go");
			if (!apiKey) throw new Error("AuthStorage returned no stored OpenCode Go API key");
			const fetch = recordingFetch(sent);
			for (const [api, model] of wireApis()) {
				const mark = sent.length;
				await exerciseModel(model, apiKey, fetch);
				expect({
					api,
					requests: sent.slice(mark).map(request => ({
						url: request.url,
						credential:
							request.headers.get("authorization")?.replace(/^Bearer /, "") ?? request.headers.get("x-api-key"),
						org: request.headers.get(OPENCODE_GO_ORG_HEADER),
					})),
				}).toEqual({
					api,
					requests: [{ url: `${GATEWAY}${GATEWAY_PATH[api]}`, credential: "sk-go-stored", org: null }],
				});
			}
		} finally {
			envKeySpy.mockRestore();
			store.close();
		}
	});

	it("discovers OpenCode Go models at the public listing with the bearer key and no organization", async () => {
		const sent: RecordedRequest[] = [];
		const options = opencodeGoModelManagerOptions({
			apiKey: "sk-go-discovery",
			fetch: recordingFetch(sent, Response.json({ data: [] })),
		});
		await options.fetchDynamicModels?.();
		expect(
			sent.map(request => ({
				api: "openai-completions",
				url: request.url,
				authorization: request.headers.get("authorization"),
				org: request.headers.get(OPENCODE_GO_ORG_HEADER),
			})),
		).toEqual([
			{
				api: "openai-completions",
				url: `${GATEWAY}/v1/models`,
				authorization: "Bearer sk-go-discovery",
				org: null,
			},
		]);
	});

	it("separates the OpenCode Go model cache for different API keys", () => {
		const optionsFor = (apiKey: string) => opencodeGoModelManagerOptions({ apiKey });
		expect({
			api: "openai-completions",
			cacheProviderIds: [optionsFor("sk-go-one").cacheProviderId, optionsFor("sk-go-two").cacheProviderId],
		}).toMatchObject({ api: "openai-completions" });
		expect(optionsFor("sk-go-one").cacheProviderId).not.toBe(optionsFor("sk-go-two").cacheProviderId);
	});
});
