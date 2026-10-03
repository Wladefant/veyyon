import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@veyyon/catalog/model-manager";
import { PROVIDER_DESCRIPTORS } from "@veyyon/catalog/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
} from "@veyyon/catalog/provider-models/openai-compat";
import type { ModelSpec } from "../src/types";
import { mergePreviousSnapshotModels } from "../scripts/generate-models";

const LIVE_FREE_MODEL_IDS = [
	"deepseek-v4-flash-free",
	"hy3-free",
	"mimo-v2.5-free",
	"nemotron-3-ultra-free",
	"north-mini-code-free",
] as const;

const LIVE_PAID_MODEL_IDS = ["claude-opus-4-8", "gpt-5.5"] as const;

const MODELS_DEV_URL = "https://models.dev/api.json";

function modelListResponse(ids: readonly string[]): Response {
	return Response.json({
		object: "list",
		data: ids.map(id => ({ id, object: "model", owned_by: "opencode" })),
	});
}

/**
 * Routes the gateway listing and models.dev to their own responses, since
 * OpenCode discovery fetches both through one `fetch`.
 */
function gatewayFetch(
	listing: readonly string[],
	modelsDev: Record<string, unknown> = {},
	counts: { listing: number; modelsDev: number } = { listing: 0, modelsDev: 0 },
): (input: string | URL | Request) => Promise<Response> {
	return async input => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === MODELS_DEV_URL) {
			counts.modelsDev++;
			return Response.json(modelsDev);
		}
		counts.listing++;
		return modelListResponse(listing);
	};
}

/** A models.dev row in the shape the `opencode` / `opencode-go` descriptors read. */
function modelsDevRow(id: string, npm: string): Record<string, unknown> {
	return {
		id,
		name: id,
		tool_call: true,
		reasoning: false,
		limit: { context: 1_000_000, output: 65_536 },
		modalities: { input: ["text"], output: ["text"] },
		provider: { npm },
	};
}

describe("OpenCode provider discovery", () => {
	test("treats the OpenCode model endpoints as authoritative catalogs", () => {
		for (const providerId of ["opencode-go", "opencode-zen"]) {
			const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === providerId);
			expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		}
		expect(opencodeGoModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
		expect(opencodeZenModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
	});
	test("routes opencode-go muse-spark-1.2 to the responses API (#8957)", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "opencode-go");
		// The Go /zen/go/v1/models discovery drops the provider.npm hint for the
		// muse-spark ids, so without an override they fall through to
		// openai-completions even though the gateway only serves them at
		// /zen/go/v1/responses. Sending completions requests closes the stream
		// with no finish_reason on every tool-call turn.
		for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
			expect(descriptor?.resolveApi?.(id, { tool_call: true })).toEqual({
				api: "openai-responses",
				baseUrl: "https://opencode.ai/zen/go/v1",
			});
		}
	});
	test("pins gateway-only muse-spark ids to responses in live discovery (#8957)", async () => {
		// models.dev omits muse-spark-1.2[-contributor] under opencode-go, so
		// there is no bundled reference row. Without the discovery-side pin the
		// mapper defaults them to openai-completions and every tool-call turn
		// fails with "stream closed before a finish_reason was received".
		const options = opencodeGoModelManagerOptions({
			apiKey: "test-key",
			fetch: async () => modelListResponse(["muse-spark-1.2", "muse-spark-1.2-contributor", "kimi-k3"]),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
			expect(byId.get(id)).toMatchObject({
				api: "openai-responses",
				baseUrl: "https://opencode.ai/zen/go/v1",
			});
		}
		// Contrast: an unpinned id with a bundled reference keeps its route.
		expect(byId.get("kimi-k3")).toMatchObject({ api: "openai-completions" });
		// Upgrade path: pinned ids invalidate caches written before the pin,
		// otherwise 17.3.7-era rows keep the completions route until TTL.
		expect(options.dropCachedModelIdsOnStaticMismatch).toContain("muse-spark-1.2-contributor");
	});

	test("routes gateway-first ids via sibling catalog and variant-base hints", async () => {
		// The Go gateway ships models before models.dev lists them under
		// opencode-go (muse-spark-1.2[-contributor] did exactly this, #8957).
		// With no same-provider metadata, the mapper borrows the
		// openai-responses route from the sibling Zen catalog or the
		// billing-variant base id — responses only, never anthropic-messages
		// (cross-gateway transports genuinely diverge there).
		const options = opencodeGoModelManagerOptions({
			apiKey: "test-key",
			fetch: async () =>
				modelListResponse([
					"gpt-5.5", // zen bundles it as openai-responses; absent from the go bundle
					"deepseek-v4-flash-free", // base id is pinned to responses on go
					"minimax-m2.5-free", // anthropic hints only -> must keep the completions default
					"brand-new-model", // no hint anywhere -> completions default
				]),
		});
		const models = await options.fetchDynamicModels?.();
		const apiById = new Map((models ?? []).map(model => [model.id, model.api]));
		expect(apiById.get("gpt-5.5")).toBe("openai-responses");
		expect(apiById.get("deepseek-v4-flash-free")).toBe("openai-responses");
		expect(apiById.get("minimax-m2.5-free")).toBe("openai-completions");
		expect(apiById.get("brand-new-model")).toBe("openai-completions");
	});

	test("replaces stale bundled Zen models with each credential's live endpoint list", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-zen-"));
		try {
			const freeCounts = { listing: 0, modelsDev: 0 };
			const freeOptions = opencodeZenModelManagerOptions({
				apiKey: "free-account-key",
				fetch: gatewayFetch(LIVE_FREE_MODEL_IDS, {}, freeCounts),
			});
			const freeResult = await resolveProviderModels(
				{ ...freeOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			const paidCounts = { listing: 0, modelsDev: 0 };
			const paidOptions = opencodeZenModelManagerOptions({
				apiKey: "paid-account-key",
				fetch: gatewayFetch(LIVE_PAID_MODEL_IDS, {}, paidCounts),
			});
			const paidResult = await resolveProviderModels(
				{ ...paidOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			expect(freeOptions.cacheProviderId).not.toBe(paidOptions.cacheProviderId);
			expect(freeResult.stale).toBe(false);
			expect(freeResult.models.map(model => model.id).sort()).toEqual([...LIVE_FREE_MODEL_IDS].sort());
			expect(paidResult.stale).toBe(false);
			expect(paidResult.models.map(model => model.id).sort()).toEqual([...LIVE_PAID_MODEL_IDS].sort());
			expect([freeCounts.listing, paidCounts.listing]).toEqual([1, 1]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * WHY: the gateway listing carries ids only. An id the bundle predates
	 * (`muse-spark-1.3-contributor-free` on Zen, `muse-spark-1.3-contributor`
	 * on Go) used to fall to `openai-completions`, and the gateway answers
	 * `/chat/completions` for those with HTTP 500; only `/responses` works.
	 * Discovery now resolves the wire API from live models.dev with the same
	 * descriptor rules the bundle generator uses. Not caught: an id absent from
	 * both the bundle and models.dev still defaults to `openai-completions`.
	 */
	describe("resolves the wire API of unbundled ids from live models.dev", () => {
		const cases = [
			{
				providerId: "opencode-zen",
				modelsDevKey: "opencode",
				options: opencodeZenModelManagerOptions,
				id: "muse-spark-1.3-contributor-free",
				baseUrl: "https://opencode.ai/zen/v1",
			},
			{
				providerId: "opencode-go",
				modelsDevKey: "opencode-go",
				options: opencodeGoModelManagerOptions,
				id: "muse-spark-1.3-contributor",
				baseUrl: "https://opencode.ai/zen/go/v1",
			},
		] as const;

		for (const { providerId, modelsDevKey, options, id, baseUrl } of cases) {
			test(`${providerId}: ${id} is Responses-only per models.dev`, async () => {
				const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `pi-catalog-${providerId}-`));
				try {
					const counts = { listing: 0, modelsDev: 0 };
					const modelsDev = {
						[modelsDevKey]: {
							models: {
								[id]: modelsDevRow(id, "@ai-sdk/openai"),
								"sibling-anthropic": modelsDevRow("sibling-anthropic", "@ai-sdk/anthropic"),
							},
						},
					};
					const result = await resolveProviderModels(
						{
							...options({
								apiKey: "key",
								fetch: gatewayFetch([id, "sibling-anthropic", "unlisted-anywhere"], modelsDev, counts),
							}),
							cacheDbPath: path.join(tempDir, "models.db"),
						},
						"online-if-uncached",
					);
					const byId = new Map(result.models.map(model => [model.id, model]));
					expect(counts).toEqual({ listing: 1, modelsDev: 1 });
					expect(byId.get(id)?.api).toBe("openai-responses");
					expect(byId.get(id)?.baseUrl).toBe(baseUrl);
					expect(byId.get(id)?.contextWindow).toBe(1_000_000);
					expect(byId.get("sibling-anthropic")?.api).toBe("anthropic-messages");
					expect(byId.get("sibling-anthropic")?.baseUrl).toBe(baseUrl.slice(0, -"/v1".length));
					expect(byId.get("unlisted-anywhere")?.api).toBe("openai-completions");
				} finally {
					await fs.rm(tempDir, { recursive: true, force: true });
				}
			});
		}
	});
});

describe("issue #10416 — retired provider snapshot pruning", () => {
	test("prunes retired provider rows while restoring live previous-snapshot providers", () => {
		const staleModel: ModelSpec = {
			id: "legacy-wafer-model",
			name: "Legacy Wafer Model",
			api: "openai-completions",
			provider: "wafer-pass",
			baseUrl: "https://legacy.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		};
		const liveModel: ModelSpec = {
			id: "live-fallback-model",
			name: "Live Fallback Model",
			api: "openai-completions",
			provider: "fixture-provider",
			baseUrl: "https://fixture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		};

		const merged = mergePreviousSnapshotModels(
			[],
			{
				"wafer-pass": { [staleModel.id]: staleModel },
				"fixture-provider": { [liveModel.id]: liveModel },
			},
			new Set(),
		);

		expect(merged.map(model => `${model.provider}/${model.id}`)).toEqual(["fixture-provider/live-fallback-model"]);
	});
});
