import type { ModelManagerOptions } from "../model-manager";
import { CLOUD_CODE_ENDPOINT } from "../provider-endpoints";
import type { FetchImpl } from "../types";
import { GEMINI_CLI_VARIANT_COLLAPSE_TABLE } from "../variant-collapse";

export interface GoogleModelManagerConfig {
	apiKey?: string;
	fetch?: FetchImpl;
}

export interface GoogleVertexModelManagerConfig {
	apiKey?: string;
	project?: string;
	location?: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface GoogleAntigravityModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
	fetch?: FetchImpl;
}

export interface GoogleGeminiCliModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
	fetch?: FetchImpl;
}

export function googleModelManagerOptions(
	config?: GoogleModelManagerConfig,
): ModelManagerOptions<"google-generative-ai"> {
	const apiKey = config?.apiKey;
	return {
		providerId: "google",
		...(apiKey
			? {
					fetchDynamicModels: async hooks => {
						// Deferred import: static import pulls discovery into @veyyon/catalog/provider-models and inflates the reach graph.
						const { fetchGeminiModels } = await import("../discovery/gemini");
						return fetchGeminiModels({ apiKey, fetch: config?.fetch, onFailure: hooks?.onFailure });
					},
				}
			: undefined),
	};
}

export function googleVertexModelManagerOptions(_config?: GoogleVertexModelManagerConfig): ModelManagerOptions {
	return { providerId: "google-vertex" };
}

export function googleAntigravityModelManagerOptions(
	config?: GoogleAntigravityModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	return {
		providerId: "google-antigravity",
		...(token
			? {
					fetchDynamicModels: async hooks => {
						// Deferred import: static import pulls discovery into @veyyon/catalog/provider-models and inflates the reach graph.
						const { fetchAntigravityDiscoveryModels } = await import("../discovery/antigravity");
						return fetchAntigravityDiscoveryModels({
							token,
							endpoint: config?.endpoint,
							fetcher: config?.fetch,
							onFailure: hooks?.onFailure,
						});
					},
				}
			: undefined),
	};
}

export function googleGeminiCliModelManagerOptions(
	config?: GoogleGeminiCliModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	const endpoint = config?.endpoint ?? CLOUD_CODE_ENDPOINT;
	return {
		providerId: "google-gemini-cli",
		...(token
			? {
					fetchDynamicModels: async hooks => {
						// Deferred import: static import pulls discovery into @veyyon/catalog/provider-models and inflates the reach graph.
						const { fetchAntigravityDiscoveryModels } = await import("../discovery/antigravity");
						const models = await fetchAntigravityDiscoveryModels({
							token,
							endpoint,
							fetcher: config?.fetch,
							collapseTable: GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
							onFailure: hooks?.onFailure,
						});
						if (models === null) {
							return null;
						}
						return models.map(m => ({
							...m,
							provider: "google-gemini-cli" as const,
							baseUrl: endpoint,
						}));
					},
				}
			: undefined),
	};
}
