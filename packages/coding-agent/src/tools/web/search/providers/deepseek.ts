/**
 * DeepSeek Web Search Provider
 *
 * DeepSeek's Search API is a plain JSON endpoint: one query in, a ranked `results` array out, with
 * no synthesized answer. It authenticates with the same bearer key as the `deepseek` model
 * provider, so a machine that can already run the model can also search with it.
 * https://api-docs.deepseek.com/guides/search
 */
import type { ApiKey, AuthStorage, FetchImpl } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { withHardTimeout } from "@veyyon/web/hard-timeout";
import { resolveProviderTextTransform, transformProviderPayload } from "../../../../provider-boundary";
import type { SearchResponse, SearchSource } from "../types";
import { clampNumResults, dateToAgeSeconds, SEARCH_DEFAULT_NUM_RESULTS } from "../utils";
import type { SearchParams } from "./base";
import { ApiKeySearchProvider } from "./base";
import { handleProviderHttpError } from "./utils";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
/** DeepSeek's documented request bounds: `count` is 1..50 and `query` is 1..128 characters. */
const QUERY_MAX_CHARS = 128;
const MAX_NUM_RESULTS = 50;

export interface DeepSeekSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	resolveProviderTextTransform?: SearchParams["resolveProviderTextTransform"];
}

interface DeepSeekSearchResult {
	title?: string | null;
	url?: string | null;
	snippet?: string | null;
	summary?: string | null;
	date?: string | null;
}

interface DeepSeekSearchResponse {
	results?: DeepSeekSearchResult[];
}

/** Find the DeepSeek API key through AuthStorage's unified refresh pipeline. */
export async function findApiKey(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	return (await authStorage.getApiKey("deepseek", sessionId, { signal })) ?? null;
}

/**
 * Cut the query to DeepSeek's documented 128-character limit.
 *
 * DeepSeek refuses a longer query outright, so an over-long model-written query would turn a
 * search into an error. Counted in code points rather than UTF-16 units, so a cut can never leave
 * half a surrogate pair behind; a query that already fits is returned untouched.
 */
export function truncateQuery(query: string): string {
	if (query.length <= QUERY_MAX_CHARS) return query;
	return Array.from(query).slice(0, QUERY_MAX_CHARS).join("");
}

/** Exported for testing. Builds the DeepSeek request body from unified params. */
export function buildRequestBody(params: DeepSeekSearchParams): Record<string, unknown> {
	return {
		query: truncateQuery(params.query),
		count: clampNumResults(params.num_results, SEARCH_DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
		// The normalized source carries one snippet per result, and a full page body would swell
		// every search response. The fetch tool is the path for a whole document.
		need_content: false,
	};
}

async function callDeepSeekSearch(apiKey: string, params: DeepSeekSearchParams): Promise<DeepSeekSearchResponse> {
	return withHardTimeout(params.signal, async hardSignal => {
		const transform = resolveProviderTextTransform(params.resolveProviderTextTransform, "DeepSeek search");
		const body = transformProviderPayload(buildRequestBody(params), transform, "DeepSeek search");
		const response = await (params.fetch ?? fetch)(DEEPSEEK_SEARCH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: hardSignal,
		});

		if (!response.ok) {
			await handleProviderHttpError("deepseek", response, `DeepSeek search request failed (${response.status}).`);
		}

		return (await response.json()) as DeepSeekSearchResponse;
	});
}

function toSearchResponse(response: DeepSeekSearchResponse, numResults: number): SearchResponse {
	const sources: SearchSource[] = [];

	for (const result of response.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title?.trim() || result.url,
			url: result.url,
			// DeepSeek documents `summary` as the field written for a model to read and `snippet` as
			// the short one for a UI. The normalized source has a single text field, and that field
			// is what reaches the model, so the model-facing text wins.
			snippet: result.summary?.trim() || result.snippet?.trim() || undefined,
			publishedDate: result.date ?? undefined,
			ageSeconds: dateToAgeSeconds(result.date ?? undefined),
		});
	}

	return {
		provider: "deepseek",
		sources: sources.slice(0, numResults),
		authMode: "api_key",
	};
}

/** Execute DeepSeek web search. */
export async function searchDeepSeek(params: SearchParams): Promise<SearchResponse> {
	const deepseekParams: DeepSeekSearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		signal: params.signal,
		fetch: params.fetch,
		resolveProviderTextTransform: params.resolveProviderTextTransform,
	};
	const keyOrResolver: ApiKey = params.authStorage.resolver("deepseek", {
		sessionId: params.sessionId,
	});
	const numResults = clampNumResults(deepseekParams.num_results, SEARCH_DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const response = await withAuth(keyOrResolver, key => callDeepSeekSearch(key, deepseekParams), {
		signal: params.signal,
		missingKeyMessage:
			'DeepSeek credentials not found. Set DEEPSEEK_API_KEY or configure an API key for provider "deepseek".',
	});

	return toSearchResponse(response, numResults);
}

/** Search provider for DeepSeek web search. */
export class DeepSeekProvider extends ApiKeySearchProvider {
	readonly id = "deepseek";
	readonly label = "DeepSeek";

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDeepSeek(params);
	}
}
