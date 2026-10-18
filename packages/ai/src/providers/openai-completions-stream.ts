/**
 * One streamed Chat Completions turn, assembled from its chunks.
 *
 * `OpenAICompletionsTurn` applies each `ChatCompletionChunk` to the turn's `AssistantMessage`: it
 * opens, grows and closes the text, thinking and tool-call blocks and pushes their start, delta and
 * end events, runs leaked-markup healing and DeepSeek template-token stripping over visible text,
 * records usage and the finish reason, and reports when the turn has both its terminal signal and
 * its accounting. The request, its retries, the idle watchdog and the final stop-reason rules are in
 * `openai-completions.ts`.
 */
import { tryParseJson } from "@veyyon/utils/json";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import { isRecord } from "@veyyon/utils/type-guards";
import * as AIError from "../error";
import type { AssistantMessage, StopReason, TextContent, ThinkingContent, ToolCall } from "../types";
import { clearStreamingPartialJson, kStreamingLastParseLen, setStreamingPartialJson } from "../utils/block-symbols";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { parseToolCallArguments } from "../utils/tool-call-arguments";
import { servedModelFromOpenRouterReasoning } from "./anthropic-signature";
import type { ChatCompletionChunk } from "./openai-chat-wire";
import type { OpenAICompatPolicy } from "./openai-shared";

/** The usage fields an OpenAI-compatible host may send, each read only when it holds a number. */
export type OpenAICompletionsUsageLike = {
	completion_tokens?: unknown;
	prompt_tokens?: unknown;
	cached_tokens?: unknown;
	prompt_cache_hit_tokens?: unknown;
	prompt_cache_miss_tokens?: unknown;
	prompt_tokens_details?: unknown;
	completion_tokens_details?: unknown;
	// Vertex/Gemini reports cache hits here (camelCase) when fronted by an
	// OpenAI-compatible gateway; the OpenAI-shaped cached fields stay absent.
	cachedContentTokenCount?: unknown;
};

export type OpenAICompletionsPromptTokenDetails = {
	cached_tokens?: unknown;
	cache_write_tokens?: unknown;
};

type ProviderAttributedChatCompletionChunk = ChatCompletionChunk & {
	provider?: unknown;
};

type OpenAICompletionsChoiceUsage = ChatCompletionChunk.Choice & {
	usage?: unknown;
};

type OpenAIChunkDelta = ChatCompletionChunk.Choice["delta"];
type OpenAIChunkToolCall = NonNullable<OpenAIChunkDelta["tool_calls"]>[number];

type OpenAICompletionsDeltaWithReasoningDetails = OpenAIChunkDelta & {
	reasoning_details?: unknown;
};

type ToolCallStreamBlock = ToolCall & {
	partialArgs?: string | Record<string, unknown>;
	streamIndex?: number;
	[kStreamingLastParseLen]?: number;
};
type OpenAIStreamBlock = TextContent | ThinkingContent | ToolCallStreamBlock;

/**
 * The text of one `delta.content` part. Most providers stream `delta.content` as a string, but some
 * (notably Mistral Medium 3.5 / `mistral-medium-2604`) return typed content parts such as
 * `[{ type: "text", text: "Hello" }]`; string-coercing those printed `[object Object]` (issue #911).
 * Non-text parts and unknown shapes read as empty text.
 */
function contentPartText(part: unknown): string {
	if (typeof part === "string") return part;
	if (!part || typeof part !== "object") return "";
	const { type, text } = part as { type?: unknown; text?: unknown };
	return (type === undefined || type === "text") && typeof text === "string" ? text : "";
}

/** `delta.content` as plain text, whether a string, one content part or an array of them. */
function normalizeStreamingContentText(content: unknown): string {
	if (!Array.isArray(content)) return contentPartText(content);
	let out = "";
	for (const part of content) out += contentPartText(part);
	return out;
}

export type GeminiMessageThoughtSignatureField = "thinking_signature" | "thought_signature" | "reasoning_signature";

export type GeminiMessageThoughtSignature = {
	field: GeminiMessageThoughtSignatureField;
	signature: string;
};

export type GeminiThoughtSignatureNamespace = "google" | "vertex";

export type GeminiThoughtSignatureExtraContent = Partial<
	Record<GeminiThoughtSignatureNamespace, { thought_signature: string }>
>;

const GEMINI_THOUGHT_SIGNATURE_NAMESPACES: readonly GeminiThoughtSignatureNamespace[] = ["google", "vertex"];

const GEMINI_MESSAGE_THOUGHT_SIGNATURE_FIELDS: readonly GeminiMessageThoughtSignatureField[] = [
	"thinking_signature",
	"thought_signature",
	"reasoning_signature",
];

export function getGeminiThoughtSignatureExtraContent(value: unknown): GeminiThoughtSignatureExtraContent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	for (const namespace of GEMINI_THOUGHT_SIGNATURE_NAMESPACES) {
		const providerContent = Reflect.get(value, namespace);
		if (typeof providerContent !== "object" || providerContent === null) continue;
		const thoughtSignature = Reflect.get(providerContent, "thought_signature");
		if (typeof thoughtSignature !== "string" || thoughtSignature.length === 0) continue;
		return namespace === "google"
			? { google: { thought_signature: thoughtSignature } }
			: { vertex: { thought_signature: thoughtSignature } };
	}
	return undefined;
}

export function getGeminiMessageThoughtSignature(value: unknown): GeminiMessageThoughtSignature | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	for (const field of GEMINI_MESSAGE_THOUGHT_SIGNATURE_FIELDS) {
		const signature = Reflect.get(value, field);
		if (typeof signature === "string" && signature.length > 0) return { field, signature };
	}
	return undefined;
}

export function parseStoredThoughtSignature(thoughtSignature: string | undefined): unknown {
	if (!thoughtSignature) return undefined;
	try {
		return JSON.parse(thoughtSignature);
	} catch {
		return undefined;
	}
}

// A single tool-call turn on an OpenAI-compatible Gemini wire can carry two independent signatures: a
// per-call one (`extra_content.google|vertex` or an encrypted `reasoning_details` entry) and a
// message-level one (`thinking_signature`, `thought_signature`, or `reasoning_signature`). Both are
// stashed on the originating tool call's `thoughtSignature`, so persistence and replay keep each field.
// `perCall` holds the raw extra_content object or reasoning detail; `message` holds the message-level
// signature in its wire shape.
export type StoredGeminiSignature = {
	perCall?: unknown;
	message?: Partial<Record<GeminiMessageThoughtSignatureField, string>>;
};

// Reads the stored envelope, also accepting the legacy raw shapes emitted before the envelope existed
// (a bare extra_content object, reasoning detail, or message-level signature) so persisted history keeps
// replaying.
export function normalizeStoredGeminiSignature(value: unknown): StoredGeminiSignature | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const perCall = Reflect.get(value, "perCall");
	const envelopeMessage = getGeminiMessageThoughtSignature(Reflect.get(value, "message"));
	if (perCall !== undefined || envelopeMessage) {
		const normalized: StoredGeminiSignature = {};
		if (perCall !== undefined) normalized.perCall = perCall;
		if (envelopeMessage) normalized.message = { [envelopeMessage.field]: envelopeMessage.signature };
		return normalized;
	}
	const legacyMessage = getGeminiMessageThoughtSignature(value);
	if (legacyMessage) return { message: { [legacyMessage.field]: legacyMessage.signature } };
	return { perCall: value };
}

// Merges a new per-call or message-level signature into whatever is already stored, so a later
// message-level signature never clobbers an earlier per-call one (and vice versa).
export function mergeStoredGeminiSignature(existing: string | undefined, update: StoredGeminiSignature): string {
	const merged = normalizeStoredGeminiSignature(parseStoredThoughtSignature(existing)) ?? {};
	if (update.perCall !== undefined) merged.perCall = update.perCall;
	if (update.message) merged.message = update.message;
	return JSON.stringify(merged);
}

/**
 * LiteLLM's wire shape for Anthropic thinking: streamed as `delta.thinking_blocks` (mirrored under
 * `delta.provider_specific_fields.thinking_blocks`) and required back verbatim, in order, on the
 * assistant turn that carries `tool_calls`; otherwise the upstream rejects the turn or LiteLLM silently
 * drops its thinking. https://docs.litellm.ai/docs/reasoning_content#tool-calling-with-thinking
 */
export type LiteLLMThinkingBlock =
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

function getLiteLLMThinkingBlocksDelta(delta: object): unknown[] | undefined {
	const direct = Reflect.get(delta, "thinking_blocks");
	if (Array.isArray(direct) && direct.length > 0) return direct;
	const providerFields = Reflect.get(delta, "provider_specific_fields");
	if (typeof providerFields !== "object" || providerFields === null) return undefined;
	const mirrored = Reflect.get(providerFields, "thinking_blocks");
	return Array.isArray(mirrored) && mirrored.length > 0 ? mirrored : undefined;
}

/**
 * Rebuilds LiteLLM `thinking_blocks` from a stored assistant turn. Thinking blocks parsed from
 * `thinking_blocks` keep the raw Anthropic signature as `thinkingSignature`; blocks parsed from
 * `reasoning_content`-style fields carry the field name instead and are skipped. `transformMessages`
 * strips signatures and redacted blocks on cross-model replays, so only the issuing model ever receives
 * them back.
 */
export function encodeLiteLLMThinkingBlocks(content: AssistantMessage["content"]): LiteLLMThinkingBlock[] {
	const blocks: LiteLLMThinkingBlock[] = [];
	for (const block of content) {
		if (block.type === "thinking") {
			const signature = block.thinkingSignature;
			if (
				!signature ||
				signature === "reasoning_content" ||
				signature === "reasoning" ||
				signature === "reasoning_text"
			) {
				continue;
			}
			blocks.push({ type: "thinking", thinking: block.thinking, signature });
		} else if (block.type === "redactedThinking") {
			blocks.push({ type: "redacted_thinking", data: block.data });
		}
	}
	return blocks;
}

/** An own key of a streamed argument object that may be copied without touching a prototype. */
function isArgumentKey(object: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(object, key) && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function cloneStreamingArgumentValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneStreamingArgumentValue);
	if (isRecord(value)) return mergeStreamingArgumentObjects(undefined, value);
	return value;
}

function streamingArgumentObjectsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	let leftKeys = 0;
	for (const key in left) {
		if (!isArgumentKey(left, key)) continue;
		leftKeys++;
		if (!Object.hasOwn(right, key) || !streamingArgumentValuesEqual(left[key], right[key])) return false;
	}
	let rightKeys = 0;
	for (const key in right) {
		if (isArgumentKey(right, key)) rightKeys++;
	}
	return leftKeys === rightKeys;
}

function streamingArgumentValuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && streamingArgumentArrayStartsWith(left, right);
	}
	if (isRecord(left) && isRecord(right)) return streamingArgumentObjectsEqual(left, right);
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
	if (streamingArgumentArrayStartsWith(fragment, prev)) return fragment.map(cloneStreamingArgumentValue);
	if (streamingArgumentArrayStartsWith(prev, fragment)) return prev.map(cloneStreamingArgumentValue);
	const merged = prev.map(cloneStreamingArgumentValue);
	for (const value of fragment) merged.push(cloneStreamingArgumentValue(value));
	return merged;
}

function mergeStreamingArgumentValues(prev: unknown, fragment: unknown): unknown {
	if (typeof prev === "string" && typeof fragment === "string") {
		return fragment.startsWith(prev) ? fragment : prev + fragment;
	}
	if (Array.isArray(prev) && Array.isArray(fragment)) return mergeStreamingArgumentArrays(prev, fragment);
	if (isRecord(prev) && isRecord(fragment)) return mergeStreamingArgumentObjects(prev, fragment);
	return cloneStreamingArgumentValue(fragment);
}

/**
 * Object-shaped `function.arguments` (MiniMax-compatible hosts) merged into what earlier chunks
 * sent: a string that restates its prefix replaces it, an array that extends another replaces it,
 * and nested objects merge key by key.
 */
function mergeStreamingArgumentObjects(
	prev: Record<string, unknown> | undefined,
	fragment: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	if (prev) {
		for (const key in prev) {
			if (isArgumentKey(prev, key)) merged[key] = cloneStreamingArgumentValue(prev[key]);
		}
	}
	for (const key in fragment) {
		if (!isArgumentKey(fragment, key)) continue;
		merged[key] = Object.hasOwn(merged, key)
			? mergeStreamingArgumentValues(merged[key], fragment[key])
			: cloneStreamingArgumentValue(fragment[key]);
	}
	return merged;
}

// DeepSeek models leak chat-template special tokens (e.g. `<｜tool_calls_begin｜>`,
// `<｜DSML｜tool_calls｜>`) into visible `content` deltas when hosted behind providers
// (such as NVIDIA NIM) that don't strip them server-side. The structured `tool_calls`
// payload is still emitted correctly — only the leaked markers are filtered from
// user-visible text. Tokens use either fullwidth pipes (｜, U+FF5C) or ASCII pipes.
// Body is restricted to identifier-like chars (with the DeepSeek tokenizer's `▁`),
// capped at a sane length to avoid swallowing legitimate angle-bracket text.
//
// A token is removed with the whitespace that follows it: the template renders
// `<｜Assistant｜>\n\n`, and that newline belongs to the marker, not to the answer.
// The rule depends on nothing but the concatenated text, so the visible result is the
// same however the host split the stream into chunks.
const DEEPSEEK_SPECIAL_TOKEN_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*/g;
const DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*$/;

function applyOpenAIReasoningDetails(delta: OpenAIChunkDelta, output: AssistantMessage): void {
	if (!("reasoning_details" in delta)) return;
	const details = (delta as OpenAICompletionsDeltaWithReasoningDetails).reasoning_details;
	if (!Array.isArray(details)) return;
	for (const detail of details) {
		if (!isRecord(detail)) continue;
		if (!output.upstreamModel) output.upstreamModel = servedModelFromOpenRouterReasoning(detail);
		if (detail.type === "reasoning.encrypted" && typeof detail.id === "string" && detail.data) {
			const matchingToolCall = output.content.find(b => b.type === "toolCall" && b.id === detail.id);
			if (matchingToolCall && matchingToolCall.type === "toolCall") {
				matchingToolCall.thoughtSignature = mergeStoredGeminiSignature(matchingToolCall.thoughtSignature, {
					perCall: detail,
				});
			}
		}
	}
}

type OpenAICompletionsRepetitionChoice = ChatCompletionChunk.Choice & {
	stop_reason?: unknown;
};

/**
 * Detect a server-declared repetition stop on a streamed choice.
 *
 * vLLM and other OpenAI-compatible servers report a generation that degenerated into repetition as a
 * terminal signal: `finish_reason: "repetition"`, and/or `stop_reason: "repetition_detected"`. The
 * `stop_reason` form arrives alongside an ordinary `finish_reason: "stop"`, or with none, so it is read
 * independently of `finish_reason`.
 *
 * Returns the raw values for the diagnostic message, or `undefined` when the choice carries no signal.
 */
function detectRepetitionStop(choice: ChatCompletionChunk.Choice): string | undefined {
	const finishReason: string | null | undefined = choice.finish_reason;
	const stopReason = (choice as OpenAICompletionsRepetitionChoice).stop_reason;
	const namesRepetition = (value: string): boolean => {
		const lower = value.toLowerCase();
		return lower === "repetition" || lower === "repetition_detected";
	};
	const flagged =
		(typeof finishReason === "string" && namesRepetition(finishReason)) ||
		(typeof stopReason === "string" && namesRepetition(stopReason));
	if (!flagged) return undefined;
	const parts: string[] = [];
	if (typeof finishReason === "string" && finishReason.length > 0) parts.push(`finish_reason=${finishReason}`);
	if (typeof stopReason === "string" && stopReason.length > 0) parts.push(`stop_reason=${stopReason}`);
	return parts.join(" ") || "repetition";
}

// The tail of `text` that may still become a special token once the next chunk arrives:
// everything from the last unclosed `<｜`/`<|`, or a solo trailing `<` that the next chunk
// may complete into a delimiter. A `<` after a closed token is held too, since the next
// token can begin right after the last one ends.
function getTrailingPartialDeepseekToken(text: string): string {
	const open = Math.max(text.lastIndexOf("<｜"), text.lastIndexOf("<|"));
	if (open !== -1) {
		const tail = text.slice(open);
		// Cap the held-back length so a stray `<｜` in normal prose can't grow unboundedly.
		if (!tail.includes("｜>") && !tail.includes("|>") && tail.length <= 256) return tail;
	}
	return text.endsWith("<") ? "<" : "";
}

/** Hosts send reasoning under one of these aliases; the first non-empty one is the chunk's reasoning. */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

function extractOpenAIReasoningDelta(deltaRecord: Record<string, unknown>): { field?: string; delta: string } {
	for (const field of REASONING_FIELDS) {
		const reasoningDelta = deltaRecord[field];
		if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
			return { field, delta: reasoningDelta };
		}
	}
	return { delta: "" };
}

function recordOpenAIChunkMetadata(chunk: ChatCompletionChunk, output: AssistantMessage): void {
	// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
	// and each chunk in a streamed completion carries the same id.
	output.responseId ||= chunk.id;
	if (!output.upstreamProvider) {
		const upstreamProvider = (chunk as ProviderAttributedChatCompletionChunk).provider;
		output.upstreamProvider =
			typeof upstreamProvider === "string" && upstreamProvider.length > 0 ? upstreamProvider : undefined;
	}
}

function hasPositiveCacheReadTokenField(rawUsage: object): boolean {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	if (typeof usageLike.cached_tokens === "number" && usageLike.cached_tokens > 0) return true;
	if (typeof usageLike.prompt_cache_hit_tokens === "number" && usageLike.prompt_cache_hit_tokens > 0) return true;
	if (typeof usageLike.cachedContentTokenCount === "number" && usageLike.cachedContentTokenCount > 0) return true;

	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	if (typeof rawPromptTokenDetails !== "object" || rawPromptTokenDetails === null) return false;

	const promptTokenDetails = rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails;
	return typeof promptTokenDetails.cached_tokens === "number" && promptTokenDetails.cached_tokens > 0;
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	// Some OpenAI-compatible gateways fronting Google Gemini backends emit the
	// native uppercase finish reasons (`STOP`, `MAX_TOKENS`) instead of the
	// lowercase OpenAI contract values. Fold case so a clean completion isn't
	// misclassified as a provider error.
	const normalized = typeof reason === "string" ? reason.toLowerCase() : reason;
	switch (normalized) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
		case "max_tokens":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: AIError.providerFinishErrorMessage("content_filter") };
		case "network_error":
			return { stopReason: "error", errorMessage: AIError.providerFinishErrorMessage("network_error") };
		case "insufficient_system_resource":
			// DeepSeek kills the generation mid-stream when its inference system runs
			// out of resources (docs: "the request is interrupted due to insufficient
			// resource of the inference system"). Server-side capacity failure: word
			// the message to match the transient-transport retry pattern so the turn is
			// auto-retried instead of pinned as an error.
			return {
				stopReason: "error",
				errorMessage: "Provider returned error finish_reason: insufficient_system_resource",
			};
		case "unknown":
		case "other":
		case "unspecified":
		case "finish_reason_unspecified":
			// The provider ended the stream without saying why (a dropped
			// connection behind a gateway, a backend that lost the stop code).
			// Pinning it as a terminal error strands a turn that a resample
			// fixes. Word the message to match the transient-transport retry
			// pattern; the retry budget bounds the replay.
			return {
				stopReason: "error",
				errorMessage: `Provider returned error finish_reason: ${normalized}`,
			};
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

/** A streamed call with an id, a name and arguments that parse to a JSON object. */
function isCompleteToolCall(block: ToolCallStreamBlock): boolean {
	if (!block.id || !block.name) return false;
	const argumentsValue =
		block.partialArgs === undefined
			? block.arguments
			: typeof block.partialArgs === "string"
				? tryParseJson(block.partialArgs)
				: block.partialArgs;
	return isRecord(argumentsValue);
}

export class OpenAICompletionsTurn {
	/**
	 * `Date.now()` when a chunk carried `finish_reason`, or when a choiceless usage chunk closed a
	 * complete tool-call batch; `undefined` while the turn has no terminal signal.
	 */
	finishedAt: number | undefined;
	/** `performance.now()` at the turn's first visible text or reasoning byte. */
	firstTokenTime: number | undefined;
	readonly #output: AssistantMessage;
	readonly #stream: AssistantMessageEventStream;
	readonly #usageFor: (rawUsage: object) => AssistantMessage["usage"];
	readonly #stripDeepseekTokens: boolean;
	readonly #healing: StreamMarkupHealing | undefined;
	readonly #reasoningMayBeCumulative: boolean;
	#current: OpenAIStreamBlock | undefined;
	readonly #pendingToolCalls: ToolCallStreamBlock[] = [];
	readonly #toolCallByIndex = new Map<number, ToolCallStreamBlock>();
	/**
	 * Blocks born from an unkeyed multi-entry `tool_calls` array (no `id`, no `index`), by array
	 * offset, so continuation chunks that omit the entry name still route back to the sibling created
	 * earlier instead of collapsing onto the current block.
	 */
	readonly #unkeyedBatch: (ToolCallStreamBlock | undefined)[] = [];
	/**
	 * The last full cumulative reasoning snapshot per reasoning field. MiniMax-M3 keeps sending the
	 * same cumulative `reasoning_content` after `</think>` and visible text arrive, when the current
	 * block is already text; keyed outside the block, the snapshot is not re-emitted as a fresh
	 * thinking block after the answer started.
	 */
	readonly #reasoningSnapshots = new Map<string, string>();
	#deepseekHeld = "";
	/**
	 * True while the released DeepSeek text ends in a special token, so whitespace at the start of
	 * the next release still belongs to that token and is dropped with it.
	 */
	#afterDeepseekToken = false;
	/** Set once the host streams native reasoning, after which healed thinking is dropped. */
	#suppressHealedThinking = false;
	#sawUsage = false;
	/**
	 * True while the last usage payload had no cache-read count. Some OpenAI-compatible servers send
	 * basic usage with `finish_reason` and cache-read details in a trailing usage-only chunk, so only
	 * a choiceless chunk may end the turn while those details are pending.
	 */
	#awaitTrailingUsageDetails = false;
	/** The server-declared repetition stop latched from the chunks; `throwIfRepetitionStop` fails the turn on it. */
	#repetitionStop: string | undefined;
	/** A message-level Gemini thought signature, waiting for the first open tool call to carry it. */
	#messageThoughtSignature: GeminiMessageThoughtSignature | undefined;
	/** The LiteLLM thinking block whose text and signature fragments are still arriving. */
	#liteLLMThinkingBlock: ThinkingContent | undefined;
	/** Block to its index in `output.content`; content is append-only, so the per-delta lookup stays O(1). */
	readonly #contentIndexByBlock = new Map<OpenAIStreamBlock, number>();

	constructor(
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
		policy: OpenAICompatPolicy["stream"],
		usageFor: (rawUsage: object) => AssistantMessage["usage"],
	) {
		this.#output = output;
		this.#stream = stream;
		this.#usageFor = usageFor;
		this.#stripDeepseekTokens = policy.stripSpecialTokens === "deepseek";
		this.#healing = policy.markupHealingPattern
			? new StreamMarkupHealing({ pattern: policy.markupHealingPattern })
			: undefined;
		this.#reasoningMayBeCumulative = policy.reasoningDeltasMayBeCumulative;
	}

	/** Applies one chunk; true once the turn has its terminal signal and the accounting to close on. */
	applyChunk(chunk: ChatCompletionChunk | null | undefined): boolean {
		if (!chunk || typeof chunk !== "object") return false;
		recordOpenAIChunkMetadata(chunk, this.#output);
		if (chunk.usage) this.#applyUsage(chunk.usage);

		const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
		if (!choice) return this.#endsOnChoicelessChunk();

		if (!chunk.usage) {
			const choiceUsage = (choice as OpenAICompletionsChoiceUsage).usage;
			if (typeof choiceUsage === "object" && choiceUsage !== null) this.#applyUsage(choiceUsage);
		}
		// A server-declared repetition stop completes the response, so it takes the same terminal bookkeeping
		// as a `finish_reason` chunk. Latched: a trailing frame without the signal must not clear the one an
		// earlier chunk carried.
		this.#repetitionStop ??= detectRepetitionStop(choice);
		if (this.#repetitionStop) this.finishedAt ??= Date.now();
		if (choice.finish_reason) this.#applyFinishReason(choice.finish_reason);
		if (choice.delta) this.#applyDelta(choice.delta);

		// Usage that arrived on the finish chunk without cache-read fields keeps the turn draining
		// through the grace window for vLLM-style trailing usage details.
		return this.finishedAt !== undefined && this.#sawUsage && !this.#awaitTrailingUsageDetails;
	}

	/** True when the turn streamed at least one tool call and every one has an id, a name and object arguments. */
	hasCompleteToolCallBatch(): boolean {
		let sawToolCall = false;
		for (const block of this.#output.content) {
			if (block.type !== "toolCall") continue;
			sawToolCall = true;
			if (!isCompleteToolCall(block)) return false;
		}
		return sawToolCall;
	}

	/** Releases the bytes the healer and the DeepSeek filter hold back, then closes every open block. */
	flush(): void {
		const healing = this.#healing;
		if (healing) {
			for (const event of healing.flushEvents()) this.#emitHealingEvent(event);
			for (const call of healing.drainCompleted()) this.#emitHealedToolCall(call);
		}
		this.#releaseDeepseekHeld(true);
		this.closeOpenBlocks();
	}

	/**
	 * Fails the turn when the server declared a repetition stop. Call it after `flush()`: the sweep has
	 * closed every block, so the partial output is dropped here rather than committed or replayed into the
	 * retry. The error carries `AIError.Flag.ThinkingLoop`, the flag the loop guard uses, because degenerate
	 * reasoning is replay garbage (#12525).
	 */
	throwIfRepetitionStop(): void {
		const repetitionStop = this.#repetitionStop;
		if (repetitionStop === undefined) return;
		this.#output.content = [];
		// The sweep already closed every block. Clear the handle so no later `thinking_end` targets an index that is gone.
		this.#current = undefined;
		throw AIError.attach(
			new AIError.ProviderResponseError(`Provider reported a repetition stop: ${repetitionStop}`, {
				provider: this.#output.provider,
				kind: "runtime",
			}),
			AIError.create(AIError.Flag.ThinkingLoop),
		);
	}

	/** Closes the open text or thinking block, then every tool call still taking arguments. */
	closeOpenBlocks(): void {
		this.#closeTextOrThinking();
		for (const block of Array.from(this.#pendingToolCalls)) this.#finishToolCall(block);
	}

	#applyUsage(rawUsage: object): void {
		this.#output.usage = this.#usageFor(rawUsage);
		this.#sawUsage = true;
		this.#awaitTrailingUsageDetails = !hasPositiveCacheReadTokenField(rawUsage);
	}

	/**
	 * A trailing usage-only chunk arrives after generation. A few OpenAI-compatible gateways omit
	 * both `finish_reason` and `[DONE]` after a tool batch but still send it, so it ends the turn as
	 * `toolUse` when every streamed call has an id, a name and complete JSON-object arguments. Text
	 * and partial-call EOFs stay errors. On the compliant path it follows an explicit finish reason.
	 */
	#endsOnChoicelessChunk(): boolean {
		if (this.#sawUsage && this.hasCompleteToolCallBatch()) {
			this.#output.stopReason = "toolUse";
			this.finishedAt ??= Date.now();
			return true;
		}
		return this.finishedAt !== undefined && this.#sawUsage;
	}

	#applyFinishReason(reason: ChatCompletionChunk.Choice["finish_reason"]): void {
		const mapped = mapStopReason(reason);
		this.#output.stopReason = mapped.stopReason;
		if (mapped.errorMessage) this.#output.errorMessage = mapped.errorMessage;
		this.finishedAt ??= Date.now();
	}

	#applyDelta(delta: OpenAIChunkDelta): void {
		this.#applyReasoning(delta);
		this.#applyContent(delta);
		if (delta.tool_calls && delta.tool_calls.length > 0) this.#applyToolCalls(delta.tool_calls);
		applyOpenAIReasoningDetails(delta, this.#output);
		this.#applyMessageThoughtSignature(delta);
	}

	/** Stamps the message-level Gemini signature on the first tool call that is open when it arrives. */
	#applyMessageThoughtSignature(delta: OpenAIChunkDelta): void {
		const incoming = getGeminiMessageThoughtSignature(delta);
		if (incoming) this.#messageThoughtSignature = incoming;
		const pending = this.#messageThoughtSignature;
		if (!pending) return;
		for (const block of this.#output.content) {
			if (block.type !== "toolCall") continue;
			block.thoughtSignature = mergeStoredGeminiSignature(block.thoughtSignature, {
				message: { [pending.field]: pending.signature },
			});
			this.#messageThoughtSignature = undefined;
			break;
		}
	}

	/**
	 * llama.cpp sends reasoning in `reasoning_content`, other hosts in `reasoning`; the first
	 * non-empty alias is used so a chunk carrying several aliases of one text is not duplicated.
	 */
	#applyReasoning(delta: OpenAIChunkDelta): void {
		// LiteLLM mirrors Anthropic thinking into both `reasoning_content` and `thinking_blocks`; only the
		// latter carries the signature, so it wins and the text alias is skipped to avoid duplication.
		const liteLLMThinkingBlocks = getLiteLLMThinkingBlocksDelta(delta);
		if (liteLLMThinkingBlocks) {
			for (const entry of liteLLMThinkingBlocks) this.#appendLiteLLMThinkingBlock(entry);
			this.#suppressHealedThinking = true;
			return;
		}
		const { field, delta: reasoning } = extractOpenAIReasoningDelta(delta as Record<string, unknown>);
		if (!field) return;
		this.#appendThinking(reasoning, field, this.#reasoningMayBeCumulative);
		this.#suppressHealedThinking = true;
	}

	#applyContent(delta: OpenAIChunkDelta): void {
		const text = normalizeStreamingContentText(delta.content);
		if (text.length === 0) return;
		this.firstTokenTime ||= performance.now();
		const healing = this.#healing;
		if (!healing) {
			this.#appendVisibleText(text);
			return;
		}
		const events =
			Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
				? healing.feedEventsWithoutCalls(text)
				: healing.feedEvents(text);
		for (const event of events) this.#emitHealingEvent(event);
	}

	#emitHealingEvent(event: StreamMarkupHealingEvent): void {
		if (event.type === "text") this.#appendVisibleText(event.text);
		else if (event.type === "thinking") {
			if (!this.#suppressHealedThinking) this.#appendThinking(event.thinking, undefined, false);
		} else this.#emitHealedToolCall(event.call);
	}

	/** Visible text after healing: through the DeepSeek token filter when the model leaks its template. */
	#appendVisibleText(text: string): void {
		if (text.length === 0) return;
		if (!this.#stripDeepseekTokens) {
			this.#appendText(text);
			return;
		}
		this.#deepseekHeld += text;
		this.#releaseDeepseekHeld(false);
	}

	/** Emits held DeepSeek text without its special tokens, keeping back a token not yet closed unless `final`. */
	#releaseDeepseekHeld(final: boolean): void {
		const held = this.#deepseekHeld;
		if (held.length === 0) return;
		const trailing = final ? "" : getTrailingPartialDeepseekToken(held);
		let flushable = held.slice(0, held.length - trailing.length);
		this.#deepseekHeld = trailing;
		if (this.#afterDeepseekToken) {
			flushable = flushable.trimStart();
			if (flushable.length === 0) return;
		}
		this.#afterDeepseekToken = DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test(flushable);
		this.#appendText(flushable.replace(DEEPSEEK_SPECIAL_TOKEN_REGEX, ""));
	}

	#appendText(text: string): void {
		if (!text) return;
		this.firstTokenTime ||= performance.now();
		let block = this.#current;
		if (block?.type !== "text") {
			this.#closeTextOrThinking();
			block = { type: "text", text: "" };
			this.#current = block;
			this.#pushContentBlock(block);
			this.#stream.push({ type: "text_start", contentIndex: this.#blockIndex(block), partial: this.#output });
		}
		block.text += text;
		this.#stream.push({
			type: "text_delta",
			contentIndex: this.#blockIndex(block),
			delta: text,
			partial: this.#output,
		});
	}

	/**
	 * Opens a thinking block after the current text or thinking block closes. The wire marks no summaries
	 * here; `portable-reasoning` vouches per family that this text is the full trace.
	 */
	#openThinkingBlock(signature?: string): ThinkingContent {
		// Same as appendText: leave toolCall blocks pending so index-only continuation deltas can still find them.
		this.#closeTextOrThinking();
		const block: ThinkingContent = { type: "thinking", thinking: "", thinkingSignature: signature, summary: false };
		this.#current = block;
		this.#pushContentBlock(block);
		this.#stream.push({ type: "thinking_start", contentIndex: this.#blockIndex(block), partial: this.#output });
		return block;
	}

	/**
	 * Appends reasoning to the current thinking block, opening one when none is current or the reasoning
	 * field changed. A `cumulative` host resends the whole reasoning so far, so only the growth past the
	 * last snapshot of that field is appended.
	 */
	#appendThinking(thinking: string, signature: string | undefined, cumulative: boolean): void {
		if (!thinking) return;
		const delta = cumulative ? this.#reasoningGrowth(thinking, signature ?? "") : thinking;
		if (!delta) return;
		this.firstTokenTime ||= performance.now();
		const current = this.#current;
		const block =
			current?.type === "thinking" && (signature === undefined || current.thinkingSignature === signature)
				? current
				: this.#openThinkingBlock(signature);
		if (signature !== undefined && !block.thinkingSignature) block.thinkingSignature = signature;
		block.thinking += delta;
		this.#stream.push({ type: "thinking_delta", contentIndex: this.#blockIndex(block), delta, partial: this.#output });
	}

	/**
	 * LiteLLM `thinking_blocks` entries each carry a text fragment, a signature fragment, or a whole
	 * redacted block. A signature seals its block, so text arriving after one opens the next block;
	 * signature fragments concatenate like Anthropic `signature_delta`. The raw signature lands in
	 * `thinkingSignature` for `encodeLiteLLMThinkingBlocks`.
	 */
	#appendLiteLLMThinkingBlock(entry: unknown): void {
		if (typeof entry !== "object" || entry === null) return;
		const type = Reflect.get(entry, "type");
		if (type === "redacted_thinking") {
			const data = Reflect.get(entry, "data");
			if (typeof data !== "string" || data.length === 0) return;
			this.#closeTextOrThinking();
			this.#current = undefined;
			this.#liteLLMThinkingBlock = undefined;
			this.#output.content.push({ type: "redactedThinking", data });
			return;
		}
		if (type !== "thinking") return;
		const rawThinking = Reflect.get(entry, "thinking");
		const rawSignature = Reflect.get(entry, "signature");
		const thinking = typeof rawThinking === "string" ? rawThinking : "";
		const signature = typeof rawSignature === "string" ? rawSignature : "";
		if (!thinking && !signature) return;
		this.firstTokenTime ||= performance.now();
		let block = this.#current === this.#liteLLMThinkingBlock ? this.#liteLLMThinkingBlock : undefined;
		if (!block || (thinking && block.thinkingSignature)) {
			block = this.#openThinkingBlock();
			this.#liteLLMThinkingBlock = block;
		}
		if (thinking) {
			block.thinking += thinking;
			this.#stream.push({
				type: "thinking_delta",
				contentIndex: this.#blockIndex(block),
				delta: thinking,
				partial: this.#output,
			});
		}
		if (signature) block.thinkingSignature = (block.thinkingSignature ?? "") + signature;
	}

	#reasoningGrowth(snapshot: string, field: string): string {
		const last = this.#reasoningSnapshots.get(field) ?? "";
		this.#reasoningSnapshots.set(field, snapshot);
		return snapshot.startsWith(last) ? snapshot.slice(last.length) : snapshot;
	}

	#emitHealedToolCall(call: HealedToolCall): void {
		this.#finishBlock(this.#current);
		const block: ToolCall & { partialArgs: string } = {
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: {},
			partialArgs: call.arguments,
		};
		block.arguments = parseStreamingJson(call.arguments);
		this.#current = block;
		this.#pushContentBlock(block);
		const contentIndex = this.#blockIndex(block);
		this.#stream.push({ type: "toolcall_start", contentIndex, partial: this.#output });
		this.#stream.push({ type: "toolcall_delta", contentIndex, delta: call.arguments, partial: this.#output });
		this.#finishBlock(block);
		this.#current = undefined;
	}

	#applyToolCalls(toolCalls: OpenAIChunkToolCall[]): void {
		// A pure tool-call chunk emits no text or thinking delta, so the first structured call stamps TTFT here.
		this.firstTokenTime ||= performance.now();
		for (let offset = 0; offset < toolCalls.length; offset++) {
			const toolCall = toolCalls[offset]!;
			const block = this.#toolCallBlock(toolCall, offset, toolCalls.length);
			const extraContent = getGeminiThoughtSignatureExtraContent(Reflect.get(toolCall, "extra_content"));
			if (extraContent) {
				block.thoughtSignature = mergeStoredGeminiSignature(block.thoughtSignature, { perCall: extraContent });
			}

			if (toolCall.id) block.id = toolCall.id;
			const name = toolCall.function?.name;
			if (name) block.name = name;
			const delta = this.#appendToolCallArguments(block, toolCall.function?.arguments);
			this.#stream.push({
				type: "toolcall_delta",
				contentIndex: this.#blockIndex(block),
				delta,
				partial: this.#output,
			});
		}
	}

	/** The block a `tool_calls` entry continues, made current; a new block when it continues none. */
	#toolCallBlock(toolCall: OpenAIChunkToolCall, offset: number, batchSize: number): ToolCallStreamBlock {
		const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
		const unkeyed = batchSize > 1 && streamIndex === undefined && !toolCall.id;
		const existing = this.#continuedToolCall(toolCall, streamIndex, unkeyed ? offset : undefined);
		// A text or thinking block ends here. Tool-call blocks stay pending: chunks after the first
		// typically carry only `index`, so a finished call would be reborn as a nameless phantom.
		this.#closeTextOrThinking();
		if (!existing) {
			return this.#openToolCall(
				toolCall.id || "",
				toolCall.function?.name || "",
				streamIndex,
				unkeyed ? offset : undefined,
			);
		}
		this.#current = existing;
		// Rebind the index so id-less continuations follow the call that last spoke on it.
		if (streamIndex !== undefined && this.#toolCallByIndex.get(streamIndex) !== existing) {
			existing.streamIndex = streamIndex;
			this.#toolCallByIndex.set(streamIndex, existing);
		}
		return existing;
	}

	/**
	 * The block an entry continues: by `id`, then by stream `index` unless the entry opens a new call (a
	 * different id with a `function.name`), then by offset within an unkeyed batch, or the current tool
	 * call when the entry names no other id.
	 */
	#continuedToolCall(
		toolCall: OpenAIChunkToolCall,
		streamIndex: number | undefined,
		batchOffset: number | undefined,
	): ToolCallStreamBlock | undefined {
		const id = toolCall.id;
		const byId = id ? this.#pendingToolCalls.find(candidate => candidate.id === id) : undefined;
		if (byId) return byId;
		const indexedBlock = streamIndex === undefined ? undefined : this.#toolCallByIndex.get(streamIndex);
		if (indexedBlock && (!id || !indexedBlock.id || !toolCall.function?.name)) return indexedBlock;
		if (batchOffset !== undefined) {
			const sibling = this.#unkeyedBatch[batchOffset];
			return sibling?.partialArgs !== undefined ? sibling : undefined;
		}
		const current = this.#current;
		return current?.type === "toolCall" && (!id || current.id === id) ? current : undefined;
	}

	#openToolCall(
		id: string,
		name: string,
		streamIndex: number | undefined,
		batchOffset: number | undefined,
	): ToolCallStreamBlock {
		const block: ToolCallStreamBlock = { type: "toolCall", id, name, arguments: {}, partialArgs: "", streamIndex };
		if (streamIndex !== undefined) this.#toolCallByIndex.set(streamIndex, block);
		this.#pendingToolCalls.push(block);
		this.#current = block;
		this.#pushContentBlock(block);
		this.#stream.push({ type: "toolcall_start", contentIndex: this.#blockIndex(block), partial: this.#output });
		if (batchOffset !== undefined) this.#unkeyedBatch[batchOffset] = block;
		return block;
	}

	/** Folds one entry's arguments into the block; returns the wire delta, empty for object-shaped arguments. */
	#appendToolCallArguments(block: ToolCallStreamBlock, rawArgs: unknown): string {
		if (typeof rawArgs === "string") {
			if (rawArgs.length === 0) return "";
			const partialArgs = (typeof block.partialArgs === "string" ? block.partialArgs : "") + rawArgs;
			block.partialArgs = partialArgs;
			setStreamingPartialJson(block, partialArgs);
			const throttled = parseStreamingJsonThrottled(partialArgs, block[kStreamingLastParseLen] ?? 0);
			if (throttled) {
				block.arguments = throttled.value;
				block[kStreamingLastParseLen] = throttled.parsedLen;
			}
			return rawArgs;
		}
		if (isRecord(rawArgs)) {
			const merged = mergeStreamingArgumentObjects(
				isRecord(block.partialArgs) ? block.partialArgs : undefined,
				rawArgs,
			);
			block.partialArgs = merged;
			block.arguments = merged;
		}
		return "";
	}

	#closeTextOrThinking(): void {
		if (this.#current?.type !== "toolCall") this.#finishBlock(this.#current);
	}

	#finishBlock(block: OpenAIStreamBlock | undefined): void {
		if (!block) return;
		const contentIndex = this.#blockIndex(block);
		if (contentIndex < 0) return;
		if (block.type === "text") {
			this.#stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.#output });
		} else if (block.type === "thinking") {
			this.#stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.#output });
		} else {
			this.#finishToolCall(block);
		}
	}

	#finishToolCall(block: ToolCallStreamBlock): void {
		const partialArgs = block.partialArgs;
		if (partialArgs === undefined) return;
		const contentIndex = this.#blockIndex(block);
		if (contentIndex < 0) return;
		if (typeof partialArgs === "string") {
			block.arguments = parseToolCallArguments(partialArgs);
		} else {
			this.#flushObjectArguments(partialArgs, contentIndex);
			block.arguments = partialArgs;
		}
		delete block.partialArgs;
		// The published mirror goes with the accumulator: a marker left holding text is how
		// `agent-loop.ts` tells a call whose arguments never finished from one that closed normally.
		clearStreamingPartialJson(block);
		if (block.streamIndex !== undefined) {
			if (this.#toolCallByIndex.get(block.streamIndex) === block) this.#toolCallByIndex.delete(block.streamIndex);
			delete block.streamIndex;
		}
		const pendingIndex = this.#pendingToolCalls.indexOf(block);
		if (pendingIndex >= 0) this.#pendingToolCalls.splice(pendingIndex, 1);
		for (let offset = 0; offset < this.#unkeyedBatch.length; offset++) {
			if (this.#unkeyedBatch[offset] === block) this.#unkeyedBatch[offset] = undefined;
		}
		this.#stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: this.#output });
	}

	/**
	 * Object-shaped arguments are held with an empty wire delta per chunk, because each chunk's
	 * `JSON.stringify` would feed concat-based consumers (proxy.ts, openai-chat-server,
	 * openai-responses-server, anthropic-messages-server) an invalid `{"input":"a"}{"input":"b"}`.
	 * The merged object goes out as one concat-safe delta before `toolcall_end`.
	 */
	#flushObjectArguments(merged: Record<string, unknown>, contentIndex: number): void {
		const fullJson = JSON.stringify(merged);
		if (fullJson.length > 0 && fullJson !== "{}") {
			this.#stream.push({ type: "toolcall_delta", contentIndex, delta: fullJson, partial: this.#output });
		}
	}

	#blockIndex(block: OpenAIStreamBlock): number {
		return this.#contentIndexByBlock.get(block) ?? this.#output.content.indexOf(block);
	}

	#pushContentBlock(block: OpenAIStreamBlock): void {
		this.#contentIndexByBlock.set(block, this.#output.content.length);
		this.#output.content.push(block);
	}
}
