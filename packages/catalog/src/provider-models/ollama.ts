import { fetchWithRetry } from "@veyyon/utils/fetch-retry";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import type { DiscoveryFailureStage, DiscoveryHooks } from "../discovery/failure";
import { fetchOpenAICompatibleModels } from "../discovery/openai-compatible";
import { Effort } from "../effort";
import { isGlm52ModelId } from "../identity/family";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec, ThinkingConfig } from "../types";
import { discoveryFetch, toNonEmptyString } from "../utils";
import { createBundledReferenceMap, createReferenceResolver, mapWithBundledReference } from "./bundled-references";
import type { ModelManagerConfig } from "./descriptor-types";
import { fetchOllamaShow, ollamaInput, ollamaThinking, readOllamaTags } from "./ollama-native";

// ---------------------------------------------------------------------------
// Local Ollama: the daemon's OpenAI-compatible `/v1`, enriched from its native API
// ---------------------------------------------------------------------------

/**
 * The OpenAI-compatible base URL for an Ollama endpoint: the configured origin AND PATH, with
 * exactly one `/v1` on the end.
 *
 * The path is the part worth stating. An Ollama reached through a reverse proxy is mounted at a
 * subpath (`http://gateway:11434/ollama`), and a normalizer that keeps only the origin sends every
 * request to the proxy's root, where nothing answers.
 */
export function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "http://127.0.0.1:11434/v1";
	}
	const trimmed = trimTrailingSlashes(value);
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** The same endpoint addressed by Ollama's own API, which is the OpenAI-compatible one without `/v1`. */
export function toOllamaNativeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

/**
 * Fallback context window for Ollama models when `/api/show` is unavailable
 * or states no context window. Matches the size Ollama's cloud catalog
 * reports for stock models.
 */
const OLLAMA_FALLBACK_CONTEXT_WINDOW = 128_000;
/** Cap max output tokens at a value that matches Veyyon's other openai-responses defaults. */
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;

interface OllamaResolvedMetadata {
	contextWindow: number;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
}

type OllamaMetadataResolver = (
	modelId: string,
	onFailure?: DiscoveryHooks["onFailure"],
) => Promise<OllamaResolvedMetadata>;

/**
 * Build a resolver that fetches `/api/show` metadata per model id and caches
 * the result in-memory for the lifetime of the manager. Successful lookups are
 * cached so repeated `fetchDynamicModels` calls do not refetch; failed
 * lookups stay uncached so a later refresh can recover.
 *
 * The fallback is not neutral. The caller OVERWRITES the model's context window
 * with it, so a `/api/show` that fails does not leave the bundled figure in
 * place: it replaces a real 32k with a hardcoded 128k, prompts get packed to the
 * larger size, and Ollama drops the front of the context to make them fit. That
 * is why `fetchOllamaShow` reports every failure.
 */
function createOllamaMetadataResolver(nativeBaseUrl: string, fetchImpl?: FetchImpl): OllamaMetadataResolver {
	const cache = new Map<string, Promise<OllamaResolvedMetadata>>();
	return (modelId, onFailure) => {
		const cached = cache.get(modelId);
		if (cached) return cached;
		const pending = (async (): Promise<OllamaResolvedMetadata> => {
			const show = await fetchOllamaShow(nativeBaseUrl, modelId, { fetch: fetchImpl, onFailure });
			if (!show) {
				cache.delete(modelId);
				return { contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW };
			}
			const { capabilities } = show;
			return {
				contextWindow: show.contextWindow ?? OLLAMA_FALLBACK_CONTEXT_WINDOW,
				reasoning: capabilities?.has("thinking"),
				thinking: capabilities && ollamaThinking(capabilities),
				input: capabilities && ollamaInput(capabilities),
			};
		})();
		cache.set(modelId, pending);
		void pending.catch(() => cache.delete(modelId));
		return pending;
	};
}

async function fetchOllamaNativeModels(
	baseUrl: string,
	resolveMetadata: OllamaMetadataResolver,
	fetchImpl: FetchImpl = discoveryFetch(),
	onFailure?: DiscoveryHooks["onFailure"],
): Promise<ModelSpec<"openai-responses">[] | null> {
	const url = `${toOllamaNativeBaseUrl(baseUrl)}/api/tags`;
	const report = (stage: DiscoveryFailureStage, detail: string): void => onFailure?.({ stage, url, detail });
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch (error) {
		// Null is 'this resolver produced no catalog', which the caller distinguishes from the `[]` an endpoint
		// with no models returns. This is the last step before an empty picker, so the reason for the `null`
		// travels back with it: a refused connection to a local daemon and a 403 from a proxy in front of it
		// were the same silence, and they call for entirely different things from whoever is looking.
		report("request", errorMessage(error));
		return null;
	}
	const tags = await readOllamaTags(response, report);
	if (tags === undefined) return null;
	const models = await Promise.all(
		tags.map(async (tag): Promise<ModelSpec<"openai-responses">> => {
			const metadata = await resolveMetadata(tag.id, onFailure);
			return {
				id: tag.id,
				name: tag.name ?? tag.id,
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				reasoning: metadata.reasoning ?? false,
				thinking: metadata.thinking,
				input: metadata.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.contextWindow,
				maxTokens: Math.min(metadata.contextWindow, OLLAMA_DEFAULT_MAX_TOKENS),
			};
		}),
	);
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

export function ollamaModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaBaseUrl(config?.baseUrl);
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"openai-responses">(
		"ollama" as Parameters<typeof createBundledReferenceMap>[0],
	);
	const resolveMetadata = createOllamaMetadataResolver(nativeBaseUrl, config?.fetch);
	return {
		providerId: "ollama",
		fetchDynamicModels: async hooks => {
			const openAiCompatible = await fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					if (!reference) {
						return {
							...defaults,
							name: toNonEmptyString(entry.name) ?? defaults.name,
							contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW,
							maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
						};
					}
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (openAiCompatible && openAiCompatible.length > 0) {
				await Promise.all(
					openAiCompatible.map(async model => {
						const metadata = await resolveMetadata(model.id, hooks?.onFailure);
						model.contextWindow = metadata.contextWindow;
						if (model.maxTokens !== null) model.maxTokens = Math.min(model.maxTokens, metadata.contextWindow);
						if (metadata.reasoning !== undefined) {
							model.reasoning = metadata.reasoning;
							model.thinking = metadata.thinking;
						}
						if (metadata.input) {
							model.input = metadata.input;
						}
					}),
				);
				return openAiCompatible;
			}
			const nativeFallback = await fetchOllamaNativeModels(
				baseUrl,
				resolveMetadata,
				config?.fetch,
				hooks?.onFailure,
			);
			if (nativeFallback && nativeFallback.length > 0) {
				return nativeFallback;
			}
			return openAiCompatible;
		},
	};
}

// ---------------------------------------------------------------------------
// Ollama Cloud: the native API at ollama.com
// ---------------------------------------------------------------------------

const OLLAMA_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const OLLAMA_CLOUD_GLM_52_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.High, Effort.Max],
};

export function normalizeOllamaCloudBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "https://ollama.com";
	}
	const trimmed = trimTrailingSlashes(value);
	return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function createCloudHeaders(apiKey: string): Record<string, string> {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
}

function getCloudThinkingConfig(modelId: string, capabilities: ReadonlySet<string>): ThinkingConfig | undefined {
	const thinking = ollamaThinking(capabilities);
	return thinking && isGlm52ReasoningEffortModelId(modelId) ? OLLAMA_CLOUD_GLM_52_THINKING : thinking;
}

export function ollamaCloudModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"ollama-chat"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaCloudBaseUrl(config?.baseUrl);
	const providerReferences = createBundledReferenceMap<"ollama-chat">("ollama-cloud");
	const resolveReference = createReferenceResolver(providerReferences);
	return {
		providerId: "ollama-cloud",
		fetchDynamicModels: async hooks => {
			if (!apiKey) {
				return [];
			}
			const url = `${baseUrl}/api/tags`;
			const report = (stage: DiscoveryFailureStage, detail: string): void =>
				hooks?.onFailure?.({ stage, url, detail });
			let response: Response;
			try {
				response = await fetchWithRetry(url, {
					method: "GET",
					headers: createCloudHeaders(apiKey),
					fetch: discoveryFetch(config?.fetch),
					defaultDelayMs: OLLAMA_RETRY_DELAYS_MS,
				});
			} catch (error) {
				report("request", errorMessage(error));
				return null;
			}
			const tags = await readOllamaTags(response, report);
			if (tags === undefined) return null;
			const models = await Promise.all(
				tags.map(async (tag): Promise<ModelSpec<"ollama-chat">> => {
					const { id } = tag;
					const providerReference = providerReferences.get(id);
					const reference = resolveReference(id);
					const show = await fetchOllamaShow(baseUrl, id, {
						fetch: config?.fetch,
						headers: { Authorization: `Bearer ${apiKey}` },
						onFailure: hooks?.onFailure,
					});
					const capabilities = show?.capabilities;
					const discoveredContextWindow = show?.contextWindow;
					// `/api/show` is the only trustworthy Ollama-owned source for size caps.
					// When it is unavailable (or returns only coarse capabilities), do NOT
					// inherit giant budgets from bundled fallback metadata sourced from a
					// different catalog; keep the historical safe fallback instead.
					const contextWindow = discoveredContextWindow ?? 128000;

					return {
						id,
						name: tag.name && tag.name !== id ? tag.name : (reference?.name ?? id),
						api: "ollama-chat",
						provider: "ollama-cloud",
						baseUrl,
						reasoning: capabilities ? capabilities.has("thinking") : (reference?.reasoning ?? false),
						thinking: capabilities ? getCloudThinkingConfig(id, capabilities) : reference?.thinking,
						input: capabilities ? ollamaInput(capabilities) : (reference?.input ?? ["text"]),
						cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow,
						maxTokens:
							discoveredContextWindow !== undefined
								? (providerReference?.maxTokens ?? Math.min(contextWindow, 8192))
								: Math.min(contextWindow, 8192),
						omitMaxOutputTokens: true,
					};
				}),
			);
			return models.sort((left, right) => left.id.localeCompare(right.id));
		},
	};
}
