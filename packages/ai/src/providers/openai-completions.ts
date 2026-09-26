import type { Effort } from "@veyyon/catalog/effort";
import { isKimiModelId } from "@veyyon/catalog/identity";
import { resolveReasoningSelection } from "@veyyon/catalog/model-thinking";
import { calculateCost, emptyCost } from "@veyyon/catalog/models";
import type { ResolvedOpenAICompat } from "@veyyon/catalog/types";
import { $env } from "@veyyon/utils/env";
import { tryParseJson } from "@veyyon/utils/json";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import { getEnvApiKey } from "../stream";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Message,
	MessageAttribution,
	Model,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts, resolveCacheRetention } from "../utils";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import {
	clearStreamingPartialJson,
	isDemotedThinking,
	kStreamingLastParseLen,
	setStreamingPartialJson,
} from "../utils/block-symbols";
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
import { callWithCopilotModelRetry } from "../utils/retry";
import { adaptSchemaForStrict, NO_STRICT, normalizeSchemaForMoonshot, toolWireSchema } from "../utils/schema";
import { notifyRawSseEvent, resolveOpenAiSseEventName } from "../utils/sse-debug";
import {
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import type { CacheControlEphemeral } from "./anthropic-wire";
import { createInitialResponsesAssistantMessage } from "./initial-message";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionTool,
	ChatCompletionToolMessageParam,
} from "./openai-chat-wire";
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
	applyChatCompletionsCompatPolicy,
	applyChatCompletionsToolStream,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyOpenAIServiceTier,
	applyWireModelIdTransform,
	calculateOpenAIUsageAccounting,
	clearOpenAIStrictToolsState,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	getOpenAIPromptCacheKey,
	getOpenAIStrictToolsScope,
	isCompiledGrammarTooLargeStrictError,
	isOpenRouterAnthropicModel,
	isStrictToolsDisabledForScope,
	type OpenAICompatPolicy,
	type OpenAICompletionsParams,
	type OpenAIRequestSetup,
	type OpenAIStrictToolsScope,
	type OpenAIStrictToolsState,
	parseAzureDeploymentNameMap,
	resolveOpenAICompatPolicy,
	resolveOpenAIOutputTokenParam,
	resolveOpenAIRequestSetup,
	resolveZaiReasoningOutputClamp,
	shouldRetryWithoutStrictTools,
} from "./openai-shared";
import { transformMessages } from "./transform-messages";
import {
	isDashscopeCompatibleModeTextOnlyQwen,
	joinTextWithImagePlaceholder,
	NON_VISION_IMAGE_PLACEHOLDER,
} from "./vision-guard";

export { applyOpenRouterRoutingVariant } from "./openai-shared";

type OpenAICompletionsReasoningField = NonNullable<ResolvedOpenAICompat["reasoningContentField"]>;

type ProviderAttributedChatCompletionChunk = ChatCompletionChunk & {
	provider?: unknown;
};

type OpenAICompletionsChoiceUsage = ChatCompletionChunk.Choice & {
	usage?: unknown;
};

type OpenAICompletionsDeltaWithReasoningDetails = ChatCompletionChunk.Choice["delta"] & {
	reasoning_details?: unknown;
};

type OpenAICompletionsAssistantMessageParam = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: unknown[];
	};

type OpenAICompletionsToolMessageParam = ChatCompletionToolMessageParam & {
	name?: string;
};

type OpenAICompletionsUsageLike = {
	completion_tokens?: unknown;
	prompt_tokens?: unknown;
	cached_tokens?: unknown;
	prompt_cache_hit_tokens?: unknown;
	prompt_cache_miss_tokens?: unknown;
	prompt_tokens_details?: unknown;
	completion_tokens_details?: unknown;
};

type OpenAICompletionsPromptTokenDetails = {
	cached_tokens?: unknown;
	cache_write_tokens?: unknown;
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

function hasPositiveCacheReadTokenField(rawUsage: object): boolean {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	if (typeof usageLike.cached_tokens === "number" && usageLike.cached_tokens > 0) return true;
	if (typeof usageLike.prompt_cache_hit_tokens === "number" && usageLike.prompt_cache_hit_tokens > 0) return true;

	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	if (typeof rawPromptTokenDetails !== "object" || rawPromptTokenDetails === null) return false;

	const promptTokenDetails = rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails;
	return typeof promptTokenDetails.cached_tokens === "number" && promptTokenDetails.cached_tokens > 0;
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
 * Normalize OpenAI-compatible streaming `delta.content` into plain text.
 * Most providers stream `delta.content` as a string, but some (notably Mistral
 * Medium 3.5 / `mistral-medium-2604`) return an array of typed content parts
 * — e.g. `[{ type: "text", text: "Hello" }]`. Without normalization those
 * parts get string-coerced via `text += array`, producing the literal
 * `[object Object]` sequences observed in issue #911.
 *
 * Returns the joined text. Non-text parts and unknown shapes are skipped so
 * we never emit JS object sigils as visible output.
 */
function normalizeStreamingContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const part of content) {
			if (typeof part === "string") {
				out += part;
			} else if (part && typeof part === "object") {
				const obj = part as { type?: unknown; text?: unknown };
				if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
					out += obj.text;
				}
			}
		}
		return out;
	}
	if (content && typeof content === "object") {
		const obj = content as { type?: unknown; text?: unknown };
		if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
			return obj.text;
		}
	}
	return "";
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

function cloneStreamingArgumentValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(cloneStreamingArgumentValue);
	}
	if (isRecord(value)) {
		return mergeStreamingArgumentObjects(undefined, value as Record<string, unknown>);
	}
	return value;
}

function streamingArgumentValuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let i = 0; i < left.length; i++) {
			if (!streamingArgumentValuesEqual(left[i], right[i])) return false;
		}
		return true;
	}
	if (
		left !== null &&
		typeof left === "object" &&
		!Array.isArray(left) &&
		right !== null &&
		typeof right === "object" &&
		!Array.isArray(right)
	) {
		const leftObject = left as Record<string, unknown>;
		const rightObject = right as Record<string, unknown>;
		let leftKeys = 0;
		for (const key in leftObject) {
			if (!Object.hasOwn(leftObject, key) || key === "__proto__" || key === "constructor" || key === "prototype")
				continue;
			leftKeys++;
			if (!Object.hasOwn(rightObject, key) || !streamingArgumentValuesEqual(leftObject[key], rightObject[key])) {
				return false;
			}
		}
		let rightKeys = 0;
		for (const key in rightObject) {
			if (!Object.hasOwn(rightObject, key) || key === "__proto__" || key === "constructor" || key === "prototype")
				continue;
			rightKeys++;
		}
		return leftKeys === rightKeys;
	}
	return false;
}

function streamingArgumentArrayStartsWith(value: unknown[], prefix: unknown[]): boolean {
	if (prefix.length > value.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (!streamingArgumentValuesEqual(value[i], prefix[i])) return false;
	}
	return true;
}

function mergeStreamingArgumentArrays(prev: unknown[], fragment: unknown[]): unknown[] {
	if (streamingArgumentArrayStartsWith(fragment, prev)) {
		return fragment.map(cloneStreamingArgumentValue);
	}
	if (streamingArgumentArrayStartsWith(prev, fragment)) {
		return prev.map(cloneStreamingArgumentValue);
	}
	const merged = prev.map(cloneStreamingArgumentValue);
	for (const value of fragment) {
		merged.push(cloneStreamingArgumentValue(value));
	}
	return merged;
}

function mergeStreamingArgumentValues(prev: unknown, fragment: unknown): unknown {
	if (typeof prev === "string" && typeof fragment === "string") {
		return fragment.startsWith(prev) ? fragment : prev + fragment;
	}
	if (Array.isArray(prev) && Array.isArray(fragment)) {
		return mergeStreamingArgumentArrays(prev, fragment);
	}
	if (
		prev !== null &&
		typeof prev === "object" &&
		!Array.isArray(prev) &&
		fragment !== null &&
		typeof fragment === "object" &&
		!Array.isArray(fragment)
	) {
		return mergeStreamingArgumentObjects(prev as Record<string, unknown>, fragment as Record<string, unknown>);
	}
	return cloneStreamingArgumentValue(fragment);
}

function mergeStreamingArgumentObjects(
	prev: Record<string, unknown> | undefined,
	fragment: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	if (prev) {
		for (const key in prev) {
			if (!Object.hasOwn(prev, key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
			merged[key] = cloneStreamingArgumentValue(prev[key]);
		}
	}
	for (const key in fragment) {
		if (!Object.hasOwn(fragment, key) || key === "__proto__" || key === "constructor" || key === "prototype")
			continue;
		merged[key] = Object.hasOwn(merged, key)
			? mergeStreamingArgumentValues(merged[key], fragment[key])
			: cloneStreamingArgumentValue(fragment[key]);
	}
	return merged;
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
		choices?: ReadonlyArray<{
			finish_reason?: unknown;
			usage?: unknown;
			delta?: {
				content?: unknown;
				tool_calls?: unknown;
				reasoning?: unknown;
				reasoning_content?: unknown;
				reasoning_text?: unknown;
				refusal?: unknown;
			};
		}>;
	};
	if (record.usage) return true;
	const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
	if (!choice) return false;
	if (choice.finish_reason) return true;
	if (choice.usage) return true;
	const delta = choice.delta;
	if (!delta) return false;
	const content = delta.content;
	if (typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0) return true;
	if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
	if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
	if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
	if (typeof delta.reasoning_text === "string" && delta.reasoning_text.length > 0) return true;
	if (typeof delta.refusal === "string" && delta.refusal.length > 0) return true;
	return false;
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
	OpenAIReasoningEffortFallbackState;

function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const state: OpenAICompletionsProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		close: () => {
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
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

// DeepSeek models leak chat-template special tokens (e.g. `<｜tool_calls_begin｜>`,
// `<｜DSML｜tool_calls｜>`) into visible `content` deltas when hosted behind providers
// (such as NVIDIA NIM) that don't strip them server-side. The structured `tool_calls`
// payload is still emitted correctly — we only need to filter the leaked markers from
// user-visible text. Tokens use either fullwidth pipes (｜, U+FF5C) or ASCII pipes.
// Body is restricted to identifier-like chars (with the DeepSeek tokenizer's `▁`),
// capped at a sane length to avoid swallowing legitimate angle-bracket text.
const DEEPSEEK_SPECIAL_TOKEN_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/g;
const DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX = /^\s*<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/;
const DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*$/;
const DEEPSEEK_OPEN_DELIMS = ["<｜", "<|"] as const;

function stripDeepseekSpecialTokens(text: string): string {
	const stripped = text.replace(DEEPSEEK_SPECIAL_TOKEN_REGEX, "");
	if (stripped === text) return text;

	let normalized = stripped;
	if (DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX.test(text)) normalized = normalized.replace(/^\s+/u, "");
	if (DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test(text)) normalized = normalized.replace(/\s+$/u, "");
	return normalized;
}

// Find a trailing partial `<｜...` (or `<|...`) that has not yet been closed by a
// matching `｜>`/`|>`, so it can be held back until the next chunk arrives. A solo
// trailing `<` is also held in case it is the start of a new token.
function getTrailingPartialDeepseekToken(text: string): string {
	let bestIdx = -1;
	for (const delim of DEEPSEEK_OPEN_DELIMS) {
		const idx = text.lastIndexOf(delim);
		if (idx > bestIdx) bestIdx = idx;
	}
	if (bestIdx === -1) {
		return text.endsWith("<") ? "<" : "";
	}
	const tail = text.slice(bestIdx);
	if (tail.includes("｜>") || tail.includes("|>")) return "";
	// Cap the held-back length so a stray `<｜` in normal prose can't grow unboundedly.
	if (tail.length > 256) return "";
	return tail;
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

type ToolCallStreamBlock = ToolCall & {
	partialArgs?: string | Record<string, unknown>;
	streamIndex?: number;
	[kStreamingLastParseLen]?: number;
};
type OpenAIChunkDelta = ChatCompletionChunk.Choice["delta"];
type OpenAIChunkToolCall = NonNullable<OpenAIChunkDelta["tool_calls"]>[number];
type OpenAIStreamBlock = TextContent | ThinkingContent | ToolCallStreamBlock;
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
	rawSseObserver: ((event: RawSseEvent) => void) | undefined;
	providerSessionState: OpenAICompletionsProviderSessionState | undefined;
	strictToolsScope: OpenAIStrictToolsScope;
	disableStrictTools: boolean;
	outputApi: Api;
	onRequestDump: (dump: RawHttpRequestDump, wireBodyJson: string) => void;
}

async function connectOpenAICompletionsStream(args: ConnectOpenAICompletionsStreamArgs): Promise<{
	openaiHandle: OpenAIStreamHandle<ChatCompletionChunk>;
	disableStrictTools: boolean;
}> {
	let appliedStrictTools = false;
	const requestReasoningEffortFallbacks = new Map<string, OpenAIReasoningEffortFallback>();
	const attemptedReasoningEffortFallbacks = new Set<string>();
	let activeReasoningEffortFallbackKey: string | undefined;
	let activeRequestParams: OpenAICompletionsParams | undefined;
	let currentDisableStrictTools = args.disableStrictTools;

	const createCompletionsStream = async (toolStrictModeOverride?: ToolStrictModeOverride, captureOnly = false) => {
		const effectiveToolStrictModeOverride = currentDisableStrictTools ? "none" : toolStrictModeOverride;
		const { params, strictToolsApplied } = buildParams(
			args.model,
			args.context,
			args.options,
			effectiveToolStrictModeOverride,
		);
		appliedStrictTools = strictToolsApplied;
		const reasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
			"chat-completions",
			args.trimmedBaseUrl,
			params.model,
		);
		const requestReasoningEffortFallback = requestReasoningEffortFallbacks.has(reasoningEffortFallbackKey)
			? requestReasoningEffortFallbacks.get(reasoningEffortFallbackKey)
			: getOpenAIReasoningEffortFallback(args.providerSessionState, reasoningEffortFallbackKey);
		if (requestReasoningEffortFallback !== undefined) {
			applyOpenAIReasoningEffortFallback(params, requestReasoningEffortFallback);
		}
		activeReasoningEffortFallbackKey = reasoningEffortFallbackKey;
		const prepareRequest = async (): Promise<RequestInit> => {
			const bodyJson = JSON.stringify(params);
			let wireParams = params;
			if (args.options?.onPayload) {
				const attemptParams = JSON.parse(bodyJson) as OpenAICompletionsParams;
				const replacementPayload = await args.options.onPayload(attemptParams, args.model);
				wireParams =
					replacementPayload !== undefined && replacementPayload !== attemptParams
						? (replacementPayload as OpenAICompletionsParams)
						: attemptParams;
			}
			activeRequestParams = wireParams;
			const body = wireParams === params ? bodyJson : JSON.stringify(wireParams);
			const rawRequestDump: RawHttpRequestDump = {
				provider: args.model.provider,
				api: args.outputApi,
				model: args.model.id,
				method: "POST",
				url: args.completionsUrl,
				headers: args.requestHeaders,
			};
			args.onRequestDump(rawRequestDump, body);
			return { body };
		};
		if (captureOnly) {
			await prepareRequest();
			throw new AIError.RequestAbortError();
		}
		let requestTimeout: NodeJS.Timeout | undefined;
		if (args.requestTimeoutMs !== undefined) {
			requestTimeout = setTimeout(
				() => args.abortTracker.abortLocally(args.firstEventTimeoutAbortError),
				args.requestTimeoutMs,
			);
		}
		try {
			const headersWithTimeout = { ...args.headers };
			if (args.requestTimeoutMs !== undefined) {
				headersWithTimeout["X-Stainless-Timeout"] = Math.floor(args.requestTimeoutMs / 1000).toString();
			}
			return await postOpenAIStream<ChatCompletionChunk>({
				url: args.completionsUrl,
				headers: headersWithTimeout,
				body: undefined,
				signal: args.requestSignal,
				fetch: args.options?.fetch,
				prepareInit: prepareRequest,
				maxRetryDelayMs: args.options?.maxRetryDelayMs,
				onSseEvent: args.rawSseObserver,
			});
		} finally {
			clearTimeout(requestTimeout);
		}
	};

	if (args.requestSignal.aborted) await createCompletionsStream(undefined, true);
	let openaiHandle: OpenAIStreamHandle<ChatCompletionChunk>;
	try {
		openaiHandle = await callWithCopilotModelRetry(() => createCompletionsStream(), {
			provider: args.model.provider,
			signal: args.requestSignal,
		});
	} catch (error) {
		const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
		const reasoningEffortFallback =
			activeReasoningEffortFallbackKey && activeRequestParams && !args.requestSignal.aborted
				? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, activeRequestParams, {
						explicitDisable: args.options?.disableReasoning === true && args.options.reasoning === undefined,
					})
				: undefined;
		if (reasoningEffortFallback !== undefined && activeReasoningEffortFallbackKey) {
			const retryMarker = `${activeReasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
			if (attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
			attemptedReasoningEffortFallbacks.add(retryMarker);
			requestReasoningEffortFallbacks.set(activeReasoningEffortFallbackKey, reasoningEffortFallback);
			openaiHandle = await createCompletionsStream();
			rememberOpenAIReasoningEffortFallback(
				args.providerSessionState,
				activeReasoningEffortFallbackKey,
				reasoningEffortFallback,
			);
		} else if (
			isOpenRouterAnthropicModel(args.model) &&
			!currentDisableStrictTools &&
			isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse)
		) {
			disableStrictToolsForScope(args.providerSessionState, args.strictToolsScope);
			currentDisableStrictTools = true;
			openaiHandle = await createCompletionsStream("none");
		} else {
			if (!shouldRetryWithoutStrictTools(error, capturedErrorResponse, appliedStrictTools, args.context.tools)) {
				throw error;
			}
			disableStrictToolsForScope(args.providerSessionState, args.strictToolsScope);
			currentDisableStrictTools = true;
			openaiHandle = await createCompletionsStream("none");
		}
	}
	return { openaiHandle, disableStrictTools: currentDisableStrictTools };
}

function extractOpenAIReasoningDelta(deltaRecord: Record<string, unknown>): { field?: string; delta: string } {
	const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
	for (const field of reasoningFields) {
		const reasoningDelta = deltaRecord[field];
		if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
			return { field, delta: reasoningDelta };
		}
	}
	return { delta: "" };
}

function handleOpenAIStreamingToolCallDeltas(
	toolCalls: OpenAIChunkToolCall[],
	toolCallBlockByIndex: Map<number, ToolCallStreamBlock>,
	pendingToolCallBlocks: ToolCallStreamBlock[],
	unkeyedBatchBlocks: (ToolCallStreamBlock | undefined)[],
	getCurrentBlock: () => OpenAIStreamBlock | undefined,
	setCurrentBlock: (block: OpenAIStreamBlock | undefined) => void,
	finishCurrentBlock: (block: OpenAIStreamBlock | undefined) => void,
	blockIndex: (block: OpenAIStreamBlock | undefined) => number,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	for (let toolCallOffset = 0; toolCallOffset < toolCalls.length; toolCallOffset++) {
		const toolCall = toolCalls[toolCallOffset]!;
		const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
		const incomingName = toolCall.function?.name || "";
		const unkeyedBatchedArrayEntry = toolCalls.length > 1 && streamIndex === undefined && !toolCall.id;
		let block = streamIndex !== undefined ? toolCallBlockByIndex.get(streamIndex) : undefined;
		if (!block && toolCall.id) {
			block = pendingToolCallBlocks.find(candidate => candidate.id === toolCall.id);
		}
		if (!block && unkeyedBatchedArrayEntry) {
			const offsetBlock = unkeyedBatchBlocks[toolCallOffset];
			if (offsetBlock && offsetBlock.partialArgs !== undefined) block = offsetBlock;
		}
		const cur = getCurrentBlock();
		if (!block && !unkeyedBatchedArrayEntry && cur?.type === "toolCall" && (!toolCall.id || cur.id === toolCall.id)) {
			block = cur;
		}

		if (!block) {
			if (cur?.type !== "toolCall") {
				finishCurrentBlock(cur);
			}
			block = {
				type: "toolCall",
				id: toolCall.id || "",
				name: incomingName,
				arguments: {},
				partialArgs: "",
				streamIndex,
			};
			if (streamIndex !== undefined) toolCallBlockByIndex.set(streamIndex, block);
			pendingToolCallBlocks.push(block);
			setCurrentBlock(block);
			output.content.push(block);
			stream.push({
				type: "toolcall_start",
				contentIndex: blockIndex(block),
				partial: output,
			});
			if (unkeyedBatchedArrayEntry) unkeyedBatchBlocks[toolCallOffset] = block;
		} else {
			if (cur !== block && cur && cur.type !== "toolCall") {
				finishCurrentBlock(cur);
			}
			setCurrentBlock(block);
			if (streamIndex !== undefined && block.streamIndex === undefined) {
				block.streamIndex = streamIndex;
				toolCallBlockByIndex.set(streamIndex, block);
			}
		}

		if (toolCall.id) block.id = toolCall.id;
		if (incomingName) block.name = incomingName;
		let delta = "";
		const rawArgs = toolCall.function?.arguments as string | Record<string, unknown> | undefined;
		if (typeof rawArgs === "string") {
			if (rawArgs.length > 0) {
				delta = rawArgs;
				const prev = typeof block.partialArgs === "string" ? block.partialArgs : "";
				block.partialArgs = prev + rawArgs;
				setStreamingPartialJson(block, block.partialArgs);
				const throttled = parseStreamingJsonThrottled(block.partialArgs, block[kStreamingLastParseLen] ?? 0);
				if (throttled) {
					block.arguments = throttled.value;
					block[kStreamingLastParseLen] = throttled.parsedLen;
				}
			}
		} else if (isRecord(rawArgs)) {
			const prev = isRecord(block.partialArgs) ? block.partialArgs : undefined;
			const merged = mergeStreamingArgumentObjects(prev, rawArgs);
			block.partialArgs = merged;
			block.arguments = merged;
		}
		stream.push({
			type: "toolcall_delta",
			contentIndex: blockIndex(block),
			delta,
			partial: output,
		});
	}
}

function applyOpenAIReasoningDetails(delta: OpenAIChunkDelta, output: AssistantMessage): void {
	if (!("reasoning_details" in delta)) return;
	const details = (delta as OpenAICompletionsDeltaWithReasoningDetails).reasoning_details;
	if (!Array.isArray(details)) return;
	for (const detail of details) {
		if (!isRecord(detail)) continue;
		if (detail.type === "reasoning.encrypted" && typeof detail.id === "string" && detail.data) {
			const matchingToolCall = output.content.find(b => b.type === "toolCall" && b.id === detail.id);
			if (matchingToolCall && matchingToolCall.type === "toolCall") {
				matchingToolCall.thoughtSignature = JSON.stringify(detail);
			}
		}
	}
}

function recordOpenAIChunkMetadata(chunk: ChatCompletionChunk, output: AssistantMessage): void {
	output.responseId ||= chunk.id;
	if (!output.upstreamProvider) {
		const upstreamProvider = (chunk as ProviderAttributedChatCompletionChunk).provider;
		output.upstreamProvider =
			typeof upstreamProvider === "string" && upstreamProvider.length > 0 ? upstreamProvider : undefined;
	}
}

function handleOpenAIStreamingContentDelta(
	delta: OpenAIChunkDelta,
	appendThinkingDelta: (thinking: string, signature?: string, source?: "delta" | "cumulative") => void,
	appendProcessedText: (processedText: string) => void,
	streamMarkupHealing: StreamMarkupHealing | undefined,
	emitHealingEvent: (event: StreamMarkupHealingEvent, suppressThinking: boolean) => void,
	explicitReasoningDeltasMayBeCumulative: boolean,
	markFirstToken: () => void,
	setSuppressHealedThinking: () => void,
	getSuppressHealedThinking: () => boolean,
): void {
	const { field: foundReasoningField, delta: foundReasoningDelta } = extractOpenAIReasoningDelta(
		delta as Record<string, unknown>,
	);
	if (foundReasoningField) {
		appendThinkingDelta(
			foundReasoningDelta,
			foundReasoningField,
			explicitReasoningDeltasMayBeCumulative ? "cumulative" : "delta",
		);
		setSuppressHealedThinking();
	}

	const normalizedDeltaText = normalizeStreamingContentText(delta.content);
	if (normalizedDeltaText.length > 0) {
		markFirstToken();
		const hasStructuredToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;

		if (streamMarkupHealing) {
			const healingEvents = hasStructuredToolCalls
				? streamMarkupHealing.feedEventsWithoutCalls(normalizedDeltaText)
				: streamMarkupHealing.feedEvents(normalizedDeltaText);
			for (const event of healingEvents) {
				emitHealingEvent(event, getSuppressHealedThinking());
			}
		} else {
			appendProcessedText(normalizedDeltaText);
		}
	}
}
/**
 * `currentBlock`, `healedToolCallEmitted` and `firstTokenTime` are read through getters: the healer
 * and DeepSeek flushes below release held bytes, which can open a text block, close the block that
 * was current, emit a healed tool call and mark the first token. A copy taken before the flush
 * closes a block twice and leaves the one the flush opened without its end event.
 */
function finalizeOpenAICompletionsStream(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-completions">,
	policy: OpenAICompatPolicy,
	startTime: number,
	getFirstTokenTime: () => number | undefined,
	hasCompleteToolCalls: boolean,
	streamMarkupHealing: StreamMarkupHealing | undefined,
	suppressHealedThinking: boolean,
	getHealedToolCallEmitted: () => boolean,
	emitHealingEvent: (event: StreamMarkupHealingEvent, suppressThinking: boolean) => void,
	flushHealedToolCalls: () => void,
	stripDeepseekChatTemplateTokens: boolean,
	flushDeepseekStripBuffer: (final: boolean) => void,
	getCurrentBlock: () => OpenAIStreamBlock | undefined,
	finishCurrentBlock: (block: OpenAIStreamBlock | undefined) => void,
	finishPendingToolCallBlocks: () => void,
	streamFinishedAt: number | undefined,
): void {
	if (streamFinishedAt === undefined) {
		const stopReason = stopReasonForTerminallessEof(output.content, hasCompleteToolCalls);
		if (stopReason === undefined) {
			throw new AIError.ProviderResponseError(
				"OpenAI completions stream closed before a terminal finish reason was received",
				{ provider: model.provider, kind: "incomplete-stream" },
			);
		}
		output.stopReason = stopReason;
	}

	if (streamMarkupHealing) {
		for (const event of streamMarkupHealing.flushEvents()) {
			emitHealingEvent(event, suppressHealedThinking);
		}
		flushHealedToolCalls();
		if (getHealedToolCallEmitted() && output.stopReason === "stop") {
			// Hosts that leak tool-call templates often still report `finish_reason: stop` for the
			// surrounding turn. Promote only that natural-completion finish; leave `error`, `length`,
			// `aborted` untouched.
			output.stopReason = "toolUse";
		}
	}

	if (stripDeepseekChatTemplateTokens) {
		flushDeepseekStripBuffer(true);
	}

	const currentBlock = getCurrentBlock();
	if (currentBlock?.type === "toolCall") {
		finishPendingToolCallBlocks();
	} else {
		finishCurrentBlock(currentBlock);
		finishPendingToolCallBlocks();
	}

	// Some OpenAI-compatible hosts stream structured `tool_calls` but report `finish_reason: "stop"`.
	// In the OpenAI contract a tool call means "execute and continue", so promote that
	// natural-completion finish to `toolUse` whenever the turn produced tool-call blocks; the agent
	// loop gates execution on the stop reason. `error`, `length` and `aborted` are left untouched.
	// (Anthropic's `end_turn`-with-tool-calls "abandon" semantics stay in its own provider.)
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
	const firstTokenTime = getFirstTokenTime();
	if (firstTokenTime) output.ttft = firstTokenTime - startTime;
	stream.push({ type: "done", reason: output.stopReason, message: output });
	stream.end();
}

function extractRawErrorMetadata(error: unknown): string | undefined {
	if (isRecord(error) && isRecord(error.error) && isRecord(error.error.metadata)) {
		const raw = error.error.metadata.raw;
		if (typeof raw === "string") return raw;
	}
	return undefined;
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
	firstTokenTime: number | undefined,
	finishOpenBlocksOnError: () => void,
): Promise<void> {
	// Close open blocks first so consumers tracking text_/thinking_/toolcall_ lifecycles never see
	// orphaned starts on the error path. A throw here must not prevent the terminal error event.
	try {
		finishOpenBlocksOnError();
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
	const rawMetadata = extractRawErrorMetadata(error);
	if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
	output.duration = performance.now() - startTime;
	if (firstTokenTime) output.ttft = firstTokenTime - startTime;
	stream.push({ type: "error", reason: output.stopReason, error: output });
	stream.end();
}
const streamOpenAICompletionsOnce = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const policy = resolveOpenAICompatForRequest(model, options);

		const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		/** Exact bytes of the last sent request body; materialized into a dump only on the 400/413 path. */
		let wireBodyJson: string | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
			OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
		);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const modelSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;
		const rawSseObserver = modelSseObserver
			? (event: RawSseEvent) => {
					resolveOpenAiSseEventName(event);
					notifyRawSseEvent(modelSseObserver, event);
				}
			: undefined;
		// Assigned once the block helpers exist (they are scoped to the `try`);
		// the catch handler uses it to close open blocks before emitting the
		// terminal error so both exit paths obey the same block lifecycle.
		let finishOpenBlocksOnError: () => void = () => {};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const idleTimeoutFallbackMs = model.compat.streamIdleTimeoutMs;
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(idleTimeoutFallbackMs);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const { copilotPremiumRequests, baseUrl, headers, query, requestHeaders } = createRequestSetup(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				getOpenAIPromptCacheKey(options),
				conversationIdForOpenCode(options),
			);
			const premiumRequestsTotal = copilotPremiumRequests;
			const providerSessionState = getOpenAICompletionsProviderSessionState(
				model,
				baseUrl,
				options?.providerSessionState,
			);
			const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
			let disableStrictTools = isStrictToolsDisabledForScope(providerSessionState, strictToolsScope);
			const trimmedBaseUrl = trimTrailingSlashes(baseUrl);
			const completionsUrl = query
				? `${trimmedBaseUrl}/chat/completions?${new URLSearchParams(query)}`
				: `${trimmedBaseUrl}/chat/completions`;

			const connectionResult = await connectOpenAICompletionsStream({
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
				rawSseObserver,
				providerSessionState,
				strictToolsScope,
				disableStrictTools,
				outputApi: output.api,
				onRequestDump: (dump, wireBody) => {
					rawRequestDump = dump;
					wireBodyJson = wireBody;
				},
			});
			const openaiHandle = connectionResult.openaiHandle;
			disableStrictTools = connectionResult.disableStrictTools;
			await notifyProviderResponse(options, openaiHandle.response, model, openaiHandle.requestId);
			const openaiStream = openaiHandle.events;
			if (premiumRequestsTotal !== undefined) {
				output.usage.premiumRequests = premiumRequestsTotal;
			}
			stream.push({ type: "start", partial: output });
			const pendingToolCallBlocks: ToolCallStreamBlock[] = [];
			const toolCallBlockByIndex = new Map<number, ToolCallStreamBlock>();
			// Blocks born from an unkeyed multi-entry `tool_calls` array (no `id`,
			// no `index`), tracked by array offset so continuation chunks that omit
			// the entry name still route back to the sibling created earlier
			// instead of collapsing onto `currentBlock`.
			const unkeyedBatchBlocks: (ToolCallStreamBlock | undefined)[] = [];
			const clearUnkeyedBatchSlot = (block: ToolCallStreamBlock): void => {
				for (let index = 0; index < unkeyedBatchBlocks.length; index++) {
					if (unkeyedBatchBlocks[index] === block) unkeyedBatchBlocks[index] = undefined;
				}
			};
			let currentBlock: OpenAIStreamBlock | undefined;
			const blockIndex = (block: OpenAIStreamBlock | undefined): number => {
				if (!block) return Math.max(0, output.content.length - 1);
				return output.content.indexOf(block);
			};
			const hasCompleteToolCallBatch = (): boolean => {
				const toolCalls = output.content.filter((block): block is ToolCallStreamBlock => block.type === "toolCall");
				if (toolCalls.length === 0) return false;
				return toolCalls.every(block => {
					if (!block.id || !block.name) return false;
					const argumentsValue =
						block.partialArgs === undefined
							? block.arguments
							: typeof block.partialArgs === "string"
								? tryParseJson(block.partialArgs)
								: block.partialArgs;
					return isRecord(argumentsValue);
				});
			};
			const finishToolCallBlock = (block: ToolCallStreamBlock): void => {
				if (block.partialArgs === undefined) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;
				// Object-shaped `partialArgs` came from MiniMax-compatible hosts that stream
				// `function.arguments` as an object. The per-chunk handler holds them with an
				// empty wire delta (see the object branch below) because emitting each chunk's
				// `JSON.stringify(rawArgs)` would feed concat-based downstream consumers
				// (proxy.ts, openai-chat-server, openai-responses-server, anthropic-messages-server)
				// an invalid concatenation like `{"input":"a"}{"input":"b"}`. Flush the final
				// merged object as one concat-safe delta now so those consumers reconstruct the
				// args correctly before observing `toolcall_end`.
				if (typeof block.partialArgs === "object" && !Array.isArray(block.partialArgs)) {
					const fullJson = JSON.stringify(block.partialArgs);
					if (fullJson.length > 0 && fullJson !== "{}") {
						stream.push({ type: "toolcall_delta", contentIndex, delta: fullJson, partial: output });
					}
				}
				block.arguments =
					typeof block.partialArgs === "string" ? parseStreamingJson(block.partialArgs) : block.partialArgs;
				delete block.partialArgs;
				// The published mirror has to go with the accumulator: a marker left
				// holding text is how `agent-loop.ts` tells a call whose arguments
				// never finished from one that closed normally.
				clearStreamingPartialJson(block);
				if (block.streamIndex !== undefined) {
					toolCallBlockByIndex.delete(block.streamIndex);
					delete block.streamIndex;
				}
				const pendingIndex = pendingToolCallBlocks.indexOf(block);
				if (pendingIndex >= 0) pendingToolCallBlocks.splice(pendingIndex, 1);
				clearUnkeyedBatchSlot(block);
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			};
			const finishPendingToolCallBlocks = (): void => {
				for (const block of pendingToolCallBlocks.slice()) {
					finishToolCallBlock(block);
				}
			};
			const finishCurrentBlock = (block: OpenAIStreamBlock | undefined): void => {
				if (!block) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					return;
				}
				if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
					return;
				}
				finishToolCallBlock(block);
			};
			finishOpenBlocksOnError = () => {
				if (currentBlock?.type !== "toolCall") finishCurrentBlock(currentBlock);
				finishPendingToolCallBlocks();
			};
			const appendText = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				text: string,
			): void => {
				if (currentBlock?.type !== "text") {
					// Leave toolCall blocks pending across text transitions: chunks after
					// the first typically carry only `index`, so a finished (de-registered)
					// call would be reborn as a nameless phantom block when its arguments
					// resume. The stream-end sweep finalizes pending calls.
					if (currentBlock?.type !== "toolCall") finishCurrentBlock(currentBlock);
					currentBlock = { type: "text", text: "" };
					message.content.push(currentBlock);
					eventStream.push({ type: "text_start", contentIndex: blockIndex(currentBlock), partial: message });
				}
				currentBlock.text += text;
				eventStream.push({
					type: "text_delta",
					contentIndex: blockIndex(currentBlock),
					delta: text,
					partial: message,
				});
			};
			const appendThinking = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				thinking: string,
				signature?: string,
			): void => {
				if (
					currentBlock?.type !== "thinking" ||
					(signature !== undefined && currentBlock.thinkingSignature !== signature)
				) {
					// Same as appendText: leave toolCall blocks pending so index-only
					// continuation deltas can still find them.
					if (currentBlock?.type !== "toolCall") finishCurrentBlock(currentBlock);
					currentBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
					message.content.push(currentBlock);
					eventStream.push({
						type: "thinking_start",
						contentIndex: blockIndex(currentBlock),
						partial: message,
					});
				}
				if (signature !== undefined && !currentBlock.thinkingSignature) {
					currentBlock.thinkingSignature = signature;
				}
				currentBlock.thinking += thinking;
				eventStream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(currentBlock),
					delta: thinking,
					partial: message,
				});
			};

			const appendTextDelta = (text: string): void => {
				if (!text) return;
				if (!firstTokenTime) firstTokenTime = performance.now();
				appendText(output, stream, text);
			};
			// Tracks the last full cumulative reasoning snapshot per signature (the
			// reasoning field name) so dedup survives block transitions. Required
			// for MiniMax-M3: once `</think>` and visible text arrive, currentBlock
			// flips to "text", but later chunks keep carrying the same cumulative
			// `reasoning_content` snapshot. Without an external tracker the guard
			// below misses and the snapshot gets re-emitted as a fresh thinking
			// block after the answer has started.
			const lastCumulativeReasoningBySignature = new Map<string, string>();
			const appendThinkingDelta = (
				thinking: string,
				signature?: string,
				source: "delta" | "cumulative" = "delta",
			): void => {
				if (!thinking) return;
				let emittedThinking = thinking;
				if (source === "cumulative") {
					const key = signature ?? "";
					const lastSnapshot = lastCumulativeReasoningBySignature.get(key) ?? "";
					if (thinking.startsWith(lastSnapshot)) {
						emittedThinking = thinking.slice(lastSnapshot.length);
					}
					lastCumulativeReasoningBySignature.set(key, thinking);
					if (!emittedThinking) return;
				}
				if (!firstTokenTime) firstTokenTime = performance.now();
				appendThinking(output, stream, emittedThinking, signature);
			};
			const stripDeepseekChatTemplateTokens = policy.stream.stripSpecialTokens === "deepseek";
			let deepseekStripBuffer = "";
			const flushDeepseekStripBuffer = (final: boolean): void => {
				if (deepseekStripBuffer.length === 0) return;
				let flushable: string;
				if (final) {
					flushable = deepseekStripBuffer;
					deepseekStripBuffer = "";
				} else {
					const trailing = getTrailingPartialDeepseekToken(deepseekStripBuffer);
					flushable = deepseekStripBuffer.slice(0, deepseekStripBuffer.length - trailing.length);
					deepseekStripBuffer = trailing;
				}
				const stripped = stripDeepseekSpecialTokens(flushable);
				if (stripped && (stripped === flushable || stripped.trim().length > 0)) appendTextDelta(stripped);
			};
			const appendProcessedText = (processedText: string): void => {
				if (processedText.length === 0) return;
				if (stripDeepseekChatTemplateTokens) {
					deepseekStripBuffer += processedText;
					flushDeepseekStripBuffer(false);
				} else {
					appendTextDelta(processedText);
				}
			};
			const streamMarkupHealingPattern = policy.stream.markupHealingPattern;
			const streamMarkupHealing = streamMarkupHealingPattern
				? new StreamMarkupHealing({ pattern: streamMarkupHealingPattern })
				: undefined;
			const explicitReasoningDeltasMayBeCumulative = policy.stream.reasoningDeltasMayBeCumulative;
			let suppressHealedThinking = false;
			let healedToolCallEmitted = false;
			const emitHealedToolCall = (call: HealedToolCall): void => {
				finishCurrentBlock(currentBlock);
				const block: ToolCall & { partialArgs: string } = {
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: {},
					partialArgs: call.arguments,
				};
				block.arguments = parseStreamingJson(call.arguments);
				currentBlock = block;
				output.content.push(block);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(block), partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(block),
					delta: call.arguments,
					partial: output,
				});
				finishCurrentBlock(block);
				currentBlock = undefined;
				healedToolCallEmitted = true;
			};
			const emitHealingEvent = (event: StreamMarkupHealingEvent, suppressThinking: boolean): void => {
				if (event.type === "text") {
					appendProcessedText(event.text);
				} else if (event.type === "thinking") {
					if (!suppressThinking) appendThinkingDelta(event.thinking);
				} else {
					emitHealedToolCall(event.call);
				}
			};
			const flushHealedToolCalls = (): void => {
				if (!streamMarkupHealing) return;
				const calls = streamMarkupHealing.drainCompleted();
				for (const call of calls) emitHealedToolCall(call);
			};

			// Terminal-chunk bookkeeping for the post-finish grace window below.
			// `streamFinishedAt` flips when a chunk carries `finish_reason`;
			// `sawUsagePayload` flips when a usage payload was parsed. Some
			// OpenAI-compatible servers send basic usage with `finish_reason` and
			// cache-read details in a trailing usage-only chunk, so only the
			// no-choice terminal path may break while those details are pending.
			let streamFinishedAt: number | undefined;
			let sawUsagePayload = false;
			let awaitTrailingUsageDetails = false;
			const applyUsagePayload = (rawUsage: object): void => {
				output.usage = parseChunkUsage(rawUsage, model, premiumRequestsTotal);
				sawUsagePayload = true;
				awaitTrailingUsageDetails = !hasPositiveCacheReadTokenField(rawUsage);
			};
			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
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
				finishedAtMs: () => streamFinishedAt,
				graceMs: OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS,
				// The inner idle-timeout generator is parked mid-`next()` when the
				// grace window closes, so abort the transport to settle that read
				// and release the socket immediately (a queued `.return()` alone
				// would wait on the never-arriving next chunk).
				onGraceEnd: () => requestAbortController.abort(),
			});
			for await (const chunk of terminalAwareStream) {
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				recordOpenAIChunkMetadata(chunk, output);

				if (chunk.usage) {
					applyUsagePayload(chunk.usage);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) {
					// A trailing usage-only frame is emitted after generation. A few
					// OpenAI-compatible gateways omit both `finish_reason` and `[DONE]`
					// after a tool batch, but still send this accounting frame. Accept
					// that alternate terminal signal only when every streamed call has
					// an id, a name, and strictly complete JSON-object arguments. Text
					// and partial-call EOFs remain errors below.
					if (sawUsagePayload && hasCompleteToolCallBatch()) {
						output.stopReason = "toolUse";
						streamFinishedAt ??= Date.now();
						break;
					}
					// Normal compliant path: usage follows an explicit finish reason.
					if (streamFinishedAt !== undefined && sawUsagePayload) break;
					continue;
				}

				if (!chunk.usage) {
					const choiceUsage = (choice as OpenAICompletionsChoiceUsage).usage;
					if (typeof choiceUsage === "object" && choiceUsage !== null) {
						applyUsagePayload(choiceUsage);
					}
				}

				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					streamFinishedAt ??= Date.now();
				}

				if (choice.delta) {
					// Some endpoints return reasoning in reasoning_content (llama.cpp),
					// or reasoning (other openai compatible endpoints). Use the first
					// non-empty reasoning field to avoid duplication when a chunk carries
					// multiple aliases for the same reasoning text.
					handleOpenAIStreamingContentDelta(
						choice.delta,
						appendThinkingDelta,
						appendProcessedText,
						streamMarkupHealing,
						emitHealingEvent,
						explicitReasoningDeltasMayBeCumulative,
						() => {
							if (!firstTokenTime) firstTokenTime = performance.now();
						},
						() => {
							suppressHealedThinking = true;
						},
						() => suppressHealedThinking,
					);

					if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
						handleOpenAIStreamingToolCallDeltas(
							choice.delta.tool_calls,
							toolCallBlockByIndex,
							pendingToolCallBlocks,
							unkeyedBatchBlocks,
							() => currentBlock,
							block => {
								currentBlock = block;
							},
							finishCurrentBlock,
							blockIndex,
							output,
							stream,
						);
					}

					applyOpenAIReasoningDetails(choice.delta, output);
				}

				// If usage arrived on the finish chunk without cache-read fields,
				// keep draining through the grace window for vLLM-style trailing
				// usage details instead of finalizing the incomplete accounting.
				if (streamFinishedAt !== undefined && sawUsagePayload && !awaitTrailingUsageDetails) break;
			}
			const localAbortReason = abortTracker.getLocalAbortReason();
			if (localAbortReason) {
				throw localAbortReason;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new AIError.RequestAbortError();
			}

			finalizeOpenAICompletionsStream(
				output,
				stream,
				model,
				policy,
				startTime,
				() => firstTokenTime,
				hasCompleteToolCallBatch(),
				streamMarkupHealing,
				suppressHealedThinking,
				() => healedToolCallEmitted,
				emitHealingEvent,
				flushHealedToolCalls,
				stripDeepseekChatTemplateTokens,
				flushDeepseekStripBuffer,
				() => currentBlock,
				finishCurrentBlock,
				finishPendingToolCallBlocks,
				streamFinishedAt,
			);
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
				firstTokenTime,
				finishOpenBlocksOnError,
			);
		}
	})();

	return stream;
};

/**
 * Public entry: wrap the single-attempt streamer with bounded empty-completion
 * retries — flaky gateways occasionally 200 with `delta: {}` + `finish_reason:
 * "stop"` and no usage, which would otherwise stall the agent loop. Shared with
 * the Anthropic provider via `withEmptyCompletionRetry`.
 */
export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOpenAICompletionsOnce);

function createRequestSetup(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
	promptCacheSessionId?: string,
	conversationId?: string,
): OpenAIRequestSetup & { baseUrl: string } {
	const apiVersion = $env.AZURE_OPENAI_API_VERSION || "2024-10-21";
	const deploymentName = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id) ?? model.id;
	const setup = resolveOpenAIRequestSetup(model, {
		apiKey,
		extraHeaders,
		initiatorOverride,
		promptCacheSessionId,
		conversationId,
		messages: context.messages,
		defaultBaseUrl: "https://api.openai.com/v1",
		// Provider auth/header overlay: Kimi-code hosts require shared client
		// attribution headers prepended before caller headers. Kept here (not in
		// the shared helper) because it is provider-specific request setup.
		prependHeaders: model.provider === "kimi-code" ? getKimiCommonHeaders : undefined,
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
): OpenAICompatPolicy {
	return resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: mapToOpenAICompletionsToolChoice(options?.toolChoice),
	});
}

function dropOpenRouterKimiForcedToolReasoning(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	policy: OpenAICompatPolicy,
): void {
	if (
		policy.reasoning.disableReason === "forced-tool-choice" &&
		policy.reasoning.disableMode === "openrouter-enabled-false" &&
		policy.compat.isOpenRouterHost &&
		isKimiModelId(model.id)
	) {
		delete params.reasoning;
	}
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	toolStrictModeOverride?: ToolStrictModeOverride,
): {
	params: OpenAICompletionsParams;
	toolStrictMode: AppliedToolStrictMode;
	strictToolsApplied: boolean;
} {
	const initialPolicy = resolveOpenAICompatForRequest(model, options);
	const initialCompat = initialPolicy.compat as ResolvedOpenAICompat;

	const requestModelId = resolveOpenAICompletionsModelId(model, options);
	const params: OpenAICompletionsParams = {
		model: requestModelId,
		messages: [],
		stream: true,
	};
	let toolStrictMode: AppliedToolStrictMode = "none";
	let strictToolsApplied = false;

	if (initialCompat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	if (initialCompat.supportsStore) {
		params.store = false;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.minP !== undefined) {
		params.min_p = options.minP;
	}
	if (options?.presencePenalty !== undefined) {
		params.presence_penalty = options.presencePenalty;
	}
	if (options?.repetitionPenalty !== undefined) {
		params.repetition_penalty = options.repetitionPenalty;
	}
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		params.stop = seqs.length === 1 ? seqs[0] : seqs.slice(0, 4);
	}
	if (options?.frequencyPenalty !== undefined) {
		params.frequency_penalty = options.frequencyPenalty;
	}
	applyOpenAIServiceTier(params, options?.serviceTier, model);

	if (context.tools?.length) {
		const builtTools = convertTools(context.tools, initialCompat, toolStrictModeOverride);
		params.tools = builtTools.tools;
		toolStrictMode = builtTools.toolStrictMode;
		strictToolsApplied = builtTools.strictToolsApplied;
	} else if (context.tools === undefined && hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires the `tools` param when the conversation
		// contains tool_calls/tool_results, even when no tools are offered this turn.
		// Only inject the sentinel when the caller passed `context.tools = undefined`
		// (i.e. tools were not specified at all). An explicit `context.tools = []` means
		// the caller opted out of tools for this turn (as /btw and IRC background replies
		// do via AgentSession.runEphemeralTurn) — honour that intent and emit nothing,
		// so LiteLLM → Bedrock never sees an empty `toolConfig` block.
		params.tools = [];
	}

	if (options?.toolChoice && initialCompat.supportsToolChoice) {
		params.tool_choice = mapToOpenAICompletionsToolChoice(options.toolChoice);
	}
	if (
		typeof params.tool_choice === "object" &&
		params.tool_choice !== null &&
		!initialCompat.supportsNamedToolChoice
	) {
		params.tool_choice = "required";
	}
	if (isForcedToolChoice(params.tool_choice) && !initialCompat.supportsForcedToolChoice) {
		// Some thinking-required OpenAI-compatible models reject forced
		// `tool_choice` while still accepting tools with the default auto
		// selector. Keep the tool available and let the model choose it.
		params.tool_choice = "auto";
	}

	if (params.tool_choice === "none" && (!Array.isArray(params.tools) || params.tools.length === 0)) {
		// `tool_choice: "none"` with no tools to gate is redundant and also
		// trips LiteLLM → Bedrock: the proxy serializes the directive into a
		// `toolConfig` block, and Bedrock requires `toolConfig.tools` to be
		// non-empty whenever the conversation already holds `toolUse`/`toolResult`
		// content. Drop it whenever the resolved tools list is missing or empty.
		// Side-channel turns hit this: `/btw` and IRC background replies route
		// through `AgentSession.runEphemeralTurn`, which sets `context.tools = []`
		// and `toolChoice: "none"` (see packages/coding-agent/src/session/agent-session.ts).
		delete params.tool_choice;
	}

	const forcedToolName =
		typeof params.tool_choice === "object" && params.tool_choice !== null && "function" in params.tool_choice
			? params.tool_choice.function.name
			: undefined;
	if (
		forcedToolName !== undefined &&
		(!Array.isArray(params.tools) ||
			!params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName))
	) {
		// A forced named tool_choice is only valid when the same request offers
		// that function in `tools`. Active-tool filtering normally enforces this
		// before provider dispatch; this guard keeps raw provider callers from
		// emitting a self-inconsistent OpenAI-compatible payload.
		delete params.tool_choice;
	}

	const finalPolicy = resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: params.tool_choice,
	});
	const compat = finalPolicy.compat as ResolvedOpenAICompat;
	const messages = convertMessages(model, context, compat);
	maybeAddAnthropicCacheControl(compat, messages, resolveCacheRetention(options?.cacheRetention));
	params.messages = messages;
	const outputToken = resolveOpenAIOutputTokenParam({
		field: compat.maxTokensField,
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		routedUpstreamSelfCaps: compat.routedUpstreamSelfCaps,
		alwaysSendMaxTokens: compat.alwaysSendMaxTokens,
		providerOutputClamp: resolveZaiReasoningOutputClamp(model, compat),
	});
	if (outputToken) {
		if (outputToken.field === "max_tokens") {
			params.max_tokens = outputToken.value;
		} else if (outputToken.field === "max_completion_tokens") {
			params.max_completion_tokens = outputToken.value;
		}
	}
	applyChatCompletionsToolStream(params, model, compat);

	applyChatCompletionsCompatPolicy(params, finalPolicy);
	dropOpenRouterKimiForcedToolReasoning(params, model, finalPolicy);

	applyOpenAIGatewayRouting(params, compat);

	applyOpenAIExtraBody(params, compat.extraBody, {
		dropThinkingWhenReasoningEffort: compat.dropThinkingWhenReasoningEffort,
	});

	return { params, toolStrictMode, strictToolsApplied };
}

export function parseChunkUsage(
	rawUsage: object,
	model: Model<"openai-completions">,
	premiumRequests: number | undefined,
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
	const completionReasoningTokens = completionTokenDetails?.reasoning_tokens;
	const cacheWriteTokens = promptTokenDetails?.cache_write_tokens;
	const outputTokens = typeof completionTokens === "number" ? completionTokens : 0;
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: typeof promptTokens === "number" ? promptTokens : 0,
		outputTokens,
		cachedTokens: firstPositiveNumber(cachedTokens, promptCacheHitTokens, promptTokenCachedTokens),
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
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "developer") continue;

		const content = msg.content;
		if (typeof content === "string") {
			if (content.trim().length === 0) continue;
			msg.content = [
				Object.assign({ type: "text" as const, text: content }, { cache_control: { ...cacheControl } }),
			];
			return;
		}

		if (!Array.isArray(content)) continue;

		// Find last non-empty text part and add cache_control. Empty assistant
		// content is valid for tool-call replay, but Anthropic/OpenRouter reject
		// empty text blocks once cache_control turns it into structured content.
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part?.type === "text" && part.text.trim().length > 0) {
				Object.assign(part, { cache_control: { ...cacheControl } });
				return;
			}
		}
	}
}

function normalizeOpenAIToolCallId(id: string, compat: ResolvedOpenAICompat): string {
	if (compat.requiresMistralToolIds) return normalizeMistralToolId(id, true);

	// Handle pipe-separated IDs from OpenAI Responses API
	// Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
	// These come from providers like github-copilot, openai-codex, opencode
	// Extract just the call_id part and normalize it
	if (id.includes("|")) {
		const [callId] = id.split("|");
		// Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
		return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
	}

	if (compat.usesOpenAIToolCallIdLimit) return id.length > 40 ? id.slice(0, 40) : id;
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
	const supportsImages = model.input.includes("image") && !isDashscopeCompatibleModeTextOnlyQwen(model);
	const content: ChatCompletionContentPart[] = [];
	let omittedImages = false;
	for (const item of msg.content) {
		if (item.type === "text") {
			const text = item.text.toWellFormed();
			if (text.trim().length === 0) continue;
			content.push({
				type: "text",
				text,
			} satisfies ChatCompletionContentPartText);
		} else if (supportsImages) {
			content.push({
				type: "image_url",
				image_url: {
					url: `data:${item.mimeType};base64,${item.data}`,
					...(item.detail && item.detail !== "original" ? { detail: item.detail } : {}),
				},
			} satisfies ChatCompletionContentPartImage);
		} else {
			omittedImages = true;
		}
	}
	if (omittedImages) {
		content.push({
			type: "text",
			text: NON_VISION_IMAGE_PLACEHOLDER,
		} satisfies ChatCompletionContentPartText);
	}
	if (content.length === 0) return null;
	if (msg.role === "developer" && role === "developer" && !msg.content.some(item => item.type === "image")) {
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

function buildOpenAIAssistantContent(nonEmptyTextBlocks: TextContent[]): string | null {
	if (nonEmptyTextBlocks.length === 0) return null;
	return nonEmptyTextBlocks
		.map((b, i) => {
			const text = b.text.toWellFormed();
			return isDemotedThinking(b) && i < nonEmptyTextBlocks.length - 1 ? `${text}\n` : text;
		})
		.join("");
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
	if (compat.requiresReasoningContentForToolCalls) {
		const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
		const wireField =
			compat.allowsSyntheticReasoningContentForToolCalls &&
			(signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text")
				? signature
				: signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
					? (compat.reasoningContentField ?? "reasoning_content")
					: undefined;
		if (wireField) {
			assistantMsg[wireField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
		}
	} else if (compat.thinkingFormat === "zai" && model.reasoning) {
		const reasoningField = compat.reasoningContentField ?? "reasoning_content";
		assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
	} else if (compat.replayReasoningContent) {
		const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
		const reasoningField: OpenAICompletionsReasoningField =
			signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
				? signature
				: (compat.reasoningContentField ?? "reasoning_content");
		assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
	}

	if (compat.requiresReasoningContentForToolCalls) {
		const streamedReasoningField = nonEmptyThinkingBlocks[0]?.thinkingSignature;
		const reasoningField =
			compat.allowsSyntheticReasoningContentForToolCalls &&
			(streamedReasoningField === "reasoning_content" ||
				streamedReasoningField === "reasoning" ||
				streamedReasoningField === "reasoning_text")
				? streamedReasoningField
				: (compat.reasoningContentField ?? "reasoning_content");
		const reasoningContent = assistantMsg[reasoningField];
		if (!reasoningContent) {
			const reasoning = assistantMsg.reasoning;
			const reasoningText = assistantMsg.reasoning_text;
			if (reasoning && reasoningField !== "reasoning") {
				assistantMsg[reasoningField] = reasoning;
			} else if (reasoningText && reasoningField !== "reasoning_text") {
				assistantMsg[reasoningField] = reasoningText;
			} else {
				assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
			}
		}
	}
}

function applyOpenAIAssistantReasoningTiers(
	assistantMsg: OpenAICompletionsAssistantMessageParam,
	allThinkingBlocks: ThinkingContent[],
	toolCallsLength: number,
	compat: ResolvedOpenAICompat,
): boolean {
	const canUseSyntheticReasoningContent =
		compat.requiresReasoningContentForToolCalls &&
		compat.allowsSyntheticReasoningContentForToolCalls &&
		(compat.thinkingFormat === "openai" || compat.thinkingFormat === "openrouter" || compat.thinkingFormat === "zai");
	const needsReasoningOnAllTurns = compat.requiresReasoningContentForAllAssistantTurns;
	const needsReasoningField = needsReasoningOnAllTurns || toolCallsLength > 0;
	let hasReasoningField =
		assistantMsg.reasoning_content !== undefined ||
		assistantMsg.reasoning !== undefined ||
		assistantMsg.reasoning_text !== undefined;

	if (
		needsReasoningField &&
		!hasReasoningField &&
		compat.requiresReasoningContentForToolCalls &&
		!compat.allowsSyntheticReasoningContentForToolCalls
	) {
		if (allThinkingBlocks.length > 0) {
			const signature = allThinkingBlocks[0].thinkingSignature;
			if (signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text") {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				assistantMsg[reasoningField] = allThinkingBlocks.map(b => b.thinking).join("\n");
				hasReasoningField = true;
			}
		}
	}

	if (
		needsReasoningField &&
		!hasReasoningField &&
		compat.requiresReasoningContentForToolCalls &&
		!compat.allowsSyntheticReasoningContentForToolCalls
	) {
		const reasoningField = compat.reasoningContentField ?? "reasoning_content";
		assistantMsg[reasoningField] = "";
		hasReasoningField = true;
	}

	if (toolCallsLength > 0 && canUseSyntheticReasoningContent && !hasReasoningField) {
		const reasoningField = compat.reasoningContentField ?? "reasoning_content";
		assistantMsg[reasoningField] = ".";
		hasReasoningField = true;
	}
	return hasReasoningField;
}

function applyOpenAIAssistantToolCalls(
	assistantMsg: OpenAICompletionsAssistantMessageParam,
	toolCalls: ToolCall[],
	compat: ResolvedOpenAICompat,
	ensureToolCallId: (rawId: string, seed: string) => string,
	rememberToolCallId: (originalId: string, normalizedId: string) => void,
	msgIndex: number,
): void {
	if (toolCalls.length === 0) return;
	assistantMsg.tool_calls = toolCalls.map((tc, toolCallIndex) => {
		const toolCallId = ensureToolCallId(tc.id, `${msgIndex}:${toolCallIndex}:${tc.name}`);
		rememberToolCallId(tc.id, toolCallId);
		return {
			id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
			type: "function" as const,
			function: {
				name: tc.name,
				arguments: serializeToolArguments(tc.arguments, tc.name),
			},
		};
	});
	const reasoningDetails = toolCalls
		.filter(tc => tc.thoughtSignature)
		.map(tc => tryParseJson(tc.thoughtSignature!))
		.filter(Boolean);
	if (reasoningDetails.length > 0) {
		assistantMsg.reasoning_details = reasoningDetails;
	}
}

function convertOpenAIAssistantMessage(
	msg: AssistantMessage,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	ensureToolCallId: (rawId: string, seed: string) => string,
	rememberToolCallId: (originalId: string, normalizedId: string) => void,
	msgIndex: number,
): OpenAICompletionsAssistantMessageParam | null {
	const assistantMsg: OpenAICompletionsAssistantMessageParam = {
		role: "assistant",
		content: null,
	};
	const textBlocks = msg.content.filter(b => b.type === "text") as TextContent[];
	const nonEmptyTextBlocks = textBlocks.filter(b => b.text && b.text.trim().length > 0);
	assistantMsg.content = buildOpenAIAssistantContent(nonEmptyTextBlocks);

	const thinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
	const nonEmptyThinkingBlocks = thinkingBlocks.filter(b => b.thinking && b.thinking.trim().length > 0);
	applyOpenAIAssistantThinking(assistantMsg, nonEmptyThinkingBlocks, model, compat);

	const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];
	const hasReasoningField = applyOpenAIAssistantReasoningTiers(assistantMsg, thinkingBlocks, toolCalls.length, compat);
	applyOpenAIAssistantToolCalls(assistantMsg, toolCalls, compat, ensureToolCallId, rememberToolCallId, msgIndex);

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

function convertOpenAIToolResultsBatch(
	startIndex: number,
	transformedMessages: Message[],
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	ensureToolCallId: (rawId: string, seed: string) => string,
	consumeToolCallId: (originalId: string) => string | null,
	params: ChatCompletionMessageParam[],
): { nextIndex: number; newLastRole: string } {
	const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
	let j = startIndex;

	for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
		const toolMsg = transformedMessages[j] as ToolResultMessage;
		const textResult = toolMsg.content
			.filter(c => c.type === "text")
			.map(c => (c as TextContent).text)
			.join("\n");
		const supportsImages = model.input.includes("image") && !isDashscopeCompatibleModeTextOnlyQwen(model);
		const hasImages = toolMsg.content.some(c => c.type === "image");
		const omittedImages = hasImages && !supportsImages;
		const hasText = textResult.length > 0;
		const remappedToolCallId = consumeToolCallId(toolMsg.toolCallId);
		const resolvedToolCallId =
			remappedToolCallId ?? ensureToolCallId(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
		const toolResultContent = omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: hasText
				? textResult
				: hasImages
					? "(see attached image)"
					: "";
		const toolResultMsg: OpenAICompletionsToolMessageParam = {
			role: "tool",
			content: toolResultContent.toWellFormed(),
			tool_call_id: normalizeMistralToolId(resolvedToolCallId, compat.requiresMistralToolIds),
		};
		if (compat.requiresToolResultName && toolMsg.toolName) {
			toolResultMsg.name = toolMsg.toolName;
		}
		params.push(toolResultMsg);

		if (hasImages && supportsImages) {
			for (const block of toolMsg.content) {
				if (block.type === "image") {
					imageBlocks.push({
						type: "image_url",
						image_url: {
							url: `data:${block.mimeType};base64,${block.data}`,
						},
					});
				}
			}
		}
	}

	if (imageBlocks.length > 0) {
		if (compat.requiresAssistantAfterToolResult) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}
		params.push({
			role: "user",
			content: [
				{
					type: "text",
					text: "Attached image(s) from tool result:",
				},
				...imageBlocks,
			],
		});
		return { nextIndex: j, newLastRole: "user" };
	}
	return { nextIndex: j, newLastRole: "toolResult" };
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const maxNormalizedToolCallIdLength = compat.requiresMistralToolIds
		? 9
		: compat.usesOpenAIToolCallIdLimit
			? 40
			: undefined;
	const duplicateToolCallIdSuffixPrefix = compat.requiresMistralToolIds ? "dup" : undefined;
	const normalizeToolCallId = (id: string): string => normalizeOpenAIToolCallId(id, compat);
	const transformedMessages = transformMessages(
		context.messages,
		model,
		id => normalizeToolCallId(id),
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
		compat,
	);

	const remappedToolCallIds = new Map<string, string[]>();
	let generatedToolCallIdCounter = 0;

	const generateFallbackToolCallId = (seed: string): string => {
		generatedToolCallIdCounter += 1;
		const hash = Bun.hash(`${model.provider}:${model.id}:${seed}:${generatedToolCallIdCounter}`).toString(36);
		return `call_${hash}`;
	};

	const rememberToolCallId = (originalId: string, normalizedId: string): void => {
		const queue = remappedToolCallIds.get(originalId);
		if (queue) {
			queue.push(normalizedId);
			return;
		}
		remappedToolCallIds.set(originalId, [normalizedId]);
	};

	const consumeToolCallId = (originalId: string): string | null => {
		const queue = remappedToolCallIds.get(originalId);
		if (!queue || queue.length === 0) return null;
		const nextId = queue.shift() ?? null;
		if (queue.length === 0) remappedToolCallIds.delete(originalId);
		return nextId;
	};

	const ensureToolCallId = (rawId: string, seed: string): string => {
		const normalized = normalizeToolCallId(rawId);
		if (normalized.trim().length > 0) return normalized;
		return generateFallbackToolCallId(seed);
	};

	params.push(...buildOpenAISystemMessageParams(context.systemPrompt, model, compat));

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// A message the converter drops leaves the role sequence as if it were never there: it neither
		// earns the synthetic assistant turn a tool result needs before the next user turn, nor
		// consumes it on behalf of the message that follows.
		if (msg.role === "user" || msg.role === "developer") {
			const converted = convertOpenAIUserOrDeveloperMessage(msg, model, compat);
			if (!converted) continue;
			if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult") {
				params.push({
					role: "assistant",
					content: "I have processed the tool results.",
				});
			}
			params.push(converted);
		} else if (msg.role === "assistant") {
			const assistantMsg = convertOpenAIAssistantMessage(
				msg,
				model,
				compat,
				ensureToolCallId,
				rememberToolCallId,
				i,
			);
			if (!assistantMsg) continue;
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const { nextIndex, newLastRole } = convertOpenAIToolResultsBatch(
				i,
				transformedMessages,
				model,
				compat,
				ensureToolCallId,
				consumeToolCallId,
				params,
			);
			i = nextIndex - 1;
			lastRole = newLastRole;
			continue;
		}

		lastRole =
			msg.role === "developer"
				? model.reasoning && compat.supportsDeveloperRole
					? "developer"
					: "system"
				: msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride?: ToolStrictModeOverride,
): BuiltOpenAICompletionTools {
	const adaptedTools = tools.map(tool => {
		const strict = !NO_STRICT && compat.supportsStrictMode !== false && tool.strict !== false;
		const baseParameters = toolWireSchema(tool);
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

	return {
		tools: adaptedTools.map(({ tool, baseParameters, parameters, strict }) => {
			const includeStrict = toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && strict);
			// `strict: false` is semantically distinct from omitted `strict` on some
			// backends: with it absent, optional properties may be over-filled with
			// placeholder values (#4336). Preserve the author's explicit `false`,
			// but only in "mixed" mode against a provider that understands the
			// field — the `all_strict → none` collapse and `supportsStrictMode:
			// false` paths deliberately keep the wire flag uniformly absent.
			const includeExplicitFalse =
				!includeStrict &&
				tool.strict === false &&
				toolStrictMode === "mixed" &&
				compat.supportsStrictMode !== false;
			const wireParameters = includeStrict ? parameters : baseParameters;
			return {
				type: "function",
				function: {
					name: tool.name,
					description: tool.description || "",
					// Moonshot/Kimi native hosts validate against the stricter MFJS subset
					// (const→enum, typed enums, no validators) and 400 otherwise.
					parameters:
						compat.toolSchemaFlavor === "moonshot-mfjs"
							? (normalizeSchemaForMoonshot(wireParameters) as Record<string, unknown>)
							: wireParameters,
					// Only include strict if provider supports it. Some reject unknown fields.
					...(includeStrict ? { strict: true } : includeExplicitFalse ? { strict: false } : {}),
				},
			};
		}),
		toolStrictMode,
		strictToolsApplied:
			tools.length > 0 &&
			(toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && adaptedTools.some(tool => tool.strict))),
	};
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: AIError.providerFinishErrorMessage("content_filter") };
		case "network_error":
			return { stopReason: "error", errorMessage: AIError.providerFinishErrorMessage("network_error") };
		default:
			// Gateways (OpenRouter, Vercel AI Gateway, …) report upstream model
			// failures as a bare `finish_reason: "error"` with no detail, which the
			// turn domain retries. Every other unrecognised reason states itself.
			return {
				stopReason: "error",
				errorMessage: AIError.providerFinishErrorMessage(typeof reason === "string" ? reason : undefined),
			};
	}
}
