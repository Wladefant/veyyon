/**
 * OpenAI Codex Web Search Provider
 *
 * Uses Codex's built-in web_search tool via the Responses API.
 * Auth is resolved through `AuthStorage.getOAuthAccess("openai-codex")` so the
 * broker is the sole refresh authority — this module never opens a sibling
 * SQLite store, never POSTs the broker sentinel to an OpenAI token endpoint.
 */
import * as os from "node:os";
import type { AuthStorage, FetchImpl, OAuthAccess } from "@veyyon/ai";
import { withOAuthAccess } from "@veyyon/ai/auth-retry";
import { resolveCodexAccessPrograms } from "@veyyon/ai/providers/openai-codex/access-programs";
import { getBundledModels } from "@veyyon/catalog/models";
import {
	// The host is imported, never respelled. `@veyyon/catalog/wire/codex` owns it and
	// six other modules already read it from there; this file had its own copy of the
	// literal, so a Codex host change would have moved every caller but this one and
	// web search alone would have kept posting to the old endpoint.
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	type CodexRoutedBody,
	codexRoutingHint,
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

/** The ids of the bundled Codex Responses models, in catalog order. */
function getBundledCodexModelIds(): string[] {
	const ids: string[] = [];
	for (const model of getBundledModels("openai-codex")) {
		if (model.api === "openai-codex-responses") ids.push(model.id);
	}
	return ids;
}

function getDefaultModelCandidates(): string[] {
	const bundled = getBundledCodexModelIds();
	const candidates = DEFAULT_MODEL_PREFERENCES.filter(id => bundled.includes(id));
	if (candidates.length > 0) return candidates;
	const nonMini = bundled.find(id => !id.includes("mini") && !id.includes("spark"));
	return [nonMini ?? bundled[0] ?? FALLBACK_MODEL];
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
 * Resolve a Codex bearer + accountId through {@link AuthStorage} — the single
 * refresh authority. Returns `null` when no OAuth credential is configured,
 * when the credential cannot be refreshed (broker error, revoked token, etc.),
 * or when the access token carries no `chatgpt_account_id` claim.
 */
async function findCodexAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ access: OAuthAccess; accountId: string } | null> {
	const access = await authStorage.getOAuthAccess("openai-codex", sessionId, { signal });
	if (!access) return null;
	const accountId = access.accountId ?? getAccountIdFromJwt(access.accessToken);
	if (!accountId) return null;
	return { access, accountId };
}

/**
 * Builds HTTP headers for Codex API requests.
 */
function buildCodexHeaders(accessToken: string, accountId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		[OPENAI_HEADERS.ACCOUNT_ID]: accountId,
		[OPENAI_HEADERS.BETA]: OPENAI_HEADER_VALUES.BETA_RESPONSES,
		[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
		[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
		"User-Agent": `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`,
		Accept: "text/event-stream",
		"Content-Type": "application/json",
	};
}

/**
 * Calls the Codex Responses API with web search tool enabled.
 * The caller provides the exact model id to send; retry / fallback policy
 * lives one layer up in `searchCodex()` so we can distinguish explicit user
 * overrides from the default ChatGPT-account model-selection path.
 *
 * The request is the plain Responses shape for every model, including one discovery marks for
 * Responses-Lite. Under the Lite header the endpoint accepts only function, custom and client tool
 * search tools in `tools`: a hosted `web_search` moved into the `additional_tools` input item is
 * never forced and answers from the model's own knowledge, and a `tool_choice` naming it fails with
 * 400 `Tool choice 'web_search_preview' not found in 'tools' parameter.`
 */
async function callCodexSearch(
	auth: { accessToken: string; accountId: string },
	query: string,
	options: {
		signal?: AbortSignal;
		systemPrompt?: string;
		searchContextSize?: "low" | "medium" | "high";
		model: string;
		fetch?: FetchImpl;
		resolveProviderTextTransform?: ProviderTextTransformResolver;
	},
): Promise<CodexSearchAnswer> {
	const url = `${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;
	const headers = buildCodexHeaders(auth.accessToken, auth.accountId);

	const requestedModel = options.model;
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
		tool_choice: { type: "web_search" },
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};

	const fetchImpl = options.fetch ?? fetch;
	return withHardTimeout(options.signal, async hardSignal => {
		const transform = resolveProviderTextTransform(options.resolveProviderTextTransform, "Codex search request");
		// A search for security material is judged like a turn: without the account's Daybreak program it
		// is answered under the automatic treatment and refused with `cyber_policy`.
		const accessPrograms = await resolveCodexAccessPrograms(
			{ id: requestedModel, baseUrl: CODEX_BASE_URL },
			auth.accessToken,
			{
				accountId: auth.accountId,
				fetch: fetchImpl,
				signal: hardSignal,
			},
		);
		if (accessPrograms) body.access_programs = accessPrograms;
		const requestBody = transformProviderPayload(body, transform, "Codex search request");
		// The hint states the model of the body as sent, as a turn's does.
		const routingHint = codexRoutingHint(requestBody as CodexRoutedBody);
		const response = await fetchImpl(url, {
			method: "POST",
			headers: routingHint ? { ...headers, [OPENAI_HEADERS.ROUTING_HINT]: routingHint } : headers,
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
		for await (const event of readSseJson<CodexSearchEvent>(response.body, options.signal)) {
			collector.accept(event);
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
	const seed = await findCodexAuth(params.authStorage, params.sessionId, params.signal);
	if (!seed) {
		throw new Error(
			"No Codex OAuth credentials found. Login with 'veyyon /login openai-codex' to enable Codex web search.",
		);
	}

	const configuredModel = $env.VEYYON_CODEX_WEB_SEARCH_MODEL?.trim();
	const modelCandidates = configuredModel ? [configuredModel] : getDefaultModelCandidates();

	const result = await withOAuthAccess(
		params.authStorage,
		"openai-codex",
		async access => {
			// Derive ALL auth material from the access this attempt received —
			// a refreshed/rotated credential carries a different bearer and
			// ChatGPT account id than the seed.
			const accountId = access.accountId ?? getAccountIdFromJwt(access.accessToken);
			if (!accountId) {
				throw new Error("Codex OAuth credential is missing a ChatGPT account id");
			}
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
		{ sessionId: params.sessionId, signal: params.signal, seed: seed.access },
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
