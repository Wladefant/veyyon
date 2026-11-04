/**
 * OpenAI Codex Web Search Provider
 *
 * Uses Codex's built-in web_search tool via the Responses API.
 * Auth is resolved through `AuthStorage.getOAuthAccess("openai-codex")` so the
 * broker is the sole refresh authority — this module never opens a sibling
 * SQLite store, never POSTs the broker sentinel to an OpenAI token endpoint.
 */
import * as os from "node:os";
import type { AuthStorage, FetchImpl, Model } from "@veyyon/ai";
import { withOAuthAccess } from "@veyyon/ai/auth-retry";
import { getBundledChatModels } from "@veyyon/catalog/models";
import {
	// The host is imported, never respelled. `@veyyon/catalog/wire/codex` owns it and
	// six other modules already read it from there; this file had its own copy of the
	// literal, so a Codex host change would have moved every caller but this one and
	// web search alone would have kept posting to the old endpoint.
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@veyyon/catalog/wire/codex";
import { $env, readSseJson } from "@veyyon/utils";
import { withHardTimeout } from "@veyyon/web/hard-timeout";
import packageJson from "../../../../../package.json" with { type: "json" };
import {
	type ProviderTextTransformResolver,
	resolveProviderTextTransform,
	transformProviderPayload,
} from "../../../../provider-boundary";
import type { SearchResponse } from "../types";
import { SearchProviderError } from "../types";
import { applyResultLimit } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { CodexAnswerCollector, type CodexSearchAnswer, type CodexSearchEvent } from "./codex-answer";
import { throwProviderHttpError } from "./utils";

const CODEX_RESPONSES_PATH = "/codex/responses";
const FALLBACK_MODEL = "gpt-5.5";
const DEFAULT_MODEL_PREFERENCES = [
	"gpt-5.6-luna",
	"gpt-5.6-terra",
	"gpt-5.6-sol",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5-codex",
	"gpt-5",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.1-codex",
	"gpt-5-codex-mini",
];
const DEFAULT_INSTRUCTIONS =
	"You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources.";

type CodexSearchModel = Model<"openai-codex-responses">;

interface CodexModelCandidate {
	modelId: string;
	catalogModel?: CodexSearchModel;
}

function getBundledCodexModels(): CodexSearchModel[] {
	const models: CodexSearchModel[] = [];
	for (const model of getBundledChatModels("openai-codex")) {
		if (model.api === "openai-codex-responses") {
			models.push(model as CodexSearchModel);
		}
	}
	return models;
}

function getConfiguredModel(): CodexModelCandidate | undefined {
	const configuredModel = $env.VEYYON_CODEX_WEB_SEARCH_MODEL?.trim();
	if (!configuredModel) return undefined;

	const catalogModel = getBundledCodexModels().find(model => model.id === configuredModel);
	return { modelId: configuredModel, ...(catalogModel ? { catalogModel } : {}) };
}

function getDefaultModelCandidates(): CodexModelCandidate[] {
	const bundledModels = getBundledCodexModels();
	const candidates: CodexModelCandidate[] = [];
	for (const modelId of DEFAULT_MODEL_PREFERENCES) {
		const catalogModel = bundledModels.find(model => model.id === modelId);
		if (catalogModel) candidates.push({ modelId, catalogModel });
	}

	if (candidates.length > 0) {
		return candidates;
	}

	const nonMini = bundledModels.find(model => !model.id.includes("mini") && !model.id.includes("spark"));
	if (nonMini) {
		return [{ modelId: nonMini.id, catalogModel: nonMini }];
	}

	const fallbackModel = bundledModels[0];
	return fallbackModel ? [{ modelId: fallbackModel.id, catalogModel: fallbackModel }] : [{ modelId: FALLBACK_MODEL }];
}

/** The Codex error body, or the message raised from it, of a model a ChatGPT account cannot use. */
const UNSUPPORTED_MODEL =
	/model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i;

function shouldRetryWithNextDefaultModel(error: unknown): boolean {
	if (!(error instanceof SearchProviderError)) return false;
	if (error.provider !== "codex" || error.status !== 400) return false;
	return UNSUPPORTED_MODEL.test(error.message);
}

export interface CodexSearchParams {
	signal?: AbortSignal;
	fetch?: FetchImpl;
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Search context size: controls how much web content to include */
	search_context_size?: "low" | "medium" | "high";
	resolveProviderTextTransform?: ProviderTextTransformResolver;
}

/**
 * Extracts account ID from a Codex access token.
 * @param accessToken - JWT access token
 * @returns Account ID string, or null if not found
 */
function getAccountIdFromJwt(accessToken: string): string | null {
	// `null` rather than `undefined` because this module's auth resolution reports every absence as `null`.
	// The claim namespace and the empty-claim rule are the owner's, in `@veyyon/catalog/wire/codex`.
	return getCodexAccountId(accessToken) ?? null;
}

/**
 * Builds HTTP headers for Codex API requests.
 */
function buildCodexHeaders(accessToken: string, accountId?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		[OPENAI_HEADERS.BETA]: OPENAI_HEADER_VALUES.BETA_RESPONSES,
		[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
		[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
		"User-Agent": `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`,
		Accept: "text/event-stream",
		"Content-Type": "application/json",
	};
	if (accountId) {
		headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
	}
	return headers;
}

/**
 * Extracts a backend error `{code, message}` from a Codex SSE event, tolerating
 * the envelope shapes the ChatGPT Codex backend emits: top-level `{code,message}`,
 * a nested `error` object, and a `response.error` object (as in `response.failed`).
 * Without this the nested shapes collapse to `Codex error (): Unknown error`,
 * discarding the backend diagnostic — e.g. a regional/model-snapshot rejection (#7200).
 */
function extractCodexSseError(rawEvent: Record<string, unknown>): { code: string; message: string } {
	const candidates: unknown[] = [
		rawEvent,
		rawEvent.error,
		(rawEvent.response as { error?: unknown } | undefined)?.error,
	];
	let code = "";
	let message = "";
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		const record = candidate as Record<string, unknown>;
		if (!code && typeof record.code === "string" && record.code) code = record.code;
		if (!message && typeof record.message === "string" && record.message) message = record.message;
	}
	return { code, message };
}

function acceptsNamedToolChoice(compat: CodexSearchModel["compat"] | undefined): boolean {
	return !(compat && "supportsNamedToolChoice" in compat && compat.supportsNamedToolChoice === false);
}

/**
 * Calls the Codex Responses API with web search tool enabled.
 * The caller provides the exact model id to send; retry / fallback policy
 * lives one layer up in `searchCodex()` so we can distinguish explicit user
 * overrides from the default ChatGPT-account model-selection path.
 */
async function callCodexSearch(
	auth: { accessToken: string; accountId?: string },
	query: string,
	options: {
		signal?: AbortSignal;
		systemPrompt?: string;
		searchContextSize?: "low" | "medium" | "high";
		model: CodexModelCandidate;
		fetch?: FetchImpl;
		resolveProviderTextTransform?: ProviderTextTransformResolver;
	},
): Promise<CodexSearchAnswer> {
	const url = `${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;
	const headers = buildCodexHeaders(auth.accessToken, auth.accountId);

	const requestedModel = options.model.modelId;

	// Hosted web_search is a top-level Responses tool, even for Lite catalog
	// models. Relocating it into additional_tools prevents the backend searching.
	const body: Record<string, unknown> = {
		model: requestedModel,
		stream: true,
		store: false,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		tool_choice: acceptsNamedToolChoice(options.model.catalogModel?.compat) ? { type: "web_search" } : "required",
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};

	const fetchImpl = options.fetch ?? fetch;
	return withHardTimeout(options.signal, async hardSignal => {
		const transform = resolveProviderTextTransform(options.resolveProviderTextTransform, "Codex search request");
		const requestBody = transformProviderPayload(body, transform, "Codex search request");
		const response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: hardSignal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throwProviderHttpError(
				"codex",
				response.status,
				errorText,
				UNSUPPORTED_MODEL.test(errorText)
					? "codex: requested model is not supported"
					: `Codex API error (${response.status}).`,
			);
		}
		if (!response.body) {
			throw new SearchProviderError("codex", "Codex API returned no response body", 500);
		}
		const collector = new CodexAnswerCollector(requestedModel);
		for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, options.signal)) {
			const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
			if (eventType === "error") {
				const { code, message } = extractCodexSseError(rawEvent);
				throw new SearchProviderError("codex", `Codex error (${code}): ${message || "Unknown error"}`, 500);
			}
			if (eventType === "response.failed") {
				const { code, message } = extractCodexSseError(rawEvent);
				const detail = code
					? `Codex request failed (${code}): ${message || "Request failed"}`
					: `Codex request failed: ${message || "Request failed"}`;
				throw new SearchProviderError("codex", detail, 500);
			}
			collector.accept(rawEvent as CodexSearchEvent);
		}
		return collector.finish();
	});
}

/**
 * Executes a web search using OpenAI Codex's built-in web search tool.
 *
 * Default-model behavior:
 * - If `VEYYON_CODEX_WEB_SEARCH_MODEL` is set, use it exactly once and surface any
 *   upstream error verbatim.
 * - Otherwise prefer ChatGPT-account-safe bundled defaults (GPT-5.6 Luna,
 *   Terra, Sol, GPT-5.5, …) and retry the next candidate only when Codex
 *   returns the known 400 "model is not supported" family. This avoids
 *   selecting `gpt-5-codex-mini` first on ChatGPT accounts, which OpenAI
 *   rejects.
 */
export async function searchCodex(params: SearchParams): Promise<SearchResponse> {
	const seed = await params.authStorage.getOAuthAccess("openai-codex", params.sessionId, {
		signal: params.signal,
	});
	if (!seed) {
		throw new Error(
			"No Codex OAuth credentials found. Login with 'veyyon /login openai-codex' to enable Codex web search.",
		);
	}

	const configuredModel = getConfiguredModel();
	const modelCandidates = configuredModel ? [configuredModel] : getDefaultModelCandidates();

	const result = await withOAuthAccess(
		params.authStorage,
		"openai-codex",
		async access => {
			// Derive ALL auth material from the access this attempt received —
			// a refreshed/rotated credential carries a different bearer and
			// ChatGPT account id than the seed.
			const accountId = access.accountId ?? getAccountIdFromJwt(access.accessToken) ?? undefined;
			const auth = { accessToken: access.accessToken, accountId };

			// An explicit model is the only candidate, so it is also the last and is never retried.
			for (const [index, candidate] of modelCandidates.entries()) {
				try {
					return await callCodexSearch(auth, params.query, {
						signal: params.signal,
						systemPrompt: params.systemPrompt,
						searchContextSize: "high",
						model: candidate,
						fetch: params.fetch,
						resolveProviderTextTransform: params.resolveProviderTextTransform,
					});
				} catch (error) {
					if (index === modelCandidates.length - 1 || !shouldRetryWithNextDefaultModel(error)) throw error;
				}
			}
			throw new Error("Codex search has no model to try");
		},
		{ sessionId: params.sessionId, signal: params.signal, seed },
	);

	const sources = applyResultLimit(result.sources, params.numSearchResults ?? params.limit);

	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
		model: result.model,
		requestId: result.requestId,
	};
}

/**
 * Checks if Codex web search is available.
 */
export async function hasCodexSearch(authStorage: AuthStorage): Promise<boolean> {
	// `isAvailable` runs before every request — keep the probe cheap.
	// `hasOAuth(...)` is a synchronous in-memory check that returns true as soon
	// as a Codex OAuth credential is loaded, without driving the refresh
	// pipeline. The actual refresh happens lazily in `searchCodex`.
	return authStorage.hasOAuth("openai-codex");
}

/** Search provider for OpenAI Codex web search. */
export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "OpenAI";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return hasCodexSearch(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex(params);
	}
}
