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
import {
	applyCodexResponsesLiteShape,
	resolveCodexResponsesLite,
} from "@veyyon/ai/providers/openai-codex/request-transformer";
import { createOpenAICodexCompatibilityMetadata } from "@veyyon/ai/providers/openai-codex-responses";
import { getBundledModels } from "@veyyon/catalog/models";
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
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { applyResultLimit } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError } from "./utils";

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
	for (const model of getBundledModels("openai-codex")) {
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

function shouldRetryWithNextDefaultModel(error: unknown): boolean {
	if (!(error instanceof SearchProviderError)) return false;
	if (error.provider !== "codex" || error.status !== 400) return false;
	return /model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i.test(
		error.message,
	);
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

/** Codex API response structure */
interface CodexResponseItem {
	type: string;
	id?: string;
	role?: string;
	name?: string;
	call_id?: string;
	status?: string;
	arguments?: string;
	content?: CodexContentPart[];
	summary?: Array<{ type: string; text: string }>;
}

interface CodexContentPart {
	type: string;
	text?: string;
	annotations?: CodexAnnotation[];
}

interface CodexAnnotation {
	type: string;
	url?: string;
	title?: string;
	start_index?: number;
	end_index?: number;
}

interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface CodexResponse {
	id?: string;
	model?: string;
	status?: string;
	usage?: CodexUsage;
}

/**
 * Known Codex "image placeholder" answers — short prose the assistant emits in
 * place of a real answer when it produced a screenshot instead of text. These
 * carry no information, so callers treat them as non-answers and advance the
 * chain to a provider that returns text. Extend by adding the normalized
 * literal below; no regex tuning required.
 */
const IMAGE_PLACEHOLDER_ANSWERS: ReadonlySet<string> = new Set([
	"see attached image",
	"attached image",
	"see the attached image",
	"see image",
	"see image above",
	"image above",
	"see image below",
	"image below",
]);

function isImagePlaceholderAnswer(text: string): boolean {
	// Strip surrounding brackets/quotes and trailing punctuation, lowercase,
	// then match against the known-placeholder set.
	const normalized = text
		.trim()
		.replace(/^[[("'`*_]+/, "")
		.replace(/[\])"'`*_.!?]+$/, "")
		.trim()
		.toLowerCase();
	return IMAGE_PLACEHOLDER_ANSWERS.has(normalized);
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!sources.some(existing => existing.url === source.url)) {
		sources.push(source);
	}
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const char of text) {
		if (char === target) {
			count += 1;
		}
	}
	return count;
}

/**
 * Strips prose punctuation and unmatched closing delimiters from extracted URLs.
 * Codex often returns links in markdown or sentence text without structured annotations.
 */
function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();

	while (url.length > 0) {
		const lastCharacter = url.at(-1);
		if (!lastCharacter) break;
		if (/[.,!?;:'"]/u.test(lastCharacter)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "}" && countCharacter(url, "}") > countCharacter(url, "{")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}

	if (!/^https?:\/\//.test(url)) {
		return null;
	}

	try {
		return new URL(url).toString();
	} catch {
		// A citation URL trimmed out of model prose. The trailing-punctuation loop above strips what it can,
		// and what is left either parses or was never a URL, so the throw is the answer: no citation rather
		// than a guessed one, since the URL is shown to the reader as a source.
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;

	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") {
			return null;
		}
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return index;
		}
		if (depth < 0) {
			return null;
		}
	}

	return null;
}

/**
 * Extracts citation sources from markdown links and bare URLs in the answer text.
 * Used as a fallback when the Codex response omits `url_citation` annotations.
 */
function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") {
			continue;
		}
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") {
			continue;
		}
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) {
			continue;
		}
		const title = text.slice(index + 1, titleEnd).trim();
		const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
		if (url) {
			addSource(sources, { title: title || url, url });
		}
		index = urlEnd;
	}

	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (!url) continue;
		addSource(sources, { title: url, url });
	}

	return sources;
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

function acceptsNamedToolChoice(model: Pick<CodexSearchModel, "compat">): boolean {
	const compat = model.compat;
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
		sessionId?: string;
		fetch?: FetchImpl;
		resolveProviderTextTransform?: ProviderTextTransformResolver;
	},
): Promise<{
	answer: string;
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
	const url = `${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;
	const headers = buildCodexHeaders(auth.accessToken, auth.accountId);

	const requestedModel = options.model.modelId;
	const candidateModel = options.model.catalogModel ?? {
		id: requestedModel,
		api: "openai-codex-responses" as const,
		provider: "openai-codex" as const,
	};
	const usesResponsesLite = resolveCodexResponsesLite(candidateModel, undefined);

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
		tool_choice: acceptsNamedToolChoice(candidateModel) ? { type: "web_search" } : "required",
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};
	if (usesResponsesLite) {
		const metadata = createOpenAICodexCompatibilityMetadata({
			sessionId: options.sessionId,
			requestKind: "turn",
			startNewTurn: true,
		});
		Object.assign(headers, metadata.headers);
		headers[OPENAI_HEADERS.RESPONSES_LITE] = "true";
		body.client_metadata = metadata.clientMetadata;
		body.reasoning = { context: "all_turns" };
		applyCodexResponsesLiteShape(body);
	}

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
			const classified = classifyProviderHttpError("codex", response.status, errorText);
			if (classified) throw classified;
			const message =
				/model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i.test(
					errorText,
				)
					? "codex: requested model is not supported"
					: `Codex API error (${response.status}).`;
			throw new SearchProviderError("codex", message, response.status);
		}

		if (!response.body) {
			throw new SearchProviderError("codex", "Codex API returned no response body", 500);
		}

		// Parse SSE stream
		const answerParts: string[] = [];
		const streamedAnswerParts: string[] = [];
		const sources: SearchSource[] = [];
		let model = requestedModel;
		let requestId = "";
		let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

		for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, options.signal)) {
			const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
			if (!eventType) continue;

			if (eventType === "response.output_text.delta") {
				const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
				if (delta) {
					streamedAnswerParts.push(delta);
				}
			} else if (eventType === "response.output_item.done") {
				const item = rawEvent.item as CodexResponseItem | undefined;
				if (!item) continue;

				// Handle text message content and extract sources from annotations
				if (item.type === "message" && item.content) {
					for (const part of item.content) {
						if (part.type === "output_text" && part.text) {
							answerParts.push(part.text);

							// Extract sources from url_citation annotations
							if (part.annotations) {
								for (const annotation of part.annotations) {
									if (annotation.type === "url_citation" && annotation.url) {
										// Deduplicate by URL
										addSource(sources, { title: annotation.title ?? annotation.url, url: annotation.url });
									}
								}
							}
						}
					}
				}

				// Handle reasoning summary as part of answer
				if (item.type === "reasoning" && item.summary) {
					for (const part of item.summary) {
						if (part.type === "summary_text" && part.text) {
							answerParts.push(part.text);
						}
					}
				}
			} else if (eventType === "response.completed" || eventType === "response.done") {
				const resp = (rawEvent as { response?: CodexResponse }).response;
				if (resp) {
					if (resp.model) model = resp.model;
					if (resp.id) requestId = resp.id;
					if (resp.usage) {
						const cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0;
						usage = {
							inputTokens: (resp.usage.input_tokens ?? 0) - cachedTokens,
							outputTokens: resp.usage.output_tokens ?? 0,
							totalTokens: resp.usage.total_tokens ?? 0,
						};
					}
				}
			} else if (eventType === "error") {
				const { code, message } = extractCodexSseError(rawEvent);
				throw new SearchProviderError("codex", `Codex error (${code}): ${message || "Unknown error"}`, 500);
			} else if (eventType === "response.failed") {
				const { code, message } = extractCodexSseError(rawEvent);
				const detail = code
					? `Codex request failed (${code}): ${message || "Request failed"}`
					: `Codex request failed: ${message || "Request failed"}`;
				throw new SearchProviderError("codex", detail, 500);
			}
		}

		const finalAnswer = answerParts.join("\n\n").trim();
		const streamedAnswer = streamedAnswerParts.join("").trim();
		// Throw to advance the chain whenever Codex emitted nothing but image
		// placeholder prose — including the case where the streamed delta itself
		// is the placeholder (the model occasionally streams the same text it
		// publishes as the final output_text).
		const finalIsPlaceholder = finalAnswer.length > 0 && isImagePlaceholderAnswer(finalAnswer);
		const streamedIsPlaceholder = streamedAnswer.length > 0 && isImagePlaceholderAnswer(streamedAnswer);
		const hasFinalText = finalAnswer.length > 0 && !finalIsPlaceholder;
		const hasStreamedText = streamedAnswer.length > 0 && !streamedIsPlaceholder;
		if (!hasFinalText && !hasStreamedText && sources.length === 0) {
			throw new SearchProviderError("codex", "Codex returned image-only response", 502);
		}
		const answer = hasFinalText ? finalAnswer : hasStreamedText ? streamedAnswer : "";

		// Fallback: when Codex omits url_citation annotations, scrape markdown links
		// and bare URLs from the synthesized answer so callers still receive sources.
		if (sources.length === 0 && answer.length > 0) {
			for (const source of extractTextSources(answer)) {
				addSource(sources, source);
			}
		}

		return {
			answer,
			sources,
			model,
			requestId,
			usage,
		};
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

			let lastError: unknown;
			for (let index = 0; index < modelCandidates.length; index += 1) {
				const candidate = modelCandidates[index];
				if (!candidate) continue;

				try {
					return await callCodexSearch(auth, params.query, {
						signal: params.signal,
						systemPrompt: params.systemPrompt,
						searchContextSize: "high",
						model: candidate,
						sessionId: params.sessionId,
						fetch: params.fetch,
						resolveProviderTextTransform: params.resolveProviderTextTransform,
					});
				} catch (error) {
					lastError = error;
					const isLastCandidate = index === modelCandidates.length - 1;
					if (configuredModel || isLastCandidate || !shouldRetryWithNextDefaultModel(error)) {
						throw error;
					}
				}
			}
			throw lastError ?? new Error("Codex search failed without returning a result");
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
