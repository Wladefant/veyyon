/**
 * Decoding a Responses API event stream into an assistant message: the per-block accumulators the
 * generic Responses decoder and the Codex decoder share, the generic decoder itself, and the stop-reason
 * mapping both apply at the end of a turn.
 */
import { calculateCost } from "@veyyon/catalog/models";
import { structuredCloneJSON } from "@veyyon/utils/json";
import { classifyJsonPrefix, parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Model,
	ServiceTier,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import {
	clearStreamingPartialJson,
	kStreamingArgumentsDone,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import type {
	Response as OpenAIResponse,
	ResponseContentPartAddedEvent,
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
	ResponseStreamEvent,
} from "./openai-responses-wire";
import {
	applyOpenAIResponsesServiceTierCost,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	populateResponsesUsageFromResponse,
} from "./openai-shared";

/**
 * Per-block accumulation helpers shared by the two Responses decode loops —
 * {@link processResponsesStream} (generic Responses) and the Codex stream
 * handler in `openai-codex-responses.ts`. Each endpoint keeps its own
 * item-routing, terminal handling, and transport bookkeeping; these own only
 * the leaf mutations on an already-resolved open block, so the
 * append/parse/finalize logic lives in exactly one place. The caller passes the
 * `contentIndex` its router resolved (generic uses `output.content.indexOf`;
 * Codex uses the open item's recorded index) so the emitted stream events match
 * each decoder's existing behavior byte-for-byte.
 */
type ResponsesToolCallBlock = ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number };

export function appendReasoningSummaryPart(
	item: ResponseReasoningItem,
	part: ResponseReasoningItem["summary"][number],
): void {
	item.summary = item.summary || [];
	item.summary.push(part);
}

/**
 * Response-global accumulator for the sequential-cutoff summary contract.
 *
 * Summary indices are cumulative across ALL reasoning items in a response:
 * each new reasoning item replays the previous item's last completed section
 * (`.done` at index N-1) before streaming its own, and replay-only items may
 * add nothing new. Folding per item would re-emit every replayed section, so
 * the canonical summary and the emitted text span items and live here.
 */
export interface SequentialCutoffSummaryState {
	/** Latest full text per response-global summary index. */
	summary: ResponseReasoningItem["summary"];
	/** Canonical summary text already emitted as thinking deltas across all blocks. */
	emitted: string;
}

export function createSequentialCutoffSummaryState(): SequentialCutoffSummaryState {
	return { summary: [], emitted: "" };
}

// Sequential-cutoff streams may repeat the full canonical summary as later parts.
function foldReasoningSummary(parts: ResponseReasoningItem["summary"] | undefined): string {
	if (!parts) return "";
	let canonical = "";
	for (const part of parts) {
		const text = part.text;
		if (!text || text === canonical) continue;
		const extendsCanonical = text.startsWith(canonical) && text[canonical.length] === "\n";
		canonical = !canonical || extendsCanonical ? text : `${canonical}\n\n${text}`;
	}
	return canonical;
}

/** Chooses final reasoning text without making sequential-cutoff results disagree with emitted deltas. */
export function finalizeReasoningThinking(
	item: ResponseReasoningItem,
	streamedThinking: string,
	cutoff?: SequentialCutoffSummaryState,
): string {
	if (cutoff) return finalizeCutoffReasoningThinking(item, streamedThinking, cutoff);
	const summaryThinking = item.summary?.map(part => part.text).join("\n\n") ?? "";
	if (summaryThinking) return summaryThinking;
	const contentThinking = item.content?.[0]?.type === "reasoning_text" ? (item.content[0].text ?? "") : "";
	return contentThinking || streamedThinking || "";
}

function finalizeCutoffReasoningThinking(
	item: ResponseReasoningItem,
	streamedThinking: string,
	cutoff: SequentialCutoffSummaryState,
): string {
	// The block's streamed deltas are authoritative: final text must never
	// disagree with what delta consumers already rendered.
	if (streamedThinking) return streamedThinking;
	const summaryThinking = foldReasoningSummary(item.summary);
	if (summaryThinking) {
		// The done payload carries the response-cumulative summary. Emit only
		// what no earlier block already emitted; replay-only items finalize empty.
		if (cutoff.emitted.startsWith(summaryThinking)) return "";
		if (!cutoff.emitted || summaryThinking.startsWith(cutoff.emitted)) {
			const suffix = summaryThinking.slice(cutoff.emitted.length).replace(/^\n+/, "");
			// Adopt the payload as canonical so later items cannot replay this text.
			cutoff.summary = item.summary?.map(part => ({ ...part })) ?? [];
			cutoff.emitted = summaryThinking;
			return suffix;
		}
		// Diverged from streamed text — the deltas already shown win.
		return "";
	}
	return item.content?.[0]?.type === "reasoning_text" ? (item.content[0].text ?? "") : "";
}

export function appendReasoningSummaryTextDelta(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	item.summary = item.summary || [];
	const lastPart = item.summary[item.summary.length - 1];
	if (!lastPart) return;
	block.thinking += delta;
	lastPart.text += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
}

export function appendReasoningSummaryPartDone(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	item.summary = item.summary || [];
	const lastPart = item.summary[item.summary.length - 1];
	if (!lastPart) return;
	block.thinking += "\n\n";
	lastPart.text += "\n\n";
	stream.push({ type: "thinking_delta", contentIndex, delta: "\n\n", partial: output });
}

/**
 * Applies an atomic `response.reasoning_summary_text.done` snapshot.
 *
 * Sequential-cutoff summary indices are response-global: later reasoning items
 * replay earlier sections, resend the accumulated summary as one part, or
 * complete without new sections. The canonical summary is rebuilt in `state`
 * (spanning items) and only its append-only suffix is emitted into the current
 * block. Divergent corrections stay buffered until finalization so delta
 * consumers never receive suffixes based on unseen replacement text.
 */
export function applyReasoningSummaryDone(
	state: SequentialCutoffSummaryState,
	block: ThinkingContent,
	text: string,
	summaryIndex: number,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	while (state.summary.length <= summaryIndex) {
		state.summary.push({ type: "summary_text", text: "" });
	}
	state.summary[summaryIndex].text = text;
	const after = foldReasoningSummary(state.summary);
	if (!after.startsWith(state.emitted)) return;
	let delta = after.slice(state.emitted.length);
	if (!delta) return;
	state.emitted = after;
	// A fresh block starts a new section: drop the inter-section separator so
	// each thinking block stands alone.
	if (!block.thinking) delta = delta.replace(/^\n+/, "");
	if (!delta) return;
	block.thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
}

export function appendMessageContentPart(
	item: ResponseOutputMessage,
	part: ResponseContentPartAddedEvent["part"] | undefined,
): void {
	item.content = item.content || [];
	if (part && (part.type === "output_text" || part.type === "refusal")) {
		item.content.push(part);
	}
}

export function appendMessageTextDelta(
	item: ResponseOutputMessage,
	block: TextContent,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	partType: "output_text" | "refusal",
): void {
	item.content = item.content || [];
	let lastPart = item.content[item.content.length - 1];
	if (lastPart?.type !== partType) {
		// `content_part.added` never arrived (lossy proxy) — synthesize the part
		// so live text still streams instead of freezing until output_item.done.
		lastPart =
			partType === "output_text"
				? { type: "output_text", text: "", annotations: [] }
				: { type: "refusal", refusal: "" };
		item.content.push(lastPart);
	}
	block.text += delta;
	if (lastPart.type === "output_text") {
		lastPart.text += delta;
	} else {
		lastPart.refusal += delta;
	}
	stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}
/** Chooses final message text while treating non-empty terminal content as authoritative. */
export function finalizeMessageText(item: ResponseOutputMessage, streamedText: string): string {
	if (!item.content?.length) return streamedText || "";
	return item.content.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? ""))).join("");
}

export type ToolCallArgumentsDeltaShape = "incremental" | "cumulative";

/**
 * Declared wire shape for tool-call argument deltas across Responses-family providers.
 *
 * Every provider or API that routes into `processResponsesStream` or `accumulateToolCallArgumentsDelta`
 * must explicitly declare its stream shape here. A provider added without a declared shape
 * throws rather than silently inheriting an arbitrary default.
 */
export const RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES: Readonly<Record<string, ToolCallArgumentsDeltaShape>> = {
	azure: "incremental",
	"github-copilot": "incremental",
	"gitlab-duo": "incremental",
	ollama: "incremental",
	openai: "incremental",
	"openai-codex": "cumulative",
	opencode: "incremental",
	"opencode-go": "incremental",
	"opencode-zen": "incremental",
	openrouter: "incremental",
	sakana: "incremental",
	"xai-oauth": "incremental",
};

/**
 * Declared wire shape fallback by built-in Responses API identifier when provider is not matched.
 */
export const RESPONSES_API_TOOL_CALL_DELTA_SHAPES: Readonly<Record<string, ToolCallArgumentsDeltaShape>> = {
	"openai-responses": "incremental",
	"azure-openai-responses": "incremental",
	"openai-codex-responses": "cumulative",
	openrouter: "incremental",
};

export function resolveResponsesToolCallDeltaShape(
	providerOrModel: string | { provider?: string; api?: string },
	api?: string,
): ToolCallArgumentsDeltaShape {
	const provider = typeof providerOrModel === "string" ? providerOrModel : (providerOrModel.provider ?? "");
	const resolvedApi = typeof providerOrModel === "object" ? (providerOrModel.api ?? api) : api;

	const providerShape = provider ? RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES[provider] : undefined;
	if (providerShape) return providerShape;

	const apiShape = resolvedApi ? RESPONSES_API_TOOL_CALL_DELTA_SHAPES[resolvedApi] : undefined;
	if (apiShape) return apiShape;

	throw new Error(
		`Undeclared tool-call argument delta wire shape for provider "${provider}" (api: "${resolvedApi}"). Explicitly declare its shape in RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES before routing through the Responses accumulator.`,
	);
}

/**
 * Accumulate one streamed function-argument delta into the live buffer.
 *
 * Wire streams differ in the shape of `response.function_call_arguments.delta`:
 * - Incremental providers (e.g. OpenAI Responses, Azure OpenAI Responses) deliver
 *   true incremental string fragments.
 * - Cumulative providers (e.g. OpenAI Codex Responses) deliver cumulative snapshots
 *   representing the full arguments string accumulated so far.
 *
 * The accumulator behavior is driven by the explicitly declared {@link ToolCallArgumentsDeltaShape}
 * rather than guessing or inferring from payload bytes: inferring cumulative resends
 * via prefix heuristics on an incremental stream risks corrupting valid arguments
 * (such as repeated keys or indentation that coincidental prefix matches truncate),
 * while unconditional appending on a cumulative stream doubles argument text.
 *
 * Authoritative final arguments are applied on `response.function_call_arguments.done` via
 * {@link finalizeToolCallArgumentsDone}.
 */
export function accumulateToolCallArgumentsDelta(
	block: ResponsesToolCallBlock,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	shape: ToolCallArgumentsDeltaShape,
): void {
	if (shape === "cumulative") {
		const previous = block[kStreamingPartialJson] ?? "";
		const accumulated = delta.startsWith(previous) ? delta : previous + delta;
		const incrementalDelta = accumulated.slice(previous.length);
		block[kStreamingPartialJson] = accumulated;
		const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			block.arguments = throttled.value;
			block[kStreamingLastParseLen] = throttled.parsedLen;
		}
		if (incrementalDelta) {
			stream.push({ type: "toolcall_delta", contentIndex, delta: incrementalDelta, partial: output });
		}
	} else {
		block[kStreamingPartialJson] = (block[kStreamingPartialJson] ?? "") + delta;
		const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			block.arguments = throttled.value;
			block[kStreamingLastParseLen] = throttled.parsedLen;
		}
		if (delta) {
			stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
		}
	}
}

/**
 * Finalize streamed function-call arguments from the authoritative `.done`
 * payload. The caller owns the `argumentsDone` flag (generic Responses sets it;
 * Codex's block shape has no such field), so this only rewrites `arguments` and
 * drops the transient accumulation fields.
 */
export function finalizeToolCallArgumentsDone(block: ResponsesToolCallBlock, args: string): void {
	block[kStreamingPartialJson] = args;
	block.arguments = parseStreamingJson(block[kStreamingPartialJson]);
	clearStreamingPartialJson(block);
}

export function accumulateCustomToolCallInputDelta(
	block: ResponsesToolCallBlock,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	block[kStreamingPartialJson] += delta;
	block.arguments = { input: block[kStreamingPartialJson] };
	stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
}

export function finalizeCustomToolCallInputDone(block: ResponsesToolCallBlock, input: string): void {
	block[kStreamingPartialJson] = input;
	block.arguments = { input };
}

type OpenAIResponsesTerminalStreamEvent =
	| Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>
	| { type: "response.done"; response?: Partial<OpenAIResponse> };

/**
 * Some Responses-compatible backends (Azure deployments among them) report
 * failure detail under an undocumented `status_details` envelope instead of
 * the SDK-typed top-level `error` field.
 */
interface ResponsesStatusDetailsView {
	status_details?: { error?: { code?: string; message?: string }; reason?: unknown };
}

function getOpenAIResponsesTerminalEvent(event: ResponseStreamEvent): OpenAIResponsesTerminalStreamEvent | undefined {
	const type = (event as { type?: unknown }).type;
	return type === "response.completed" || type === "response.incomplete" || type === "response.done"
		? (event as OpenAIResponsesTerminalStreamEvent)
		: undefined;
}

export interface ProcessResponsesStreamOptions {
	onFirstToken?: () => void;
	onOutputItemDone?: (item: ResponseOutputItem) => void;
	/**
	 * Called when a terminal `response.completed`, `response.incomplete`, or
	 * `response.done` event is successfully processed. Only invoked on the
	 * successful-completion path; thrown failure (`response.failed`) and
	 * cancellation paths never call this.
	 * Used by callers to detect premature stream closure (i.e. the stream ended
	 * without a recognized terminal event).
	 */
	onCompleted?: () => void;
	/**
	 * Caller-requested service tier, used to bill the served tier when the
	 * response omits the `service_tier` echo. Only applied for `provider: "openai"`.
	 */
	requestServiceTier?: ServiceTier;
}

type StreamingToolCallBlock = ToolCall & {
	[kStreamingPartialJson]: string;
	[kStreamingLastParseLen]?: number;
	[kStreamingArgumentsDone]?: boolean;
};

/** A Responses output item open on the stream, and the content block it streams into. */
interface StreamingItem {
	item: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | ResponseCustomToolCall;
	block: ThinkingContent | TextContent | StreamingToolCallBlock;
}

interface ReasoningEntry extends StreamingItem {
	item: ResponseReasoningItem;
	block: ThinkingContent;
}

interface MessageEntry extends StreamingItem {
	item: ResponseOutputMessage;
	block: TextContent;
}

interface ToolCallEntry<TItem extends ResponseFunctionToolCall | ResponseCustomToolCall> extends StreamingItem {
	item: TItem;
	block: StreamingToolCallBlock;
}

/** The routing keys a per-item Responses event can carry. */
interface OpenItemKeys {
	output_index?: number;
	item_id?: string;
}

type ResponsesEvent<TType extends ResponseStreamEvent["type"]> = Extract<ResponseStreamEvent, { type: TType }>;

function isReasoningEntry(entry: StreamingItem | undefined): entry is ReasoningEntry {
	return entry?.item.type === "reasoning" && entry.block.type === "thinking";
}

function isMessageEntry(entry: StreamingItem | undefined): entry is MessageEntry {
	return entry?.item.type === "message" && entry.block.type === "text";
}

function isFunctionCallEntry(entry: StreamingItem | undefined): entry is ToolCallEntry<ResponseFunctionToolCall> {
	return entry?.item.type === "function_call" && entry.block.type === "toolCall";
}

function isCustomToolCallEntry(entry: StreamingItem | undefined): entry is ToolCallEntry<ResponseCustomToolCall> {
	return entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall";
}

function isUnfinishedFunctionCall(entry: StreamingItem | undefined): boolean {
	return isFunctionCallEntry(entry) && !entry.block[kStreamingArgumentsDone];
}

function hasOpenItemKey(event: OpenItemKeys): boolean {
	return typeof event.output_index === "number" || event.item_id !== undefined;
}

function prefixedFunctionCallItemKey(callId: string | undefined): string | undefined {
	return callId ? `fc_${callId}` : undefined;
}

function startsJsonObjectDelta(delta: unknown): boolean {
	if (typeof delta !== "string") return false;
	for (let index = 0; index < delta.length; index++) {
		const code = delta.charCodeAt(index);
		if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20) continue;
		return code === 0x7b;
	}
	return false;
}

function shouldAdvanceIdentifierlessFunctionDelta(
	event: OpenItemKeys & { delta?: unknown },
	candidate: StreamingItem,
): boolean {
	const delta = event.delta;
	if (
		hasOpenItemKey(event) ||
		typeof delta !== "string" ||
		!startsJsonObjectDelta(delta) ||
		candidate.item.type !== "function_call" ||
		candidate.block.type !== "toolCall"
	) {
		return false;
	}
	const partial = candidate.block[kStreamingPartialJson];
	if (partial.trim().length === 0) return false;
	// A `{`-starting identifierless delta is ambiguous: the opening of a new
	// sibling call, or continuation bytes inside the candidate's own argument
	// JSON (`{"command":"echo ` + `{1..3}"}`). Advance only when the candidate
	// cannot absorb the delta: its buffer is already one complete JSON value,
	// already unsalvageable (lossy hosts abandon buffers mid-string, leaving
	// raw control characters strict JSON forbids), or the concatenation would
	// break it. Otherwise the delta is a legal continuation and must stay.
	const state = classifyJsonPrefix(partial);
	if (state !== "prefix") return true;
	return classifyJsonPrefix(partial + delta) === "invalid";
}

/**
 * The output items open on one Responses stream, routed by `output_index`, item id and call-id aliases.
 *
 * Multiple items (parallel function_calls in particular) can be open at the same
 * time. OpenAI's spec routes every per-item event by `output_index`/`item_id`.
 * llama.cpp emits parallel function_call deltas interleaved, and a singleton
 * `current` reference would
 * fold them into the wrong block and drop arguments on every call but the last.
 *
 * OpenAI-compatible hosts can compound this by omitting `item.id` and
 * `output_index` on `output_item.added` while routing later argument deltas to
 * either the bare `call_id` or a synthesized `fc_<call_id>` item id. Register
 * both keys so each delta reaches its own block instead of falling back to the
 * most recently added parallel call.
 */
class ResponsesOpenItems {
	readonly #byOutputIndex = new Map<number, StreamingItem>();
	readonly #byItemId = new Map<string, StreamingItem>();
	readonly #byPrefixedCallId = new Map<string, StreamingItem>();
	readonly #inOrder: StreamingItem[] = [];
	#last: StreamingItem | undefined;
	#identifierlessFunctionDeltaTarget: StreamingItem | undefined;

	register(
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void {
		if (typeof outputIndex === "number") this.#byOutputIndex.set(outputIndex, entry);
		if (itemId) this.#byItemId.set(itemId, entry);
		if (alternateItemKey && alternateItemKey !== itemId) this.#byItemId.set(alternateItemKey, entry);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey
		) {
			this.#byPrefixedCallId.set(prefixedAlternateItemKey, entry);
		}
		this.#inOrder.push(entry);
		this.#last = entry;
	}

	close(
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem | undefined,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void {
		if (typeof outputIndex === "number") this.#byOutputIndex.delete(outputIndex);
		if (itemId) this.#byItemId.delete(itemId);
		if (alternateItemKey && alternateItemKey !== itemId) this.#byItemId.delete(alternateItemKey);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey &&
			this.#byPrefixedCallId.get(prefixedAlternateItemKey) === entry
		) {
			this.#byPrefixedCallId.delete(prefixedAlternateItemKey);
		}
		if (!entry) return;
		const index = this.#inOrder.indexOf(entry);
		if (index >= 0) this.#inOrder.splice(index, 1);
		if (this.#identifierlessFunctionDeltaTarget === entry) this.#identifierlessFunctionDeltaTarget = undefined;
		if (this.#last === entry) this.#last = undefined;
	}

	lookup(event: OpenItemKeys): StreamingItem | undefined {
		if (typeof event.output_index === "number") {
			const found = this.#byOutputIndex.get(event.output_index);
			if (found) return found;
		}
		if (event.item_id) {
			const found = this.#byItemId.get(event.item_id);
			if (found) return found;
		}
		// Keyed events whose item already closed are stale; drop them instead of
		// routing to a sibling. Only fully identifierless mock/proxy events use the
		// legacy singleton fallback.
		return hasOpenItemKey(event) ? undefined : this.#last;
	}

	lookupToolCallAlias(event: OpenItemKeys, type: "function_call" | "custom_tool_call"): StreamingItem | undefined {
		if (typeof event.output_index === "number") {
			const byOutputIndex = this.#byOutputIndex.get(event.output_index);
			if (byOutputIndex) return byOutputIndex;
			// A lossy host (llama.cpp/Ollama, issue #2015) can omit `output_index` on
			// `output_item.added` while still stamping the spec-required field on the
			// delta. The index was never registered, so fall through to the prefixed
			// alias / exact item-id maps instead of dropping to the last open item.
		}
		if (event.item_id) {
			// Prefixed call-id aliases share the same wire namespace as real call ids.
			// Argument/input events can use the prefixed form, while final
			// output_item.done events use exact call ids; keep aliases in a
			// separate map so a real `call_id: "fc_x"` cannot overwrite the alias
			// for `call_id: "x"`.
			const alias = this.#byPrefixedCallId.get(event.item_id);
			if (alias?.item.type === type) return alias;
			const exact = this.#byItemId.get(event.item_id);
			if (exact) return exact;
		}
		return this.lookup(event);
	}

	lookupFunctionCall(event: OpenItemKeys & { delta?: unknown }): StreamingItem | undefined {
		if (hasOpenItemKey(event)) return this.lookupToolCallAlias(event, "function_call");
		const continuesIdentifierlessDelta = typeof event.delta === "string";
		if (continuesIdentifierlessDelta) {
			const target = this.#continueIdentifierlessDelta(event);
			if (target) return target;
		}
		let skippedStartedCandidate = false;
		for (let index = 0; index < this.#inOrder.length; index++) {
			const candidate = this.#inOrder[index]!;
			if (!isUnfinishedFunctionCall(candidate)) continue;
			if (
				shouldAdvanceIdentifierlessFunctionDelta(event, candidate) &&
				this.#hasLaterUnfinishedFunctionCall(index)
			) {
				skippedStartedCandidate = true;
				continue;
			}
			if (continuesIdentifierlessDelta) this.#identifierlessFunctionDeltaTarget = candidate;
			return candidate;
		}
		if (skippedStartedCandidate && startsJsonObjectDelta(event.delta)) return undefined;
		return this.#last?.item.type === "function_call" ? this.#last : undefined;
	}

	/** The call the previous identifierless delta went to, while this delta still continues it. */
	#continueIdentifierlessDelta(event: OpenItemKeys & { delta?: unknown }): StreamingItem | undefined {
		const target = this.#identifierlessFunctionDeltaTarget;
		if (!target) return undefined;
		const targetIndex = this.#inOrder.indexOf(target);
		if (targetIndex < 0 || !isUnfinishedFunctionCall(target)) {
			this.#identifierlessFunctionDeltaTarget = undefined;
			return undefined;
		}
		const advances =
			shouldAdvanceIdentifierlessFunctionDelta(event, target) && this.#hasLaterUnfinishedFunctionCall(targetIndex);
		return advances ? undefined : target;
	}

	#hasLaterUnfinishedFunctionCall(start: number): boolean {
		for (let index = start + 1; index < this.#inOrder.length; index++) {
			if (isUnfinishedFunctionCall(this.#inOrder[index])) return true;
		}
		return false;
	}
}

/** The detail of a failed Responses turn: its error, its incomplete reason, or `status_details.reason` when given. */
function responsesFailureMessage(
	error: { code?: string | null; message?: string | null } | null | undefined,
	incompleteReason: string | null | undefined,
	statusDetailsReason?: unknown,
): string {
	if (error) return `${error.code || "unknown"}: ${error.message || "no message"}`;
	if (incompleteReason) return `incomplete: ${incompleteReason}`;
	if (typeof statusDetailsReason === "string" && statusDetailsReason.length > 0) {
		return `status_details: ${statusDetailsReason}`;
	}
	return "Unknown error (no error details in response)";
}

/** The error a Responses `error` event reports. */
function responsesErrorEventError(event: ResponsesEvent<"error">, provider: string): AIError.ProviderResponseError {
	// Error events carry either a nested `error` object or the code/message
	// fields inline, depending on the backend.
	const errorEvent = event as {
		error?: { code?: unknown; message?: unknown };
		code?: unknown;
		message?: unknown;
	};
	const err = errorEvent.error ?? errorEvent;
	const code = err.code ?? "unknown";
	const message = err.message ?? "no message";
	return new AIError.ProviderResponseError(`Error Code ${code}: ${message}`, { provider, kind: "output" });
}

/** The authoritative final arguments of a function call: its `.done` arguments, the item's own, or the streamed buffer. */
function functionCallFinalArguments(
	item: ResponseFunctionToolCall,
	block: StreamingToolCallBlock | undefined,
): ToolCall["arguments"] {
	if (block?.[kStreamingArgumentsDone]) return block.arguments;
	if (item.arguments) return parseStreamingJson(item.arguments);
	if (block?.[kStreamingPartialJson]) return parseStreamingJson(block[kStreamingPartialJson]);
	return parseStreamingJson("{}");
}

/** Folds one Responses event stream into an assistant message, one event at a time. */
class ResponsesStreamDecoder<TApi extends Api> {
	readonly #items = new ResponsesOpenItems();
	readonly #output: AssistantMessage;
	readonly #stream: AssistantMessageEventStream;
	readonly #model: Model<TApi>;
	readonly #options: ProcessResponsesStreamOptions | undefined;
	readonly #deltaShape: ToolCallArgumentsDeltaShape;
	#sawFirstToken = false;

	constructor(
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
		model: Model<TApi>,
		options: ProcessResponsesStreamOptions | undefined,
	) {
		this.#output = output;
		this.#stream = stream;
		this.#model = model;
		this.#options = options;
		this.#deltaShape = resolveResponsesToolCallDeltaShape(model);
	}

	/** Fold one event into the message. True once a terminal event completed the turn. */
	apply(event: ResponseStreamEvent): boolean {
		switch (event.type) {
			case "response.created":
				this.#output.responseId = event.response.id;
				return false;
			case "response.output_item.added":
				if (!this.#sawFirstToken) {
					this.#sawFirstToken = true;
					this.#options?.onFirstToken?.();
				}
				this.#startItem(event.item, event.output_index);
				return false;
			case "response.output_item.done":
				this.#finishItem(event);
				return false;
			case "response.reasoning_summary_part.added":
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_summary_part.done":
			case "response.reasoning_text.delta":
				this.#applyReasoningEvent(event);
				return false;
			case "response.content_part.added":
			case "response.output_text.delta":
			case "response.refusal.delta":
				this.#applyMessageEvent(event);
				return false;
			case "response.function_call_arguments.delta":
			case "response.function_call_arguments.done":
				this.#applyFunctionCallEvent(event);
				return false;
			case "response.custom_tool_call_input.delta":
			case "response.custom_tool_call_input.done":
				this.#applyCustomToolCallEvent(event);
				return false;
			case "error":
				throw responsesErrorEventError(event, this.#model.provider);
			case "response.failed": {
				populateResponsesUsageFromResponse(this.#output, event.response?.usage);
				const error =
					event.response?.error ??
					(event.response as ResponsesStatusDetailsView | undefined)?.status_details?.error;
				throw new AIError.ProviderResponseError(
					responsesFailureMessage(error, event.response?.incomplete_details?.reason),
					{ provider: this.#model.provider, kind: "output" },
				);
			}
			default: {
				const terminalEvent = getOpenAIResponsesTerminalEvent(event);
				if (!terminalEvent) return false;
				this.#complete(terminalEvent.response);
				return true;
			}
		}
	}

	#indexOf(block: ThinkingContent | TextContent | StreamingToolCallBlock): number {
		return this.#output.content.indexOf(block);
	}

	#open(
		entry: StreamingItem,
		outputIndex: number | undefined,
		start: "thinking_start" | "text_start" | "toolcall_start",
		callId?: string,
	): void {
		this.#output.content.push(entry.block);
		this.#items.register(outputIndex, entry.item.id, entry, callId, prefixedFunctionCallItemKey(callId));
		this.#stream.push({ type: start, contentIndex: this.#indexOf(entry.block), partial: this.#output });
	}

	#startItem(item: ResponseOutputItem, outputIndex: number | undefined): void {
		switch (item.type) {
			case "reasoning":
				this.#open(
					{ item, block: { type: "thinking", thinking: "", itemId: item.id } },
					outputIndex,
					"thinking_start",
				);
				return;
			case "message":
				this.#open(
					{
						item,
						block: {
							type: "text",
							text: "",
							textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined),
						},
					},
					outputIndex,
					"text_start",
				);
				return;
			case "function_call":
				this.#open(
					{
						item,
						block: {
							type: "toolCall",
							id: encodeResponsesToolCallId(item.call_id, item.id),
							name: item.name,
							arguments: {},
							[kStreamingPartialJson]: item.arguments || "",
						},
					},
					outputIndex,
					"toolcall_start",
					item.call_id,
				);
				return;
			case "custom_tool_call":
				this.#open(
					{
						item,
						block: {
							type: "toolCall",
							id: encodeResponsesToolCallId(item.call_id, item.id),
							// Preserve the raw wire name (e.g. `apply_patch`). The agent-loop
							// dispatcher matches it against both `Tool.name` and
							// `Tool.customWireName`, so this stays wire-accurate through
							// history replay while still routing to the right handler.
							name: item.name,
							arguments: { input: item.input ?? "" },
							customWireName: item.name,
							// Custom tools stream a raw string, but we reuse `partialJson` as the
							// accumulation buffer so later code that inspects the field still works.
							[kStreamingPartialJson]: item.input ?? "",
						},
					},
					outputIndex,
					"toolcall_start",
					item.call_id,
				);
				return;
		}
	}

	#applyReasoningEvent(
		event: ResponsesEvent<
			| "response.reasoning_summary_part.added"
			| "response.reasoning_summary_text.delta"
			| "response.reasoning_summary_part.done"
			| "response.reasoning_text.delta"
		>,
	): void {
		const entry = this.#items.lookup(event);
		if (!isReasoningEntry(entry)) return;
		switch (event.type) {
			case "response.reasoning_summary_part.added":
				appendReasoningSummaryPart(entry.item, event.part);
				return;
			case "response.reasoning_summary_text.delta":
				appendReasoningSummaryTextDelta(
					entry.item,
					entry.block,
					event.delta,
					this.#stream,
					this.#output,
					this.#indexOf(entry.block),
				);
				return;
			case "response.reasoning_summary_part.done":
				appendReasoningSummaryPartDone(
					entry.item,
					entry.block,
					this.#stream,
					this.#output,
					this.#indexOf(entry.block),
				);
				return;
			case "response.reasoning_text.delta":
				// Raw reasoning text delta from local providers that stream thinking
				// directly rather than via the OpenAI summary tracking protocol.
				entry.block.thinking += event.delta;
				this.#stream.push({
					type: "thinking_delta",
					contentIndex: this.#indexOf(entry.block),
					delta: event.delta,
					partial: this.#output,
				});
				return;
		}
	}

	#applyMessageEvent(
		event: ResponsesEvent<"response.content_part.added" | "response.output_text.delta" | "response.refusal.delta">,
	): void {
		const entry = this.#items.lookup(event);
		if (!isMessageEntry(entry)) return;
		if (event.type === "response.content_part.added") {
			appendMessageContentPart(entry.item, event.part);
			return;
		}
		appendMessageTextDelta(
			entry.item,
			entry.block,
			event.delta,
			this.#stream,
			this.#output,
			this.#indexOf(entry.block),
			event.type === "response.output_text.delta" ? "output_text" : "refusal",
		);
	}

	#applyFunctionCallEvent(
		event: ResponsesEvent<"response.function_call_arguments.delta" | "response.function_call_arguments.done">,
	): void {
		const entry = this.#items.lookupFunctionCall(event);
		if (!isFunctionCallEntry(entry)) return;
		if (event.type === "response.function_call_arguments.delta") {
			accumulateToolCallArgumentsDelta(
				entry.block,
				event.delta,
				this.#stream,
				this.#output,
				this.#indexOf(entry.block),
				this.#deltaShape,
			);
			return;
		}
		finalizeToolCallArgumentsDone(entry.block, event.arguments);
		entry.block[kStreamingArgumentsDone] = true;
	}

	#applyCustomToolCallEvent(
		event: ResponsesEvent<"response.custom_tool_call_input.delta" | "response.custom_tool_call_input.done">,
	): void {
		const entry = this.#items.lookupToolCallAlias(event, "custom_tool_call");
		if (!isCustomToolCallEntry(entry)) return;
		if (event.type === "response.custom_tool_call_input.delta") {
			accumulateCustomToolCallInputDelta(
				entry.block,
				event.delta,
				this.#stream,
				this.#output,
				this.#indexOf(entry.block),
			);
			return;
		}
		finalizeCustomToolCallInputDone(entry.block, event.input);
	}

	#finishItem(event: ResponsesEvent<"response.output_item.done">): void {
		const item = structuredCloneJSON(event.item);
		this.#options?.onOutputItemDone?.(item);
		switch (item.type) {
			case "reasoning":
				this.#finishReasoning(item, event.output_index);
				return;
			case "message":
				this.#finishMessage(item, event.output_index);
				return;
			case "function_call":
				this.#finishFunctionCall(item, event.output_index);
				return;
			case "custom_tool_call":
				this.#finishCustomToolCall(item, event.output_index);
				return;
		}
	}

	#finishReasoning(item: ResponseReasoningItem, outputIndex: number | undefined): void {
		const entry = this.#items.lookup({ output_index: outputIndex, item_id: item.id });
		// Prefer the routed entry; the bare itemId find misroutes when ids are
		// absent (`undefined === undefined` matches the FIRST thinking block) and
		// misses entirely when the done-event id drifts from the added-event id.
		const reasoningBlock =
			entry?.block.type === "thinking"
				? entry.block
				: (this.#output.content.find(b => b.type === "thinking" && (b as ThinkingContent).itemId === item.id) as
						| ThinkingContent
						| undefined);
		if (reasoningBlock) {
			reasoningBlock.thinking = finalizeReasoningThinking(item, reasoningBlock.thinking);
			reasoningBlock.thinkingSignature = JSON.stringify(item);
			this.#stream.push({
				type: "thinking_end",
				contentIndex: this.#indexOf(reasoningBlock),
				content: reasoningBlock.thinking,
				partial: this.#output,
			});
		}
		this.#items.close(outputIndex, item.id, entry);
	}

	#finishMessage(item: ResponseOutputMessage, outputIndex: number | undefined): void {
		const entry = this.#items.lookup({ output_index: outputIndex, item_id: item.id });
		const block = entry?.block.type === "text" ? entry.block : undefined;
		const text = finalizeMessageText(item, block?.text ?? "");
		const textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
		let contentIndex: number;
		if (block) {
			block.text = text;
			block.textSignature = textSignature;
			contentIndex = this.#indexOf(block);
		} else {
			// `output_item.added` never arrived (lossy proxy) — synthesize the
			// block so the final message still carries the authoritative text.
			this.#output.content.push({ type: "text", text, textSignature });
			contentIndex = this.#output.content.length - 1;
		}
		this.#stream.push({ type: "text_end", contentIndex, content: text, partial: this.#output });
		this.#items.close(outputIndex, item.id, entry);
	}

	#finishFunctionCall(item: ResponseFunctionToolCall, outputIndex: number | undefined): void {
		const entry = this.#items.lookup({ output_index: outputIndex, item_id: item.id ?? item.call_id });
		const block = entry?.block.type === "toolCall" ? entry.block : undefined;
		const args = functionCallFinalArguments(item, block);
		// Persist the authoritative final args on the stored block. The
		// throttled delta parser may have skipped the last partial parse,
		// leaving block.arguments stale (often `{}`); the emitted toolCall
		// and the persisted block must agree.
		this.#endToolCall(item, outputIndex, entry, block, args, {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: args,
		});
	}

	#finishCustomToolCall(item: ResponseCustomToolCall, outputIndex: number | undefined): void {
		const entry = this.#items.lookup({ output_index: outputIndex, item_id: item.id ?? item.call_id });
		const block = entry?.block.type === "toolCall" ? entry.block : undefined;
		const rawInput = block?.[kStreamingPartialJson] ? block[kStreamingPartialJson] : (item.input ?? "");
		this.#endToolCall(
			item,
			outputIndex,
			entry,
			block,
			{ input: rawInput },
			{
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: item.name,
				arguments: { input: rawInput },
				customWireName: item.name,
			},
		);
	}

	/**
	 * Store a finished tool call's final arguments on its streamed block and drop the transient
	 * accumulation buffer. A call whose `output_item.added` never arrived (lossy proxy) is
	 * synthesized so the final message carries the call the consumer was told completed (the
	 * agent loop executes tools from message.content).
	 */
	#endToolCall(
		item: ResponseFunctionToolCall | ResponseCustomToolCall,
		outputIndex: number | undefined,
		entry: StreamingItem | undefined,
		block: StreamingToolCallBlock | undefined,
		finalArguments: ToolCall["arguments"],
		toolCall: ToolCall,
	): void {
		let contentIndex: number;
		if (block) {
			block.arguments = finalArguments;
			clearStreamingPartialJson(block);
			contentIndex = this.#indexOf(block);
		} else {
			this.#output.content.push(toolCall);
			contentIndex = this.#output.content.length - 1;
		}
		this.#items.close(outputIndex, item.id, entry, item.call_id, prefixedFunctionCallItemKey(item.call_id));
		this.#stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.#output });
	}

	#complete(response: OpenAIResponsesTerminalStreamEvent["response"]): void {
		const output = this.#output;
		const model = this.#model;
		finalizePendingResponsesToolCalls(output);
		if (response?.id) {
			output.responseId = response.id;
		}
		populateResponsesUsageFromResponse(output, response?.usage);
		calculateCost(model, output.usage);
		applyOpenAIResponsesServiceTierCost(
			model,
			output.usage,
			(response as { service_tier?: unknown } | undefined)?.service_tier,
			this.#options?.requestServiceTier,
		);
		output.stopReason = mapOpenAIResponsesStopReason(response?.status);
		if (response?.status === "failed" || response?.status === "cancelled") {
			const statusDetails = (response as ResponsesStatusDetailsView).status_details;
			throw new AIError.ProviderResponseError(
				responsesFailureMessage(
					response.error ?? statusDetails?.error,
					response.incomplete_details?.reason,
					statusDetails?.reason,
				),
				{ provider: model.provider, kind: "output" },
			);
		}
		if (response?.status === "incomplete" && response.incomplete_details?.reason === "content_filter") {
			// A content-filtered turn is a failure, not a token-cap truncation —
			// mapping it to "length" would route the agent loop into "shorten your
			// output" recovery against a filtered prompt.
			throw new AIError.ProviderResponseError("incomplete: content_filter", {
				provider: model.provider,
				kind: "content-blocked",
			});
		}
		promoteResponsesToolUseStopReason(output, (response as { end_turn?: boolean } | undefined)?.end_turn);
		this.#options?.onCompleted?.();
	}
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: ProcessResponsesStreamOptions,
): Promise<void> {
	const decoder = new ResponsesStreamDecoder(output, stream, model, options);
	for await (const event of openaiStream) {
		// `response.completed`/`response.incomplete`/`response.done` is the last event of a
		// Responses stream. Stop pulling instead of waiting for the server to
		// close the connection: misbehaving providers keep the socket open
		// after the terminal event, which would park this loop until the idle
		// watchdog converts an already-successful turn into a timeout error.
		// Breaking unwinds the iterator chain (the consumer's `.return()`
		// reaches the SDK stream), actively releasing the connection.
		if (decoder.apply(event)) break;
	}
}

export function mapOpenAIResponsesStopReason(status: ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			// Compile-time exhaustiveness; at runtime a brand-new status from the
			// server must degrade gracefully instead of failing a fully-streamed
			// response.
			const exhaustive: never = status;
			logger.warn("Unhandled OpenAI Responses stop reason", { status: exhaustive });
			return "stop";
		}
	}
}

/**
 * Finalize any streamed toolCall block whose `output_item.done` never arrived
 * (lossy proxy, or a terminal event that raced the per-item done): parse the
 * accumulated `partialJson` into authoritative arguments and strip the transient
 * streaming fields so they never persist. Shared by the chat-Responses decoder
 * and the Codex decoder. Closed blocks already cleared these fields, so walking
 * the full content list leaves them untouched.
 */
export function finalizePendingResponsesToolCalls(output: AssistantMessage): void {
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		const pending = block as ToolCall & {
			[kStreamingPartialJson]?: string;
			[kStreamingLastParseLen]?: number;
			[kStreamingArgumentsDone]?: boolean;
		};
		if (pending[kStreamingPartialJson] && !pending[kStreamingArgumentsDone]) {
			pending.arguments =
				pending.customWireName !== undefined
					? { input: pending[kStreamingPartialJson] }
					: parseStreamingJson(pending[kStreamingPartialJson]);
		}
		clearStreamingPartialJson(pending);
	}
}

/**
 * Apply the Responses terminal stop-reason invariants shared by the chat-Responses
 * and Codex decoders: a turn that produced tool calls becomes `toolUse`, and a
 * Codex-lineage `end_turn: false` marker pauses the turn so the agent loop
 * re-samples instead of ending. Callers set `output.stopReason` from the wire
 * status first via {@link mapOpenAIResponsesStopReason}.
 */
export function promoteResponsesToolUseStopReason(output: AssistantMessage, endTurn: boolean | undefined): void {
	if (output.content.some(block => block.type === "toolCall") && output.stopReason === "stop") {
		output.stopReason = "toolUse";
	}
	if (endTurn === false && output.stopReason === "stop") {
		output.stopDetails = { type: "pause_turn" };
	}
}
