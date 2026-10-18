import { resolveModelPolicy } from "@veyyon/catalog/compat/resolve";
import type { Effort } from "@veyyon/catalog/effort";
import { resolveReasoningSelection } from "@veyyon/catalog/model-thinking";
import { calculateCost, emptyCost } from "@veyyon/catalog/models";
import type { ResolvedOpenAICompat } from "@veyyon/catalog/types";
import { clinePassClientHeaders } from "@veyyon/catalog/wire/cline-pass";
import { $env } from "@veyyon/utils/env";
import { tryParseJson } from "@veyyon/utils/json";
import * as logger from "@veyyon/utils/logger";
import type { ServerSentEvent } from "@veyyon/utils/stream";
import { isRecord } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { renderDemotedThinking } from "../dialect/demotion";
import { getEnvApiKey } from "../env-api-key";
import * as AIError from "../error";
import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	OpenAIPromptCacheOptions,
	ProviderSessionState,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
	VideoContent,
} from "../types";
import { normalizeSystemPrompts, normalizeToolCallId, resolveCacheRetention } from "../utils";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import { isDemotedThinking } from "../utils/block-symbols";
import {
	EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE,
	hasVisibleAssistantContent,
	withEmptyCompletionRetry,
} from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
	iterateWithTerminalGrace,
} from "../utils/idle-iterator";
import { OpenAIHttpError, type OpenAIStreamHandle, postOpenAIStream } from "../utils/openai-http";
import { conversationIdForOpenCode } from "../utils/opencode-headers";
import { notifyProviderResponse } from "../utils/provider-response";
import { wrapFetchForRequestCompression } from "../utils/request-compression";
import {
	adaptSchemaForStrict,
	findStrictToolSchemaViolation,
	flattenExclusiveRequiredRootUnion,
	NO_STRICT,
	normalizeSchemaForMoonshot,
	sanitizeSchemaForGrammar,
	toolWireSchema,
} from "../utils/schema";
import { notifyRawSseEvent, resolveOpenAiSseEventName } from "../utils/sse-debug";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import { parseToolCallArguments } from "../utils/tool-call-arguments";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import type { CacheControlEphemeral } from "./anthropic-wire";
import { servedModelFromOpenRouterReasoning } from "./anthropic-signature";
import { parseAzureDeploymentNameMap } from "./azure-deployment-names";
import { resolveCopilotRequestIdentity, wrapFetchForCopilotFallback } from "./github-copilot-headers";
import { createInitialResponsesAssistantMessage } from "./initial-message";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionContentPartVideo,
	ChatCompletionMessageFunctionToolCall,
	ChatCompletionMessageParam,
	ChatCompletionMistralThinkingPart,
	ChatCompletionTool,
	ChatCompletionToolMessageParam,
} from "./openai-chat-wire";
import {
	encodeLiteLLMThinkingBlocks,
	type GeminiMessageThoughtSignatureField,
	type GeminiThoughtSignatureExtraContent,
	getGeminiMessageThoughtSignature,
	getGeminiThoughtSignatureExtraContent,
	type LiteLLMThinkingBlock,
	mergeStoredGeminiSignature,
	normalizeStoredGeminiSignature,
	type OpenAICompletionsPromptTokenDetails,
	OpenAICompletionsTurn,
	type OpenAICompletionsUsageLike,
	parseStoredThoughtSignature,
	type StoredGeminiSignature,
} from "./openai-completions-stream";
import {
	applyOpenAIReasoningEffortFallback,
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackKey,
	createOpenAIReasoningEffortFallbackState,
	getOpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallbackState,
	rememberOpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "./openai-reasoning-fallback";
import {
	applyChatCompletionsReasoningParams,
	applyChatCompletionsToolStream,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyOpenAIServiceTier,
	applyProviderReportedCost,
	applyWireModelIdTransform,
	calculateOpenAIUsageAccounting,
	clearOpenAIStrictToolsState,
	clearOpenAIToolChoiceState,
	createOpenAIStrictToolsState,
	createOpenAIToolChoiceState,
	disableStrictToolsForScope,
	getOpenAIPromptCacheKey,
	getOpenAIStrictToolsScope,
	isCompiledGrammarTooLargeStrictError,
	isStrictToolsDisabledForScope,
	isToolChoiceRejectedForScope,
	isToolChoiceRejection,
	type OpenAICompatPolicy,
	type OpenAICompletionsParams,
	type OpenAIRequestSetup,
	type OpenAIStrictToolsScope,
	type OpenAIStrictToolsState,
	type OpenAIToolChoiceState,
	readOpenRouterRawMetadata,
	rejectToolChoiceForScope,
	resolveOpenAICompatPolicy,
	resolveOpenAICompletionsOutputClamp,
	resolveOpenAIOutputTokenParam,
	resolveOpenAIRequestSetup,
	shouldDropAutoToolChoiceForReasoning,
	shouldRetryWithoutStrictTools,
} from "./openai-shared";
import { transformMessages } from "./transform-messages";
import {
	joinTextWithImagePlaceholder,
	NON_VIDEO_MODEL_PLACEHOLDER,
	NON_VISION_IMAGE_PLACEHOLDER,
} from "./vision-content";
import { isOpenAICompletionsVisionSupported } from "./vision-guard";

const OPENAI_TOOL_CALL_ID_MAX_LENGTH = 40;

export { applyOpenRouterRoutingVariant } from "./openai-shared";

type OpenAICompletionsReasoningField = NonNullable<ResolvedOpenAICompat["reasoningContentField"]>;

type OpenAICompletionsFunctionToolCall = ChatCompletionMessageFunctionToolCall & {
	extra_content?: GeminiThoughtSignatureExtraContent;
};

type OpenAICompletionsAssistantMessageParam = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField | GeminiMessageThoughtSignatureField, string>> & {
		reasoning_details?: unknown[];
		thinking_blocks?: LiteLLMThinkingBlock[];
	};

type OpenAICompletionsToolMessageParam = ChatCompletionToolMessageParam & {
	name?: string;
};

type OpenAICompletionsCompletionTokenDetails = {
	reasoning_tokens?: unknown;
};

function firstPositiveNumber(...values: unknown[]): number {
	for (const value of values) {
		if (typeof value === "number" && value > 0) return value;
	}
	return 0;
}

/**
 * Normalize tool call ID for Mistral.
 * Mistral requires tool IDs to be exactly 9 alphanumeric characters (a-z, A-Z, 0-9).
 */
function normalizeMistralToolId(id: string, isMistral: boolean): string {
	if (!isMistral) return id;
	// Remove non-alphanumeric characters
	let normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	// Mistral requires exactly 9 characters
	if (normalized.length < 9) {
		// Pad with deterministic characters based on original ID to ensure matching
		const padding = "ABCDEFGHI";
		normalized = normalized + padding.slice(0, 9 - normalized.length);
	} else if (normalized.length > 9) {
		normalized = normalized.slice(0, 9);
	}
	return normalized;
}
// Direct DeepSeek model ids on NanoGPT are routed via the default tools-capable
// path. We deliberately do NOT append `:tools` here: with `:tools`, NanoGPT
// performs server-side tool-call parsing on the upstream DeepSeek stream and
// 502s with `code: "malformed_tool_call"` on more complex tool schemas (issue
// #1488). The default route forwards `delta.content` (including DSML
// envelope leaks) which `StreamMarkupHealing` heals into a structured call
// client-side.

function resolveOpenAICompletionsModelId(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): string {
	// Effort-tier variants route per request effort (off → bare id, efforts →
	// the thinking backing id); catalog variants (Copilot long-context `-1m`
	// entries) pin via `requestModelId`; everything else serializes `model.id`.
	const selection = resolveReasoningSelection(model, {
		effort: options?.reasoning as Effort | undefined,
		disabled: options?.disableReasoning,
	});
	const wireId = selection.wireModelId;
	return applyWireModelIdTransform(wireId, model.compat.wireModelIdMode, options?.openrouterVariant);
}

/**
 * Serialize a recorded tool call's arguments back into the JSON string the
 * provider expects when the conversation is replayed.
 *
 * The `arguments` field only has to be a string containing JSON, so any valid
 * JSON is preserved, not just an object: a stored array or scalar is still what
 * the model produced, and re-serializing it keeps the replayed history honest.
 * Dropping such a value to `{}` used to corrupt the model's view of its own
 * history (it would see it called the tool with no arguments) for no gain. The
 * `{}` safety net remains for a string that is not valid JSON at all, since a
 * strict provider rejects a non-JSON arguments string, but that drop is now
 * surfaced rather than swallowed (Law 10).
 */
export function serializeToolArguments(value: unknown, toolName?: string): string {
	if (isRecord(value)) {
		try {
			return JSON.stringify(value);
		} catch {
			return "{}";
		}
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return "{}";
		try {
			// Re-stringify so the output is canonical JSON, whether the parsed value
			// is an object, an array, or a scalar. All three are valid here.
			return JSON.stringify(JSON.parse(trimmed));
		} catch {
			logger.warn("A recorded tool call had unparseable arguments, replaced with {} when replayed to the provider", {
				...(toolName ? { tool: toolName } : {}),
				fix: "The model emitted arguments that are not valid JSON. The tool already ran, but its arguments are lost from the replayed history, which can confuse later turns. This usually points at a provider streaming malformed tool-call deltas.",
			});
			return "{}";
		}
	}

	return "{}";
}

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some(block => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}
/**
 * Identify "real progress" stream chunks vs. keepalives, role-only preambles,
 * and empty `{choices:[]}` no-ops emitted by some OpenAI-compatible endpoints.
 * Without this filter, every keepalive resets `iterateWithIdleTimeout`'s
 * deadline, so a provider that streams nothing but pings keeps the watchdog
 * asleep indefinitely — observed against z.ai/GLM via OpenRouter where a
 * agent stalled for hours with no error surfaced.
 *
 * A chunk counts as progress when it carries terminal usage, a finish reason,
 * or a model-produced delta (content / tool calls / reasoning / refusal).
 * Role-only `delta: { role: "assistant" }` preambles do NOT count; we want the
 * (longer) first-event timeout to keep governing until real output appears.
 */
export function isOpenAICompletionsProgressChunk(chunk: unknown): boolean {
	if (!chunk || typeof chunk !== "object") return false;
	const record = chunk as {
		usage?: unknown;
		choices?: ReadonlyArray<{ finish_reason?: unknown; usage?: unknown; delta?: OpenAICompletionsProgressDelta }>;
	};
	if (record.usage) return true;
	const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
	if (!choice) return false;
	if (choice.finish_reason || choice.usage) return true;
	return choice.delta ? isOpenAICompletionsProgressDelta(choice.delta) : false;
}

interface OpenAICompletionsProgressDelta {
	content?: unknown;
	tool_calls?: unknown;
	reasoning?: unknown;
	reasoning_content?: unknown;
	reasoning_text?: unknown;
	refusal?: unknown;
}

function isOpenAICompletionsProgressDelta(delta: OpenAICompletionsProgressDelta): boolean {
	const content = delta.content;
	if (typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0) return true;
	if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
	if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
	if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
	if (typeof delta.reasoning_text === "string" && delta.reasoning_text.length > 0) return true;
	return typeof delta.refusal === "string" && delta.refusal.length > 0;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Force-disable reasoning where supported, or request the lowest effort on generic effort endpoints. */
	disableReasoning?: boolean;
	serviceTier?: ServiceTier;
	/** @internal True when maxTokens came from the caller, not the model default. */
	maxTokensExplicit?: boolean;
	/**
	 * Routing-variant suffix appended to OpenRouter model IDs when none is
	 * already present (`anthropic/claude-haiku-latest` → `…:nitro`). Common
	 * values: `"nitro"`, `"floor"`, `"online"`, `"exacto"`. Ignored when the
	 * resolved `model.id` already contains a colon-suffix after the last
	 * provider segment (explicit `:nitro` in the selector or a catalog entry
	 * with the variant baked in).
	 */
	openrouterVariant?: string;
	/** Opt-in GPT-5.6+ prompt-cache policy. Unsupported explicit mode fails locally. */
	promptCache?: OpenAIPromptCacheOptions;
}

type AppliedToolStrictMode = "mixed" | "all_strict" | "none";
type ToolStrictModeOverride = Exclude<ResolvedOpenAICompat["toolStrictMode"], "mixed"> | undefined;

type BuiltOpenAICompletionTools = {
	tools: ChatCompletionTool[];
	toolStrictMode: AppliedToolStrictMode;
	/** True when at least one wire tool was sent with `strict: true`. */
	strictToolsApplied: boolean;
};

const OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX = "openai-completions:";

type OpenAICompletionsProviderSessionState = ProviderSessionState &
	OpenAIStrictToolsState &
	OpenAIReasoningEffortFallbackState &
	OpenAIToolChoiceState;

function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const toolChoiceState = createOpenAIToolChoiceState();
	const state: OpenAICompletionsProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		...toolChoiceState,
		close: () => {
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
			clearOpenAIToolChoiceState(state);
		},
	};
	return state;
}

function getOpenAICompletionsProviderSessionState(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAICompletionsProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${baseUrl ?? ""}:${model.id}`;
	const existing = providerSessionState.get(key) as OpenAICompletionsProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAICompletionsProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

const OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI completions stream timed out while waiting for the first event";
// How long to keep draining the stream after a `finish_reason` chunk arrived.
// Compliant hosts follow it (almost) immediately with an optional usage-only
// chunk and the `[DONE]` sentinel, so the window only ever elapses on hosts
// that hold the connection open after the response logically completed —
// without it the turn parks on `iterator.next()` until the idle watchdog
// converts the already-successful response into a timeout error.
const OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS = 2_500;

const OPENAI_COMPLETIONS_ERROR_STATUS_BY_TYPE: Readonly<Record<string, number>> = {
	SERVICE_UNAVAILABLE: 503,
	TOO_MANY_REQUESTS: 429,
	REQUEST_TIMEOUT: 408,
};

function parseOpenAICompletionsErrorStatus(value: unknown): number | undefined {
	const status =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d{3}$/.test(value.trim())
				? Number(value)
				: undefined;
	return status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

/**
 * Classify an SSE chunk that carries an `error` envelope inside a successful
 * HTTP response (queue-full, in-stream timeouts). Returns undefined for a
 * regular completion chunk. A status found in `code` or implied by `type` keeps
 * HTTP semantics so retry and model-fallback recovery treat it like a non-2xx.
 */
function createOpenAICompletionsStreamError(chunk: unknown, provider: string): Error | undefined {
	if (!chunk || typeof chunk !== "object") return undefined;
	const error = Reflect.get(chunk, "error");
	const flatMessage = Reflect.get(chunk, "message");
	const structuredError = error !== null && typeof error === "object";
	if (!structuredError && typeof error !== "string" && typeof flatMessage !== "string") return undefined;

	const parsed = AIError.OpenAIHttpError.parseEnvelope(chunk, undefined);
	const detail = parsed.detail ?? "Provider returned an in-band OpenAI completions stream error";
	if (!structuredError) {
		return new AIError.ProviderResponseError(detail, { provider, kind: "runtime" });
	}

	const typeValue = Reflect.get(error, "type");
	const codeValue = Reflect.get(error, "code");
	const type = typeof typeValue === "string" ? typeValue.trim() : undefined;
	const status =
		parseOpenAICompletionsErrorStatus(codeValue) ??
		(type ? OPENAI_COMPLETIONS_ERROR_STATUS_BY_TYPE[type.toUpperCase()] : undefined);
	if (status === undefined) {
		return new AIError.ProviderResponseError(detail, { provider, kind: "runtime" });
	}
	return new AIError.ProviderHttpError(`${status} ${detail}`, status, { code: parsed.code });
}

interface ConnectOpenAICompletionsStreamArgs {
	model: Model<"openai-completions">;
	context: Context;
	options?: OpenAICompletionsOptions;
	completionsUrl: string;
	headers: Record<string, string>;
	requestHeaders: Record<string, string>;
	trimmedBaseUrl: string;
	requestTimeoutMs: number | undefined;
	requestSignal: AbortSignal;
	abortTracker: AbortSourceTracker;
	firstEventTimeoutAbortError: AIError.StreamTimeoutError;
	rawSseObserver: ((event: ServerSentEvent) => void) | undefined;
	providerSessionState: OpenAICompletionsProviderSessionState | undefined;
	strictToolsScope: OpenAIStrictToolsScope;
	disableStrictTools: boolean;
	outputApi: Api;
	onRequestDump: (dump: RawHttpRequestDump, wireBodyJson: string) => void;
	copilotCacheKey: string | undefined;
	copilotCacheSnapshot: string | null | undefined;
}

/**
 * Serializes a request body. A caller's `onPayload` receives a copy and may return a replacement; the
 * result carries the params that actually went on the wire, which the fallback classifiers read.
 */
async function serializeOpenAICompletionsRequest(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	onPayload: OpenAICompletionsOptions["onPayload"],
): Promise<{ body: string; wireParams: OpenAICompletionsParams }> {
	const bodyJson = JSON.stringify(params);
	if (!onPayload) return { body: bodyJson, wireParams: params };
	const attemptParams = JSON.parse(bodyJson) as OpenAICompletionsParams;
	const replacementPayload = await onPayload(attemptParams, model);
	const wireParams =
		replacementPayload !== undefined && replacementPayload !== attemptParams
			? (replacementPayload as OpenAICompletionsParams)
			: attemptParams;
	return { body: JSON.stringify(wireParams), wireParams };
}

async function postOpenAICompletionsRequest(
	args: ConnectOpenAICompletionsStreamArgs,
	prepareInit: () => Promise<RequestInit>,
): Promise<OpenAIStreamHandle<ChatCompletionChunk>> {
	const headers = { ...args.headers };
	let requestTimeout: NodeJS.Timeout | undefined;
	if (args.requestTimeoutMs !== undefined) {
		requestTimeout = setTimeout(
			() => args.abortTracker.abortLocally(args.firstEventTimeoutAbortError),
			args.requestTimeoutMs,
		);
		headers["X-Stainless-Timeout"] = Math.floor(args.requestTimeoutMs / 1000).toString();
	}
	try {
		return await postOpenAIStream<ChatCompletionChunk>({
			url: args.completionsUrl,
			headers,
			body: undefined,
			signal: args.requestSignal,
			fetch: wrapFetchForCopilotFallback(
				wrapFetchForRequestCompression(args.options?.fetch ?? fetch, args.model),
				args.model.provider === "github-copilot",
				resolveCopilotRequestIdentity(args.options?.headers),
				args.copilotCacheKey,
				args.copilotCacheSnapshot,
			),
			prepareInit,
			maxRetryDelayMs: args.options?.maxRetryDelayMs,
			onSseEvent: args.rawSseObserver,
		});
	} finally {
		clearTimeout(requestTimeout);
	}
}

/**
 * Opens a Chat Completions stream and retries once per recognized rejection: a reasoning effort the
 * host refuses, a `tool_choice` form it refuses, or strict tool schemas it cannot compile. Each
 * recovery is remembered on the provider session so later turns send the accepted form first.
 */
class OpenAICompletionsConnection {
	readonly #args: ConnectOpenAICompletionsStreamArgs;
	readonly #toolChoiceState: OpenAIToolChoiceState;
	readonly #reasoningEffortFallbacks = new Map<string, OpenAIReasoningEffortFallback>();
	#disableStrictTools: boolean;
	#appliedStrictTools = false;
	#reasoningEffortFallbackKey: string | undefined;
	#requestParams: OpenAICompletionsParams | undefined;

	constructor(args: ConnectOpenAICompletionsStreamArgs) {
		this.#args = args;
		this.#disableStrictTools = args.disableStrictTools;
		// With no session the rejected `tool_choice` form is remembered for this call only, which is
		// still what lets the one retry leave it out.
		this.#toolChoiceState = args.providerSessionState ?? createOpenAIToolChoiceState();
	}

	async open(): Promise<OpenAIStreamHandle<ChatCompletionChunk>> {
		const args = this.#args;
		if (args.requestSignal.aborted) await this.#attempt(true);
		try {
			return await this.#attempt();
		} catch (error) {
			return await this.#recover(error);
		}
	}

	async #attempt(captureOnly = false): Promise<OpenAIStreamHandle<ChatCompletionChunk>> {
		const args = this.#args;
		const builtParams = buildParams(
			args.model,
			args.context,
			args.options,
			this.#disableStrictTools ? "none" : undefined,
			this.#toolChoiceState,
			args.strictToolsScope,
		);
		const { params, strictToolsApplied, reasoningEffortFallbackAllowed } = builtParams;
		this.#appliedStrictTools = strictToolsApplied;
		// Tool-triggered suppression is a hard wire constraint; cached enabled-effort negotiation must not overwrite its `none`.
		const fallbackKey = reasoningEffortFallbackAllowed
			? createOpenAIReasoningEffortFallbackKey("chat-completions", args.trimmedBaseUrl, params.model)
			: undefined;
		const reasoningEffortFallback =
			fallbackKey === undefined
				? undefined
				: this.#reasoningEffortFallbacks.has(fallbackKey)
					? this.#reasoningEffortFallbacks.get(fallbackKey)
					: getOpenAIReasoningEffortFallback(args.providerSessionState, fallbackKey);
		if (reasoningEffortFallback !== undefined) {
			applyOpenAIReasoningEffortFallback(params, reasoningEffortFallback);
		}
		this.#reasoningEffortFallbackKey = fallbackKey;
		const prepareRequest = async (): Promise<RequestInit> => {
			const { body, wireParams } = await serializeOpenAICompletionsRequest(
				params,
				args.model,
				args.options?.onPayload,
			);
			this.#requestParams = wireParams;
			args.onRequestDump(
				{
					provider: args.model.provider,
					api: args.outputApi,
					model: args.model.id,
					method: "POST",
					url: args.completionsUrl,
					headers: args.requestHeaders,
				},
				body,
			);
			return { body };
		};
		if (captureOnly) {
			await prepareRequest();
			throw new AIError.RequestAbortError();
		}
		return await postOpenAICompletionsRequest(args, prepareRequest);
	}

	async #recover(error: unknown): Promise<OpenAIStreamHandle<ChatCompletionChunk>> {
		const args = this.#args;
		const captured = error instanceof OpenAIHttpError ? error.captured : undefined;
		const fallbackKey = this.#reasoningEffortFallbackKey;
		const requestParams = this.#requestParams;
		const aborted = args.requestSignal.aborted;
		const isExplicitDisable = args.options?.disableReasoning === true;
		const reasoningEffortFallback =
			fallbackKey && requestParams && !aborted
				? resolveOpenAIReasoningEffortFallback(error, captured, requestParams, {
						explicitDisable: isExplicitDisable,
					})
				: undefined;
		if (reasoningEffortFallback !== undefined && fallbackKey) {
			this.#reasoningEffortFallbacks.set(fallbackKey, reasoningEffortFallback);
			const handle = await this.#attempt();
			// Explicit-disable fallbacks stay per-request so a reasoning-off side request cannot
			// downgrade later normal turns sharing the session state.
			if (!isExplicitDisable) {
				rememberOpenAIReasoningEffortFallback(args.providerSessionState, fallbackKey, reasoningEffortFallback);
			}
			return handle;
		}
		if (!aborted && isToolChoiceRejection(error, captured, requestParams?.tool_choice)) {
			// The endpoint takes the request but not the `tool_choice` form it named. Retry once
			// without that form and remember it for this model, so the session pays one request.
			// The retry sends no such form, so its own failure cannot land here again.
			rejectToolChoiceForScope(this.#toolChoiceState, args.strictToolsScope, requestParams?.tool_choice);
			return await this.#attempt();
		}
		const strictToolsRejected =
			(args.model.compat.retryWithoutStrictOnGrammarError &&
				!this.#disableStrictTools &&
				isCompiledGrammarTooLargeStrictError(error, captured)) ||
			shouldRetryWithoutStrictTools(error, captured, this.#appliedStrictTools, args.context.tools);
		if (!strictToolsRejected) throw error;
		disableStrictToolsForScope(args.providerSessionState, args.strictToolsScope);
		this.#disableStrictTools = true;
		return await this.#attempt();
	}
}
/**
 * `turn.flush()` releases the bytes the healer and the DeepSeek filter hold back and closes every
 * open block before a stop reason is read, because a released healed tool call makes a natural
 * finish a `toolUse`.
 */
function finalizeOpenAICompletionsStream(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-completions">,
	policy: OpenAICompatPolicy,
	startTime: number,
	turn: OpenAICompletionsTurn,
): void {
	if (turn.finishedAt === undefined) {
		const stopReason = stopReasonForTerminallessEof(output.content, turn.hasCompleteToolCallBatch());
		if (stopReason === undefined) {
			throw new AIError.ProviderResponseError(
				"OpenAI completions stream closed before a terminal finish reason was received",
				{ provider: model.provider, kind: "incomplete-stream" },
			);
		}
		output.stopReason = stopReason;
	}

	turn.flush();
	turn.throwIfRepetitionStop();

	// Some OpenAI-compatible hosts stream structured `tool_calls`, or leak tool-call templates the
	// healer turns into calls, but report `finish_reason: "stop"`. In the OpenAI contract a tool call
	// means "execute and continue", so promote that natural-completion finish to `toolUse` whenever
	// the turn produced tool-call blocks; the agent loop gates execution on the stop reason. `error`,
	// `length` and `aborted` are left untouched. (Anthropic's `end_turn`-with-tool-calls "abandon"
	// semantics stay in its own provider.)
	if (output.stopReason === "stop" && output.content.some(b => b.type === "toolCall")) {
		output.stopReason = "toolUse";
	}

	if (
		policy.stream.emptyLengthFinishIsContextError &&
		output.stopReason === "length" &&
		!hasVisibleAssistantContent(output)
	) {
		output.stopReason = "error";
		output.errorMessage = EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE;
	}

	if (output.stopReason === "aborted") {
		throw new AIError.RequestAbortError();
	}
	if (output.stopReason === "error") {
		throw new AIError.ProviderResponseError(output.errorMessage || "Provider returned an error stop reason", {
			provider: model.provider,
			kind: "runtime",
		});
	}

	output.errorMessage = undefined;
	output.duration = performance.now() - startTime;
	if (turn.firstTokenTime) output.ttft = turn.firstTokenTime - startTime;
	stream.push({ type: "done", reason: output.stopReason, message: output });
	stream.end();
}

async function handleOpenAICompletionsStreamError(
	error: unknown,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-completions">,
	abortTracker: AbortSourceTracker,
	rawRequestDump: RawHttpRequestDump | undefined,
	wireBodyJson: string | undefined,
	startTime: number,
	turn: OpenAICompletionsTurn | undefined,
): Promise<void> {
	// Close open blocks first so consumers tracking text_/thinking_/toolcall_ lifecycles never see
	// orphaned starts on the error path. A throw here must not prevent the terminal error event.
	try {
		turn?.closeOpenBlocks();
	} catch {
		// Deliberate: the terminal error event below is what the caller needs, and a failure closing
		// already-broken blocks must not replace it.
	}
	const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
	const result = await AIError.finalize(error, {
		api: model.api,
		provider: model.provider,
		abortTracker,
		rawRequestDump: materializeDumpBody(rawRequestDump, wireBodyJson),
		capturedErrorResponse,
	});
	AIError.applyFinalizeResult(output, result);
	// Some providers via OpenRouter include extra details here.
	const rawMetadata = readOpenRouterRawMetadata(capturedErrorResponse);
	if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
	output.duration = performance.now() - startTime;
	const firstTokenTime = turn?.firstTokenTime;
	if (firstTokenTime) output.ttft = firstTokenTime - startTime;
	stream.push({ type: "error", reason: output.stopReason, error: output });
	stream.end();
}

/** The raw SSE observer for `options.onSseEvent`, which names each event before the caller reads it. */
function openAICompletionsSseObserver(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): ((event: ServerSentEvent) => void) | undefined {
	const onSseEvent = options?.onSseEvent;
	if (!onSseEvent) return undefined;
	const modelSseObserver = (event: ServerSentEvent) => onSseEvent(event, model);
	return event => {
		resolveOpenAiSseEventName(event);
		notifyRawSseEvent(modelSseObserver, event);
	};
}

/** The stream's idle and first-event timeouts, and the request timeout the first-event timeout bounds. */
function openAICompletionsTimeouts(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): {
	idleTimeoutMs: number | undefined;
	firstEventTimeoutMs: number | undefined;
	requestTimeoutMs: number | undefined;
} {
	const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(model.compat.streamIdleTimeoutMs);
	const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
	const requestTimeoutMs =
		firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
	return { idleTimeoutMs, firstEventTimeoutMs, requestTimeoutMs };
}

const streamOpenAICompletionsOnce = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void runOpenAICompletionsAttempt(model, context, options, stream);
	return stream;
};

/** One request: connect, apply every chunk to an `OpenAICompletionsTurn`, then finalize or report the error. */
async function runOpenAICompletionsAttempt(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const startTime = performance.now();
	const policy = resolveOpenAICompatForRequest(model, options, Boolean(context.tools?.length));
	const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
	let rawRequestDump: RawHttpRequestDump | undefined;
	/** Exact bytes of the last sent request body; materialized into a dump only on the 400/413 path. */
	let wireBodyJson: string | undefined;
	const abortTracker = createAbortSourceTracker(options?.signal);
	const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE);
	const { requestAbortController, requestSignal } = abortTracker;
	// Set once the response opens; the error path closes its open blocks before the terminal error, so
	// both exit paths obey the same block lifecycle.
	let turn: OpenAICompletionsTurn | undefined;
	let responseHeaders: Headers | undefined;

	try {
		const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
		const { idleTimeoutMs, firstEventTimeoutMs, requestTimeoutMs } = openAICompletionsTimeouts(model, options);
		const {
			copilotPremiumRequests,
			baseUrl,
			headers,
			query,
			requestHeaders,
			copilotCacheKey,
			copilotCacheSnapshot,
		} = createRequestSetup(
			model,
			context,
			apiKey,
			options?.headers,
			options?.initiatorOverride,
			getOpenAIPromptCacheKey(options),
			conversationIdForOpenCode(options),
			options?.sessionId,
		);
		const providerSessionState = getOpenAICompletionsProviderSessionState(
			model,
			baseUrl,
			options?.providerSessionState,
		);
		const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
		const trimmedBaseUrl = trimTrailingSlashes(baseUrl);
		const completionsUrl = query
			? `${trimmedBaseUrl}/chat/completions?${new URLSearchParams(query)}`
			: `${trimmedBaseUrl}/chat/completions`;

		const openaiHandle = await new OpenAICompletionsConnection({
			model,
			context,
			options,
			completionsUrl,
			headers,
			requestHeaders,
			trimmedBaseUrl,
			requestTimeoutMs,
			requestSignal,
			abortTracker,
			firstEventTimeoutAbortError,
			rawSseObserver: openAICompletionsSseObserver(model, options),
			providerSessionState,
			strictToolsScope,
			disableStrictTools: isStrictToolsDisabledForScope(providerSessionState, strictToolsScope),
			outputApi: output.api,
			onRequestDump: (dump, wireBody) => {
				rawRequestDump = dump;
				wireBodyJson = wireBody;
			},
			copilotCacheKey,
			copilotCacheSnapshot,
		}).open();
		responseHeaders = openaiHandle.response.headers;
		await notifyProviderResponse(options, openaiHandle.response, model, openaiHandle.requestId);
		if (copilotPremiumRequests !== undefined) {
			output.usage.premiumRequests = copilotPremiumRequests;
		}
		stream.push({ type: "start", partial: output });
		const activeTurn = new OpenAICompletionsTurn(output, stream, policy.stream, rawUsage =>
			parseChunkUsage(
				rawUsage,
				model,
				copilotPremiumRequests,
				output.timestamp,
				parseFireworksCachedPromptTokens(responseHeaders),
			),
		);
		turn = activeTurn;
		const timedOpenaiStream = iterateWithIdleTimeout(openaiHandle.events, {
			idleTimeoutMs,
			firstItemTimeoutMs: firstEventTimeoutMs,
			firstItemErrorMessage: OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
			errorMessage: "OpenAI completions stream stalled while waiting for the next event",
			onIdle: () => requestAbortController.abort(),
			onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
			abortSignal: options?.signal,
			isProgressItem: isOpenAICompletionsProgressChunk,
		});
		const terminalAwareStream = iterateWithTerminalGrace(timedOpenaiStream, {
			finishedAtMs: () => activeTurn.finishedAt,
			graceMs: OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS,
			// The inner idle-timeout generator is parked mid-`next()` when the
			// grace window closes, so abort the transport to settle that read
			// and release the socket immediately (a queued `.return()` alone
			// would wait on the never-arriving next chunk).
			onGraceEnd: () => requestAbortController.abort(),
		});
		for await (const chunk of terminalAwareStream) {
			const streamError = createOpenAICompletionsStreamError(chunk, model.provider);
			if (streamError) throw streamError;
			if (activeTurn.applyChunk(chunk)) break;
		}
		const localAbortReason = abortTracker.getLocalAbortReason();
		if (localAbortReason) {
			throw localAbortReason;
		}
		if (abortTracker.wasCallerAbort()) {
			throw new AIError.RequestAbortError();
		}
		finalizeOpenAICompletionsStream(output, stream, model, policy, startTime, activeTurn);
	} catch (error) {
		await handleOpenAICompletionsStreamError(
			error,
			output,
			stream,
			model,
			abortTracker,
			rawRequestDump,
			wireBodyJson,
			startTime,
			turn,
		);
	}
}

/**
 * Custom APIs deliberately have no catalog compat type. Once an extension
 * explicitly delegates to this streamer, resolve the OpenAI wire policy on a
 * request-local clone while preserving the custom API id on the original model.
 */
function resolveOpenAICompletionsCompat(model: Model<"openai-completions">): Model<"openai-completions"> {
	if (model.compat !== undefined) return model;
	const compat = resolveModelPolicy({
		...model,
		api: "openai-completions",
		compat: model.compatConfig,
	}).compat;
	return { ...model, compat };
}

/**
 * Public entry: wrap the single-attempt streamer with bounded empty-completion
 * retries — flaky gateways occasionally 200 with `delta: {}` + `finish_reason:
 * "stop"` and no usage, which would otherwise stall the agent loop. Shared with
 * the Anthropic provider via `withEmptyCompletionRetry`.
 */
export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (model, context, options) =>
	withEmptyCompletionRetry(resolveOpenAICompletionsCompat(model), context, options, streamOpenAICompletionsOnce);

function createRequestSetup(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
	promptCacheSessionId?: string,
	conversationId?: string,
	sessionId?: string,
): OpenAIRequestSetup & { baseUrl: string } {
	const apiVersion = $env.AZURE_OPENAI_API_VERSION || "2024-10-21";
	const deploymentName = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id) ?? model.id;
	const setup = resolveOpenAIRequestSetup(model, {
		apiKey,
		extraHeaders,
		initiatorOverride,
		promptCacheSessionId,
		conversationId,
		sessionId,
		messages: context.messages,
		defaultBaseUrl: "https://api.openai.com/v1",
		// Provider auth/header overlay: Kimi-code hosts require shared client
		// attribution headers prepended before caller headers. Kept here (not in
		// the shared helper) because it is provider-specific request setup.
		// ClinePass sends the mirrored Cline CLI identity; documented in wire/cline-pass.ts.
		prependHeaders:
			model.provider === "kimi-code"
				? getKimiCommonHeaders
				: model.provider === "cline-pass"
					? () => clinePassClientHeaders(promptCacheSessionId)
					: undefined,
		alibabaCodingPlanAuth: true,
		azureChatCompletions: { apiVersion, deploymentName },
	});
	if (!setup.baseUrl) {
		throw new AIError.ConfigurationError("OpenAI request setup did not resolve a base URL");
	}
	return setup as OpenAIRequestSetup & { baseUrl: string };
}

function resolveOpenAICompatForRequest(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	hasTools: boolean,
): OpenAICompatPolicy {
	return resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: mapToOpenAICompletionsToolChoice(options?.toolChoice),
		hasTools,
	});
}

function dropOpenRouterKimiForcedToolReasoning(
	params: OpenAICompletionsParams,
	_model: Model<"openai-completions">,
	policy: OpenAICompatPolicy,
): void {
	if (
		policy.reasoning.disableReason === "forced-tool-choice" &&
		policy.reasoning.disableMode === "openrouter-enabled-false" &&
		policy.compat.isOpenRouterHost
	) {
		delete params.reasoning;
	}
}

function hasActiveNativeKimiK3Reasoning(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): boolean {
	if (!model.compat.nativeKimiK3Reasoning || !model.reasoning) return false;
	return options?.reasoning !== undefined && !options.disableReasoning;
}

function isChatCompletionsPromptCacheableContentBlock(
	block: unknown,
): block is { type: "text" | "image_url" | "input_audio" | "file"; prompt_cache_breakpoint?: { mode: "explicit" } } {
	if (typeof block !== "object" || block === null || !("type" in block)) return false;
	return block.type === "text" || block.type === "image_url" || block.type === "input_audio" || block.type === "file";
}

function markLatestStableChatCompletionsCacheBreakpoint(messages: ChatCompletionMessageParam[]): boolean {
	let latestInputMessage = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "developer") {
			latestInputMessage = i;
			break;
		}
	}
	if (latestInputMessage <= 0) return false;

	for (let i = latestInputMessage - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user" && message.role !== "developer" && message.role !== "system") continue;
		if (typeof message.content === "string") {
			messages[i] = {
				...message,
				content: [{ type: "text", text: message.content, prompt_cache_breakpoint: { mode: "explicit" } }],
			};
			return true;
		}
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j];
			if (!isChatCompletionsPromptCacheableContentBlock(block)) continue;
			Object.assign(block, { prompt_cache_breakpoint: { mode: "explicit" } });
			return true;
		}
	}
	return false;
}

function applyOpenAIChatCompletionsPromptCachePolicy(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): void {
	const promptCacheKey = getOpenAIPromptCacheKey(options);
	if (model.compat.supportsPromptCacheKey && promptCacheKey !== undefined) {
		params.prompt_cache_key = promptCacheKey;
	}

	const promptCache = options?.promptCache;
	if (!promptCache || resolveCacheRetention(options?.cacheRetention) === "none") return;
	if (!model.compat.supportsPromptCacheBreakpoints) {
		if (promptCache.mode === "explicit") {
			throw new AIError.ConfigurationError(
				`OpenAI explicit prompt caching is unsupported for ${model.provider}/${model.id}; enable compat.supportsPromptCacheBreakpoints only for a compatible endpoint.`,
			);
		}
		return;
	}

	params.prompt_cache_key = promptCacheKey;
	params.prompt_cache_options = {
		mode: promptCache.mode,
		ttl: promptCache.ttl ?? model.compat.promptCacheBreakpointTtl,
	};
	if (promptCache.mode === "explicit" && promptCache.breakpoint !== "none")
		markLatestStableChatCompletionsCacheBreakpoint(params.messages);
}

/** Copies the sampling options a caller set onto the request. A host accepts at most four stop sequences. */
function applyOpenAICompletionsSampling(
	params: OpenAICompletionsParams,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedOpenAICompat,
): void {
	if (!options) return;
	if (compat.supportsSamplingParams) {
		if (options.temperature !== undefined) {
			params.temperature = options.temperature;
		}
		if (options.topP !== undefined) {
			params.top_p = options.topP;
		}
		if (options.topK !== undefined) {
			params.top_k = options.topK;
		}
		if (options.minP !== undefined) {
			params.min_p = options.minP;
		}
		if (compat.supportsPenaltyAndStopParams) {
			if (options.presencePenalty !== undefined) {
				params.presence_penalty = options.presencePenalty;
			}
			if (options.repetitionPenalty !== undefined) {
				params.repetition_penalty = options.repetitionPenalty;
			}
			if (options.frequencyPenalty !== undefined) {
				params.frequency_penalty = options.frequencyPenalty;
			}
		}
	}
	if (options.stopSequences?.length && compat.supportsPenaltyAndStopParams) {
		const seqs = options.stopSequences;
		params.stop = seqs.length === 1 ? seqs[0] : seqs.slice(0, 4);
	}
}

function applyOpenAICompletionsTools(
	params: OpenAICompletionsParams,
	context: Context,
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride: ToolStrictModeOverride,
): { toolStrictMode: AppliedToolStrictMode; strictToolsApplied: boolean } {
	if (context.tools?.length) {
		const builtTools = convertTools(context.tools, compat, toolStrictModeOverride);
		params.tools = builtTools.tools;
		return { toolStrictMode: builtTools.toolStrictMode, strictToolsApplied: builtTools.strictToolsApplied };
	}
	if (context.tools === undefined && hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires the `tools` param when the conversation
		// contains tool_calls/tool_results, even when no tools are offered this turn.
		// Only inject the sentinel when the caller passed `context.tools = undefined`
		// (i.e. tools were not specified at all). An explicit `context.tools = []` means
		// the caller opted out of tools for this turn (as /btw and IRC background replies
		// do via AgentSession.runEphemeralTurn) — honour that intent and emit nothing,
		// so LiteLLM → Bedrock never sees an empty `toolConfig` block.
		params.tools = [];
	}
	return { toolStrictMode: "none", strictToolsApplied: false };
}

/** Sets `tool_choice` to the form this host accepts for the caller's choice. */
function applyOpenAICompletionsToolChoice(
	params: OpenAICompletionsParams,
	toolChoice: ToolChoice | undefined,
	compat: ResolvedOpenAICompat,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): string | undefined {
	if (toolChoice && compat.supportsToolChoice) {
		params.tool_choice = mapToOpenAICompletionsToolChoice(toolChoice);
	}
	const forcedToolName =
		typeof params.tool_choice === "object" && params.tool_choice !== null && "function" in params.tool_choice
			? params.tool_choice.function.name
			: undefined;
	if (typeof params.tool_choice === "object" && params.tool_choice !== null && !compat.supportsNamedToolChoice) {
		if (
			forcedToolName !== undefined &&
			Array.isArray(params.tools) &&
			params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName)
		) {
			params.tools = params.tools.filter(tool => tool.type === "function" && tool.function.name === forcedToolName);
		}
		params.tool_choice = "required";
	}
	if (
		forcedToolName !== undefined &&
		Array.isArray(params.tools) &&
		params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName) &&
		hasActiveNativeKimiK3Reasoning(model, options)
	) {
		params.tool_choice = "required";
	}
	if (isForcedToolChoice(params.tool_choice) && !compat.supportsForcedToolChoice) {
		// Some thinking-required OpenAI-compatible models reject forced
		// `tool_choice` while still accepting tools with the default auto
		// selector. Keep the tool available and let the model choose it.
		params.tool_choice = "auto";
	}
	return forcedToolName;
}
/** Removes a `tool_choice` the request cannot send as built. */
function dropUnsendableToolChoice(
	params: OpenAICompletionsParams,
	toolChoiceState: OpenAIToolChoiceState,
	toolChoiceScope: OpenAIStrictToolsScope,
	forcedToolName: string | undefined,
): void {
	const offeredTools = Array.isArray(params.tools) ? params.tools : [];
	if (
		offeredTools.length === 0 &&
		(params.tool_choice === "none" || isForcedToolChoice(params.tool_choice))
	) {
		// No tools exist to honor none or a forced choice, so neither directive belongs on the wire.
		delete params.tool_choice;
	}

	if (
		forcedToolName !== undefined &&
		!offeredTools.some(tool => tool.type === "function" && tool.function.name === forcedToolName)
	) {
		// A forced named choice is only valid when this request offers that function.
		delete params.tool_choice;
	}
	if (isToolChoiceRejectedForScope(toolChoiceState, toolChoiceScope, params.tool_choice)) {
		// This model rejected this form of `tool_choice` earlier in the session. Leaving the field
		// out is `auto`, and the reasoning policy below reads the choice that is actually sent.
		delete params.tool_choice;
	}
}


function applyOpenAICompletionsOutputTokens(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	options: OpenAICompletionsOptions | undefined,
): void {
	const outputToken = resolveOpenAIOutputTokenParam({
		field: compat.maxTokensField,
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		routedUpstreamSelfCaps: compat.routedUpstreamSelfCaps,
		alwaysSendMaxTokens: compat.alwaysSendMaxTokens,
		providerOutputClamp: resolveOpenAICompletionsOutputClamp(model, compat),
	});
	if (outputToken?.field === "max_tokens") {
		params.max_tokens = outputToken.value;
	} else if (outputToken?.field === "max_completion_tokens") {
		params.max_completion_tokens = outputToken.value;
	}
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	toolStrictModeOverride: ToolStrictModeOverride,
	toolChoiceState: OpenAIToolChoiceState,
	toolChoiceScope: OpenAIStrictToolsScope,
): {
	params: OpenAICompletionsParams;
	toolStrictMode: AppliedToolStrictMode;
	strictToolsApplied: boolean;
	reasoningEffortFallbackAllowed: boolean;
} {
	const initialPolicy = resolveOpenAICompatForRequest(model, options, Boolean(context.tools?.length));
	const initialCompat = initialPolicy.compat as ResolvedOpenAICompat;
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);

	const params: OpenAICompletionsParams = {
		model: resolveOpenAICompletionsModelId(model, options),
		messages: [],
		stream: true,
	};
	if (initialCompat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}
	if (initialCompat.supportsStore) {
		params.store = false;
	}
	applyOpenAICompletionsSampling(params, options, initialCompat);
	applyOpenAIServiceTier(params, options?.serviceTier, model);

	const { toolStrictMode, strictToolsApplied } = applyOpenAICompletionsTools(
		params,
		context,
		initialCompat,
		toolStrictModeOverride,
	);
	const forcedToolName = applyOpenAICompletionsToolChoice(
		params,
		options?.toolChoice,
		initialCompat,
		model,
		options,
	);
	dropUnsendableToolChoice(params, toolChoiceState, toolChoiceScope, forcedToolName);
	if (shouldDropAutoToolChoiceForReasoning(model, initialCompat, params.tool_choice, options)) {
		delete params.tool_choice;
	}

	const finalPolicy = resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: params.tool_choice,
		hasTools: Array.isArray(params.tools) && params.tools.length > 0,
	});
	const compat = finalPolicy.compat as ResolvedOpenAICompat;
	const messages = convertMessages(model, context, compat);
	maybeAddAnthropicCacheControl(compat, messages, cacheRetention);
	params.messages = messages;
	applyOpenAICompletionsOutputTokens(params, model, compat, options);
	applyChatCompletionsToolStream(params, model, compat);

	applyChatCompletionsReasoningParams(params, model, compat, {
		...options,
		toolChoice: params.tool_choice,
		hasTools: Array.isArray(params.tools) && params.tools.length > 0,
	});
	dropOpenRouterKimiForcedToolReasoning(params, model, finalPolicy);

	applyOpenAIGatewayRouting(params, compat, cacheRetention !== "none");

	applyOpenAIExtraBody(params, compat.extraBody, {
		dropThinkingWhenReasoningEffort: compat.dropThinkingWhenReasoningEffort,
	});
	applyOpenAIChatCompletionsPromptCachePolicy(params, model, options);

	return {
		params,
		toolStrictMode,
		strictToolsApplied,
		reasoningEffortFallbackAllowed: finalPolicy.reasoning.disableReason !== "tools",
	};
}

/** The `fireworks-cached-prompt-tokens` response header, read when the SSE body omits cached-token counts. */
function parseFireworksCachedPromptTokens(headers: Headers | undefined): number | undefined {
	const raw = headers?.get("fireworks-cached-prompt-tokens");
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Body cached-token counts win when present; the header is the fallback only when the body reports no hit. */
function resolveFireworksCachedTokens(
	cachedTokens: unknown,
	promptCacheHitTokens: unknown,
	promptTokenCachedTokens: unknown,
	cachedContentTokenCount: unknown,
	cachedTokensHeader: number | undefined,
): number {
	const bodyCachedTokens = firstPositiveNumber(
		cachedTokens,
		promptCacheHitTokens,
		promptTokenCachedTokens,
		cachedContentTokenCount,
	);
	const resolvedCachedTokens =
		bodyCachedTokens > 0 ||
		cachedTokens === 0 ||
		promptCacheHitTokens === 0 ||
		promptTokenCachedTokens === 0 ||
		cachedContentTokenCount === 0
			? bodyCachedTokens
			: (cachedTokensHeader ?? 0);
	return resolvedCachedTokens;
}

export function parseChunkUsage(
	rawUsage: object,
	model: Model<"openai-completions">,
	premiumRequests: number | undefined,
	_timestamp?: number,
	cachedTokensHeader?: number,
): AssistantMessage["usage"] {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	const promptTokenDetails =
		typeof rawPromptTokenDetails === "object" && rawPromptTokenDetails !== null
			? (rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails)
			: undefined;
	const rawCompletionTokenDetails = usageLike.completion_tokens_details;
	const completionTokenDetails =
		typeof rawCompletionTokenDetails === "object" && rawCompletionTokenDetails !== null
			? (rawCompletionTokenDetails as OpenAICompletionsCompletionTokenDetails)
			: undefined;
	const completionTokens = usageLike.completion_tokens;
	const promptTokens = usageLike.prompt_tokens;
	const cachedTokens = usageLike.cached_tokens;
	const promptCacheHitTokens = usageLike.prompt_cache_hit_tokens;
	const promptCacheMissTokens = usageLike.prompt_cache_miss_tokens;
	const promptTokenCachedTokens = promptTokenDetails?.cached_tokens;
	const cachedContentTokenCount = usageLike.cachedContentTokenCount;
	const completionReasoningTokens = completionTokenDetails?.reasoning_tokens;
	const cacheWriteTokens = promptTokenDetails?.cache_write_tokens;
	const outputTokens = typeof completionTokens === "number" ? completionTokens : 0;
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: typeof promptTokens === "number" ? promptTokens : 0,
		outputTokens,
		cachedTokens: resolveFireworksCachedTokens(
			cachedTokens,
			promptCacheHitTokens,
			promptTokenCachedTokens,
			cachedContentTokenCount,
			cachedTokensHeader,
		),
		reasoningTokens: typeof completionReasoningTokens === "number" ? completionReasoningTokens : 0,
		cacheWriteOpenRouter: typeof cacheWriteTokens === "number" ? cacheWriteTokens : undefined,
		cacheWriteDeepSeek: typeof promptCacheMissTokens === "number" ? promptCacheMissTokens : undefined,
		hasDeepSeekCacheHitAndMiss: typeof promptCacheHitTokens === "number" && typeof promptCacheMissTokens === "number",
	});
	const usage: AssistantMessage["usage"] = {
		...accounting,
		cost: emptyCost(),
		...(premiumRequests !== undefined ? { premiumRequests } : {}),
	};
	calculateCost(model, usage);
	applyProviderReportedCost(model, usage, rawUsage);
	return usage;
}

/**
 * Place the single Anthropic-style breakpoint for an OpenAI-compatible payload.
 *
 * `cacheRetention` is a cross-provider request option, and every other
 * implementation of this idea consumes it: the Anthropic provider
 * (`getCacheControl`), Bedrock (`buildSystemPrompt` / `convertMessages`), and
 * the Responses path for the very same OpenRouter Claude rows
 * (`maybeAddOpenRouterAnthropicCacheControl`). This path ignored it entirely,
 * so `none` still wrote a breakpoint and paid the cache-write premium a caller
 * had opted out of, and `long` silently degraded to the default five-minute
 * window while the Responses path for the same model asked for an hour.
 */
function maybeAddAnthropicCacheControl(
	compat: ResolvedOpenAICompat,
	messages: ChatCompletionMessageParam[],
	cacheRetention: CacheRetention,
): void {
	if (compat.cacheControlFormat !== "anthropic") return;
	if (cacheRetention === "none") return;
	const cacheControl: CacheControlEphemeral =
		cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
	// Anthropic-style caching requires cache_control on a text part. Add a breakpoint
	// on the last user/assistant message (walking backwards until we find text content).
	for (let i = messages.length - 1; i >= 0; i--) {
		if (placeAnthropicCacheBreakpoint(messages[i], cacheControl)) return;
	}
}

/** Puts `cacheControl` on the last non-empty text of a user, assistant or developer message. */
function placeAnthropicCacheBreakpoint(msg: ChatCompletionMessageParam, cacheControl: CacheControlEphemeral): boolean {
	if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "developer") return false;
	const content = msg.content;
	if (typeof content === "string") {
		if (content.trim().length === 0) return false;
		msg.content = [Object.assign({ type: "text" as const, text: content }, { cache_control: { ...cacheControl } })];
		return true;
	}
	if (!Array.isArray(content)) return false;
	// Find last non-empty text part and add cache_control. Empty assistant
	// content is valid for tool-call replay, but Anthropic/OpenRouter reject
	// empty text blocks once cache_control turns it into structured content.
	for (let j = content.length - 1; j >= 0; j--) {
		const part = content[j];
		if (part?.type === "text" && part.text.trim().length > 0) {
			Object.assign(part, { cache_control: { ...cacheControl } });
			return true;
		}
	}
	return false;
}

function normalizeCompletionsToolCallId(
	id: string,
	source: AssistantMessage | undefined,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): string {
	if (compat.requiresMistralToolIds) return normalizeMistralToolId(id, true);

	const isSameModelSource =
		source !== undefined &&
		source.provider === model.provider &&
		source.api === model.api &&
		source.model === model.id;
	if (!isSameModelSource && id.includes("|")) {
		const [callId] = id.split("|");
		const normalizedCallId = normalizeToolCallId(callId);
		return normalizedCallId.length > OPENAI_TOOL_CALL_ID_MAX_LENGTH
			? normalizedCallId.slice(0, OPENAI_TOOL_CALL_ID_MAX_LENGTH)
			: normalizedCallId;
	}

	if (compat.usesOpenAIToolCallIdLimit) {
		return id.length > OPENAI_TOOL_CALL_ID_MAX_LENGTH ? id.slice(0, OPENAI_TOOL_CALL_ID_MAX_LENGTH) : id;
	}
	return id;
}

function buildOpenAISystemMessageParams(
	systemPrompt: Context["systemPrompt"],
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const systemPrompts = normalizeSystemPrompts(systemPrompt);
	if (systemPrompts.length === 0) return [];
	const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
	const role = useDeveloperRole ? "developer" : "system";
	if (compat.supportsMultipleSystemMessages) {
		return systemPrompts.map(prompt => ({ role, content: prompt }));
	}
	return [{ role, content: systemPrompts.join("\n\n") }];
}

function convertOpenAIUserOrDeveloperMessage(
	msg: Message & { role: "user" | "developer" },
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam | null {
	const devAsUser = !compat.supportsDeveloperRole;
	const role = !devAsUser && msg.role === "developer" ? "developer" : "user";
	if (typeof msg.content === "string") {
		const text = msg.content.toWellFormed();
		if (text.trim().length === 0) return null;
		return { role, content: text };
	}
	const supportsImages = isOpenAICompletionsVisionSupported(model);
	const supportsVideos = model.input.includes("video");
	const content = convertOpenAIUserContentParts(msg.content, supportsImages, supportsVideos);
	if (content.length === 0) return null;
	if (
		msg.role === "developer" &&
		role === "developer" &&
		!msg.content.some(item => item.type === "image" || item.type === "video")
	) {
		return {
			role: "developer",
			content: content
				.filter((item): item is ChatCompletionContentPartText => item.type === "text")
				.map(item => item.text)
				.join("\n"),
		};
	}
	return { role: "user", content };
}

/** Drops blank text, and replaces images and videos a model cannot read with one placeholder each after the rest. */
function convertOpenAIUserContentParts(
	items: readonly (TextContent | ImageContent | VideoContent)[],
	supportsImages: boolean,
	supportsVideos: boolean,
): ChatCompletionContentPart[] {
	const content: ChatCompletionContentPart[] = [];
	let omittedImages = false;
	let omittedVideos = false;
	for (const item of items) {
		if (item.type === "text") {
			const text = item.text.toWellFormed();
			if (text.trim().length === 0) continue;
			content.push({ type: "text", text } satisfies ChatCompletionContentPartText);
		} else if (item.type === "image") {
			if (supportsImages) {
				content.push({
					type: "image_url",
					image_url: {
						url: item.url ?? `data:${item.mimeType};base64,${item.data}`,
						// Chat Completions has no "original"; omit it (provider default).
						...(item.detail && item.detail !== "original" ? { detail: item.detail } : {}),
					},
				} satisfies ChatCompletionContentPartImage);
			} else {
				omittedImages = true;
			}
		} else if (item.type === "video") {
			if (supportsVideos) {
				content.push({
					type: "video_url",
					video_url: { url: `data:${item.mimeType};base64,${item.data}` },
				} satisfies ChatCompletionContentPartVideo);
			} else {
				omittedVideos = true;
			}
		}
	}
	if (omittedImages) {
		content.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER } satisfies ChatCompletionContentPartText);
	}
	if (omittedVideos) {
		content.push({
			type: "text",
			text: NON_VIDEO_MODEL_PLACEHOLDER,
		} satisfies ChatCompletionContentPartText);
	}
	return content;
}

function buildOpenAIAssistantContent(nonEmptyTextBlocks: TextContent[]): string | null {
	if (nonEmptyTextBlocks.length === 0) return null;
	return nonEmptyTextBlocks
		.map((b, i) => {
			const text = b.text.toWellFormed();
			return isDemotedThinking(b) && i < nonEmptyTextBlocks.length - 1 ? `${text}\n` : text;
		})
		.join("");
}

/** Mistral Medium 3.5 reads thinking from ordered content parts, not a top-level reasoning_content field. */
function buildMistralReasoningContentParts(
	content: AssistantMessage["content"],
): Array<ChatCompletionContentPartText | ChatCompletionMistralThinkingPart> {
	const parts: Array<ChatCompletionContentPartText | ChatCompletionMistralThinkingPart> = [];
	for (const block of content) {
		if (block.type === "thinking" && block.thinking.trim()) {
			parts.push({ type: "thinking", thinking: [{ type: "text", text: block.thinking.toWellFormed() }] });
		} else if (block.type === "text" && block.text.trim()) {
			parts.push({ type: "text", text: block.text.toWellFormed() });
		}
	}
	return parts;
}

function applyOpenAIAssistantThinking(
	assistantMsg: OpenAICompletionsAssistantMessageParam,
	nonEmptyThinkingBlocks: ThinkingContent[],
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): void {
	if (nonEmptyThinkingBlocks.length === 0) return;
	if (compat.requiresThinkingAsText) {
		const thinkingText = nonEmptyThinkingBlocks.map(b => renderDemotedThinking(model.id, b.thinking)).join(" ");
		assistantMsg.content =
			typeof assistantMsg.content === "string" && assistantMsg.content.length > 0
				? `${thinkingText} ${assistantMsg.content}`
				: thinkingText;
		return;
	}
	const reasoningField = resolveOpenAIReplayedReasoningField(
		nonEmptyThinkingBlocks[0].thinkingSignature,
		model,
		compat,
	);
	if (reasoningField) assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
}

/**
 * The wire field that replays an assistant turn's thinking, or undefined when the endpoint takes none.
 * The field the turn streamed its reasoning on is reused where the endpoint accepts it.
 */
function resolveOpenAIReplayedReasoningField(
	signature: string | undefined,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): OpenAICompletionsReasoningField | undefined {
	const configuredField = compat.reasoningContentField ?? "reasoning_content";
	const streamed = signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text";
	if (compat.requiresReasoningContentForToolCalls) {
		return streamed && compat.allowsSyntheticReasoningContentForToolCalls ? signature : configuredField;
	}
	if (compat.thinkingFormat === "zai" && model.reasoning) return configuredField;
	if (compat.replayReasoningContent) return streamed ? signature : configuredField;
	return undefined;
}

/**
 * Fills the reasoning field an endpoint requires on a turn that replayed none. An endpoint that rejects
 * synthetic reasoning receives the turn's streamed reasoning, else an empty string; one that accepts it
 * receives "." on a tool-calling turn. Returns whether the turn carries a reasoning field.
 */
function applyOpenAIAssistantReasoningTiers(
	assistantMsg: OpenAICompletionsAssistantMessageParam,
	allThinkingBlocks: ThinkingContent[],
	toolCallsLength: number,
	compat: ResolvedOpenAICompat,
): boolean {
	if (
		assistantMsg.reasoning_content !== undefined ||
		assistantMsg.reasoning !== undefined ||
		assistantMsg.reasoning_text !== undefined
	) {
		return true;
	}
	if (!compat.requiresReasoningContentForToolCalls) return false;
	const reasoningField = compat.reasoningContentField ?? "reasoning_content";
	if (!compat.allowsSyntheticReasoningContentForToolCalls) {
		if (toolCallsLength === 0 && !compat.requiresReasoningContentForAllAssistantTurns) return false;
		const signature = allThinkingBlocks[0]?.thinkingSignature;
		const streamed = signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text";
		const fallback = allThinkingBlocks.length === 0 ? (compat.syntheticReasoningContentFallback ?? "") : "";
		assistantMsg[reasoningField] = streamed ? allThinkingBlocks.map(b => b.thinking).join("\n") : fallback;
		return true;
	}
	if (toolCallsLength === 0) return false;
	if (
		compat.thinkingFormat !== "openai" &&
		compat.thinkingFormat !== "openrouter" &&
		compat.thinkingFormat !== "zai"
	) {
		return false;
	}
	assistantMsg[reasoningField] = ".";
	return true;
}

/**
 * Maps the tool call ids an assistant turn recorded to the ids sent on the wire, so each tool result
 * replays against the id its call went out with. A call whose id normalizes to nothing gets a generated one.
 */
class OpenAIToolCallIds {
	readonly #model: Model<"openai-completions">;
	readonly #compat: ResolvedOpenAICompat;
	readonly #assigned = new Map<string, string[]>();
	#generated = 0;

	constructor(model: Model<"openai-completions">, compat: ResolvedOpenAICompat) {
		this.#model = model;
		this.#compat = compat;
	}

	/** The wire id for a tool call, queued for the result that answers it. */
	assign(callId: string, seed: string, source?: AssistantMessage): string {
		const wireId = this.#ensureToolCallId(callId, seed, source);
		const queue = this.#assigned.get(callId);
		if (queue) queue.push(wireId);
		else this.#assigned.set(callId, [wireId]);
		return wireId;
	}

	/** The wire id for a tool result: the next one its call was assigned, else a fresh one. */
	resolve(callId: string, seed: string): string {
		const queue = this.#assigned.get(callId);
		const assigned = queue?.shift();
		if (queue?.length === 0) this.#assigned.delete(callId);
		return assigned ?? this.#ensureToolCallId(callId, seed);
	}

	#ensureToolCallId(rawId: string, seed: string, source?: AssistantMessage): string {
		const normalized = normalizeCompletionsToolCallId(rawId, source, this.#model, this.#compat);
		if (normalized.trim().length > 0) return normalized;
		this.#generated += 1;
		const hash = Bun.hash(`${this.#model.provider}:${this.#model.id}:${seed}:${this.#generated}`).toString(36);
		return `call_${hash}`;
	}
}

function applyOpenAIAssistantToolCalls(
	assistantMsg: OpenAICompletionsAssistantMessageParam,
	toolCalls: ToolCall[],
	compat: ResolvedOpenAICompat,
	toolCallIds: OpenAIToolCallIds,
	source: AssistantMessage,
	msgIndex: number,
): void {
	if (toolCalls.length === 0) return;
	assistantMsg.tool_calls = toolCalls.map((tc, toolCallIndex) => {
		const toolCallId = toolCallIds.assign(tc.id, `${msgIndex}:${toolCallIndex}:${tc.name}`, source);
		const replayedToolCall: OpenAICompletionsFunctionToolCall = {
			id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
			type: "function",
			function: {
				name: tc.name,
				arguments: serializeToolArguments(tc.arguments, tc.name),
			},
		};
		const stored = normalizeStoredGeminiSignature(parseStoredThoughtSignature(tc.thoughtSignature));
		const extraContent = getGeminiThoughtSignatureExtraContent(stored?.perCall);
		if (extraContent) replayedToolCall.extra_content = extraContent;
		return replayedToolCall;
	});
	for (const toolCall of toolCalls) {
		const stored = normalizeStoredGeminiSignature(parseStoredThoughtSignature(toolCall.thoughtSignature));
		const messageSignature = getGeminiMessageThoughtSignature(stored?.message);
		if (!messageSignature) continue;
		assistantMsg[messageSignature.field] = messageSignature.signature;
		break;
	}
	const reasoningDetails = toolCalls.flatMap(tc => {
		const stored = normalizeStoredGeminiSignature(parseStoredThoughtSignature(tc.thoughtSignature));
		const perCall = stored?.perCall;
		if (perCall === undefined || getGeminiThoughtSignatureExtraContent(perCall)) return [];
		return [perCall];
	});
	if (reasoningDetails.length > 0) assistantMsg.reasoning_details = reasoningDetails;
}

interface OpenAIAssistantContentParts {
	nonEmptyText: TextContent[];
	thinking: ThinkingContent[];
	nonEmptyThinking: ThinkingContent[];
	toolCalls: ToolCall[];
}

function partitionOpenAIAssistantContent(content: AssistantMessage["content"]): OpenAIAssistantContentParts {
	const parts: OpenAIAssistantContentParts = { nonEmptyText: [], thinking: [], nonEmptyThinking: [], toolCalls: [] };
	for (const block of content) {
		if (block.type === "text") {
			if (block.text && block.text.trim().length > 0) parts.nonEmptyText.push(block);
		} else if (block.type === "thinking") {
			parts.thinking.push(block);
			if (block.thinking && block.thinking.trim().length > 0) parts.nonEmptyThinking.push(block);
		} else if (block.type === "toolCall") {
			parts.toolCalls.push(block);
		}
	}
	return parts;
}

function convertOpenAIAssistantMessage(
	msg: AssistantMessage,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	toolCallIds: OpenAIToolCallIds,
	msgIndex: number,
): OpenAICompletionsAssistantMessageParam | null {
	const assistantMsg: OpenAICompletionsAssistantMessageParam = {
		role: "assistant",
		content: null,
	};
	const parts = partitionOpenAIAssistantContent(msg.content);
	assistantMsg.content = buildOpenAIAssistantContent(parts.nonEmptyText);
	if (compat.mistralReasoningContentParts && parts.nonEmptyThinking.length > 0) {
		assistantMsg.content = buildMistralReasoningContentParts(msg.content);
	} else {
		applyOpenAIAssistantThinking(assistantMsg, parts.nonEmptyThinking, model, compat);
	}
	const hasReasoningField = applyOpenAIAssistantReasoningTiers(
		assistantMsg,
		parts.thinking,
		parts.toolCalls.length,
		compat,
	);
	const liteLLMThinkingBlocks = encodeLiteLLMThinkingBlocks(msg.content);
	if (liteLLMThinkingBlocks.length > 0) assistantMsg.thinking_blocks = liteLLMThinkingBlocks;
	applyOpenAIAssistantToolCalls(assistantMsg, parts.toolCalls, compat, toolCallIds, msg, msgIndex);

	if (assistantMsg.content === null && (hasReasoningField || assistantMsg.tool_calls)) {
		assistantMsg.content = "";
	}
	const content = assistantMsg.content;
	const hasContent = typeof content === "string" && content.length > 0;
	if (!hasContent && assistantMsg.tool_calls && compat.requiresAssistantContentForToolCalls) {
		assistantMsg.content = ".";
	}
	if (!hasContent && !assistantMsg.tool_calls && !hasReasoningField) {
		return null;
	}
	return assistantMsg;
}

/**
 * Converts the run of tool results that starts at `startIndex`. Images a vision model can read follow the
 * run in one user message, since the tool role takes text only.
 */
function convertOpenAIToolResultsBatch(
	startIndex: number,
	transformedMessages: Message[],
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	toolCallIds: OpenAIToolCallIds,
	params: ChatCompletionMessageParam[],
): { nextIndex: number; endsOnToolResult: boolean } {
	const supportsImages = isOpenAICompletionsVisionSupported(model);
	const imageBlocks: OpenAIToolResultImagePart[] = [];
	let j = startIndex;
	for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
		const toolMsg = transformedMessages[j] as ToolResultMessage;
		const toolCallId = toolCallIds.resolve(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
		params.push(convertOpenAIToolResult(toolMsg, toolCallId, supportsImages ? imageBlocks : undefined, compat));
	}
	if (imageBlocks.length === 0) return { nextIndex: j, endsOnToolResult: true };
	if (compat.requiresAssistantAfterToolResult) {
		params.push({ role: "assistant", content: "I have processed the tool results." });
	}
	params.push({
		role: "user",
		content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks],
	});
	return { nextIndex: j, endsOnToolResult: false };
}

type OpenAIToolResultImagePart = { type: "image_url"; image_url: { url: string } };

/** Converts one tool result; `imageBlocks`, given when the model reads images, receives its images. */
function convertOpenAIToolResult(
	toolMsg: ToolResultMessage,
	toolCallId: string,
	imageBlocks: OpenAIToolResultImagePart[] | undefined,
	compat: ResolvedOpenAICompat,
): OpenAICompletionsToolMessageParam {
	let textResult = "";
	let separator = "";
	let hasImages = false;
	for (const block of toolMsg.content) {
		if (block.type === "text") {
			textResult += separator + block.text;
			separator = "\n";
		} else if (block.type === "image") {
			hasImages = true;
			imageBlocks?.push({
				type: "image_url",
				image_url: { url: block.url ?? `data:${block.mimeType};base64,${block.data}` },
			});
		}
	}
	let toolResultContent = textResult;
	if (hasImages && !imageBlocks) toolResultContent = joinTextWithImagePlaceholder(textResult, true);
	else if (hasImages && textResult.length === 0) toolResultContent = "(see attached image)";
	const toolResultMsg: OpenAICompletionsToolMessageParam = {
		role: "tool",
		content: toolResultContent.toWellFormed(),
		tool_call_id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
	};
	if (compat.requiresToolResultName && toolMsg.toolName) {
		toolResultMsg.name = toolMsg.toolName;
	}
	return toolResultMsg;
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompat = resolveOpenAICompatPolicy(model, { endpoint: "chat-completions" })
		.compat as ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const maxNormalizedToolCallIdLength = compat.requiresMistralToolIds
		? 9
		: compat.usesOpenAIToolCallIdLimit
			? OPENAI_TOOL_CALL_ID_MAX_LENGTH
			: undefined;
	const duplicateToolCallIdSuffixPrefix = compat.requiresMistralToolIds ? "dup" : undefined;
	const transformedMessages = transformMessages(
		context.messages,
		model,
		(id, _target, source) => normalizeCompletionsToolCallId(id, source, model, compat),
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
		compat,
	);
	const toolCallIds = new OpenAIToolCallIds(model, compat);
	const params = buildOpenAISystemMessageParams(context.systemPrompt, model, compat);
	let afterToolResult = false;
	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (msg.role === "toolResult") {
			const batch = convertOpenAIToolResultsBatch(i, transformedMessages, model, compat, toolCallIds, params);
			i = batch.nextIndex - 1;
			afterToolResult = batch.endsOnToolResult;
			continue;
		}
		const converted =
			msg.role === "assistant"
				? convertOpenAIAssistantMessage(msg, model, compat, toolCallIds, i)
				: convertOpenAIUserOrDeveloperMessage(msg, model, compat);
		// A message the converter drops leaves the role sequence as if it were never there: it neither
		// earns the synthetic assistant turn a tool result needs before the next user turn, nor
		// consumes it on behalf of the message that follows.
		if (!converted) continue;
		if (afterToolResult && msg.role !== "assistant" && compat.requiresAssistantAfterToolResult) {
			params.push({ role: "assistant", content: "I have processed the tool results." });
		}
		params.push(converted);
		afterToolResult = false;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride?: ToolStrictModeOverride,
): BuiltOpenAICompletionTools {
	const rejectRootObjectUnion = compat.rejectRootObjectUnion;
	const adaptedTools = tools.map(tool => {
		const strict = !NO_STRICT && compat.supportsStrictMode !== false && tool.strict !== false;
		const baseParameters = rejectRootObjectUnion
			? flattenExclusiveRequiredRootUnion(toolWireSchema(tool))
			: toolWireSchema(tool);
		const adapted = adaptSchemaForStrict(baseParameters, strict);
		return {
			tool,
			baseParameters,
			parameters: adapted.schema,
			strict: adapted.strict,
		};
	});

	const requestedStrictMode = toolStrictModeOverride ?? compat.toolStrictMode;
	const toolStrictMode =
		requestedStrictMode === "none"
			? "none"
			: requestedStrictMode === "all_strict"
				? adaptedTools.every(tool => tool.strict)
					? "all_strict"
					: "none"
				: "mixed";

	const wireTools: ChatCompletionTool[] = [];
	let anyStrictEmitted = false;
	for (const { tool, baseParameters, parameters, strict } of adaptedTools) {
		const includeStrict = toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && strict);
		// `strict: false` is semantically distinct from omitted `strict` on some
		// backends: with it absent, optional properties may be over-filled with
		// placeholder values (#4336). Preserve the author's explicit `false`,
		// but only in "mixed" mode against a provider that understands the
		// field — the `all_strict → none` collapse and `supportsStrictMode:
		// false` paths deliberately keep the wire flag uniformly absent.
		const includeExplicitFalse =
			!includeStrict && tool.strict === false && toolStrictMode === "mixed" && compat.supportsStrictMode !== false;
		const wireParameters = includeStrict ? parameters : baseParameters;
		// Moonshot/Kimi native hosts validate against the stricter MFJS subset
		// (const→enum, typed enums, no validators) and 400 otherwise.
		// Grammar-constrained local backends (llama.cpp, LM Studio, vLLM)
		// build a GBNF grammar from the schema and 400 with
		// `Unrecognized schema: true` on the bare boolean subschema
		// `toolWireSchema` emits for open fields (issue #5914).
		const emittedParameters =
			compat.toolSchemaFlavor === "moonshot-mfjs"
				? (normalizeSchemaForMoonshot(wireParameters) as Record<string, unknown>)
				: compat.toolSchemaFlavor === "grammar"
					? sanitizeSchemaForGrammar(wireParameters)
					: wireParameters;
		const violation = findStrictToolSchemaViolation(emittedParameters);
		if (violation) {
			logger.warn(
				`Tool "${tool.name}" omitted from the openai-completions request: its parameter schema is invalid for this provider at ${violation} (an enum/const value cannot match its declared type). Other tools are unaffected.`,
			);
			continue;
		}
		if (includeStrict) anyStrictEmitted = true;
		wireTools.push({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description || "",
				parameters: emittedParameters,
				// Only include strict if provider supports it. Some reject unknown fields.
				...(includeStrict ? { strict: true } : includeExplicitFalse ? { strict: false } : {}),
			},
		});
	}

	return {
		tools: wireTools,
		toolStrictMode,
		strictToolsApplied: wireTools.length > 0 && anyStrictEmitted,
	};
}
export { convertMessages as convertOpenAICompletionsMessages };
