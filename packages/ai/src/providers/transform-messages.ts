import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { resolveCatalogPolicy } from "@veyyon/catalog/compat/catalog-policy";
import { carriesReasoning } from "@veyyon/catalog/compat/reasoning-carry";
import * as logger from "@veyyon/utils/logger";
import { escapeXmlAttribute } from "@veyyon/utils/sanitize-text";
import { isRecord } from "@veyyon/utils/type-guards";
import { renderDemotedThinking } from "../dialect/demotion";
import type {
	Api,
	AssistantMessage,
	DemotedReasoningSource,
	Message,
	Model,
	ProviderPayload,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types";
import {
	type DemotedThinkingCarrier,
	isDemotedThinking,
	kCarriedReasoning,
	kDemotedThinking,
	kSyntheticUser,
	type SyntheticUserCarrier,
} from "../utils/block-symbols";

const enum ToolCallStatus {
	/** A tool result has already been emitted for this tool call; later duplicates must be skipped. */
	Resolved = 1,
	/** A synthetic aborted result was emitted; later real results must be skipped. */
	Aborted = 2,
}

/**
 * Wrap a tool result whose originating tool call is no longer in the request.
 *
 * Compaction, session-tree branching, a locally rejected call and a
 * `providerPayload` splice all produce a result with no call to pair it to.
 * Every provider rejects the unpaired block, and dropping it loses output the
 * model needs, so the payload is preserved as an ordinary message instead.
 *
 * A caller MUST attach this to `role: "user"`, never `role: "assistant"`.
 * The assistant role puts tool output in the model's own voice, and a model
 * that reads its own prior turn ending in a note shaped like a tool result
 * reproduces that shape: `grok-4.6` on `openai-responses` emitted a whole
 * `search` result as visible prose, with a provider `textSignature` proving it
 * generated the text token by token rather than the note being echoed back.
 * The user role also keeps stale, model-untrusted output from gaining
 * instruction priority: `developer` maps to `system` on Ollama and stays above
 * user priority on OpenAI reasoning models, while `user` is plain content
 * everywhere.
 *
 * The tag matters as much as the role. An XML envelope reads as data the model
 * quotes from, where a bare `[Orphan tool result; call_id=…]: ` prefix reads as
 * a message template it can imitate.
 */
export function staleToolResultNote(options: {
	toolName: string;
	toolCallId: string;
	text: string;
	isError?: boolean;
}): string {
	const errorAttr = options.isError ? ' is-error="true"' : "";
	// Attributes are escaped through the one owner; the body stays raw, matching
	// `<tool_response>` in dialect/rendering.ts, because escaping a tool payload
	// turns every `<` in the code the model is reading into `&lt;`.
	const tool = escapeXmlAttribute(options.toolName);
	const id = escapeXmlAttribute(options.toolCallId);
	return `<stale-tool-result tool="${tool}" id="${id}"${errorAttr}>\n${options.text}\n</stale-tool-result>`;
}

/**
 * The note format persisted before the repair moved to `role: "user"`:
 * `[Orphan <tool> result; call_id=<id>]: <output>` from the Responses repair,
 * and `[Previous …]` from the Codex one.
 */
const LEGACY_STALE_TOOL_NOTE = /^\[(?:Orphan|Previous) [^\]]*result; call_id=[^\]]*\]: /;

/**
 * Text of every tool result the model read between the previous assistant turn
 * and `index`. An imitated note copies one of these verbatim, so they are the
 * only evidence of where the copy ends and the model's own reply begins.
 */
function precedingToolOutputs(messages: readonly Message[], index: number): string[] {
	const outputs: string[] = [];
	for (let i = index - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "assistant") break;
		if (message.role !== "toolResult") continue;
		const text = message.content
			.filter((block): block is TextContent => block.type === "text")
			.map(block => block.text)
			.join("\n");
		if (text.length > 0) outputs.push(text);
	}
	return outputs;
}

/**
 * Strip a legacy note from one assistant text.
 *
 * Returns the text unchanged when it holds no note, the reply that followed the
 * copied payload when the copy is byte-equal to one of `priorToolOutputs`, and
 * `undefined` when nothing of the model's own can be separated from the copy.
 * A copy that drifts from the tool output (paraphrased, truncated) cannot be
 * split soundly, so the block goes in full rather than keeping tool output in
 * the assistant's voice; measured over recorded sessions, about a third of the
 * notes are exact copies and a quarter of those carry a reply after them.
 */
function stripLegacyStaleToolNote(text: string, priorToolOutputs: readonly string[]): string | undefined {
	const match = LEGACY_STALE_TOOL_NOTE.exec(text);
	if (!match) return text;
	const rest = text.slice(match[0].length);
	for (const output of priorToolOutputs) {
		if (!rest.startsWith(output)) continue;
		const reply = rest.slice(output.length).trim();
		return reply.length > 0 ? reply : undefined;
	}
	return undefined;
}

/**
 * Apply {@link stripLegacyStaleToolNote} to the transport-native copy of the
 * turn. A Responses-family provider replays `providerPayload.items` verbatim
 * once its session is warm, in preference to `content`, so a note left in an
 * `output_text` part would keep priming the model on the live path no matter
 * what `content` says.
 */
function stripLegacyStaleToolNotesFromPayload(
	payload: ProviderPayload,
	priorToolOutputs: readonly string[],
): ProviderPayload {
	const items = payload.items.flatMap(item => {
		const parts: unknown = item.content;
		if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(parts)) return [item];
		const content = parts.flatMap((part: unknown) => {
			if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") return [part];
			const text = stripLegacyStaleToolNote(part.text, priorToolOutputs);
			if (text === part.text) return [part];
			return text === undefined ? [] : [{ ...part, text }];
		});
		return content.length > 0 ? [{ ...item, content }] : [];
	});
	return { ...payload, items };
}

/**
 * Remove legacy stale-tool notes from assistant history.
 *
 * The payload is not re-emitted as a user note. It is truncated output from a
 * call that left the request many turns ago, and a message inserted between an
 * assistant `tool_use` and its `tool_result` would break the contiguity
 * Anthropic requires, so the cost of keeping it exceeds what it can inform.
 */
function dropLegacyStaleToolNotes(messages: Message[]): Message[] {
	// This runs on every request for every provider, and all but a handful of
	// sessions hold no such note, so the common path must not copy the history:
	// scan first and hand back the same array. `content` is the detector for
	// `providerPayload` too: both come from the same response, so a note in one
	// is in the other.
	if (!messages.some(hasLegacyStaleToolNote)) return messages;

	const result: Message[] = [];
	for (const [index, message] of messages.entries()) {
		if (!hasLegacyStaleToolNote(message)) {
			result.push(message);
			continue;
		}
		const stripped = stripLegacyStaleToolNotesFromAssistant(message, precedingToolOutputs(messages, index));
		if (stripped) result.push(stripped);
	}
	return result;
}

function hasLegacyStaleToolNote(message: Message): message is AssistantMessage {
	if (message.role !== "assistant") return false;
	for (const block of message.content) {
		if (block.type === "text" && LEGACY_STALE_TOOL_NOTE.test(block.text)) {
			return true;
		}
	}
	return false;
}

/**
 * The turn with each legacy note stripped from its text and its transport-native payload, or undefined
 * when nothing but notes remains: such a turn has no tool call and no reply left to replay.
 */
function stripLegacyStaleToolNotesFromAssistant(
	message: AssistantMessage,
	priorToolOutputs: readonly string[],
): AssistantMessage | undefined {
	const kept = message.content.flatMap((block): AssistantMessage["content"] => {
		if (block.type !== "text") return [block];
		const text = stripLegacyStaleToolNote(block.text, priorToolOutputs);
		if (text === block.text) return [block];
		// The signature covered the text as generated; the shortened text no
		// longer matches it, so it must not be replayed as signed.
		return text === undefined ? [] : [{ ...block, text, textSignature: undefined }];
	});
	if (kept.length === 0) return undefined;
	const providerPayload = message.providerPayload
		? stripLegacyStaleToolNotesFromPayload(message.providerPayload, priorToolOutputs)
		: undefined;
	return { ...message, content: kept, ...(providerPayload ? { providerPayload } : {}) };
}

/**
 * Maximum tool-call id length the strictest replay provider accepts.
 *
 * Anthropic requires `^[a-zA-Z0-9_-]+$` with a 64-char cap; Google and Codex
 * `normalizeToolCallId` implementations cap individual id segments to the same
 * 64-char ceiling. Replacement ids minted here flow back through
 * `convertAnthropicMessages` (and friends) unchanged, so the `_dupN` suffix
 * MUST not push a normalized id past this bound.
 */
export const MAX_TOOL_CALL_ID_LENGTH = 64;

/** Replace unsupported tool-call ID characters and cap the result for strict replay providers. */
export function normalizeToolCallId(id: string, maxLength = MAX_TOOL_CALL_ID_LENGTH): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength);
}

const TOOL_CALL_ID_PATTERN = new RegExp(`^[a-zA-Z0-9_-]{1,${MAX_TOOL_CALL_ID_LENGTH}}$`);

/** Whether `id` already satisfies the strict 1–64 `[a-zA-Z0-9_-]` tool-call ID contract. */
export function isValidToolCallId(id: string): boolean {
	return TOOL_CALL_ID_PATTERN.test(id);
}

/**
 * OpenAI Responses-family APIs mint composite tool ids (`call_id|item_id`);
 * opaque Chat Completions ids do not (openai-completions preserves same-model
 * ids verbatim as provider correlation tokens), so ONLY these origins may be
 * canonicalized to their `call_` component for pairing.
 */
export function isResponsesFamilyApi(api: Api | undefined): boolean {
	return api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses";
}

/**
 * The wire `call_id` component of a (possibly composite) Responses id: the
 * FIRST segment before `|`. A degenerate `|itemId` (empty call half, pipe at
 * index 0) keeps its full id so unrelated empty-half ids never collapse onto
 * one empty-string bucket.
 */
export function responsesCallComponent(id: string): string {
	const pipe = id.indexOf("|");
	return pipe <= 0 ? id : id.slice(0, pipe);
}

/**
 * Origin classification for tool-call ids, tracked per CONCRETE id rather than
 * by a global prefix set. Two facts drive whether an id may be canonicalized to
 * its `call_` component for pairing:
 *
 *  - `responsesComponents`: the `call_` components of ids provably minted by a
 *    Responses-family assistant turn (keyed off the source message `api`).
 *  - `opaqueCompositeCallIds`: the FULL ids of pipe-bearing tool calls from a
 *    NON-Responses (opaque Chat Completions) assistant turn. openai-completions
 *    preserves these verbatim as provider correlation tokens; the `|` is
 *    literal, so they must pair by raw equality even when their `call_` prefix
 *    happens to collide with a Responses component seen elsewhere in history.
 *
 * Scoping by concrete id (not merely a shared prefix) is load-bearing (#10284):
 * an earlier Responses `call_A` must not license canonicalizing later same-model
 * Chat Completions ids `call_A|first` / `call_A|second` onto one `call_A`
 * bucket, which would collapse two distinct opaque calls and steer a lone
 * `call_A|second` result onto the wrong call.
 */
interface ToolCallOriginScope {
	responsesComponents: ReadonlySet<string>;
	opaqueCompositeCallIds: ReadonlySet<string>;
}

/**
 * Record one assistant turn's tool-call ids into the origin-scope sets.
 *
 * Called from the normalization map (`transformMessages`) in document order, on
 * the SAME post-transform content that message emits, so the two sets cover
 * every assistant turn exactly once and hold its post-normalization, pre-dedup
 * ids (`_dupN` replacements minted later by dedup are never scope members).
 * Both sets are only read via `.has`, so ordering is inert.
 */
function recordToolCallOriginScope(
	msg: AssistantMessage,
	content: Readonly<AssistantMessage["content"]>,
	responsesComponents: Set<string>,
	opaqueCompositeCallIds: Set<string>,
): void {
	const responsesOrigin = isResponsesFamilyApi(msg.api);
	for (const block of content) {
		if (block.type !== "toolCall") continue;
		if (responsesOrigin) responsesComponents.add(responsesCallComponent(block.id));
		else if (block.id.includes("|")) opaqueCompositeCallIds.add(block.id);
	}
}

/**
 * Canonical key for pairing a tool result with its assistant tool call.
 *
 * The OpenAI Codex/Responses APIs store a tool result's id as a composite
 * `<call_id>|<response_item_id>` (e.g. `call_ABC|fc_XYZ`), while the assistant
 * `toolCall` that produced it carries the plain `call_ABC` (or a composite with
 * a DIFFERENT item half). Keying both sides on the FIRST segment pairs them,
 * while NOT collapsing two distinct parallel calls whose results happen to
 * share a `response_item` (`fc_`) half.
 *
 * SCOPING (load-bearing, #10284): a pipe-bearing id is canonicalized to its
 * `call_` component ONLY when it is not itself a concrete opaque-origin call id
 * ({@link ToolCallOriginScope.opaqueCompositeCallIds}) and its component was
 * minted by a Responses-family turn ({@link ToolCallOriginScope.responsesComponents}).
 * A same-model Chat Completions id is an OPAQUE provider correlation token that
 * may itself contain `|` (openai-completions.ts preserves it verbatim);
 * splitting it would collapse two distinct opaque calls onto one bucket, so the
 * real result never pairs and the call is back-filled with a synthetic stub.
 * Opaque ids fall through to full-id keying, where the provider's own echoed
 * `tool_call_id` already pairs result to call by raw equality.
 *
 * Pairing keys are used only for lookup; the messages' own ids are left intact
 * so the provider encoder still receives the exact wire ids it expects.
 *
 * LOAD-BEARING INVARIANT: pairing correctness depends on the wire `call_id`
 * being unique per distinct tool call. The Codex Responses wire guarantees this
 * (distinct parallel calls carry distinct call_ids; only the `fc_` half varies),
 * and genuine cross-turn id reuse is `_dup`-suffixed on the call_ segment by
 * `deduplicateToolCallIds` (which this key preserves).
 */
function toolCallPairingKey(id: string, originScope: ToolCallOriginScope): string {
	const pipe = id.indexOf("|");
	if (pipe <= 0) return id;
	if (originScope.opaqueCompositeCallIds.has(id)) return id;
	const prefix = id.slice(0, pipe);
	return originScope.responsesComponents.has(prefix) ? prefix : id;
}

export function appendDuplicateSuffix(originalId: string, suffix: string, maxLength: number): string {
	// Responses-family ids are composites (`callId|itemId`): the wire call_id is
	// the FIRST segment (normalizeResponsesToolCallId splits on `|`), so the
	// suffix must land on every segment or the duplicate collapses back onto the
	// original call_id at encode time. The length budget applies per segment,
	// matching the per-segment caps of the provider normalizers.
	if (originalId.includes("|")) {
		return originalId
			.split("|")
			.map(segment => appendSegmentDuplicateSuffix(segment, suffix, maxLength))
			.join("|");
	}
	return appendSegmentDuplicateSuffix(originalId, suffix, maxLength);
}

function appendSegmentDuplicateSuffix(segment: string, suffix: string, maxLength: number): string {
	if (segment.length + suffix.length <= maxLength) return `${segment}${suffix}`;
	const prefixBudget = Math.max(0, maxLength - suffix.length);
	return `${segment.slice(0, prefixBudget)}${suffix}`;
}

type PendingToolResultRewrite = { replacementId: string } | undefined;

/** A real (non-synthetic) tool result filed at its position in the transformed transcript. */
interface IndexedToolResult {
	index: number;
	msg: ToolResultMessage;
	consumed: boolean;
}

/**
 * File a SURVIVING (post-dedup) tool result into the request-wide index.
 *
 * Called from the dedup pass, once per tool result message, at the position the
 * message occupies in that pass's output array — so the entries and their order
 * describe the transcript the request will actually carry.
 * The caller passes the pairing key for the id that survived the pass (a `_dup`
 * rewrite changes it), which is what the consumers downstream must pair against.
 */
function indexToolResult(
	msg: ToolResultMessage,
	index: number,
	key: string,
	realToolResultsById: Map<string, IndexedToolResult[]>,
): void {
	const entry: IndexedToolResult = { index, msg, consumed: false };
	const entries = realToolResultsById.get(key);
	if (entries) entries.push(entry);
	else realToolResultsById.set(key, [entry]);
}

/**
 * Outputs of {@link deduplicateToolCallIds}.
 *
 * Both indexes describe the pass's OWN output — a `_dup` rewrite changes ids — so
 * callers read them only after the pass completes, and no caller can hand in a
 * pre-filled container.
 */
interface DeduplicatedToolCallIds {
	messages: Message[];
	/** Every real tool result filed at its position, keyed by pairing key. */
	realToolResultsById: Map<string, IndexedToolResult[]>;
	/** Pairing key of every `tool_use` id the pass left standing. */
	validToolUseIds: Set<string>;
}

function deduplicateToolCallIds(
	messages: Message[],
	originScope: ToolCallOriginScope,
	maxToolCallIdLength: number,
	duplicateSuffixPrefix: string,
): DeduplicatedToolCallIds {
	const seenToolCallIds = new Map<string, number>();
	const pendingToolResultRewrites = new Map<string, PendingToolResultRewrite[]>();
	const realToolResultsById = new Map<string, IndexedToolResult[]>();
	const validToolUseIds = new Set<string>();

	const enqueueToolResultRewrite = (id: string, rewrite: PendingToolResultRewrite): void => {
		const rewrites = pendingToolResultRewrites.get(id);
		if (rewrites) {
			rewrites.push(rewrite);
			return;
		}
		pendingToolResultRewrites.set(id, [rewrite]);
	};

	const transformed = messages.map((msg, index) => {
		if (msg.role === "toolResult") {
			// Pair on the call_ component: a composite result id
			// (`call_X|fc_Y`) must find the rewrite enqueued under its assistant
			// call's canonical id. Raw-string keying here misses the composite,
			// so the `_dup` remap silently no-ops and a reused call_id's later
			// result is dropped downstream.
			const key = toolCallPairingKey(msg.toolCallId, originScope);
			const rewrites = pendingToolResultRewrites.get(key);
			if (!rewrites || rewrites.length === 0) {
				indexToolResult(msg, index, key, realToolResultsById);
				return msg;
			}

			const rewrite = rewrites.shift();
			if (rewrites.length === 0) pendingToolResultRewrites.delete(key);
			if (rewrite) {
				const rewritten = { ...msg, toolCallId: rewrite.replacementId };
				indexToolResult(
					rewritten,
					index,
					toolCallPairingKey(rewritten.toolCallId, originScope),
					realToolResultsById,
				);
				return rewritten;
			}
			indexToolResult(msg, index, key, realToolResultsById);
			return msg;
		}

		if (msg.role !== "assistant") return msg;

		// Ids this turn has already touched; scopes the "drop carried-over pending
		// rewrites" step to an id's FIRST occurrence per turn, so multiple blocks
		// of the same id within one turn still accumulate as duplicates. Empty
		// sets always miss `.has`, so turns with no tool call allocate nothing.
		let idsTouchedInTurn: Set<string> | undefined;
		let contentChanged = false;
		const content = msg.content.map(block => {
			if (block.type !== "toolCall") return block;

			// Route all dedup bookkeeping by the call_ component so a plain
			// assistant id and a composite result id (`call_X` / `call_X|fc_Y`)
			// share one counter + rewrite queue. The `_dup` SUFFIX still lands on
			// the full wire id via `appendDuplicateSuffix` (below) — only the
			// KEYING is canonical, so emitted ids are unchanged.
			const blockKey = toolCallPairingKey(block.id, originScope);

			// Drop any pending rewrites carried over from a prior assistant turn
			// for this id on its first appearance this turn. When a later turn
			// re-emits the same id, the older duplicate call's expected result
			// never landed in time — the second pass synthesizes
			// "No result provided" for it, and the upcoming real result(id) must
			// route to one of THIS turn's calls. Without this guard the older
			// `_dup` id would steal the next result.
			if (!idsTouchedInTurn?.has(blockKey)) {
				(idsTouchedInTurn ??= new Set()).add(blockKey);
				pendingToolResultRewrites.delete(blockKey);
			}

			const previousCount = seenToolCallIds.get(blockKey) ?? 0;
			if (previousCount === 0) {
				seenToolCallIds.set(blockKey, 1);
				enqueueToolResultRewrite(blockKey, undefined);
				return block;
			}

			let duplicateIndex = previousCount;
			let replacementId = appendDuplicateSuffix(
				block.id,
				`${duplicateSuffixPrefix}${duplicateIndex}`,
				maxToolCallIdLength,
			);
			while (seenToolCallIds.has(toolCallPairingKey(replacementId, originScope))) {
				duplicateIndex += 1;
				replacementId = appendDuplicateSuffix(
					block.id,
					`${duplicateSuffixPrefix}${duplicateIndex}`,
					maxToolCallIdLength,
				);
			}
			seenToolCallIds.set(blockKey, duplicateIndex + 1);
			seenToolCallIds.set(toolCallPairingKey(replacementId, originScope), 1);
			enqueueToolResultRewrite(blockKey, { replacementId });
			contentChanged = true;
			return { ...block, id: replacementId };
		});

		// Surviving `tool_use` pairing keys, read off the SAME post-dedup content the
		// pass emits — a rewrite changes the id, so the keys must come from here and
		// not from the input message. Recorded before the early-out because
		// `!contentChanged` still returns element-identical content.
		for (const block of content) {
			if (block.type !== "toolCall") continue;
			validToolUseIds.add(toolCallPairingKey(block.id, originScope));
		}

		if (!contentChanged) return msg;
		return { ...msg, content };
	});

	return { messages: transformed, realToolResultsById, validToolUseIds };
}

/** Default for providers without an authored tool-name policy and native OpenAI Responses history. */
const MAX_TOOL_CALL_NAME_LENGTH = 128;
const STRICT_TOOL_CALL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const GOOGLE_TOOL_CALL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.:-]*$/;
/** Any character some provider accepts in a declared tool name, for checks with no target. */
const ANY_PROVIDER_TOOL_CALL_NAME_RE = /^[a-zA-Z0-9_.:-]+$/;

/**
 * Charset and length a tool-call name must meet to replay to `model`. Without a
 * target, a name passes when any provider could declare it.
 */
function toolCallNameLimits(model: Model | undefined): { allowedName: RegExp; maxLength: number } {
	if (!model) return { allowedName: ANY_PROVIDER_TOOL_CALL_NAME_RE, maxLength: MAX_TOOL_CALL_NAME_LENGTH };
	const policy = resolveCatalogPolicy(model);
	return {
		allowedName: policy.toolCallNameCharset === "google" ? GOOGLE_TOOL_CALL_NAME_RE : STRICT_TOOL_CALL_NAME_RE,
		maxLength:
			typeof policy.toolCallNameMaxLength === "number" ? policy.toolCallNameMaxLength : MAX_TOOL_CALL_NAME_LENGTH,
	};
}

/**
 * Whether a tool-call name cannot be replayed to the target: missing, empty,
 * longer than its declaration limit, or containing a character outside its
 * declaration charset. Models emit such names when the name slot carries
 * invocation text (whitespace, NULs) or an invented internal URL (`proc://*`).
 *
 * Without a target, use the OpenAI Responses native-history constraints.
 */
export function isMalformedToolCallName(
	name: unknown,
	allowedName = STRICT_TOOL_CALL_NAME_RE,
	maxLength = MAX_TOOL_CALL_NAME_LENGTH,
): boolean {
	return typeof name !== "string" || name.length > maxLength || !allowedName.test(name);
}

function isMalformedToolCallId(id: string | undefined): boolean {
	return !id || id.trim().length === 0;
}

function isMalformedToolCall(block: { id: string; name: string }, allowedName: RegExp, maxLength: number): boolean {
	return isMalformedToolCallId(block.id) || isMalformedToolCallName(block.name, allowedName, maxLength);
}

/**
 * Drop assistant `toolCall` blocks with an empty / whitespace-only `id` or a `name`
 * the target provider cannot declare (see {@link isMalformedToolCallName}),
 * the `toolResult` messages they point at, and any assistant turn that has no
 * replayable content left.
 *
 * Models occasionally emit malformed calls such as `{ "name": "", "arguments": "{}" }`
 * (observed: GLM-5.2 + thinking on long turns, #3458) or a structurally valid
 * `toolCall` whose provider/native passthrough id never materialized (`id: ""`).
 * The agent loop rejects or skips these at execution time, but the malformed block
 * and its error tool-result can stay in `currentContext.messages`, so every
 * subsequent request replays them. Every provider validates the call shape —
 * Anthropic 400s on `tool_use.name` / `tool_use.id` (alongside an orphan
 * `tool_result`), OpenAI Chat Completions 400s on malformed
 * `tool_calls[i].function.*` — wedging the session in a 400 loop until manual
 * `/clear`. Gateways also hand back the model's whole invocation text as the
 * name (observed: a 9654-char script and a NUL-separated `bash\0arg\0…` string
 * from GLM-5.3); OpenAI Responses rejects any replayed `input[N].name` over
 * 128 characters with `string_above_max_length`.
 *
 * Run before any other transform so the rest of the pipeline never sees a
 * malformed call. Idempotent for the same target: a re-run on an already-sanitized
 * list returns the input untouched.
 */
function sanitizeMalformedToolCalls(messages: Message[], model: Model): Message[] {
	const { allowedName, maxLength } = toolCallNameLimits(model);
	// Fast path: skip the rewrite entirely when nothing is malformed.
	let hasMalformed = false;
	outer: for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "toolCall" && isMalformedToolCall(block, allowedName, maxLength)) {
				hasMalformed = true;
				break outer;
			}
		}
	}
	if (!hasMalformed) return messages;

	// Positional FIFO pairing within one assistant→tool-result window: a tool-call
	// id can repeat across history when an OpenAI-Responses composite id
	// (`callId|itemId`) collapses on the wire to the same `callId` (see
	// `deduplicateToolCallIds` + `transform-messages-dedup`). A set-based "drop
	// every result for this id" loses the real output for the surviving valid
	// occurrence whenever one duplicate is malformed. Track each `toolCall`
	// occurrence's malformed-ness on a per-id queue and pop on matching
	// `toolResult`, but clear the queues at every non-result boundary so a
	// malformed call whose rejection result never arrived cannot consume a later
	// valid call's real result when the id is reused.
	const dropQueues = new Map<string, boolean[]>();
	const result: Message[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			dropQueues.clear();
			const filtered: AssistantMessage["content"] = [];
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const malformed = isMalformedToolCall(block, allowedName, maxLength);
					const queue = dropQueues.get(block.id);
					if (queue) queue.push(malformed);
					else dropQueues.set(block.id, [malformed]);
					if (malformed) continue;
				}
				filtered.push(block);
			}
			if (filtered.length === 0) continue;
			result.push(filtered.length === msg.content.length ? msg : { ...msg, content: filtered });
			continue;
		}
		if (msg.role === "toolResult") {
			const queue = dropQueues.get(msg.toolCallId);
			if (queue && queue.length > 0) {
				const drop = queue.shift() === true;
				if (queue.length === 0) dropQueues.delete(msg.toolCallId);
				if (drop) continue;
			}
			result.push(msg);
			continue;
		}
		dropQueues.clear();
		result.push(msg);
	}
	return result;
}

/**
 * True when `model` would refuse or reject prior-turn reasoning that is already
 * demoted to prose. This is the unsigned-thinking replay policy of the
 * assistant branch below, applied to a text message that carries the same
 * reasoning: a signing Anthropic endpoint drops it on same-model replay, and
 * any `anthropic-messages` target drops it once `replayDemotedPriorReasoning`
 * is off, whether by catalog or learned from a `reasoning_extraction` refusal
 * (the transport clones the compat with the flag cleared before retrying, so
 * the retry and every later request of the session take this branch).
 */
function dropsDemotedPriorReasoning(source: DemotedReasoningSource, model: Model): boolean {
	if (!isAnthropicMessagesModel(model)) return false;
	if (!model.compat.replayDemotedPriorReasoning) return true;
	return model.compat.signingEndpoint && source.provider === model.provider && source.model === model.id;
}

/**
 * Drop text messages whose body is demoted prior reasoning the target cannot be
 * sent. The message carries the run outside the assistant turn, so the
 * per-block thinking policy never sees it; without this pass the prose reaches
 * the classifier on every request of the session, and the refusal retry that
 * clears `replayDemotedPriorReasoning` re-sends the same bytes.
 */
function dropUndeliverableDemotedReasoning(messages: Message[], model: Model): Message[] {
	let drops = false;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "developer") continue;
		if (message.demotedReasoningSource && dropsDemotedPriorReasoning(message.demotedReasoningSource, model)) {
			drops = true;
			break;
		}
	}
	if (!drops) return messages;
	return messages.filter(
		message =>
			(message.role !== "user" && message.role !== "developer") ||
			!message.demotedReasoningSource ||
			!dropsDemotedPriorReasoning(message.demotedReasoningSource, model),
	);
}

/**
 * Whether {@link transformMessages} drops `msg` from every replay: a turn cut
 * off by `length` / `error` / `aborted` that carries no text and no tool call.
 */
export function shouldDropTruncatedThinkingOnlyAssistant(msg: AssistantMessage): boolean {
	const isTruncatedStop = msg.stopReason === "length" || msg.stopReason === "error" || msg.stopReason === "aborted";
	return isTruncatedStop && !msg.content.some(block => block.type === "toolCall" || block.type === "text");
}

/**
 * Whether `msg` reaches a replay as an assistant turn, so it can be the latest
 * surviving one: {@link sanitizeMalformedToolCalls} drops its malformed tool
 * calls, then {@link shouldDropTruncatedThinkingOnlyAssistant} a truncated
 * turn left with no text and no tool call. On an already sanitized list this
 * is `!shouldDropTruncatedThinkingOnlyAssistant(msg)`. Pass the target `model`
 * to apply its tool-name limits; without one, any provider-declarable name survives.
 */
export function isSurvivingAssistant(msg: AssistantMessage, model?: Model): boolean {
	const isTruncatedStop = msg.stopReason === "length" || msg.stopReason === "error" || msg.stopReason === "aborted";
	if (msg.content.length === 0) return !isTruncatedStop;
	const { allowedName, maxLength } = toolCallNameLimits(model);
	return msg.content.some(block =>
		block.type === "toolCall"
			? !isMalformedToolCall(block, allowedName, maxLength)
			: !isTruncatedStop || block.type === "text",
	);
}

function getLatestSurvivingAssistantIndex(messages: readonly Message[], model: Model): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const msg = messages[index]!;
		if (msg.role === "assistant" && isSurvivingAssistant(msg, model)) {
			return index;
		}
	}
	return -1;
}

export function isAnthropicMessagesModel(model: Model): model is Model<"anthropic-messages"> {
	return model.api === "anthropic-messages";
}

/**
 * Targets that have proven they read unsigned foreign thinking when replayed
 * natively. This is a semantic-carry allowlist only: OpenAI-compatible
 * `reasoning_content` schema requirements and llama.cpp cache-prefix replay are
 * handled by their encoders and MUST NOT make foreign thinking look meaningful.
 */
function targetReadsForeignThinking(model: Model, compat: Model["compat"]): boolean {
	if (compat === undefined) return false;
	if (model.api === "anthropic-messages") {
		return "replayUnsignedThinking" in compat && compat.replayUnsignedThinking === true;
	}
	if (model.api !== "openai-completions") return false;
	if (!("thinkingFormat" in compat)) return false;
	if (compat.requiresThinkingAsText) return false;
	return model.reasoning && compat.thinkingFormat === "zai";
}

/**
 * Whether the target's encoder already replays the target's own plaintext
 * reasoning in a native slot. Reasoning carried from another host of the same
 * model (`carriesReasoning`) takes exactly that path, so this is derived from
 * the flags the encoders branch on rather than declared per host:
 * - chat completions writes a reasoning field or content part for thinking
 *   blocks only under these flags; otherwise it drops them.
 * - the Responses wire replays reasoning items unless history is filtered, and
 *   hosts that require reasoning replay already receive id-less plaintext
 *   items from omp (the `requiresReasoningContent*` safety net). OpenRouter's
 *   chat fallback shares the tool-call flag.
 * - Devin sends every turn's thinking in the prompt's `thinking` field.
 * Anthropic-format targets that accept unsigned thinking already read it via
 * `targetReadsForeignThinking`; Bedrock and Google reject or ignore unsigned
 * reasoning, and Codex hosts no portable family.
 */
function targetReplaysPlaintextReasoning(model: Model, compat: Model["compat"]): boolean {
	if (!model.reasoning || compat === undefined) return false;
	if (model.api === "devin-agent") return true;
	if (!("requiresReasoningContentForToolCalls" in compat)) return false;
	switch (model.api) {
		case "openai-completions":
			return (
				!compat.requiresThinkingAsText &&
				(compat.mistralReasoningContentParts === true ||
					compat.requiresReasoningContentForToolCalls ||
					compat.thinkingFormat === "zai" ||
					compat.replayReasoningContent)
			);
		case "openrouter":
			return !compat.filterReasoningHistory && compat.requiresReasoningContentForToolCalls;
		case "openai-responses":
			return (
				!compat.filterReasoningHistory &&
				(compat.requiresReasoningContentForToolCalls || compat.requiresReasoningContentForAllAssistantTurns)
			);
		default:
			return false;
	}
}

/**
 * Deterministic replacement for an id Anthropic rejects: the same input always maps to the same id,
 * so the call and its result still pair after the rewrite. SHA-256 base64url is 43 characters, within the cap.
 */
function fallbackAnthropicToolCallId(originalId: string): string {
	return `toolu_${createHash("sha256").update(originalId).digest("base64url")}`;
}

function normalizeAnthropicTargetToolCallId<TApi extends Api>(
	id: string,
	model: Model<TApi>,
	source: AssistantMessage,
	normalizeId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): string {
	if (isValidToolCallId(id)) return id;
	const normalized = normalizeId?.(id, model, source) ?? normalizeToolCallId(id);
	if (isValidToolCallId(normalized)) return normalized;
	return fallbackAnthropicToolCallId(id);
}

/**
 * The assistant turns whose thinking a later history rewrite orphaned, by index.
 *
 * Preserved thinking (Fable 5.1+): a thinking block's signature is bound to
 * the exact bytes of every message before it, so reasoning recorded before a
 * client-side history rewrite — a compaction or branch summary replacing the
 * turns it was produced against, or a tool result pruned in place — can no
 * longer be replayed. Anthropic rejects such a block with 400 unless the
 * request opts into `drop_block`; dropping it here keeps the request
 * append-only from the API's point of view and costs only reasoning the
 * summary already subsumes.
 */
function assistantsBeforeHistoryRewrite(messages: readonly Message[]): Set<number> {
	const indexes = new Set<number>();
	let latestRewriteAt: number | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const rewriteAt = historyRewriteAt(message);
		if (rewriteAt !== undefined) {
			latestRewriteAt = Math.max(latestRewriteAt ?? rewriteAt, rewriteAt);
		} else if (
			message.role === "assistant" &&
			latestRewriteAt !== undefined &&
			message.timestamp <= latestRewriteAt
		) {
			indexes.add(index);
		}
	}
	return indexes;
}

/** When a message records a history rewrite: a summary's `historyRewriteAt`, a pruned result's `prunedAt`. */
function historyRewriteAt(message: Message): number | undefined {
	if (message.role === "user" || message.role === "developer") return message.historyRewriteAt;
	return message.role === "toolResult" ? message.prunedAt : undefined;
}

type AssistantBlock = AssistantMessage["content"][number];

/** Caller hook that rewrites a tool call id the target model cannot accept. */
type ToolCallIdNormalizer<TApi extends Api> = (id: string, model: Model<TApi>, source: AssistantMessage) => string;

/**
 * The tool-call id rewrites one transform pass shares. `toolCallIdMap` renames each call the target
 * cannot take as written, and its result follows the rename; `responsesCompositeIdMap` resolves a
 * composite Responses result by its `call_id` component.
 */
interface ToolCallIdRewrites<TApi extends Api> {
	readonly toolCallIdMap: Map<string, string>;
	readonly responsesCompositeIdMap: Map<string, string>;
	readonly normalizeToolCallId: ToolCallIdNormalizer<TApi> | undefined;
}

/** Where an assistant turn sits in the transcript, and the target facts the pass reads beyond the model. */
interface AssistantReplayContext {
	readonly isLatestSurvivingAssistant: boolean;
	/** A history rewrite after this turn orphaned its thinking; see {@link assistantsBeforeHistoryRewrite}. */
	readonly thinkingOrphaned: boolean;
	readonly targetCredentialId: number | undefined;
	readonly targetHasReasoningSlot: boolean;
}

/** How one assistant message replays to the target model: the facts each of its blocks' transforms reads. */
interface AssistantReplay<TApi extends Api> {
	readonly source: AssistantMessage;
	readonly model: Model<TApi>;
	readonly targetCompat: Model<TApi>["compat"];
	/** The source message came from the target model: the same provider, API and model id. */
	readonly isSameModel: boolean;
	readonly isAnthropicTarget: boolean;
	/** An `anthropic-messages` turn replayed to an `anthropic-messages` target. */
	readonly isAnthropicReplay: boolean;
	/** The source message was issued by a provider other than the target's. */
	readonly crossProviderSource: boolean;
	/** Source and target are one Anthropic deployment, so signatures verify across the replay. */
	readonly sameAnthropicDeployment: boolean;
	readonly isLatestSurvivingAssistant: boolean;
	readonly isSigningAnthropicTarget: boolean;
	/** A signing Anthropic endpoint is on either end of the replay. */
	readonly signingAnthropicInvolved: boolean;
	/** The turn's signatures are bound to a credential other than the target's. */
	readonly foreignCredential: boolean;
	/** An Anthropic target that takes unsigned thinking natively instead of demoting it to text. */
	readonly replaysUnsignedAnthropicThinking: boolean;
	/** An Anthropic target that replays demoted prior reasoning instead of dropping it. */
	readonly replaysDemotedPriorReasoning: boolean;
	readonly officialAnthropicTarget: boolean;
	/** A same-model turn from another host whose full reasoning replays natively to a reasoning-slot target. */
	readonly carriesSameModelReasoning: boolean;
	/** The turn stopped on `aborted` or `error`. */
	readonly invalidStopReason: boolean;
	/** The turn carries tool calls but ended without requesting their execution. */
	readonly abandonedToolUse: boolean;
	readonly lastBlockIndex: number;
	/** A history rewrite after this turn orphaned its thinking; see {@link assistantsBeforeHistoryRewrite}. */
	readonly thinkingOrphaned: boolean;
	/** A same-model replay to a signing endpoint keeps none of the turn's visible thinking. */
	readonly dropsAllSameModelVisibleThinking: boolean;
}

/** The replay facts {@link thinkingSurvivesAnthropicReplay} reads. */
type ThinkingReplayFacts = Pick<
	AssistantReplay<Api>,
	| "isSameModel"
	| "isAnthropicReplay"
	| "isLatestSurvivingAssistant"
	| "isSigningAnthropicTarget"
	| "invalidStopReason"
	| "abandonedToolUse"
	| "lastBlockIndex"
>;

/** Whether a visible thinking block of an Anthropic turn survives its replay. */
function thinkingSurvivesAnthropicReplay(
	facts: ThinkingReplayFacts,
	candidate: AssistantBlock,
	candidateIndex: number,
): boolean {
	if (candidate.type !== "thinking") return false;
	if (!facts.isAnthropicReplay) return false;
	if (facts.isLatestSurvivingAssistant && facts.abandonedToolUse) return true;
	const candidateSignatureUntrustworthy =
		facts.abandonedToolUse || (facts.invalidStopReason && candidateIndex === facts.lastBlockIndex);
	const replaySignature =
		candidateSignatureUntrustworthy && candidate.thinkingSignature ? undefined : candidate.thinkingSignature;
	if (!replaySignature && (!candidate.thinking || candidate.thinking.trim() === "")) return false;
	if (facts.isSameModel && facts.isSigningAnthropicTarget && (!replaySignature || replaySignature.trim() === "")) {
		return false;
	}
	return true;
}

function assistantReplay<TApi extends Api>(
	source: AssistantMessage,
	model: Model<TApi>,
	targetCompat: Model<TApi>["compat"],
	context: AssistantReplayContext,
): AssistantReplay<TApi> {
	const { isLatestSurvivingAssistant, thinkingOrphaned, targetCredentialId, targetHasReasoningSlot } = context;
	const isSameModel = source.provider === model.provider && source.api === model.api && source.model === model.id;
	const isAnthropicTarget = isAnthropicMessagesModel(model);
	// Anthropic's all-or-none contract on prior-turn thinking blocks
	// applies to every `anthropic-messages → anthropic-messages` replay,
	// not just the latest assistant turn (#2257).
	const isAnthropicReplay = isAnthropicTarget && source.api === "anthropic-messages";
	const crossProviderSource = source.provider !== model.provider;
	// Same deployment: a first-party endpoint or a prefix-bound target, from the same provider.
	const sameAnthropicDeployment =
		isAnthropicReplay &&
		!crossProviderSource &&
		(model.compat.officialEndpoint === true || model.thinking?.prefixBinding === true);
	// Signature policy is a second axis. Anthropic cryptographically
	// binds reasoning signatures to its deployment and model lineage.
	// First-party deployments accept same-deployment cross-model signatures
	// and drop blocks the target model cannot read. Signatures still must be
	// stripped when a signing endpoint boundary is crossed:
	//   * official Anthropic (source): the 3p target can't reverify a
	//     foreign signature and keeping it leaks continuation metadata
	//     for no benefit.
	//   * signing Anthropic (target): opaque signing proxies cannot prove
	//     they share the source deployment. Foreign signatures can trigger
	//     `400 Invalid signature in thinking block` (#4297).
	// 3p ↔ 3p replays preserve signatures because compatible providers
	// (Z.AI, DeepSeek, custom `models.yaml` providers) treat them as
	// opaque continuation hints rather than verified material; stripping
	// degrades the reasoning chain into unsigned/text on the next turn
	// (#2265). Source-side official detection uses the canonical catalog
	// provider id `"anthropic"` because assistant messages carry no
	// `baseUrl` — a user who manually points `provider: "anthropic"` at
	// a custom proxy via `models.yaml` will see signatures stripped, the
	// conservative direction (degraded reasoning, not broken requests).
	const isOfficialAnthropicSource = isAnthropicReplay && source.provider === "anthropic";
	const isSigningAnthropicTarget = isAnthropicTarget && model.compat.signingEndpoint === true;
	// Signatures and redacted thinking are bound to the credential that minted them.
	// Unknown provenance preserves legacy replay for imported and older sessions.
	const foreignCredential =
		isSigningAnthropicTarget &&
		source.credentialId !== undefined &&
		targetCredentialId !== undefined &&
		source.credentialId !== targetCredentialId;
	// Thinking signatures can be untrustworthy for two distinct reasons with very
	// different blast radii:
	//
	// 1. Aborted/errored turns: the stream stopped mid-block, so only the block
	//    that was streaming at the abort point — always the FINAL content block —
	//    can carry a partially-streamed (invalid) signature. Every earlier block
	//    completed, so those signatures are whole and valid and must be kept.
	//
	// 2. Abandoned tool-use turns: a turn that carries toolCall blocks but did NOT
	//    request tool execution (stopReason !== "toolUse"). Its signatures are
	//    end_turn-bound and cannot be replayed in the synthesized continuation.
	//
	// Latest abandoned turns are exempt because Anthropic requires thinking blocks
	// from its most recent response to remain byte-for-byte unmodified.
	const invalidStopReason = source.stopReason === "aborted" || source.stopReason === "error";
	const abandonedToolUse =
		!invalidStopReason && source.stopReason !== "toolUse" && source.content.some(b => b.type === "toolCall");
	const lastBlockIndex = source.content.length - 1;
	const facts: ThinkingReplayFacts = {
		isSameModel,
		isAnthropicReplay,
		isLatestSurvivingAssistant,
		isSigningAnthropicTarget,
		invalidStopReason,
		abandonedToolUse,
		lastBlockIndex,
	};
	return {
		source,
		model,
		targetCompat,
		isSameModel,
		isAnthropicTarget,
		isAnthropicReplay,
		crossProviderSource,
		sameAnthropicDeployment,
		isLatestSurvivingAssistant,
		isSigningAnthropicTarget,
		signingAnthropicInvolved: isOfficialAnthropicSource || isSigningAnthropicTarget,
		foreignCredential,
		// Compatible Anthropic-messages reasoning targets that accept unsigned thinking
		// natively (Z.AI, DeepSeek, the generic `reasoning && !official` case). Used to keep
		// `redacted_thinking` siblings beside unsigned visible thinking.
		replaysUnsignedAnthropicThinking: isAnthropicTarget && model.compat.replayUnsignedThinking === true,
		replaysDemotedPriorReasoning: isAnthropicTarget && model.compat.replayDemotedPriorReasoning === true,
		officialAnthropicTarget: isAnthropicTarget && model.compat.officialEndpoint === true,
		carriesSameModelReasoning:
			!isSameModel &&
			source.stopReason !== "error" &&
			targetHasReasoningSlot &&
			carriesReasoning(
				{ provider: source.provider, api: source.api, model: source.upstreamModel ?? source.model },
				model,
			),
		invalidStopReason,
		abandonedToolUse,
		lastBlockIndex,
		thinkingOrphaned,
		dropsAllSameModelVisibleThinking:
			isAnthropicReplay &&
			isSameModel &&
			isSigningAnthropicTarget &&
			source.content.some(block => block.type === "thinking") &&
			!source.content.some((block, index) => thinkingSurvivesAnthropicReplay(facts, block, index)),
	};
}

/** Replay a thinking block of an `anthropic-messages` turn to an `anthropic-messages` target. */
function replayAnthropicThinking<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	thinking: ThinkingContent,
): ThinkingContent | [] {
	let sanitized = thinking;
	// Preserve same-deployment signatures and let Anthropic perform its one-way
	// model compatibility check. Across deployments, strip stale signatures so the
	// encoder applies the target's unsigned-thinking policy. 3p ↔ 3p replays keep
	// opaque signatures as continuation metadata (#2265).
	const staleSignature =
		!replay.sameAnthropicDeployment &&
		(replay.isLatestSurvivingAssistant ? replay.crossProviderSource : !replay.isSameModel);
	if (staleSignature && replay.signingAnthropicInvolved && sanitized.thinkingSignature) {
		sanitized = { ...sanitized, thinkingSignature: undefined };
	}
	// Drop blocks with neither a signature anchor nor any text — nothing for the next turn to replay.
	if (!sanitized.thinkingSignature && (!sanitized.thinking || sanitized.thinking.trim() === "")) {
		return [];
	}
	// Unsigned thinking has no signature anchor, so it survives only where the target
	// takes it natively. Same-model replay to a signature-enforcing endpoint drops it:
	// both undefined and empty string signatures are invalid, and demotion would cause the
	// reasoning_extraction safety classifier to refuse the response. Any other target that
	// does not read unsigned thinking demotes it to text, so it drops there too unless the
	// target replays demoted prior reasoning.
	const signatureIsInvalid = !sanitized.thinkingSignature || sanitized.thinkingSignature.trim() === "";
	const demotesUnsignedThinking = !replay.replaysUnsignedAnthropicThinking;
	if (
		signatureIsInvalid &&
		((replay.isSameModel && replay.isSigningAnthropicTarget) ||
			(demotesUnsignedThinking && !replay.replaysDemotedPriorReasoning))
	) {
		return [];
	}
	return sanitized;
}

/** Replay a thinking block to a target that is not an Anthropic replay of it. */
function replayForeignThinking<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	sanitized: ThinkingContent,
): ThinkingContent | TextContent | [] {
	// Cross-API target: same-model replay keeps signatures untouched
	// (the encoder needs them for native replay; an OpenAI encrypted
	// reasoning blob has empty text but a load-bearing signature).
	if (replay.isSameModel && sanitized.thinkingSignature) return sanitized;
	// Nothing left for the next turn to replay: drop empty/no-anchor
	// thinking blocks before the cross-model paths.
	if (!sanitized.thinking || sanitized.thinking.trim() === "") return [];
	if (replay.isSameModel) return sanitized;
	// Cross-model + cross-API: preserve native thinking only for targets proven to
	// read unsigned foreign reasoning (Z.AI-format OpenAI-compatible targets, plus
	// Anthropic-compatible `replayUnsignedThinking`).
	if (targetReadsForeignThinking(replay.model, replay.targetCompat)) {
		return sanitized.thinkingSignature ? { ...sanitized, thinkingSignature: undefined } : sanitized;
	}
	// Same model from another host: keep the full trace natively, minus the signature
	// and item id bound to the host that minted them. Only blocks their parser confirmed
	// as the model's own trace carry; summaries and blocks of unknown provenance keep
	// the text fallback.
	if (replay.carriesSameModelReasoning && sanitized.summary === false) {
		const carried = { type: "thinking" as const, thinking: sanitized.thinking, [kCarriedReasoning]: true };
		return carried;
	}
	// Other cross-API targets (openai-responses encrypted blobs, google thought parts,
	// anthropic-target from a non-Anthropic source, or any reasoning-disabled target)
	// can't replay an unsigned thinking block. Demote to text so the reasoning survives
	// as context, wrapped in the TARGET model's own canonical thinking-block dialect.
	// The demoted block is marked (symbol-keyed, never serialized) instead of baking a
	// separator into its text: the openai-completions flatten inserts a paragraph break
	// after marked blocks, and a separator baked into the text would leak to
	// non-flattening targets, which reject a terminal assistant message ending in whitespace.
	const demoted: TextContent & DemotedThinkingCarrier = {
		type: "text",
		text: renderDemotedThinking(replay.model.id, sanitized.thinking),
		[kDemotedThinking]: true,
	};
	return demoted;
}

function replayThinking<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	block: ThinkingContent,
	blockIndex: number,
): ThinkingContent | TextContent | [] {
	// Only an aborted/errored turn's final (mid-stream) block can hold a partial signature;
	// abandoned tool-use turns strip all. Drop the untrustworthy signature so the encoder
	// can downgrade the block to text.
	const signatureUntrustworthy =
		replay.abandonedToolUse || (replay.invalidStopReason && blockIndex === replay.lastBlockIndex);
	const sanitized =
		signatureUntrustworthy && block.thinkingSignature ? { ...block, thinkingSignature: undefined } : block;
	if (!replay.isAnthropicReplay) return replayForeignThinking(replay, sanitized);
	// Latest abandoned turn: Anthropic's byte-for-byte rule forbids even stripping a
	// signature on the latest message — but only for turns the target's own provider issued.
	if (replay.isLatestSurvivingAssistant && replay.abandonedToolUse && !replay.crossProviderSource) return block;
	return replayAnthropicThinking(replay, sanitized);
}

/**
 * Redacted thinking is native-only. Keep it for same-model signed replay, for the latest
 * byte-for-byte turn issued by the target's own provider, or for compatible targets that
 * will also emit sibling unsigned thinking natively. Drop it when the matching visible
 * thinking was discarded, or when visible thinking was stripped and will be demoted to
 * text — a foreign redacted payload can no more verify on a signing target than a foreign
 * visible signature can, even on the latest turn.
 */
function redactedThinkingSurvivesReplay<TApi extends Api>(replay: AssistantReplay<TApi>): boolean {
	if (!replay.isAnthropicReplay) return replay.isSameModel;
	if (replay.dropsAllSameModelVisibleThinking) return false;
	return (
		replay.isSameModel ||
		replay.sameAnthropicDeployment ||
		(replay.isLatestSurvivingAssistant && !replay.crossProviderSource) ||
		replay.replaysUnsignedAnthropicThinking
	);
}

/** Replay a tool call, normalizing an id the target cannot accept and recording the rename for its result. */
function replayToolCall<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	toolCall: ToolCall,
	rewrites: ToolCallIdRewrites<TApi>,
): ToolCall {
	let normalizedToolCall: ToolCall =
		!replay.isSameModel && toolCall.thoughtSignature ? { ...toolCall, thoughtSignature: undefined } : toolCall;
	let normalizedId: string | undefined;
	if (replay.isAnthropicTarget) {
		// Custom same-model endpoints own opaque correlation IDs; official endpoints and
		// cross-model replays require Anthropic-valid IDs.
		if (!replay.isSameModel || replay.officialAnthropicTarget) {
			normalizedId = normalizeAnthropicTargetToolCallId(
				toolCall.id,
				replay.model,
				replay.source,
				rewrites.normalizeToolCallId,
			);
		}
	} else if (!replay.isSameModel && rewrites.normalizeToolCallId) {
		normalizedId = rewrites.normalizeToolCallId(toolCall.id, replay.model, replay.source);
	}
	if (normalizedId !== undefined) {
		if (normalizedId !== toolCall.id) {
			rewrites.toolCallIdMap.set(toolCall.id, normalizedId);
			normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
		}
		// Record the Responses call-component → emitted-id mapping EVEN WHEN the assistant id
		// is plain and normalization is identity. A composite RESULT (`call_A|fc_R`) for a plain
		// Responses call `call_A` still needs this mapping to resolve onto the emitted id.
		if (isResponsesFamilyApi(replay.source.api)) {
			rewrites.responsesCompositeIdMap.set(responsesCallComponent(toolCall.id), normalizedId);
		}
	}
	return normalizedToolCall;
}

function replayAssistantBlock<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	block: AssistantBlock,
	blockIndex: number,
	rewrites: ToolCallIdRewrites<TApi>,
): AssistantBlock | [] {
	switch (block.type) {
		case "thinking":
			if (replay.foreignCredential || replay.thinkingOrphaned) return [];
			return replayThinking(replay, block, blockIndex);
		case "redactedThinking":
			if (replay.foreignCredential || replay.thinkingOrphaned) return [];
			return redactedThinkingSurvivesReplay(replay) ? block : [];
		case "anthropicServerTool":
			// Anthropic requires native server-tool calls and results to be replayed unchanged.
			// They are meaningful only to the provider that produced them.
			return replay.isAnthropicReplay && !replay.crossProviderSource ? block : [];
		case "fallback":
			// Server-side-fallback boundary marker (Anthropic beta `server-side-fallback-2026-06-01`).
			// Keep it for every Anthropic-messages target: `convertAnthropicMessages` decides per
			// request whether the marker can go on the wire. Every other API rejects the block or
			// throws in its converter.
			return replay.isAnthropicTarget ? block : [];
		case "image":
			// Assistant images are display artifacts. No provider accepts them in an assistant
			// replay turn; the native Responses result remains in providerPayload for OpenAI replay.
			return [];
		case "text":
			return replay.isSameModel ? block : { type: "text", text: block.text };
		case "toolCall":
			return replayToolCall(replay, block, rewrites);
		default:
			return block;
	}
}

function replayAssistantMessage<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	rewrites: ToolCallIdRewrites<TApi>,
): AssistantMessage {
	const content = replay.source.content.flatMap((block, blockIndex) =>
		replayAssistantBlock(replay, block, blockIndex, rewrites),
	);
	// A demoted-thinking block that survived as the message's final block can still end with
	// the thinking text's own trailing whitespace, and Anthropic rejects a terminal assistant
	// message whose text ends with trailing whitespace. trimEnd() is safe: demoted text is
	// synthesized context, never byte-exact replay material.
	const finalBlock = content[content.length - 1];
	if (finalBlock?.type === "text" && isDemotedThinking(finalBlock)) {
		content[content.length - 1] = { ...finalBlock, text: finalBlock.text.trimEnd() };
	}
	return { ...replay.source, content };
}


/**
 * The second pass of {@link transformMessages}: each surviving assistant tool call is followed
 * immediately by exactly one corresponding tool result.
 *
 * Every lookup goes through {@link toolCallPairingKey}, so a composite Responses result pairs with
 * its call while an opaque id pairs by raw equality.
 */
class ToolResultPairing {
	readonly output: Message[] = [];
	// All real tool results by pairing key, in document order, as the dedup pass filed them. One key
	// can map to more than one result: compaction can fold an assistant `tool_use` into a summary
	// string while its `tool_result` survives, and a later turn may reuse the id. `#takeRealToolResult`
	// pulls the earliest unconsumed result positioned AFTER the call's assistant turn, so an orphaned
	// earlier result is never pulled forward onto a later call.
	readonly #realToolResultsById: Map<string, IndexedToolResult[]>;
	// Pairing keys of the `tool_use` ids the dedup pass left standing. Anthropic rejects a `tool_result`
	// whose `tool_use_id` has no prior `tool_use`; after handoff/compaction folds an assistant turn into
	// a summary string, the user-side result can survive while its `tool_use` disappears. Orphans are
	// dropped against this set.
	readonly #validToolUseIds: Set<string>;
	readonly #originScope: ToolCallOriginScope;
	// Track which tool calls already have an emitted result so delayed/duplicate
	// toolResult messages cannot create a second provider-visible result.
	readonly #toolCallStatus = new Map<string, ToolCallStatus>();
	readonly #model: Pick<Model, "provider" | "id">;
	#pendingToolCalls: ToolCall[] = [];
	// Index of the assistant turn that declared `#pendingToolCalls`; a pulled result must be positioned after it.
	#pendingToolCallsStartIndex = -1;
	#pendingAbortedToolCalls = new Map<string, ToolCall>();
	#pendingAbortedTimestamp: number | undefined;
	#pendingAbortedStartIndex = -1;

	constructor(
		deduplicated: DeduplicatedToolCallIds,
		originScope: ToolCallOriginScope,
		model: Pick<Model, "provider" | "id">,
	) {
		this.#realToolResultsById = deduplicated.realToolResultsById;
		this.#validToolUseIds = deduplicated.validToolUseIds;
		this.#originScope = originScope;
		this.#model = model;
	}

	/** Append a message that neither declares nor answers a tool call. */
	append(msg: Message): void {
		this.output.push(msg);
	}

	/** Append an assistant turn and open the result window for its tool calls. */
	appendAssistant(msg: AssistantMessage, index: number): void {
		const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];
		this.output.push(msg);
		if (msg.stopReason === "error" || msg.stopReason === "aborted") {
			// Keep the assistant message with tool calls intact. Real tool results are
			// emitted immediately if available; otherwise synthesize aborted results
			// before the next turn boundary.
			this.#pendingAbortedToolCalls = new Map(toolCalls.map(tc => [this.#key(tc.id), tc] as const));
			this.#pendingAbortedTimestamp = msg.timestamp;
			this.#pendingAbortedStartIndex = index;
			return;
		}
		if (toolCalls.length > 0) {
			this.#pendingToolCalls = toolCalls;
			this.#pendingToolCallsStartIndex = index;
		}
	}

	/** Append a tool result that answers a call in an open window, or fold one whose call is gone. */
	appendToolResult(msg: ToolResultMessage, timestamp: number): void {
		const key = this.#key(msg.toolCallId);
		if (this.#toolCallStatus.has(key)) return;
		if (this.#pendingAbortedToolCalls.has(key)) {
			this.#pendingAbortedToolCalls.delete(key);
			this.#emitReal(msg);
			return;
		}
		if (this.#pendingToolCalls.some(tc => this.#key(tc.id) === key)) {
			this.#emitReal(msg);
			return;
		}
		// The matching tool_use exists elsewhere, but this result is not in
		// the currently open result window. Emitting it here would break the
		// provider invariant; the first real result is pulled into the correct
		// slot by the pending-call flush instead.
		if (this.#validToolUseIds.has(key)) return;
		// Orphan `tool_result`: the originating `tool_use` is not present in the
		// transformed history. Sending the block as-is would 400 the request.
		//
		// If a pending tool-call window is still open (either normal or aborted),
		// the orphan cannot be replaced with a note here: a message inserted between
		// an assistant `tool_use` and its result breaks Anthropic's contiguity, and
		// flushing pending calls now would wedge synthetic results ahead of a real
		// result that may still arrive. Drop the orphan in that case.
		if (
			this.#pendingToolCalls.some(tc => !this.#toolCallStatus.has(this.#key(tc.id))) ||
			this.#pendingAbortedToolCalls.size > 0
		) {
			return;
		}
		this.#foldOrphan(msg, timestamp);
	}

	/**
	 * Answer every call in the open result windows: with its real result when one follows its
	 * turn, and with a placeholder error result otherwise.
	 */
	closeWindows(timestamp: number): void {
		if (this.#pendingToolCalls.length > 0) {
			this.#answer(
				this.#pendingToolCalls,
				this.#pendingToolCallsStartIndex,
				"No result provided",
				timestamp,
				ToolCallStatus.Resolved,
			);
			this.#pendingToolCalls = [];
		}
		if (this.#pendingAbortedTimestamp !== undefined) {
			this.#answer(
				this.#pendingAbortedToolCalls.values(),
				this.#pendingAbortedStartIndex,
				"aborted",
				this.#pendingAbortedTimestamp,
				ToolCallStatus.Aborted,
			);
			this.#pendingAbortedToolCalls = new Map();
			this.#pendingAbortedTimestamp = undefined;
		}
	}

	#key(id: string): string {
		return toolCallPairingKey(id, this.#originScope);
	}

	#emitReal(msg: ToolResultMessage): void {
		this.#toolCallStatus.set(this.#key(msg.toolCallId), ToolCallStatus.Resolved);
		this.output.push(msg);
	}

	#answer(
		toolCalls: Iterable<ToolCall>,
		afterIndex: number,
		placeholder: string,
		timestamp: number,
		placeholderStatus: ToolCallStatus,
	): void {
		for (const tc of toolCalls) {
			const key = this.#key(tc.id);
			if (this.#toolCallStatus.has(key)) continue;
			const realToolResult = this.#takeRealToolResult(tc.id, afterIndex);
			if (realToolResult) {
				this.#emitReal(realToolResult);
				continue;
			}
			this.output.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: placeholder }],
				isError: true,
				timestamp,
			} as ToolResultMessage);
			this.#toolCallStatus.set(key, placeholderStatus);
		}
	}

	#takeRealToolResult(id: string, afterIndex: number): ToolResultMessage | undefined {
		const entries = this.#realToolResultsById.get(this.#key(id));
		if (!entries) return undefined;
		for (const entry of entries) {
			if (entry.consumed || entry.index <= afterIndex) continue;
			entry.consumed = true;
			return entry.msg;
		}
		return undefined;
	}

	/**
	 * Preserve an orphan result's text as a user note so the model still sees what the tool
	 * returned. staleToolResultNote owns both the envelope and the rule that it rides on `role: "user"`.
	 */
	#foldOrphan(msg: ToolResultMessage, timestamp: number): void {
		const textParts: string[] = [];
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim() !== "") textParts.push(part.text);
		}
		if (textParts.length === 0) return;
		logger.warn("transform-messages: folding a tool result whose call is missing from the history", {
			provider: this.#model.provider,
			model: this.#model.id,
			toolName: msg.toolName,
			toolCallId: msg.toolCallId,
		});
		const note: UserMessage & SyntheticUserCarrier = {
			role: "user",
			content: staleToolResultNote({
				toolName: msg.toolName,
				toolCallId: msg.toolCallId,
				text: textParts.join("\n"),
				isError: msg.isError,
			}),
			timestamp,
		} as UserMessage;
		// Synthesized, not sent by the user: prompt-cache decimation counts conversational turns and must skip this note.
		note[kSyntheticUser] = true;
		this.output.push(note);
	}
}

/**
 * Credential-shaped token patterns scrubbed from outbound provider traffic when
 * credential redaction is enabled. Exported so hosts can route the same shapes
 * through reversible obfuscation (keyed placeholders restored before local tool
 * execution) instead of the irreversible tag rewrite in redactSensitiveCredentials.
 */
export const SENSITIVE_TOKEN_RE =
	/(?<![a-zA-Z0-9_*-])(gh[opusr]_[a-zA-Z0-9_*]{36,}|github_pat_[a-zA-Z0-9_*]{36,}|glpat-[a-zA-Z0-9_*-]{20,}|sk-proj-[a-zA-Z0-9_*-]{36,}|sk-ant-[a-zA-Z0-9_*-]{36,}|sk-[a-zA-Z0-9_*-]{48,})(?![a-zA-Z0-9_*-])/gi;

function hasPlausibleCredentialEntropy(token: string): boolean {
	const lower = token.toLowerCase();
	const prefixLen = lower.startsWith("github_pat_")
		? 11
		: lower.startsWith("glpat-")
			? 6
			: lower.startsWith("sk-proj-")
				? 8
				: lower.startsWith("sk-ant-")
					? 7
					: lower.startsWith("gh")
						? 4
						: 3;
	const secret = token.slice(prefixLen);
	return /^\*+$/.test(secret) || [/[a-z]/, /[A-Z]/, /\d/, /[_-]/].filter(p => p.test(secret)).length >= 2;
}

/**
 * Whether outbound credential-pattern redaction is active outside any
 * {@link withCredentialRedaction} scope. On by default; a host turns it off explicitly
 * (the coding agent wires this to the `secrets.enabled` setting).
 */
let credentialRedactionEnabled = true;

/** Per-request override of {@link credentialRedactionEnabled}; see {@link withCredentialRedaction}. */
const credentialRedactionScope = new AsyncLocalStorage<boolean>();

/** Redaction policy for the request being built: its scope's, else the process-wide switch. */
function isCredentialRedactionActive(): boolean {
	return credentialRedactionScope.getStore() ?? credentialRedactionEnabled;
}

/**
 * Toggle process-wide outbound credential-pattern redaction (requests outside any
 * {@link withCredentialRedaction} scope). When disabled,
 * {@link redactSensitiveCredentials} and {@link redactSensitiveInObject} are
 * pass-throughs and outbound messages leave the process unmodified.
 */
export function configureCredentialRedaction(enabled: boolean): void {
	credentialRedactionEnabled = enabled;
}

/**
 * Runs `fn` with outbound credential-pattern redaction forced on or off for every
 * request it starts (including the async work those requests spawn), overriding
 * {@link configureCredentialRedaction}. Lets concurrent sessions in one process
 * each apply their own policy.
 */
export function withCredentialRedaction<T>(enabled: boolean, fn: () => T): T {
	return credentialRedactionScope.run(enabled, fn);
}

export function redactSensitiveCredentials(text: string): string {
	if (!isCredentialRedactionActive()) return text;
	return text.replace(SENSITIVE_TOKEN_RE, match => {
		if (!hasPlausibleCredentialEntropy(match)) return match;
		const lower = match.toLowerCase();
		const tag =
			lower.startsWith("gh") || lower.startsWith("github_pat_")
				? "github"
				: lower.startsWith("glpat-")
					? "gitlab"
					: lower.startsWith("sk-ant-")
						? "anthropic"
						: "openai";
		return `[${tag}_token_redacted]`;
	});
}

export function redactSensitiveInObject(val: unknown): { result: unknown; changed: boolean } {
	if (!isCredentialRedactionActive()) return { result: val, changed: false };
	if (typeof val === "string") {
		const result = redactSensitiveCredentials(val);
		return { result, changed: result !== val };
	}
	if (Array.isArray(val)) {
		let changed = false;
		const result = val.map(i => {
			const r = redactSensitiveInObject(i);
			if (r.changed) changed = true;
			return r.result;
		});
		return { result, changed };
	}
	if (val !== null && typeof val === "object") {
		let changed = false;
		const result: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(val)) {
			const targetKey = redactSensitiveCredentials(k);
			if (targetKey !== k) changed = true;
			if (Object.hasOwn(result, targetKey)) {
				throw new Error(`Redacted property key collision: "${targetKey}" conflicts with an existing key`);
			}
			const r = redactSensitiveInObject(v);
			if (r.changed) changed = true;
			Object.defineProperty(result, targetKey, {
				value: r.result,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return { result: changed ? result : val, changed };
	}
	return { result: val, changed: false };
}

export function redactJsonFunctionCallArguments(argsText: string): { result: string; changed: boolean } {
	if (!isCredentialRedactionActive()) return { result: argsText, changed: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(argsText);
	} catch {
		const raw = redactSensitiveCredentials(argsText);
		return { result: raw, changed: raw !== argsText };
	}
	if (parsed !== null && typeof parsed === "object") {
		const { result, changed } = redactSensitiveInObject(parsed);
		if (changed) return { result: JSON.stringify(result), changed: true };
		return { result: argsText, changed: false };
	}
	const raw = redactSensitiveCredentials(argsText);
	return { result: raw, changed: raw !== argsText };
}

function redactBlocks<T extends { type: string }>(
	blocks: T[],
	isAssistant?: boolean,
): { blocks: T[]; changed: boolean } {
	let changed = false;
	const res = blocks.map(b => {
		if (b.type === "text") {
			const r = redactSensitiveCredentials((b as unknown as TextContent).text);
			if (r !== (b as unknown as TextContent).text) {
				changed = true;
				return { ...b, text: r };
			}
		} else if (isAssistant && b.type === "thinking") {
			const r = redactSensitiveCredentials((b as unknown as ThinkingContent).thinking);
			if (r !== (b as unknown as ThinkingContent).thinking) {
				changed = true;
				return { ...b, thinking: r, thinkingSignature: undefined };
			}
		} else if (isAssistant && b.type === "toolCall" && (b as unknown as ToolCall).arguments) {
			const { result: args, changed: ch } = redactSensitiveInObject((b as unknown as ToolCall).arguments);
			if (ch) {
				changed = true;
				return { ...b, arguments: args as Record<string, unknown>, thoughtSignature: undefined };
			}
		}
		return b;
	});
	return { blocks: res, changed };
}

function redactSensitiveCredentialsInMessages(messages: Message[]): Message[] {
	if (!isCredentialRedactionActive()) return messages;
	return messages.map((msg): Message => {
		if ((msg.role === "user" || msg.role === "developer") && typeof msg.content === "string") {
			const r = redactSensitiveCredentials(msg.content);
			return r === msg.content ? msg : ({ ...msg, content: r } as Message);
		}
		if (msg.role === "assistant") {
			const { blocks, changed } = redactBlocks(msg.content, true);
			return changed ? { ...msg, content: blocks } : msg;
		}
		if (Array.isArray(msg.content)) {
			const { blocks, changed } = redactBlocks(msg.content);
			return changed ? { ...msg, content: blocks } : msg;
		}
		return msg;
	});
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 *
 * For aborted/errored turns, this function:
 * - Preserves tool call structure (unlike converting to text summaries)
 * - Injects synthetic "aborted" tool results
 */

export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	maxNormalizedToolCallIdLength = MAX_TOOL_CALL_ID_LENGTH,
	duplicateToolCallIdSuffixPrefix = "_dup",
	targetCompat: Model<TApi>["compat"] = model.compat,
	targetCredentialId?: number,
): Message[] {
	// Redact sensitive credential-like patterns from all outbound messages when
	// the host opted in via `configureCredentialRedaction` — prevents security
	// block errors from LLM providers (e.g. invalid_prompt).
	messages = redactSensitiveCredentialsInMessages(messages);

	// Sessions recorded before the repair rode `role: "user"` hold the note as
	// real assistant text. Strip it on the way out of storage so a resumed session
	// does not keep emitting tool results as prose.
	messages = dropLegacyStaleToolNotes(messages);

	// Drop assistant `toolCall` blocks whose id or name the target cannot replay
	// (and their matched `toolResult` messages) before anything else looks at
	// the history. Replaying them would 400 the target provider.
	messages = sanitizeMalformedToolCalls(messages, model);

	// Prior reasoning carried as prose is subject to the same replay policy as
	// an unsigned thinking block, and the target is only known here.
	messages = dropUndeliverableDemotedReasoning(messages, model);

	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Responses-family assistant composite ids (`call_id|item_id`) normalized for
	// a cross-provider target keyed by their `call_id` component, so a paired
	// tool RESULT arriving with a DIFFERENT item half still resolves to the same
	// normalized id. Only Responses-origin ids populate this (opaque Chat
	// Completions ids pair by raw equality and must never be canonicalized).
	const responsesCompositeIdMap = new Map<string, string>();
	const rewrites: ToolCallIdRewrites<TApi> = { toolCallIdMap, responsesCompositeIdMap, normalizeToolCallId };

	const latestSurvivingAssistantIndex = getLatestSurvivingAssistantIndex(messages, model);
	// A prefix-bound target cannot replay thinking that a later history rewrite orphaned.
	// Developer messages record rewrites as well as user messages (see historyRewriteAt).
	const orphanedThinkingAssistantIndexes = model.thinking?.prefixBinding
		? assistantsBeforeHistoryRewrite(messages)
		: undefined;
	const targetHasReasoningSlot = targetReplaysPlaintextReasoning(model, targetCompat);
	// Origin-scope sets, accumulated by the normalization map itself (below) so
	// the scope needs no second transcript walk. Only read via `.has`, so
	// iteration order is inert.
	const responsesComponents = new Set<string>();
	const opaqueCompositeCallIds = new Set<string>();
	// First pass: transform messages (thinking blocks, tool call ID normalization)
	const normalizedMessages = messages.map((msg, index): Message => {
		// User and developer messages pass through unchanged
		if (msg.role === "user" || msg.role === "developer") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const exactNormalizedId = toolCallIdMap.get(msg.toolCallId);
			const normalizedId =
				exactNormalizedId ??
				(msg.toolCallId.includes("|")
					? responsesCompositeIdMap.get(responsesCallComponent(msg.toolCallId))
					: undefined);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		if (msg.role === "assistant") {
			const replay = assistantReplay(msg, model, targetCompat, {
				isLatestSurvivingAssistant: index === latestSurvivingAssistantIndex,
				thinkingOrphaned: orphanedThinkingAssistantIndexes?.has(index) === true,
				targetCredentialId,
				targetHasReasoningSlot,
			});
			const replayed = replayAssistantMessage(replay, rewrites);
			// Record this turn's tool-call ids into the origin scope. Origin scope must be
			// complete before dedup reads it: filled here off the SAME post-transform content
			// this map emits, in document order, and never read inside the map.
			recordToolCallOriginScope(msg, replayed.content, responsesComponents, opaqueCompositeCallIds);
			return replayed;
		}
		return msg;
	});
	// Per-concrete-id origin classification — the only scope `toolCallPairingKey`
	// consults to decide whether a pipe-bearing id is a canonicalizable Responses
	// composite or an opaque Chat Completions token that pairs by raw equality.
	const originScope: ToolCallOriginScope = { responsesComponents, opaqueCompositeCallIds };
	// Second pass: ensure each surviving assistant tool call is immediately
	// followed by exactly one corresponding tool result. The dedup pass filed every
	// real result under its pairing key; ToolResultPairing owns the open windows.
	const deduplicated = deduplicateToolCallIds(
		normalizedMessages,
		originScope,
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
	);
	const transformed = deduplicated.messages;
	const pairing = new ToolResultPairing(deduplicated, originScope, model);
	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];
		const messageTimestamp = "timestamp" in msg && typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
		if (msg.role === "toolResult") {
			pairing.appendToolResult(msg, messageTimestamp);
			continue;
		}
		pairing.closeWindows(messageTimestamp);
		if (msg.role !== "assistant") {
			pairing.append(msg);
			continue;
		}
		// Drop assistant turns that carry no actionable content (no `text`, no `toolCall`)
		// AND were terminated by a truncating stop reason (`length` / `error` / `aborted`).
		const originalMsg = messages[i]!;
		if (originalMsg.role === "assistant" && shouldDropTruncatedThinkingOnlyAssistant(originalMsg)) {
			continue;
		}
		pairing.appendAssistant(msg as AssistantMessage, i);
	}
	pairing.closeWindows(Date.now());
	return pairing.output;
}
