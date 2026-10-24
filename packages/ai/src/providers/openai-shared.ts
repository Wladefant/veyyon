import type { Effort } from "@veyyon/catalog/effort";
import { toFirepassWireModelId, toFireworksWireModelId } from "@veyyon/catalog/fireworks-model-id";
import { isGlm52ReasoningEffortModelId } from "@veyyon/catalog/identity";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { emptyCost, inheritUsageCarryovers, scaleUsageCost } from "@veyyon/catalog/models";
import type {
	OpenAICompat,
	OpenAIReasoningDisableMode,
	OpenAIStreamMarkupHealingPattern,
	OpenRouterRouting,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	VercelGatewayRouting,
} from "@veyyon/catalog/types";
import {
	COREWEAVE_PROJECT_HEADER,
	coreWeaveProjectHeaders,
	hasCoreWeaveProjectHeader,
	removeBlankCoreWeaveProjectHeaders,
} from "@veyyon/catalog/wire/coreweave";
import { parseGitHubCopilotApiKey } from "@veyyon/catalog/wire/github-copilot";
import { resolveKimiCodeEndpoint } from "@veyyon/catalog/wire/kimi-code";
import { OPENCODE_GO_ORG_HEADER, resolveOpenCodeGoEndpoint } from "@veyyon/catalog/wire/opencode-go";
import { $env } from "@veyyon/utils/env";
import { extractHttpStatusFromError } from "@veyyon/utils/fetch-retry";
import { stringifyJson } from "@veyyon/utils/json";
import * as logger from "@veyyon/utils/logger";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import {
	type Api,
	type AssistantMessage,
	type CacheRetention,
	type Context,
	type DeveloperMessage,
	type ImageContent,
	type Message,
	type MessageAttribution,
	type Model,
	OPENAI_MAX_OUTPUT_TOKENS,
	type ServiceTier,
	type StreamOptions,
	shouldSendServiceTier,
	type TextContent,
	type TextSignatureV1,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
	type UserMessage,
} from "../types";
import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeResponsesToolCallId,
	normalizeSystemPrompts,
	resolveCacheRetention,
	sanitizeOpenAIResponsesAssistantFallbackItemsForReplay,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "../utils";
import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import { getOpenCodeHeaders, isOpenCodeProvider } from "../utils/opencode-headers";
import { getOpenRouterHeaders } from "../utils/openrouter-headers";
import { isForcedToolChoice } from "../utils/tool-choice";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import type { ChatCompletionCreateParamsStreaming } from "./openai-chat-wire";
import type { InputItem } from "./openai-codex/request-transformer";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "./openai-responses-wire";
import { normalizeOpenAIPromptCacheKey, normalizeOpenRouterResponsesSessionId } from "./openai-stable-ids";
import { staleToolResultNote, transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, NON_VISION_IMAGE_PLACEHOLDER, partitionVisionContent } from "./vision-guard";

// `openai-compaction.ts` is byte-locked (`scripts/the-codex-compaction-route-is-locked.test.ts`) and imports
// this name from here.
export { parseAzureDeploymentNameMap } from "./azure-deployment-names";

export interface OpenAIModelIdentity {
	provider: string;
	id: string;
	baseUrl?: string;
}

export interface OpenAIStrictToolsScope {
	provider: string;
	baseUrl: string | undefined;
	modelId: string;
}

export interface OpenAIStrictToolsState {
	strictTools: {
		disabledModelScopes: Set<string>;
	};
}

/** The forms of `tool_choice` an endpoint may reject independently: `auto`, `none`, and a forced choice. */
export type OpenAIToolChoiceKind = "auto" | "none" | "forced";

/** The `tool_choice` forms each model scope rejected this session. A rejected form is left out of later requests. */
export interface OpenAIToolChoiceState {
	toolChoice: {
		rejectedKindsByScope: Map<string, Set<OpenAIToolChoiceKind>>;
	};
}

export interface OpenAIRequestSetupModel extends OpenAIModelIdentity {
	headers?: Record<string, string>;
	premiumMultiplier?: number;
	compat?: Pick<ResolvedOpenAISharedCompat, "promptCacheSessionHeader">;
}

/** Cache identity controls shared by OpenAI-family transports. */
export interface OpenAICacheOptions {
	cacheRetention?: CacheRetention;
	sessionId?: string;
	promptCacheKey?: string;
}

export interface OpenAIRequestSetupOptions {
	apiKey?: string;
	extraHeaders?: Record<string, string>;
	initiatorOverride?: MessageAttribution;
	messages: Message[];
	defaultBaseUrl?: string;
	prependHeaders?: () => Record<string, string>;
	alibabaCodingPlanAuth?: boolean;
	azureChatCompletions?: {
		apiVersion: string;
		deploymentName: string;
	};
	openAISessionId?: string;
	promptCacheSessionId?: string;
	/**
	 * The conversation this request belongs to, for the OpenCode session header.
	 * Distinct from the two above, which are withheld once cache retention is
	 * "none", and from the routing session id, which a side-channel turn makes
	 * unique per request while keeping the conversation's prompt-cache key.
	 */
	conversationId?: string;
}

export interface OpenAIRequestSetup {
	copilotPremiumRequests: number | undefined;
	baseUrl: string | undefined;
	headers: Record<string, string>;
	query: Record<string, string> | undefined;
	requestHeaders: Record<string, string>;
}

function normalizeSakanaRequestBaseUrl(baseUrl: string | undefined): string | undefined {
	const value = baseUrl?.trim();
	if (!value) return undefined;
	const normalized = trimTrailingSlashes(value);
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function resolveSakanaRequestBaseUrl(): string | undefined {
	return normalizeSakanaRequestBaseUrl($env.SAKANA_BASE_URL) ?? normalizeSakanaRequestBaseUrl($env.FUGU_BASE_URL);
}

function applyCoreWeaveProjectHeader(headers: Record<string, string>): void {
	removeBlankCoreWeaveProjectHeaders(headers);
	if (hasCoreWeaveProjectHeader(headers)) {
		return;
	}
	const projectHeaders = coreWeaveProjectHeaders($env);
	if (projectHeaders) {
		headers[COREWEAVE_PROJECT_HEADER] = projectHeaders[COREWEAVE_PROJECT_HEADER];
	}
}

function setHeaderIfAbsent(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() === normalizedName) return;
	}
	headers[name] = value;
}

function requireOpenAIApiKey(apiKey: string | undefined): string {
	if (apiKey) return apiKey;
	if (!$env.OPENAI_API_KEY) {
		throw new AIError.MissingApiKeyError(
			undefined,
			"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
		);
	}
	return $env.OPENAI_API_KEY;
}

/** Catalog headers, provider routing headers and caller headers, in that order of precedence. */
function buildOpenAIRequestHeaders(
	model: OpenAIRequestSetupModel,
	options: OpenAIRequestSetupOptions,
): Record<string, string> {
	const headers = { ...(model.headers ?? {}) };
	if (model.provider === "openrouter") {
		Object.assign(headers, getOpenRouterHeaders());
	}
	if (isOpenCodeProvider(model.provider)) {
		// Set only when absent, so `model.headers` above and `extraHeaders` below
		// both still win. Keyed on the raw conversation id rather than the
		// prompt-cache key, so a session that disables caching still routes to one
		// upstream provider, and so both transport families derive the same value
		// for the same conversation.
		for (const [name, value] of Object.entries(
			getOpenCodeHeaders(options.conversationId ?? options.promptCacheSessionId ?? options.openAISessionId),
		)) {
			setHeaderIfAbsent(headers, name, value);
		}
	}
	Object.assign(headers, options.extraHeaders);
	if (model.provider === "coreweave") {
		applyCoreWeaveProjectHeader(headers);
	}
	return options.prependHeaders ? { ...options.prependHeaders(), ...headers } : headers;
}

/** The credential and endpoint a request authenticates with after provider-specific rewriting. */
interface OpenAIProviderEndpoint {
	apiKey: string;
	baseUrl: string | undefined;
	copilotPremiumRequests?: number;
}

/** An Alibaba Coding Plan key may be JSON naming the token and an enterprise endpoint. */
function resolveAlibabaCodingPlanEndpoint(rawApiKey: string, baseUrl: string | undefined): OpenAIProviderEndpoint {
	let parsed: { token?: unknown; enterpriseUrl?: unknown } | null;
	try {
		parsed = JSON.parse(rawApiKey);
	} catch {
		// Not JSON: the raw key and the catalog base URL stand.
		return { apiKey: rawApiKey, baseUrl };
	}
	return {
		apiKey: typeof parsed?.token === "string" ? parsed.token : rawApiKey,
		baseUrl: typeof parsed?.enterpriseUrl === "string" ? parsed.enterpriseUrl : baseUrl,
	};
}

/**
 * Rewrite the key and base URL for providers that derive them from the
 * environment or from the stored key. GitHub Copilot also merges its dynamic
 * headers into `headers`.
 */
function resolveOpenAIProviderEndpoint(
	model: OpenAIRequestSetupModel,
	options: OpenAIRequestSetupOptions,
	headers: Record<string, string>,
	rawApiKey: string,
): OpenAIProviderEndpoint {
	switch (model.provider) {
		case "moonshot":
			// Bundled `moonshot` catalog models hardcode the international endpoint
			// (`api.moonshot.ai`). MOONSHOT_BASE_URL lets users redirect the provider
			// at the China platform (`api.moonshot.cn`), which only accepts China keys
			// and rejects the international host. (#2883)
			return { apiKey: rawApiKey, baseUrl: $env.MOONSHOT_BASE_URL?.trim() || model.baseUrl };
		case "sakana":
			return { apiKey: rawApiKey, baseUrl: resolveSakanaRequestBaseUrl() ?? model.baseUrl };
		case "github-copilot": {
			const apiKey = parseGitHubCopilotApiKey(rawApiKey).accessToken;
			const copilot = buildCopilotDynamicHeaders({
				messages: options.messages,
				hasImages: hasCopilotVisionInput(options.messages),
				premiumMultiplier: model.premiumMultiplier,
				headers,
				initiatorOverride: options.initiatorOverride,
			});
			Object.assign(headers, copilot.headers);
			return {
				apiKey,
				baseUrl: resolveGitHubCopilotBaseUrl(model.baseUrl, rawApiKey) ?? model.baseUrl,
				copilotPremiumRequests: copilot.premiumRequests,
			};
		}
		case "alibaba-coding-plan":
			if (options.alibabaCodingPlanAuth) return resolveAlibabaCodingPlanEndpoint(rawApiKey, model.baseUrl);
			break;
		case "kimi-code": {
			// The key names the deployment that issued the token; a token reaches only that deployment.
			const { apiKey, baseUrl } = resolveKimiCodeEndpoint(rawApiKey, model.baseUrl);
			return { apiKey, baseUrl };
		}
		case "opencode-go": {
			// A Console login token reaches only its organization's endpoint, named in the key.
			const { apiKey, baseUrl, orgId } = resolveOpenCodeGoEndpoint(rawApiKey, model.baseUrl, "openai");
			if (orgId !== undefined) headers[OPENCODE_GO_ORG_HEADER] = orgId;
			return { apiKey, baseUrl };
		}
	}
	return { apiKey: rawApiKey, baseUrl: model.baseUrl };
}

function applyOpenAISessionHeaders(
	headers: Record<string, string>,
	model: OpenAIRequestSetupModel,
	options: OpenAIRequestSetupOptions,
): void {
	if (options.openAISessionId && model.provider === "openai") {
		setHeaderIfAbsent(headers, "session_id", options.openAISessionId);
		setHeaderIfAbsent(headers, "x-client-request-id", options.openAISessionId);
	}
	if (options.promptCacheSessionId && model.compat?.promptCacheSessionHeader) {
		setHeaderIfAbsent(headers, model.compat.promptCacheSessionHeader, options.promptCacheSessionId);
	}
}

export function resolveOpenAIRequestSetup(
	model: OpenAIRequestSetupModel,
	options: OpenAIRequestSetupOptions,
): OpenAIRequestSetup {
	const rawApiKey = requireOpenAIApiKey(options.apiKey);
	const headers = buildOpenAIRequestHeaders(model, options);
	const endpoint = resolveOpenAIProviderEndpoint(model, options, headers, rawApiKey);
	let baseUrl = endpoint.baseUrl;
	let query: Record<string, string> | undefined;
	if (options.azureChatCompletions && baseUrl?.includes(".openai.azure.com")) {
		if (!baseUrl.includes("/deployments/")) {
			baseUrl = `${baseUrl}/deployments/${options.azureChatCompletions.deploymentName}`;
		}
		query = { "api-version": options.azureChatCompletions.apiVersion };
	}
	applyOpenAISessionHeaders(headers, model, options);
	if (options.defaultBaseUrl !== undefined) {
		baseUrl = baseUrl ?? ($env.OPENAI_BASE_URL?.trim() || options.defaultBaseUrl);
	}
	const requestHeaders = { ...headers };
	headers.Authorization ??= `Bearer ${endpoint.apiKey}`;
	return { copilotPremiumRequests: endpoint.copilotPremiumRequests, baseUrl, headers, query, requestHeaders };
}

export function applyOpenAIServiceTier(
	params: { service_tier?: ServiceTier | null | undefined },
	serviceTier: ServiceTier | null | undefined,
	model: Pick<Model, "provider" | "api" | "id">,
): void {
	if (!shouldSendServiceTier(serviceTier, model)) return;
	if (serviceTier === "flex" || serviceTier === "scale" || serviceTier === "priority") {
		params.service_tier = serviceTier;
	}
}

/**
 * Standard OpenAI Responses service-tier cost multipliers. The non-Codex
 * Responses path bills the tier it was served (or requested): Flex processing is
 * half price; Priority is a 2x premium. Codex bills the same tiers with its own
 * table (Priority is 2.5x on gpt-5.5) and applies that separately.
 */
function getOpenAIResponsesServiceTierCostMultiplier(tier: string | null | undefined): number {
	switch (tier) {
		case "flex":
			return 0.5;
		case "priority":
			return 2;
		default:
			return 1;
	}
}

/**
 * Adjust resolved cost by the service tier OpenAI actually billed — parity with
 * Codex (`applyCodexServiceTierPricing`), but with the standard (non-Codex)
 * multipliers. The served tier comes from the response echo, falling back to the
 * resolved request tier. Scoped to `provider: "openai"` (the only standard
 * Responses biller) so an echoed `service_tier` from an Azure/OpenRouter/Copilot
 * proxy can never skew those costs.
 */
export function applyOpenAIResponsesServiceTierCost(
	model: Pick<Model, "provider">,
	usage: AssistantMessage["usage"],
	responseServiceTier: unknown,
	requestServiceTier: ServiceTier | null | undefined,
): void {
	if (model.provider !== "openai") return;
	// The response echo is authoritative when present (OpenAI may downgrade a
	// requested priority/flex turn to default under load); only fall back to the
	// requested tier when the response omits the echo entirely.
	const served = typeof responseServiceTier === "string" ? responseServiceTier : (requestServiceTier ?? undefined);
	const multiplier = getOpenAIResponsesServiceTierCostMultiplier(served);
	scaleUsageCost(usage, multiplier);
}

export interface OpenAIUsageAccountingInput {
	promptTokens: number;
	outputTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cacheWriteOpenRouter: number | undefined;
	cacheWriteDeepSeek: number | undefined;
	hasDeepSeekCacheHitAndMiss: boolean;
}

export interface OpenAIUsageAccounting {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoningTokens?: number;
	orchestration?: Usage["orchestration"];
}

export function calculateOpenAIUsageAccounting(accounting: OpenAIUsageAccountingInput): OpenAIUsageAccounting {
	const cacheWriteTokens = accounting.cacheWriteOpenRouter ?? accounting.cacheWriteDeepSeek ?? 0;
	const isDeepSeekUsage =
		accounting.hasDeepSeekCacheHitAndMiss &&
		accounting.cacheWriteOpenRouter === undefined &&
		(accounting.cacheWriteDeepSeek ?? 0) > 0;
	const input = isDeepSeekUsage
		? Math.max(0, accounting.promptTokens - accounting.cachedTokens)
		: Math.max(0, accounting.promptTokens - accounting.cachedTokens - cacheWriteTokens);
	const cacheWrite = isDeepSeekUsage ? 0 : cacheWriteTokens;
	return {
		input,
		output: accounting.outputTokens,
		cacheRead: accounting.cachedTokens,
		cacheWrite,
		totalTokens: input + accounting.outputTokens + accounting.cachedTokens + cacheWrite,
		...(accounting.reasoningTokens > 0 ? { reasoningTokens: accounting.reasoningTokens } : {}),
	};
}

/** Resolve a prompt-cache identity, falling back to the provider session unless caching is disabled. */
export function getOpenAIPromptCacheKey(options: OpenAICacheOptions | undefined): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}

export function getOpenAIResponsesRoutingSessionId(
	options: Pick<OpenAICacheOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIPromptCacheKey(options?.sessionId);
}

export function getOpenRouterResponsesSessionId(
	options: Pick<OpenAICacheOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenRouterResponsesSessionId(options?.sessionId);
}

export function createOpenAIStrictToolsState(): OpenAIStrictToolsState {
	return {
		strictTools: {
			disabledModelScopes: new Set<string>(),
		},
	};
}

export function clearOpenAIStrictToolsState(state: OpenAIStrictToolsState): void {
	state.strictTools.disabledModelScopes.clear();
}

export function getOpenAIStrictToolsScope(
	model: OpenAIModelIdentity,
	resolvedBaseUrl: string | undefined,
): OpenAIStrictToolsScope {
	return {
		provider: model.provider,
		baseUrl: resolvedBaseUrl ?? model.baseUrl,
		modelId: model.id,
	};
}

/** The key a per-model session memory is stored under: one entry per provider, base URL and model. */
function modelScopeKey(scope: OpenAIStrictToolsScope): string {
	return `${scope.provider}:${scope.baseUrl ?? ""}:${scope.modelId}`;
}

export function isStrictToolsDisabledForScope(
	state: OpenAIStrictToolsState | undefined,
	scope: OpenAIStrictToolsScope | undefined,
): boolean {
	if (!scope) return false;
	return state?.strictTools.disabledModelScopes.has(modelScopeKey(scope)) ?? false;
}

export function disableStrictToolsForScope(
	state: OpenAIStrictToolsState | undefined,
	scope: OpenAIStrictToolsScope | undefined,
): void {
	if (!scope) return;
	state?.strictTools.disabledModelScopes.add(modelScopeKey(scope));
}

export function createOpenAIToolChoiceState(): OpenAIToolChoiceState {
	return { toolChoice: { rejectedKindsByScope: new Map() } };
}

export function clearOpenAIToolChoiceState(state: OpenAIToolChoiceState): void {
	state.toolChoice.rejectedKindsByScope.clear();
}

/** The form of a wire `tool_choice`, or `undefined` when the request names none. */
export function openAIToolChoiceKind(choice: unknown): OpenAIToolChoiceKind | undefined {
	if (choice === undefined || choice === null) return undefined;
	if (choice === "auto" || choice === "none") return choice;
	return "forced";
}

/** Whether this model scope rejected the form of `choice` earlier in the session. */
export function isToolChoiceRejectedForScope(
	state: OpenAIToolChoiceState,
	scope: OpenAIStrictToolsScope,
	choice: unknown,
): boolean {
	const kind = openAIToolChoiceKind(choice);
	return kind !== undefined && (state.toolChoice.rejectedKindsByScope.get(modelScopeKey(scope))?.has(kind) ?? false);
}

/** Records that this model scope rejected the form of `choice`, so later requests leave it out. */
export function rejectToolChoiceForScope(
	state: OpenAIToolChoiceState,
	scope: OpenAIStrictToolsScope,
	choice: unknown,
): void {
	const kind = openAIToolChoiceKind(choice);
	if (kind === undefined) return;
	const key = modelScopeKey(scope);
	const kinds = state.toolChoice.rejectedKindsByScope.get(key);
	if (kinds) kinds.add(kind);
	else state.toolChoice.rejectedKindsByScope.set(key, new Set([kind]));
}

export function isOpenRouterAnthropicModel(model: OpenAIModelIdentity): boolean {
	return model.provider === "openrouter" && model.id.toLowerCase().startsWith("anthropic/");
}

/**
 * Append an OpenRouter routing-variant suffix (e.g. `:nitro`, `:floor`, `:online`, `:exacto`)
 * to a model id when no explicit variant is already present. A variant is considered
 * "already present" when `modelId` contains a colon after the last `/` separator —
 * which covers both user-typed selectors (`anthropic/claude-haiku:nitro`) and catalog
 * entries that bake the variant in (`deepseek/deepseek-v3.1-terminus:exacto`).
 */
export function applyOpenRouterRoutingVariant(modelId: string, variant: string | undefined): string {
	if (!variant) return modelId;
	const lastSlash = modelId.lastIndexOf("/");
	const lastColon = modelId.lastIndexOf(":");
	if (lastColon > lastSlash) return modelId;
	return `${modelId}:${variant}`;
}

export function applyWireModelIdTransform(
	baseId: string,
	mode: ResolvedOpenAISharedCompat["wireModelIdMode"],
	openrouterVariant?: string,
): string {
	switch (mode) {
		case "firepass":
			return toFirepassWireModelId(baseId);
		case "fireworks":
			return toFireworksWireModelId(baseId);
		case "openrouter":
			return applyOpenRouterRoutingVariant(baseId, openrouterVariant);
		default:
			return baseId;
	}
}

export interface OpenAIOutputTokenParam {
	field: "max_tokens" | "max_completion_tokens" | "max_output_tokens";
	value: number;
}

export interface ResolveOpenAIOutputTokenInput {
	/** Wire field the endpoint expects for the output cap. */
	field: OpenAIOutputTokenParam["field"];
	/** Caller-supplied output cap (model-defaulted by `stream.ts`, or null/undefined on direct provider calls). */
	maxTokens: number | null | undefined;
	/** Whether the caller explicitly set `maxTokens` (routing omission only applies when false). */
	maxTokensExplicit: boolean;
	/** Model output cap (`model.maxTokens`). */
	modelMaxTokens: number | null | undefined;
	/** Drop the field entirely — proxies with unknown upstream caps (Ollama via `model.omitMaxOutputTokens`). */
	omitMaxOutputTokens: boolean;
	/** The model sits behind a multi-upstream router (OpenRouter, HF Inference router); catalog default caps are omitted so each upstream self-caps. */
	routedUpstreamSelfCaps: boolean;
	/** Endpoint always needs a cap (Kimi-family TPM math); supplies the model default when the caller did not. */
	alwaysSendMaxTokens: boolean;
	/** Hard provider clamp; defaults to {@link OPENAI_MAX_OUTPUT_TOKENS}. */
	providerOutputClamp?: number;
}

/**
 * Resolve the single output-token wire parameter shared by Chat Completions
 * (`max_tokens`/`max_completion_tokens`) and the Responses family
 * (`max_output_tokens`). Centralizes the provider exceptions that previously
 * lived inline in both `buildParams`:
 *  - `alwaysSendMaxTokens`: Kimi-family endpoints derive TPM limits from the
 *    cap and require one on every call, so default from the model cap (or
 *    {@link OPENAI_MAX_OUTPUT_TOKENS}) when the caller omitted it.
 *  - `routedUpstreamSelfCaps` omission: multi-upstream routers (OpenRouter,
 *    the HF Inference Providers router) fan out to upstreams whose output caps
 *    differ from the catalog value, so a catalog default above the routed
 *    upstream's cap makes OpenRouter skip that upstream or the HF router 400
 *    ("max_tokens exceeds maximum"). Omit catalog defaults (explicit caller
 *    caps still win) so routing and per-upstream caps are honored.
 *  - model/provider clamp: never exceed `model.maxTokens` or the provider clamp
 *    (`OPENAI_MAX_OUTPUT_TOKENS`, raised for GLM-5.2 reasoning by the caller).
 *  - `omitMaxOutputTokens`: proxies (Ollama) with unknown upstream caps drop it.
 */
export function resolveOpenAIOutputTokenParam(
	input: ResolveOpenAIOutputTokenInput,
): OpenAIOutputTokenParam | undefined {
	if (input.omitMaxOutputTokens) return undefined;
	const requested =
		input.maxTokens ?? (input.alwaysSendMaxTokens ? (input.modelMaxTokens ?? OPENAI_MAX_OUTPUT_TOKENS) : undefined);
	if (requested === undefined) return undefined;
	if (input.routedUpstreamSelfCaps && !input.alwaysSendMaxTokens && !input.maxTokensExplicit) return undefined;
	const value = Math.min(
		requested,
		input.modelMaxTokens ?? Number.POSITIVE_INFINITY,
		input.providerOutputClamp ?? OPENAI_MAX_OUTPUT_TOKENS,
	);
	if (!(value > 0)) return undefined;
	return { field: input.field, value };
}

export interface OpenAIGatewayRoutingParams {
	provider?: OpenRouterRouting;
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
}

export interface OpenAIGatewayRoutingCompat {
	isOpenRouterHost: boolean;
	openRouterRouting?: OpenRouterRouting;
	isVercelGatewayHost?: boolean;
	vercelGatewayRouting?: VercelGatewayRouting;
}

/**
 * Apply gateway routing preferences to the request body. OpenRouter routes via
 * the top-level `provider` field; the Vercel AI Gateway routes via
 * `providerOptions.gateway`. Both Chat Completions and Responses call this; the
 * Vercel branch is inert for Responses, whose resolved compat never sets
 * `isVercelGatewayHost`.
 */
export function applyOpenAIGatewayRouting(
	params: OpenAIGatewayRoutingParams,
	compat: OpenAIGatewayRoutingCompat,
): void {
	if (compat.isOpenRouterHost && compat.openRouterRouting) {
		params.provider = compat.openRouterRouting;
	}
	if (compat.isVercelGatewayHost && compat.vercelGatewayRouting) {
		const routing = compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: { only?: string[]; order?: string[] } = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			params.providerOptions = { gateway: gatewayOptions };
		}
	}
}

export interface OpenAIExtraBodyOptions {
	/**
	 * Fireworks rejects DeepSeek-style `thinking` toggles alongside OpenAI-style
	 * `reasoning_effort`; drop `thinking` when the effort field carries the level.
	 */
	dropThinkingWhenReasoningEffort?: boolean;
}

/**
 * Merge a compat/options `extraBody` blob into the request params. When
 * `dropThinkingWhenReasoningEffort` is set and `reasoning_effort` is present,
 * delete the conflicting `thinking` toggle (Fireworks rejects both together).
 */
export function applyOpenAIExtraBody<P extends object>(
	params: P,
	extraBody: Record<string, unknown> | undefined,
	options?: OpenAIExtraBodyOptions,
): void {
	if (!extraBody) return;
	Object.assign(params, extraBody);
	if (options?.dropThinkingWhenReasoningEffort) {
		const shaped = params as { reasoning_effort?: unknown; thinking?: unknown };
		if (shaped.reasoning_effort !== undefined) {
			delete shaped.thinking;
		}
	}
}

/**
 * Chat Completions streaming request body shaped by the OpenAI-family providers.
 * Extends the vendored SDK params with the compat dialect fields pi-ai emits
 * (binary `thinking`, Qwen `enable_thinking`/`chat_template_kwargs`, nested
 * `reasoning`, gateway `provider`/`providerOptions`, sampling extras). Lives in
 * the shared module beside the request-shaping helpers that mutate it.
 */
export type OpenAICompletionsParams = Omit<ChatCompletionCreateParamsStreaming, "reasoning_effort" | "service_tier"> & {
	top_k?: number;
	min_p?: number;
	repetition_penalty?: number;
	thinking?: { type: "enabled" | "disabled"; keep?: "all" };
	enable_thinking?: boolean;
	preserve_thinking?: boolean;
	chat_template_kwargs?: { enable_thinking?: boolean; preserve_thinking?: boolean };
	reasoning?: { effort?: string } | { enabled: false };
	reasoning_effort?: string | null;
	service_tier?: ServiceTier;
	tool_stream?: boolean;
	provider?: OpenAICompat["openRouterRouting"];
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
};

/** Reasoning-relevant slice of caller options the Chat Completions dialect dispatch reads. */
export interface ChatCompletionsReasoningOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	disableReasoning?: boolean;
}

export type OpenAICompatEndpoint = "chat-completions" | "responses";

export type OpenAIReasoningDisableReason = "caller" | "forced-tool-choice" | "tool-choice" | "not-requested";

export type OpenAICompatPolicyCompat = ResolvedOpenAISharedCompat &
	Partial<ResolvedOpenAICompat> &
	Partial<ResolvedOpenAIResponsesCompat>;

export interface ResolveOpenAICompatPolicyOptions {
	endpoint: OpenAICompatEndpoint;
	compat?: OpenAICompatPolicyCompat;
	reasoning?: string;
	disableReasoning?: boolean;
	toolChoice?: unknown;
	strictResponsesPairing?: boolean;
	includeEncryptedReasoning?: boolean;
	filterReasoningHistory?: boolean;
	omitReasoningEffort?: boolean;
}

export interface OpenAICompatPolicy {
	endpoint: OpenAICompatEndpoint;
	compat: OpenAICompatPolicyCompat;
	reasoning: {
		modelSupported: boolean;
		supportsParams: boolean;
		requestedEffort?: string;
		wireEffort?: string;
		enabled: boolean;
		disabled: boolean;
		disableReason?: OpenAIReasoningDisableReason;
		dialect: ResolvedOpenAISharedCompat["thinkingFormat"];
		disableMode: OpenAIReasoningDisableMode;
		omitReasoningEffort: boolean;
		includeEncryptedReasoning: boolean;
		filterReasoningHistory: boolean;
		requiresReasoningContentForToolCalls: boolean;
		requiresReasoningContentForAllAssistantTurns: boolean;
		allowsSyntheticReasoningContentForToolCalls: boolean;
		reasoningContentField?: OpenAICompat["reasoningContentField"];
		requiresThinkingAsText: boolean;
	};
	tools: {
		strictResponsesPairing: boolean;
		toolCallIdKind: "default" | "openai-40" | "mistral-9-alnum";
	};
	messages: {
		systemRole: "system" | "developer";
		supportsDeveloperRole: boolean;
		supportsMultipleSystemMessages: boolean;
	};
	stream: {
		stripSpecialTokens: "deepseek" | false;
		markupHealingPattern?: OpenAIStreamMarkupHealingPattern;
		reasoningDeltasMayBeCumulative: boolean;
		emptyLengthFinishIsContextError: boolean;
	};
}

/**
 * Map a user-facing effort to the provider wire value: explicit compat
 * override first, then the model's baked `thinking.effortMap`, else identity.
 * Shared by the chat-completions/Responses policy resolver and the Codex
 * request transformer.
 */
export function mapOpenAIReasoningEffort(
	model: Pick<Model, "thinking">,
	compat: { reasoningEffortMap?: Partial<Record<Effort, string>> } | undefined,
	effort: string,
): string {
	const level = effort as Effort;
	return compat?.reasoningEffortMap?.[level] ?? model.thinking?.effortMap?.[level] ?? effort;
}

function isImplicitDisableWhenNotRequested(disableMode: OpenAIReasoningDisableMode): boolean {
	return (
		disableMode === "zai-thinking-disabled" ||
		disableMode === "qwen-enable-thinking-false" ||
		disableMode === "qwen-template-false"
	);
}

/** Why the request's tool choice turns reasoning off, if it does. */
function reasoningToolChoiceConflict(
	compat: OpenAICompatPolicyCompat,
	toolChoice: unknown,
): OpenAIReasoningDisableReason | undefined {
	if (compat.disableReasoningOnForcedToolChoice && compat.supportsForcedToolChoice && isForcedToolChoice(toolChoice)) {
		return "forced-tool-choice";
	}
	return compat.disableReasoningOnToolChoice && toolChoice !== undefined ? "tool-choice" : undefined;
}

interface RequestedReasoning {
	/** `whenThinking` when reasoning is on and the model declares one, else the base compat. */
	compat: OpenAICompatPolicyCompat;
	enabled: boolean;
	/** Z.ai maps a requested effort to `none`, its switch for no reasoning. */
	disabledByNoneEffort: boolean;
	wireEffort: string | undefined;
}

function resolveRequestedReasoning<TApi extends Api>(
	model: Model<TApi>,
	baseCompat: OpenAICompatPolicyCompat,
	effort: string | undefined,
	blocked: boolean,
): RequestedReasoning {
	if (effort === undefined || !model.reasoning || blocked) {
		return { compat: baseCompat, enabled: false, disabledByNoneEffort: false, wireEffort: undefined };
	}
	if (
		baseCompat.reasoningDisableMode === "zai-thinking-disabled" &&
		mapOpenAIReasoningEffort(model, baseCompat, effort) === "none"
	) {
		return { compat: baseCompat, enabled: false, disabledByNoneEffort: true, wireEffort: undefined };
	}
	const compat = (baseCompat.whenThinking as OpenAICompatPolicyCompat | undefined) ?? baseCompat;
	return {
		compat,
		enabled: true,
		disabledByNoneEffort: false,
		wireEffort: mapOpenAIReasoningEffort(model, compat, effort),
	};
}

/**
 * The effort sent when the caller turns reasoning off on a `lowest-effort`
 * host. `lowest-effort` means the host cannot be told to stop reasoning, so
 * the floor tier stands in for off. A model that publishes no tiers has no
 * floor to pin, and the request still has to go out: send no
 * `reasoning_effort` and let the model manage its own reasoning, rather than
 * fail a turn that asked to turn thinking off on a model with no effort dial.
 */
function lowestEffortStandIn<TApi extends Api>(
	model: Model<TApi>,
	compat: OpenAICompatPolicyCompat,
	omitReasoningEffort: boolean,
): string | undefined {
	if (compat.reasoningDisableMode !== "lowest-effort" || !compat.supportsReasoningEffort || omitReasoningEffort) {
		return undefined;
	}
	const minEffort = getSupportedEfforts(model)[0];
	return minEffort === undefined ? undefined : mapOpenAIReasoningEffort(model, compat, minEffort);
}

function resolveOpenAIReasoningPolicy<TApi extends Api>(
	model: Model<TApi>,
	baseCompat: OpenAICompatPolicyCompat,
	options: ResolveOpenAICompatPolicyOptions,
): Pick<OpenAICompatPolicy, "compat" | "reasoning"> {
	const requestedEffort = options.reasoning;
	const modelSupported = Boolean(model.reasoning);
	const conflictDisableReason = reasoningToolChoiceConflict(baseCompat, options.toolChoice);
	const disableReason = options.disableReasoning ? "caller" : conflictDisableReason;
	const requested = resolveRequestedReasoning(model, baseCompat, requestedEffort, disableReason !== undefined);
	const compat = requested.compat;
	const omitReasoningEffort =
		options.omitReasoningEffort ?? (compat.omitReasoningEffort || !compat.supportsReasoningEffort);
	const disableMode = compat.reasoningDisableMode;
	const disabledWithoutRequest =
		modelSupported &&
		requestedEffort === undefined &&
		!options.disableReasoning &&
		isImplicitDisableWhenNotRequested(disableMode);
	const disabled =
		(modelSupported && disableReason === "caller") ||
		conflictDisableReason !== undefined ||
		disabledWithoutRequest ||
		requested.disabledByNoneEffort;
	const callerTurnedOffUnrequested = disabled && disableReason === "caller" && requestedEffort === undefined;
	return {
		compat,
		reasoning: {
			modelSupported,
			supportsParams: compat.supportsReasoningParams,
			requestedEffort,
			wireEffort: callerTurnedOffUnrequested
				? lowestEffortStandIn(model, compat, omitReasoningEffort)
				: requested.wireEffort,
			enabled: requested.enabled,
			disabled,
			disableReason:
				disableReason ?? (disabledWithoutRequest || requested.disabledByNoneEffort ? "not-requested" : undefined),
			dialect: compat.thinkingFormat,
			requiresReasoningContentForToolCalls: compat.requiresReasoningContentForToolCalls,
			requiresReasoningContentForAllAssistantTurns: compat.requiresReasoningContentForAllAssistantTurns,
			allowsSyntheticReasoningContentForToolCalls: compat.allowsSyntheticReasoningContentForToolCalls,
			reasoningContentField: compat.reasoningContentField,
			requiresThinkingAsText: compat.requiresThinkingAsText,
			disableMode,
			omitReasoningEffort,
			includeEncryptedReasoning: options.includeEncryptedReasoning ?? compat.includeEncryptedReasoning,
			filterReasoningHistory: options.filterReasoningHistory ?? compat.filterReasoningHistory,
		},
	};
}

export function resolveOpenAICompatPolicy<TApi extends Api>(
	model: Model<TApi>,
	options: ResolveOpenAICompatPolicyOptions,
): OpenAICompatPolicy {
	const { compat, reasoning } = resolveOpenAIReasoningPolicy(
		model,
		(options.compat ?? model.compat) as OpenAICompatPolicyCompat,
		options,
	);
	return {
		endpoint: options.endpoint,
		compat,
		reasoning,
		tools: {
			strictResponsesPairing: options.strictResponsesPairing ?? compat.strictResponsesPairing ?? false,
			toolCallIdKind: compat.requiresMistralToolIds
				? "mistral-9-alnum"
				: compat.usesOpenAIToolCallIdLimit
					? "openai-40"
					: "default",
		},
		messages: {
			systemRole: reasoning.modelSupported && compat.supportsDeveloperRole ? "developer" : "system",
			supportsDeveloperRole: compat.supportsDeveloperRole,
			supportsMultipleSystemMessages: compat.supportsMultipleSystemMessages ?? true,
		},
		stream: {
			stripSpecialTokens: compat.stripDeepseekSpecialTokens ? "deepseek" : false,
			markupHealingPattern: compat.streamMarkupHealingPattern,
			reasoningDeltasMayBeCumulative: compat.reasoningDeltasMayBeCumulative,
			emptyLengthFinishIsContextError: compat.emptyLengthFinishIsContextError,
		},
	};
}

function encodeChatCompletionsDisabledReasoning(
	params: OpenAICompletionsParams,
	disableMode: OpenAIReasoningDisableMode,
): void {
	delete params.reasoning_effort;
	switch (disableMode) {
		case "zai-thinking-disabled":
			params.thinking = { type: "disabled" };
			break;
		case "qwen-enable-thinking-false":
			params.enable_thinking = false;
			break;
		case "qwen-template-false":
			params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: false };
			break;
		case "openrouter-enabled-false":
			(params as typeof params & { reasoning?: { effort?: string } | { enabled: false } }).reasoning = {
				enabled: false,
			};
			break;
		default:
			delete params.reasoning;
			break;
	}
}

/**
 * `preserve_thinking` is a chat-template HISTORY knob, not a per-turn
 * thinking switch — it controls whether OLDER assistant turns render
 * with `<think>...</think>` on Qwen3.6+. It is emitted before the reasoning
 * state branches and every early return in
 * {@link applyChatCompletionsCompatPolicy}, because the wire shape must carry
 * the kwarg in three cases the auto-detected `qwenPreserveThinking` flag
 * covers but `reasoning.enabled` does not:
 *
 * 1. Discovered local Qwen models. `discoverOpenAICompatibleModels`
 *    stamps `reasoning: false` on every spec built from a generic
 *    `/v1/models` endpoint (the upstream doesn't advertise the
 *    capability), so `model.reasoning === false` → `reasoning.enabled
 *    === false`, the body wouldn't otherwise see the kwarg, and the
 *    encoder's `replayReasoningContent` branch would keep shipping
 *    `reasoning_content` only for the template to strip `<think>` from
 *    older turns anyway. Exactly the #3528 / #3541 symptom on every
 *    discovered Qwen build.
 * 2. Caller-disabled reasoning. The slot's KV cache still holds prior
 *    `<think>...</think>` tokens from earlier thinking turns; the
 *    template must keep rendering them or cache invalidates at the
 *    first historic `<think>`.
 * 3. Forced-tool-choice / DeepSeek-style auto-disable. Same reasoning
 *    as (2) — historic thinking blocks have to survive history replay
 *    even when the current turn cannot think.
 *
 * Non-Qwen templates ignore the parameter (jinja `is defined` check
 * silently no-ops), so emitting it unconditionally for the Qwen-family
 * + local-cache compat flag is safe.
 */
function applyQwenPreserveThinking(params: OpenAICompletionsParams, compat: OpenAICompatPolicyCompat): void {
	if (!compat.qwenPreserveThinking) return;
	// Mirror the dialect split that gates `enable_thinking`. The
	// `qwen` dialect rides the top-level field (the only place
	// llama.cpp's `--jinja` hook AND Alibaba Cloud Model Studio's
	// compatible-mode look) while the `qwen-chat-template` dialect
	// (NVIDIA NIM, vLLM/SGLang's chat-template-kwargs path) MUST
	// ride only the kwargs copy — NIM's request schema is
	// `additionalProperties: false` and rejects every unknown
	// top-level field, the very reason `enable_thinking` is
	// route-split this way (#2299, see `catalog/src/compat/openai.ts`
	// thinkingFormat comment).
	if (compat.thinkingFormat === "qwen") {
		params.preserve_thinking = true;
	}
	params.chat_template_kwargs = { ...params.chat_template_kwargs, preserve_thinking: true };
}

/** The `zai` dialect's on switch: `thinking: {type: "enabled"}`, with the effort beside it where the host takes one. */
function encodeZaiEnabledThinking(params: OpenAICompletionsParams, policy: OpenAICompatPolicy): void {
	params.thinking = { type: "enabled" };
	if (policy.compat.thinkingKeep) params.thinking.keep = policy.compat.thinkingKeep;
	if (policy.compat.supportsReasoningEffort && policy.reasoning.wireEffort !== undefined) {
		params.reasoning_effort = policy.reasoning.wireEffort as Effort;
	}
}

function encodeChatCompletionsEnabledReasoning(params: OpenAICompletionsParams, policy: OpenAICompatPolicy): void {
	const reasoning = policy.reasoning;
	switch (reasoning.disableMode) {
		case "zai-thinking-disabled":
			if (reasoning.wireEffort === "none") {
				encodeChatCompletionsDisabledReasoning(params, reasoning.disableMode);
				return;
			}
			encodeZaiEnabledThinking(params, policy);
			break;
		case "omit":
			// A model with no off state still takes its dialect's on switch. Moonshot's always-thinking
			// Kimi rows get `thinking: {type: "enabled"}` beside the effort, as Kimi Code's client sends.
			if (policy.compat.thinkingFormat === "zai") {
				encodeZaiEnabledThinking(params, policy);
			} else if (!reasoning.omitReasoningEffort && reasoning.wireEffort !== undefined) {
				params.reasoning_effort = reasoning.wireEffort as Effort;
			}
			break;
		case "qwen-enable-thinking-false":
			params.enable_thinking = true;
			break;
		case "qwen-template-false":
			// Spread so the `preserve_thinking` kwarg set by
			// `applyQwenPreserveThinking` survives the merge — a bare
			// `{ enable_thinking: true }` would clobber it.
			params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: true };
			break;
		case "openrouter-enabled-false":
			if (reasoning.wireEffort !== undefined) {
				(params as typeof params & { reasoning?: { effort?: string } }).reasoning = {
					effort: reasoning.wireEffort,
				};
			}
			break;
		default:
			if (!reasoning.omitReasoningEffort && reasoning.wireEffort !== undefined) {
				params.reasoning_effort = reasoning.wireEffort as Effort;
			}
			break;
	}
}

export function applyChatCompletionsCompatPolicy(params: OpenAICompletionsParams, policy: OpenAICompatPolicy): void {
	applyQwenPreserveThinking(params, policy.compat);
	const reasoning = policy.reasoning;
	if ((!reasoning.modelSupported && !reasoning.disabled) || !reasoning.supportsParams) return;
	if (reasoning.enabled) {
		encodeChatCompletionsEnabledReasoning(params, policy);
		return;
	}
	if (!reasoning.disabled) return;
	if (
		reasoning.disableReason === "caller" &&
		reasoning.requestedEffort === undefined &&
		reasoning.disableMode === "lowest-effort" &&
		reasoning.wireEffort !== undefined
	) {
		params.reasoning_effort = reasoning.wireEffort as Effort;
		return;
	}
	encodeChatCompletionsDisabledReasoning(params, reasoning.disableMode);
}

export function applyChatCompletionsReasoningParams(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	options: (ChatCompletionsReasoningOptions & { toolChoice?: unknown }) | undefined,
): void {
	applyChatCompletionsCompatPolicy(
		params,
		resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			compat,
			reasoning: options?.reasoning,
			disableReasoning: options?.disableReasoning,
			toolChoice: options?.toolChoice,
		}),
	);
}

export function disableChatCompletionsReasoningForDialect(
	params: OpenAICompletionsParams,
	compat: ResolvedOpenAICompat,
): void {
	encodeChatCompletionsDisabledReasoning(params, compat.reasoningDisableMode);
}

/**
 * Z.AI/GLM-5.2 reasoning-effort dialect predicate. GLM-5.2 models served on a
 * Z.AI-format host (thinkingFormat "zai") accept `reasoning_effort`, stream tool
 * calls via `tool_stream`, and clamp output to the model cap. Moonshot Kimi and
 * Xiaomi MiMo also resolve to thinkingFormat "zai" with supportsReasoningEffort
 * true but are NOT GLM-5.2, so the model-id check is load-bearing — never swap it
 * for `compat.supportsReasoningEffort`.
 */
function isZaiReasoningEffortDialect(model: Model<"openai-completions">, compat: ResolvedOpenAICompat): boolean {
	return compat.thinkingFormat === "zai" && isGlm52ReasoningEffortModelId(model.id);
}

/**
 * Output-token clamp for the Z.AI/GLM-5.2 reasoning dialect: these hosts accept
 * the full model window on reasoning turns, so clamp to the model cap. Returns
 * `undefined` for every other model, leaving {@link resolveOpenAIOutputTokenParam}
 * on its default `OPENAI_MAX_OUTPUT_TOKENS` clamp.
 */
export function resolveZaiReasoningOutputClamp(
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): number | undefined {
	return isZaiReasoningEffortDialect(model, compat) ? (model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS) : undefined;
}

/**
 * Enable `tool_stream` for Z.AI/GLM-5.2 reasoning models when tools are present
 * (GLM-5.2 streams tool-call arguments incrementally and needs the flag to do so).
 */
export function applyChatCompletionsToolStream(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): void {
	if (
		isZaiReasoningEffortDialect(model, compat) &&
		compat.supportsReasoningEffort &&
		Array.isArray(params.tools) &&
		params.tools.length > 0
	) {
		params.tool_stream = true;
	}
}

/**
 * The sentence a rejection was stated in, wherever the provider put it.
 *
 * A captured body and an `Error.message` are two halves of one answer: some endpoints put the reason
 * in the envelope the SDK threw, some only in the body the request-inspector kept. Reading one half
 * is how a rejection goes unrecognised on one path and recognised on another.
 */
function rejectionText(error: unknown, capturedErrorResponse: CapturedHttpErrorResponse | undefined): string {
	return [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
}

/**
 * The narrow rejection a caller answers by dropping strict tools for the whole session, rather than
 * for one attempt. The words are the registry's; the status and the assembly are this path's.
 */
export function isCompiledGrammarTooLargeStrictError(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
): boolean {
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400) return false;
	return AIError.matchesCompiledGrammarTooLargeText(rejectionText(error, capturedErrorResponse));
}

/**
 * Whether this endpoint rejected the request for carrying strict tools.
 *
 * The vocabulary is `matchesStrictToolsRejectionText`, the grammar family's, and it used to be a
 * private regex here that answered the same question with different words: the registry read
 * `invalid_request_error` plus a grammar or schema complaint, this path read a wire-format code and a
 * `strict` value it could not mix, and each recognised rejections the other let through.
 */
export function shouldRetryWithoutStrictTools(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
	strictToolsApplied: boolean,
	tools: Tool[] | undefined,
): boolean {
	if (!tools || tools.length === 0 || !strictToolsApplied) return false;
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400 && status !== 422) return false;
	return AIError.matchesStrictToolsRejectionText(rejectionText(error, capturedErrorResponse));
}

/**
 * Whether this endpoint rejected the request for the `tool_choice` it carried.
 *
 * `sentChoice` is the value on the wire. A request that sent none cannot have been rejected for
 * one, which is what bounds the retry: the retried request leaves the rejected form out.
 */
export function isToolChoiceRejection(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
	sentChoice: unknown,
): boolean {
	if (openAIToolChoiceKind(sentChoice) === undefined) return false;
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400) return false;
	return AIError.matchesToolChoiceRejectionText(rejectionText(error, capturedErrorResponse));
}

export const OPENAI_RESPONSES_PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
	"response.created",
	"response.output_item.added",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_text.done",
	"response.reasoning_summary_part.done",
	"response.reasoning_text.delta",
	"response.content_part.added",
	"response.output_text.delta",
	"response.refusal.delta",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.custom_tool_call_input.delta",
	"response.custom_tool_call_input.done",
	"response.output_item.done",
	"response.completed",
	"response.incomplete",
	"response.failed",
	"error",
]);

export function isOpenAIResponsesProgressEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has(type);
}

export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

export function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export function encodeResponsesToolCallId(callId: string, itemId: string | null | undefined): string {
	const stableItemId = itemId && itemId.length > 0 ? itemId : `fc_${Bun.hash(callId).toString(36)}`;
	return `${callId}|${stableItemId}`;
}

export function normalizeResponsesToolCallIdForTransform(
	id: string,
	model?: Model<Api>,
	source?: AssistantMessage,
): string {
	if (!id.includes("|")) return id;
	const isForeignToolCall =
		source != null && model != null && (source.provider !== model.provider || source.api !== model.api);
	if (isForeignToolCall) {
		const [callId, itemId] = id.split("|");
		const normalizeIdPart = (part: string): string => {
			const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
			const truncated = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
			return truncated.replace(/_+$/, "");
		};
		const normalizedCallId = normalizeIdPart(callId);
		let normalizedItemId = `fc_${Bun.hash(itemId).toString(36)}`;
		if (normalizedItemId.length > 64) normalizedItemId = normalizedItemId.slice(0, 64);
		return `${normalizedCallId}|${normalizedItemId}`;
	}
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId}`;
}

/**
 * Adds the call ids that `items` issue to `knownCallIds`, and the ones issued as freeform custom tool calls to
 * `customCallIds`.
 */
function recordIssuedCallIds(items: ResponseInput, knownCallIds: Set<string>, customCallIds: Set<string>): void {
	for (const item of items) {
		if (item.type !== "function_call" && item.type !== "custom_tool_call") continue;
		// Replayed items come from a stored payload, so the declared string type is not enforced at run time.
		const callId: unknown = item.call_id;
		if (typeof callId !== "string") continue;
		knownCallIds.add(callId);
		if (item.type === "custom_tool_call") customCallIds.add(callId);
	}
}

/**
 * Placeholder output for a tool call whose result is absent from the input.
 * The model reads this text, so it has one owner: every Responses request
 * repairs an unpaired call through {@link repairResponsesToolPairs}.
 */
export const ORPHAN_TOOL_CALL_PLACEHOLDER =
	"[No tool output recorded: the tool call was interrupted before it produced a result.]";

/**
 * The fields {@link repairResponsesToolPairs} reads and writes, common to the Responses input and the Codex request
 * input.
 */
interface ResponsesToolPairItem {
	type?: string | null;
	role?: unknown;
	content?: unknown;
	call_id?: unknown;
	name?: unknown;
	output?: unknown;
}

const ORPHAN_OUTPUT_LIMIT = 16_000;

function isToolCallItemType(type: string | null | undefined): boolean {
	return type === "function_call" || type === "custom_tool_call";
}

function isToolOutputItemType(type: string | null | undefined): boolean {
	return type === "function_call_output" || type === "custom_tool_call_output";
}

/**
 * Repair both halves of unpaired tool exchanges so the Responses input grammar stays valid. The API rejects
 * either orphan with a 400.
 *
 * - A `function_call_output` / `custom_tool_call_output` whose `call_id` matches no `function_call` /
 *   `custom_tool_call` in the input (`400 No tool call found for function call output with call_id …`) becomes a
 *   user-role note. A previous turn's `providerPayload` snapshot can replace the input array via the `dt: false`
 *   splice (see {@link convertConversationMessages}), wiping the call while its output stays queued in a later
 *   `toolResult`; a locally rejected call (argument-validation failure, hook reject, a turn aborted before the call
 *   streamed) produces a result without a call in any persisted payload. Dropping the result loses what the model
 *   needs to recover, so the note keeps the call id and the truncated output. {@link staleToolResultNote} sets the
 *   envelope and the role, and states why the role is never `assistant` (#472, #1351).
 * - A `function_call` / `custom_tool_call` with no matching output (`400 No tool output found for function call …`)
 *   gets a placeholder output right after it. Branching the session tree to a node that ends on a tool call drops
 *   the result child, and a turn aborted after the call streamed never persists its result. The placeholder keeps
 *   the call visible so the model can re-issue it.
 *
 * Returns `input` itself when every call and output is paired.
 */
export function repairResponsesToolPairs<T extends ResponsesToolPairItem>(input: T[]): T[] {
	const callIds = new Set<string>();
	const outputCallIds = new Set<string>();
	for (const item of input) {
		// Replayed items come from a stored payload, so the declared string type is not enforced at run time.
		const callId = item.call_id;
		if (typeof callId !== "string") continue;
		if (isToolCallItemType(item.type)) callIds.add(callId);
		else if (isToolOutputItemType(item.type)) outputCallIds.add(callId);
	}
	const orphanOutputCallIds: string[] = [];
	for (const callId of outputCallIds) if (!callIds.has(callId)) orphanOutputCallIds.push(callId);
	let hasOrphanCall = false;
	for (const callId of callIds) {
		if (outputCallIds.has(callId)) continue;
		hasOrphanCall = true;
		break;
	}
	if (orphanOutputCallIds.length === 0 && !hasOrphanCall) return input;
	if (orphanOutputCallIds.length > 0) {
		// The fold is the only trace of how the pairing was lost. The reported occurrences (an imitated note in a
		// session with no compaction and every result paired in storage) cannot be diagnosed from the transcript alone.
		logger.warn("openai-responses: folding tool outputs whose call is missing from the request", {
			orphanCallIds: orphanOutputCallIds,
			knownCallIds: [...callIds],
			inputItems: input.length,
		});
	}
	const repaired: T[] = [];
	for (const item of input) {
		const callId = item.call_id;
		if (typeof callId !== "string") {
			repaired.push(item);
		} else if (isToolOutputItemType(item.type) && !callIds.has(callId)) {
			repaired.push(orphanToolOutputNote(item, callId));
		} else {
			repaired.push(item);
			if (isToolCallItemType(item.type) && !outputCallIds.has(callId)) {
				repaired.push({
					type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
					call_id: callId,
					output: ORPHAN_TOOL_CALL_PLACEHOLDER,
				} as T);
			}
		}
	}
	return repaired;
}

function orphanToolOutputNote<T extends ResponsesToolPairItem>(item: T, callId: string): T {
	const toolName = typeof item.name === "string" && item.name.length > 0 ? item.name : "tool";
	const rawOutput = item.output;
	let text: string;
	if (typeof rawOutput === "string") text = rawOutput;
	else if (rawOutput == null) text = "";
	else {
		try {
			text = JSON.stringify(rawOutput);
		} catch {
			text = String(rawOutput);
		}
	}
	if (text.length > ORPHAN_OUTPUT_LIMIT) text = `${text.slice(0, ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
	return { type: "message", role: "user", content: staleToolResultNote({ toolName, toolCallId: callId, text }) } as T;
}

/**
 * Some Responses backends (notably GitHub Copilot) reject the OpenAI image
 * `detail: "original"` value with a 400. When the model does not advertise
 * support for it, degrade `"original"` to `"auto"` so the request still goes
 * through with the closest valid fidelity instead of failing outright. See #2822.
 */
function clampResponsesImageDetail(
	detail: ImageContent["detail"],
	supportsImageDetailOriginal: boolean,
): ResponseInputImage["detail"] {
	const resolved = detail ?? "auto";
	return resolved === "original" && !supportsImageDetailOriginal ? "auto" : resolved;
}

export function convertResponsesInputContent(
	content: string | Array<TextContent | ImageContent>,
	supportsImages: boolean,
	supportsImageDetailOriginal: boolean,
): ResponseInputContent[] | undefined {
	if (typeof content === "string") {
		if (content.trim().length === 0) return undefined;
		return [{ type: "input_text", text: content.toWellFormed() } satisfies ResponseInputText];
	}

	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const normalizedContent: ResponseInputContent[] = [];
	for (const item of textBlocks) {
		const text = item.text.toWellFormed();
		if (text.trim().length === 0) continue;
		normalizedContent.push({
			type: "input_text",
			text,
		} satisfies ResponseInputText);
	}
	for (const item of imageBlocks) {
		normalizedContent.push({
			type: "input_image",
			detail: clampResponsesImageDetail(item.detail, supportsImageDetailOriginal),
			image_url: `data:${item.mimeType};base64,${item.data}`,
		} satisfies ResponseInputImage);
	}
	if (omittedImages) {
		normalizedContent.push({
			type: "input_text",
			text: NON_VISION_IMAGE_PLACEHOLDER,
		} satisfies ResponseInputText);
	}
	return normalizedContent.length > 0 ? normalizedContent : undefined;
}

/**
 * Map freeform custom-tool wire names back to the internal tool name for
 * providers that only accept function_call / function_call_output.
 * Built once per request; `apply_patch` → `edit` is the veyyon default.
 */
function buildCustomToolWireNameMap(tools: readonly Tool[] | undefined): ReadonlyMap<string, string> | undefined {
	if (!tools?.length) return undefined;
	const map = new Map<string, string>();
	for (const tool of tools) {
		if (tool.customWireName) map.set(tool.customWireName, tool.name);
	}
	return map.size > 0 ? map : undefined;
}

function resolveReplayCustomToolName(wireName: string, wireNameMap: ReadonlyMap<string, string> | undefined): string {
	return wireNameMap?.get(wireName) ?? (wireName === "apply_patch" ? "edit" : wireName);
}

/**
 * Downgrade OpenAI-only custom tool items when the target model does not
 * advertise freeform custom tools (`applyPatchToolType === "freeform"`).
 * No-op (returns the same array reference) when freeform is supported.
 */
function adaptResponsesReplayItemsForModel(
	input: ResponseInput,
	supportsCustomToolCalls: boolean,
	wireNameMap: ReadonlyMap<string, string> | undefined,
): ResponseInput {
	if (supportsCustomToolCalls) return input;

	let changed = false;
	const adapted: ResponseInput = [];
	for (const item of input) {
		if (item.type === "custom_tool_call") {
			changed = true;
			adapted.push({
				type: "function_call",
				...(item.id ? { id: item.id } : {}),
				call_id: item.call_id,
				name: resolveReplayCustomToolName(item.name, wireNameMap),
				arguments: JSON.stringify({ input: item.input }),
				...(item.namespace ? { namespace: item.namespace } : {}),
			});
			continue;
		}
		if (item.type === "custom_tool_call_output") {
			changed = true;
			adapted.push({
				type: "function_call_output",
				call_id: item.call_id,
				output: item.output,
			});
			continue;
		}
		adapted.push(item);
	}
	return changed ? adapted : input;
}

/**
 * Whether a request to this model offers freeform custom tools (the OpenAI custom-tool grammar variant for
 * `apply_patch`). The generated catalog and Codex discovery set `model.applyPatchToolType` for the models that
 * accept them. An Azure request sends every tool as a `function` tool, so it offers none.
 */
export function supportsFreeformApplyPatch(model: Pick<Model, "api" | "applyPatchToolType">): boolean {
	return model.api !== "azure-openai-responses" && model.applyPatchToolType === "freeform";
}

export interface BuildResponsesInputOptions<TApi extends Api> {
	model: Model<TApi>;
	context: Context;
	strictResponsesPairing: boolean;
	supportsImageDetailOriginal: boolean;
	/**
	 * Whether the request's tools include freeform custom tools. When false, a custom tool call and its output are
	 * sent as a `function_call` and a `function_call_output`. Pass the answer the request's tool converter used, so
	 * the input never carries a call kind its tools do not offer. Defaults to `supportsFreeformApplyPatch(model)`.
	 */
	supportsCustomToolCalls?: boolean;
	systemRole?: "system" | "developer";
	nativeHistory?: {
		replay: boolean;
		filterReasoning: boolean;
	};
	includeThinkingSignatures?: boolean;
	developerStringContent?: boolean;
	supportsDeveloperRole?: boolean;
	/**
	 * Has no effect: `buildResponsesInput` repairs every input it builds. The server-compaction encoder in
	 * `openai-compaction.ts` sets it, and `scripts/the-codex-compaction-route-is-locked.test.ts` pins that file's
	 * bytes.
	 */
	repairOrphanOutputs?: true;
	/** Preserve assistant message item IDs from text signatures during fallback replay. */
	preserveAssistantMessageIds?: boolean;
}

export function buildResponsesInput<TApi extends Api>(options: BuildResponsesInputOptions<TApi>): ResponseInput {
	return new ResponsesInputBuilder(options).build();
}

/**
 * Builds a Responses `input` from a transcript in one pass.
 *
 * `#knownCallIds` holds the call id of every `function_call` and `custom_tool_call` in `#messages`, and
 * `#customCallIds` every custom call id appended so far. A native-history replay adds the ids of the items it
 * appends; rescanning the whole input on each replay made a session of incremental snapshots quadratic.
 */
class ResponsesInputBuilder<TApi extends Api> {
	readonly #options: BuildResponsesInputOptions<TApi>;
	readonly #messages: ResponseInput = [];
	readonly #knownCallIds = new Set<string>();
	readonly #customCallIds = new Set<string>();
	readonly #acceptsImages: boolean;
	// Compat is resolved by the catalog (e.g. Copilot / xai-oauth reject
	// `detail: "original"`). Do not re-branch on provider id here.
	readonly #supportsImageDetailOriginal: boolean;
	// Freeform custom tools (`custom_tool_call`) only when the request's tools offer them.
	readonly #supportsCustomToolCalls: boolean;
	readonly #customToolWireNameMap: ReadonlyMap<string, string> | undefined;
	readonly #includeThinkingSignatures: boolean;

	constructor(options: BuildResponsesInputOptions<TApi>) {
		this.#options = options;
		this.#acceptsImages = options.model.input.includes("image");
		this.#supportsImageDetailOriginal = options.supportsImageDetailOriginal;
		this.#supportsCustomToolCalls = options.supportsCustomToolCalls ?? supportsFreeformApplyPatch(options.model);
		this.#customToolWireNameMap = this.#supportsCustomToolCalls
			? undefined
			: buildCustomToolWireNameMap(options.context.tools);
		this.#includeThinkingSignatures = options.includeThinkingSignatures ?? options.nativeHistory?.replay ?? true;
	}

	build(): ResponseInput {
		const { context, model, systemRole } = this.#options;
		if (systemRole) {
			for (const systemPrompt of normalizeSystemPrompts(context.systemPrompt)) {
				this.#messages.push({ role: systemRole, content: systemPrompt });
			}
		}
		let msgIndex = 0;
		for (const msg of transformMessages(context.messages, model, normalizeResponsesToolCallIdForTransform)) {
			if (this.#append(msg, msgIndex)) msgIndex++;
		}
		return repairResponsesToolPairs(this.#messages);
	}

	/** Appends one transcript message. Returns true when it takes a position in the `msg_<index>` id sequence. */
	#append(msg: Message, msgIndex: number): boolean {
		switch (msg.role) {
			case "user":
			case "developer":
				return this.#appendInputMessage(msg);
			case "assistant":
				return this.#appendAssistantMessage(msg, msgIndex);
			case "toolResult":
				appendResponsesToolResultMessages(
					this.#messages,
					msg,
					this.#options.model,
					this.#options.strictResponsesPairing,
					this.#supportsImageDetailOriginal,
					this.#knownCallIds,
					this.#customCallIds,
					this.#supportsCustomToolCalls,
				);
				return true;
		}
	}

	#appendInputMessage(msg: UserMessage | DeveloperMessage): boolean {
		const { model, nativeHistory, supportsDeveloperRole, developerStringContent } = this.#options;
		const historyItems = nativeHistory
			? getOpenAIResponsesHistoryItems(msg.providerPayload, model.provider)
			: undefined;
		if (
			historyItems &&
			(nativeHistory?.replay ||
				historyItems.some(item => item?.type === "compaction" || item?.type === "compaction_summary"))
		) {
			const sanitizedItems = sanitizeOpenAIResponsesHistoryItemsForReplay(this.#withoutReasoning(historyItems), {
				supportsImageDetailOriginal: this.#supportsImageDetailOriginal,
			});
			this.#appendReplayItems(
				adaptResponsesReplayItemsForModel(
					sanitizedItems,
					this.#supportsCustomToolCalls,
					this.#customToolWireNameMap,
				),
			);
			return true;
		}
		if (
			msg.role === "developer" &&
			supportsDeveloperRole &&
			Array.isArray(msg.content) &&
			msg.content.some(item => item.type === "image")
		) {
			const textContent = convertResponsesInputContent(
				msg.content.filter((item): item is TextContent => item.type === "text"),
				false,
				this.#supportsImageDetailOriginal,
			);
			const imageContent = convertResponsesInputContent(
				msg.content.filter((item): item is ImageContent => item.type === "image"),
				this.#acceptsImages,
				this.#supportsImageDetailOriginal,
			);
			if (textContent) this.#messages.push({ role: "developer", content: textContent });
			if (imageContent) this.#messages.push({ role: "user", content: imageContent });
			return false;
		}
		const content = convertResponsesInputContent(msg.content, this.#acceptsImages, this.#supportsImageDetailOriginal);
		if (!content) return false;
		this.#messages.push({
			role: msg.role === "developer" && supportsDeveloperRole ? "developer" : "user",
			content:
				developerStringContent && msg.role === "developer" && typeof msg.content === "string"
					? msg.content.toWellFormed()
					: content,
		});
		return true;
	}

	#appendAssistantMessage(msg: AssistantMessage, msgIndex: number): boolean {
		const { model, nativeHistory, preserveAssistantMessageIds } = this.#options;
		// Providers replay stale native items even when the current request has
		// disabled native replay (cold session state, filter policy). Consult
		// the payload sanitizer directly so hidden-empty turns are recognized
		// on both the warm and cold paths.
		const providerPayload =
			msg.api === model.api && msg.model === model.id
				? getOpenAIResponsesHistoryPayload(msg.providerPayload, model.provider, msg.provider)
				: undefined;
		let suppressHiddenEmptyFallback = false;
		if (providerPayload) {
			const sanitizedItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
				this.#withoutReasoning(providerPayload.items),
				{ supportsImageDetailOriginal: this.#supportsImageDetailOriginal },
			);
			if (!sanitizedItems) {
				suppressHiddenEmptyFallback = true;
			} else if (nativeHistory?.replay === true) {
				const replayItems = adaptResponsesReplayItemsForModel(
					sanitizedItems,
					this.#supportsCustomToolCalls,
					this.#customToolWireNameMap,
				);
				// A snapshot without `dt` holds the whole conversation, so it replaces everything appended so far.
				if (!providerPayload.dt) {
					this.#messages.length = 0;
					this.#knownCallIds.clear();
				}
				this.#appendReplayItems(replayItems);
				return true;
			}
		}

		const convertedOutputItems = convertResponsesAssistantMessage(
			msg,
			model,
			msgIndex,
			this.#knownCallIds,
			!suppressHiddenEmptyFallback && this.#includeThinkingSignatures,
			this.#customCallIds,
			preserveAssistantMessageIds,
			this.#supportsCustomToolCalls,
			this.#customToolWireNameMap,
		);
		const outputItems = suppressHiddenEmptyFallback
			? sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(convertedOutputItems)
			: convertedOutputItems;
		if (outputItems.length === 0) return false;
		for (const item of outputItems) this.#messages.push(item);
		return true;
	}

	#withoutReasoning(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
		return this.#options.nativeHistory?.filterReasoning ? items.filter(item => item?.type !== "reasoning") : items;
	}

	#appendReplayItems(items: ResponseInput): void {
		for (const item of items) this.#messages.push(item);
		recordIssuedCallIds(items, this.#knownCallIds, this.#customCallIds);
	}
}

type ResponsesReplayAssistantMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };

function parseResponseReasoningReplayItem(signature: string | undefined): ResponseReasoningItem | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		if (!("type" in parsed) || parsed.type !== "reasoning") return undefined;
		if (!("id" in parsed) || typeof parsed.id !== "string") return undefined;
		return parsed as ResponseReasoningItem;
	} catch {
		// A signature that is not a reasoning-item envelope cannot be replayed, which is the same undefined
		// the three shape checks above return, and the caller then replays the turn without it.
		return undefined;
	}
}

const NO_REASONING_ITEMS: readonly (ResponseReasoningItem | undefined)[] = [];

/**
 * The reasoning item each thinking block's signature replays, in block order, `undefined` for a block whose
 * signature does not replay. Empty when the turn replays no reasoning: signatures are excluded or the turn errored.
 */
function replayReasoningItems(
	assistantMsg: AssistantMessage,
	includeThinkingSignatures: boolean,
): readonly (ResponseReasoningItem | undefined)[] {
	if (!includeThinkingSignatures || assistantMsg.stopReason === "error") return NO_REASONING_ITEMS;
	let items: (ResponseReasoningItem | undefined)[] | undefined;
	for (const block of assistantMsg.content) {
		if (block.type !== "thinking") continue;
		items ??= [];
		items.push(parseResponseReasoningReplayItem(block.thinkingSignature));
	}
	return items ?? NO_REASONING_ITEMS;
}

/**
 * The `id` a signed text block replays under. Without the matching reasoning item the server rejects replayed
 * item ids (#4173), so the id is dropped whatever its shape, including a legacy plain-string signature that would
 * otherwise reach the over-64-char hash and fabricate a `msg_` id.
 */
function signedReplayMessageId(signatureId: string, keepId: boolean): string | undefined {
	if (!keepId) return undefined;
	return signatureId.length > 64 ? `msg_${Bun.hash(signatureId).toString(36)}` : signatureId;
}

function textReplayItem(
	text: string,
	id: string | undefined,
	phase: TextSignatureV1["phase"] | undefined,
): ResponseInput[number] {
	const messageItem: ResponsesReplayAssistantMessage = {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: text.toWellFormed(), annotations: [] }],
		status: "completed",
		...(id ? { id } : {}),
		...(phase ? { phase } : {}),
	};
	return messageItem as ResponseInput[number];
}

function toolCallReplayItem(
	block: ToolCall,
	dropServerItemIds: boolean,
	knownCallIds: Set<string>,
	customCallIds: Set<string> | undefined,
	supportsCustomToolCalls: boolean,
	customToolWireNameMap: ReadonlyMap<string, string> | undefined,
): ResponseInput[number] {
	const normalized = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
	// Every normalized item id is server-issued (`fc_`, `fcr_`, `ctc_`), so the server rejects each one replayed
	// without its reasoning item or into another model.
	const itemId = dropServerItemIds ? undefined : normalized.itemId;
	knownCallIds.add(normalized.callId);
	if (block.customWireName && supportsCustomToolCalls) {
		customCallIds?.add(normalized.callId);
		return {
			type: "custom_tool_call",
			...(itemId ? { id: itemId } : {}),
			call_id: normalized.callId,
			name: block.customWireName,
			input: typeof block.arguments?.input === "string" ? block.arguments.input : "",
		} as ResponseInput[number];
	}
	return {
		type: "function_call",
		...(itemId ? { id: itemId } : {}),
		call_id: normalized.callId,
		name: block.customWireName
			? resolveReplayCustomToolName(block.customWireName, customToolWireNameMap)
			: block.name,
		arguments: stringifyJson(block.arguments) ?? "null",
	};
}

export function convertResponsesAssistantMessage<TApi extends Api>(
	assistantMsg: AssistantMessage,
	model: Model<TApi>,
	msgIndex: number,
	knownCallIds: Set<string>,
	includeThinkingSignatures = true,
	customCallIds?: Set<string>,
	preserveMessageIds = false,
	supportsCustomToolCalls = true,
	customToolWireNameMap?: ReadonlyMap<string, string>,
): ResponseInput {
	const outputItems: ResponseInput = [];
	const reasoningItems = replayReasoningItems(assistantMsg, includeThinkingSignatures);
	const hasReplayableReasoningItem = reasoningItems.some(item => item !== undefined);
	const isDifferentModel =
		assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;
	const dropServerItemIds = !hasReplayableReasoningItem || isDifferentModel;
	let thinkingBlocks = 0;
	let unsignedTextBlocks = 0;

	for (const block of assistantMsg.content) {
		switch (block.type) {
			case "thinking": {
				const reasoningItem = reasoningItems[thinkingBlocks++];
				if (reasoningItem) outputItems.push(reasoningItem);
				break;
			}
			case "text": {
				const parsedSignature = parseTextSignature(block.textSignature);
				let msgId = parsedSignature?.id;
				if (msgId) {
					msgId = signedReplayMessageId(msgId, preserveMessageIds || hasReplayableReasoningItem);
				} else if (hasReplayableReasoningItem) {
					// Distinct ids per unsigned block: several text blocks in one message
					// (cross-provider replay downgrades thinking → text) must not share an id.
					msgId = unsignedTextBlocks === 0 ? `msg_${msgIndex}` : `msg_${msgIndex}_${unsignedTextBlocks}`;
					unsignedTextBlocks += 1;
				}
				outputItems.push(textReplayItem(block.text, msgId, parsedSignature?.phase));
				break;
			}
			case "toolCall":
				outputItems.push(
					toolCallReplayItem(
						block,
						dropServerItemIds,
						knownCallIds,
						customCallIds,
						supportsCustomToolCalls,
						customToolWireNameMap,
					),
				);
				break;
		}
	}

	return outputItems;
}

export function appendResponsesToolResultMessages<TApi extends Api>(
	messages: ResponseInput,
	toolResult: ToolResultMessage,
	model: Model<TApi>,
	strictResponsesPairing: boolean,
	supportsImageDetailOriginal: boolean,
	knownCallIds: ReadonlySet<string>,
	customCallIds?: ReadonlySet<string>,
	supportsCustomToolCalls = true,
): void {
	const supportsImages = model.input.includes("image");
	const textResult = toolResult.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const hasImages = toolResult.content.some((block): block is ImageContent => block.type === "image");
	const omittedImages = hasImages && !supportsImages;
	const normalized = normalizeResponsesToolCallId(toolResult.toolCallId);
	// "(see attached image)" is only truthful when the result actually carries
	// images (they ride as a separate user message on the Responses API). A
	// genuinely empty text result (empty file read, silent tool) must stay
	// empty — the placeholder sent models chasing an attachment that never
	// existed.
	const output = (
		omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: textResult.length > 0
				? textResult
				: hasImages
					? "(see attached image)"
					: ""
	).toWellFormed();
	if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
		// Strict backends (Azure, Copilot) reject unpaired outputs outright, but
		// silently dropping the result loses information the model needs. Fold it
		// into a note instead (same shape as repairResponsesToolPairs).
		logger.warn("openai-responses: folding a tool result whose call is missing from the request", {
			provider: model.provider,
			model: model.id,
			toolName: toolResult.toolName,
			toolCallId: toolResult.toolCallId,
			normalizedCallId: normalized.callId,
			knownCallIds: [...knownCallIds],
		});
		const noteText =
			output.length > ORPHAN_OUTPUT_LIMIT ? `${output.slice(0, ORPHAN_OUTPUT_LIMIT)}\n...[truncated]` : output;
		messages.push({
			type: "message",
			role: "user",
			content: staleToolResultNote({
				toolName: toolResult.toolName || "tool",
				toolCallId: normalized.callId,
				text: noteText,
				isError: toolResult.isError,
			}),
		} as ResponseInput[number]);
		return;
	}
	if (supportsCustomToolCalls && customCallIds?.has(normalized.callId)) {
		messages.push({
			type: "custom_tool_call_output",
			call_id: normalized.callId,
			output,
		} as ResponseInput[number]);
	} else {
		messages.push({
			type: "function_call_output",
			call_id: normalized.callId,
			output,
		});
	}

	if (!hasImages || !supportsImages) {
		return;
	}

	const contentParts: ResponseInputContent[] = [
		{ type: "input_text", text: "Attached image(s) from tool result:" } satisfies ResponseInputText,
	];
	for (const block of toolResult.content) {
		if (block.type === "image") {
			contentParts.push({
				type: "input_image",
				detail: clampResponsesImageDetail(block.detail, supportsImageDetailOriginal),
				image_url: `data:${block.mimeType};base64,${block.data}`,
			} satisfies ResponseInputImage);
		}
	}
	messages.push({ role: "user", content: contentParts });
}

/** Extension fields we add on top of `ResponseCreateParamsStreaming` across the Responses-family providers. */
export type ResponsesSamplingParamsExtras = {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

type CommonResponsesParams = ResponseCreateParamsStreaming & ResponsesSamplingParamsExtras;

type CommonSamplingOptions = Pick<
	StreamOptions,
	"temperature" | "topP" | "topK" | "minP" | "presencePenalty" | "repetitionPenalty" | "maxTokens"
> & { serviceTier?: ServiceTier };

/**
 * Apply the common `StreamOptions` → Responses sampling-parameter mapping (max output tokens,
 * temperature, top-p/k, min-p, presence/repetition penalties, service tier). Mutates `params`.
 *
 * `max_output_tokens` is suppressed when {@link Model.omitMaxOutputTokens} is `true`, so
 * proxies (notably Ollama) that forward to upstream APIs with an unknown output-token cap
 * can let the upstream apply its own default instead of 400-ing on `maxTokens` values that
 * reflect the model's context window rather than the upstream output limit.
 */
export function applyCommonResponsesSamplingParams<P extends CommonResponsesParams>(
	params: P,
	options: CommonSamplingOptions | undefined,
	model: Pick<Model, "provider" | "api" | "id" | "omitMaxOutputTokens" | "maxTokens">,
): void {
	if (options?.maxTokens && !model.omitMaxOutputTokens) {
		params.max_output_tokens = Math.min(
			options.maxTokens,
			model.maxTokens ?? Number.POSITIVE_INFINITY,
			OPENAI_MAX_OUTPUT_TOKENS,
		);
	}
	if (options?.temperature !== undefined) params.temperature = options.temperature;
	if (options?.topP !== undefined) params.top_p = options.topP;
	if (options?.topK !== undefined) params.top_k = options.topK;
	if (options?.minP !== undefined) params.min_p = options.minP;
	if (options?.presencePenalty !== undefined) params.presence_penalty = options.presencePenalty;
	if (options?.repetitionPenalty !== undefined) params.repetition_penalty = options.repetitionPenalty;
	applyOpenAIServiceTier(params, options?.serviceTier, model);
}

type ReasoningOptions = {
	reasoning?: string;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	disableReasoning?: boolean;
	toolChoice?: unknown;
};

export interface ApplyResponsesCompatPolicyOptions {
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	mapEffort?: (effort: string) => string;
}

export function applyResponsesCompatPolicy<P extends ResponseCreateParamsStreaming>(
	params: P,
	policy: OpenAICompatPolicy,
	options: ApplyResponsesCompatPolicyOptions | undefined,
): void {
	const reasoning = policy.reasoning;
	if (!reasoning.modelSupported) return;
	if (reasoning.includeEncryptedReasoning) {
		const include = params.include ?? [];
		if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
		params.include = include;
	}

	if (reasoning.disabled) {
		if (reasoning.disableMode === "openrouter-enabled-false") {
			params.reasoning = { enabled: false } as P["reasoning"];
			return;
		}
		if (
			reasoning.disableMode === "lowest-effort" &&
			reasoning.wireEffort !== undefined &&
			!reasoning.omitReasoningEffort
		) {
			type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
			params.reasoning = { effort: reasoning.wireEffort as ReasoningParam["effort"] } as P["reasoning"] &
				ReasoningParam;
			return;
		}
		return;
	}

	if (reasoning.requestedEffort !== undefined || options?.reasoningSummary !== undefined) {
		if (reasoning.omitReasoningEffort) {
			if (options?.reasoningSummary !== undefined && options.reasoningSummary !== null) {
				type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
				params.reasoning = { summary: options.reasoningSummary || "auto" } as P["reasoning"] & ReasoningParam;
			}
			return;
		}

		const requested = reasoning.requestedEffort ?? "medium";
		const wireEffort = reasoning.wireEffort ?? options?.mapEffort?.(requested) ?? requested;
		type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
		const reasoningParams: ReasoningParam = {
			effort: wireEffort as ReasoningParam["effort"],
		};
		if (options?.reasoningSummary !== null) {
			reasoningParams.summary = options?.reasoningSummary || "auto";
		}
		params.reasoning = reasoningParams as P["reasoning"];
		return;
	}
}

/**
 * Apply reasoning-related Responses parameters. Default behavior comes from
 * catalog compat; include/omit arguments are explicit adapter-wrapper overrides.
 */
export function applyResponsesReasoningParams<P extends ResponseCreateParamsStreaming>(
	params: P,
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	options: ReasoningOptions | undefined,
	mapEffort?: (effort: string) => string,
	includeEncryptedReasoning?: boolean,
	omitReasoningEffort?: boolean,
): void {
	return applyResponsesCompatPolicy(
		params,
		resolveOpenAICompatPolicy(model, {
			endpoint: "responses",
			reasoning: options?.reasoning,
			disableReasoning: options?.disableReasoning,
			toolChoice: options?.toolChoice,
			includeEncryptedReasoning,
			omitReasoningEffort,
		}),
		{ reasoningSummary: options?.reasoningSummary, mapEffort },
	);
}

/** Populate `output.usage` from a Responses-API `response.usage` payload. Does not invoke `calculateCost`. */
export function populateResponsesUsageFromResponse(
	output: AssistantMessage,
	usage:
		| {
				input_tokens?: number | null;
				output_tokens?: number | null;
				total_tokens?: number | null;
				prompt_cache_hit_tokens?: number | null;
				prompt_cache_miss_tokens?: number | null;
				input_tokens_details?: {
					cached_tokens?: number | null;
					cache_write_tokens?: number | null;
					orchestration_input_tokens?: number | null;
					orchestration_input_cached_tokens?: number | null;
				} | null;
				output_tokens_details?: {
					reasoning_tokens?: number | null;
					orchestration_output_tokens?: number | null;
				} | null;
		  }
		| null
		| undefined,
): void {
	if (!usage) return;
	const details = usage.input_tokens_details;
	const outputDetails = usage.output_tokens_details;
	const reportedInputTokens = usage.input_tokens ?? 0;
	const reportedOutputTokens = usage.output_tokens ?? 0;
	const reportedCachedTokens = details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
	const orchestrationInputTokens = details?.orchestration_input_tokens ?? 0;
	const orchestrationInputCachedTokens = details?.orchestration_input_cached_tokens ?? 0;
	const orchestrationOutputTokens = outputDetails?.orchestration_output_tokens ?? 0;
	const reportedTotalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
	const reportedPrimaryTokens = reportedInputTokens + reportedOutputTokens;
	const reportedWithSeparateOrchestration =
		reportedPrimaryTokens + orchestrationInputTokens + orchestrationOutputTokens;
	const primaryIncludesOrchestration =
		reportedTotalTokens !== undefined &&
		orchestrationInputTokens + orchestrationOutputTokens > 0 &&
		Math.abs(reportedTotalTokens - reportedPrimaryTokens) <=
			Math.abs(reportedTotalTokens - reportedWithSeparateOrchestration);
	const orchestrationInputCached = Math.min(orchestrationInputTokens, orchestrationInputCachedTokens);
	const orchestrationInput = Math.max(0, orchestrationInputTokens - orchestrationInputCached);
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: Math.max(0, reportedInputTokens - (primaryIncludesOrchestration ? orchestrationInputTokens : 0)),
		outputTokens: Math.max(0, reportedOutputTokens - (primaryIncludesOrchestration ? orchestrationOutputTokens : 0)),
		cachedTokens: Math.max(0, reportedCachedTokens - (primaryIncludesOrchestration ? orchestrationInputCached : 0)),
		reasoningTokens: outputDetails?.reasoning_tokens ?? 0,
		cacheWriteOpenRouter: details?.cache_write_tokens ?? undefined,
		cacheWriteDeepSeek: usage.prompt_cache_miss_tokens ?? undefined,
		hasDeepSeekCacheHitAndMiss:
			usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_miss_tokens !== undefined,
	});
	const orchestrationTotal = orchestrationInput + orchestrationInputCached + orchestrationOutputTokens;
	if (orchestrationTotal > 0) {
		accounting.orchestration = {
			...(orchestrationInput > 0 ? { input: orchestrationInput } : {}),
			...(orchestrationInputCached > 0 ? { cacheRead: orchestrationInputCached } : {}),
			...(orchestrationOutputTokens > 0 ? { output: orchestrationOutputTokens } : {}),
		};
		accounting.totalTokens = reportedTotalTokens ?? accounting.totalTokens + orchestrationTotal;
	}

	// Wholesale replacement must not drop what the object already carried (Copilot
	// premium-request accounting, the spend of discarded attempts): the
	// failed/cancelled paths throw right after this call with no later chance to
	// re-apply it.
	output.usage = inheritUsageCarryovers(output.usage, {
		...accounting,
		cost: emptyCost(),
	});
}

/**
 * Structural equality for the chain prefix/option check, equivalent to the
 * default {@link Bun.deepEquals} (own enumerable keys, `absent ≡ own-undefined`)
 * except for two deliberate exclusions:
 *  - **symbol-keyed properties are ignored** — `for…in` walks enumerable
 *    *string* keys only (never symbols); these are plain wire items whose
 *    prototype contributes no enumerable keys, so iteration is effectively
 *    own-string-keyed. That is how the transient streaming symbols
 *    (`block-symbols.ts`) stamped onto live request items are excluded (the
 *    deep-cloned baseline never carries them). Do NOT add an
 *    `Object.getOwnPropertySymbols` pass, or those symbols resurface and break
 *    chaining.
 *  - keys listed in `omitKeys` are skipped (the option compare omits `input`
 *    and the per-turn `client_metadata`). The omit lookup is an own-property
 *    check, not `omitKeys[key]`: a bare index would read `Object.prototype`
 *    members, so a key literally named `toString`/`valueOf`/`constructor` would
 *    resolve to the inherited method (truthy) and be silently omitted from the
 *    comparison even though it is not in the omit list.
 * A defined value differing across sides IS a difference; a key undefined or
 * absent on both stays equal. Nested values use full {@link Bun.deepEquals}.
 */
function deepEqualsWithout(a: unknown, b: unknown, omitKeys?: Record<string, boolean>): boolean {
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return Bun.deepEquals(a, b);
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	for (const key in ao) {
		if (omitKeys && Object.hasOwn(omitKeys, key) && omitKeys[key]) continue;
		const av = ao[key];
		const bv = bo[key];
		if (av !== bv && !Bun.deepEquals(av, bv)) return false;
	}
	for (const key in bo) {
		if (omitKeys && Object.hasOwn(omitKeys, key) && omitKeys[key]) continue;
		// Own-property test, not `key in ao`: the model here is own enumerable keys
		// (see the doc above). `key in ao` also matches inherited Object.prototype
		// members, so a `b` that owns a defined key named after one (`toString`,
		// `constructor`, …) that `a` does not own would be treated as present on `a`
		// and the extra key would not break equality — a false chain match.
		if (bo[key] !== undefined && !Object.hasOwn(ao, key)) return false;
	}
	return true;
}

const TOP_LEVEL_EXCLUDE_MAP = {
	input: true,
	client_metadata: true,
};

/**
 * Strict-prefix delta for stateful `previous_response_id` chaining (used by the
 * platform Responses provider and the Codex provider on both transports):
 * returns the input items the current request appends beyond the previous
 * request's input plus the previous response's output items, or null when the
 * request options differ or history mutated (the chain must break). Per-turn
 * `client_metadata` (e.g. rotating turn ids) is excluded from the option
 * comparison; codex-rs excludes it from the same check.
 */
export function buildResponsesDeltaInput<TItem extends ResponseInputItem | InputItem>(
	previous: { input?: TItem[] } | undefined,
	previousResponseItems: readonly TItem[] | undefined,
	current: { input?: TItem[] },
): TItem[] | null {
	if (!previous) return null;
	if (!Array.isArray(previous.input) || !Array.isArray(current.input)) return null;
	if (!deepEqualsWithout(previous, current, TOP_LEVEL_EXCLUDE_MAP)) {
		return null;
	}

	const baselineLen = (previous.input?.length ?? 0) + (previousResponseItems?.length ?? 0);
	if (current.input.length <= baselineLen) return null;

	let index = 0;
	for (const series of [previous.input, previousResponseItems]) {
		if (!series) continue;
		for (const item of series) {
			if (deepEqualsWithout(item, current.input[index])) {
				index++;
			} else {
				return null;
			}
		}
	}
	return current.input.slice(index) as TItem[];
}

/**
 * The OpenAI-compatible error envelope, shared by the OpenAI Responses and
 * Chat Completions server modules — both emit byte-identical `{ error: {
 * message, type } }` bodies, so the shape lives here once to keep the two
 * `formatError` implementations from drifting. Anthropic and pi-native use
 * their own envelopes (top-level `type: "error"`, no-store cache header) and
 * deliberately do NOT share this.
 */
export function formatOpenAiError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { message, type } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
