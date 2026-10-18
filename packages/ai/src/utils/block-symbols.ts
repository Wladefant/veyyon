export * from "@veyyon/model/stream-block";

/** Stores a provider-local stream block index without exposing a string-keyed property. */
export const kStreamingBlockIndex = Symbol("provider.block.index");

/** Stores the last parsed argument prefix length for throttled streaming JSON parsing. */
export const kStreamingLastParseLen = Symbol("provider.block.lastParseLen");

/** Marks streamed tool-call arguments that already received an authoritative done payload. */
export const kStreamingArgumentsDone = Symbol("provider.block.argumentsDone");

/** Classifies Cursor's in-flight tool-call kind without leaking provider-private state. */
export const kStreamingBlockKind = Symbol("provider.block.kind");

/**
 * Marks a `toolCall` content block that Cursor's exec channel already
 * executed server-side (via the coding-agent bridge) and whose result is
 * buffered separately for emission via the assistant-loop stream.
 *
 * `agent-loop.ts` MUST skip execution of blocks carrying this marker —
 * treating them as a fresh runnable tool call would run the same
 * side-effecting tool (bash, write, delete, …) a second time. Symbol-keyed
 * so it never persists across the JSONL round-trip, where rebuild instead
 * pairs the block with its already-persisted `toolResult` message by id.
 */
export const kCursorExecResolved = Symbol("provider.block.cursorExecResolved");

/** Carries the resolved marker without exposing a string-keyed property. */
export type CursorExecResolvedCarrier = object & { [kCursorExecResolved]?: true };

/**
 * Marks a text block synthesized by cross-model thinking demotion in
 * `transformMessages`. Converters that flatten adjacent text blocks into one
 * string (openai-completions) insert a paragraph separator after marked
 * blocks; unmarked adjacent blocks keep their original byte sequence.
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kDemotedThinking = Symbol("provider.block.demotedThinking");

/** Carries the demoted-thinking marker without exposing a string-keyed property. */
export type DemotedThinkingCarrier = object & { [kDemotedThinking]?: boolean };

/** True for text blocks synthesized by cross-model thinking demotion. */
export function isDemotedThinking(block: DemotedThinkingCarrier | null | undefined): boolean {
	return block?.[kDemotedThinking] === true;
}

/**
 * Marks a thinking block that `transformMessages` carried natively from
 * another host serving the same model (see `compat/reasoning-carry` in the
 * catalog). Its host-bound signature and item id are gone, so encoders that
 * replay reasoning from stored payloads (Responses) emit a plaintext item for
 * it instead. Symbol-keyed so the marker never persists or reaches the wire.
 */
export const kCarriedReasoning = Symbol("provider.block.carriedReasoning");

/** Carries the carried-reasoning marker without exposing a string-keyed property. */
export type CarriedReasoningCarrier = object & { [kCarriedReasoning]?: boolean };

/** True for thinking blocks carried natively from another host of the same model. */
export function isCarriedReasoning(block: CarriedReasoningCarrier | null | undefined): boolean {
	return block?.[kCarriedReasoning] === true;
}

/**
 * Marks a `role: "user"` message that `transformMessages` synthesized rather
 * than one the user sent.
 *
 * The stale-tool-result note is deliberately emitted as `user` so no provider
 * elevates untrusted tool output to instruction priority, which leaves it
 * indistinguishable from a real turn by role alone. Prompt-cache decimation
 * must not count it, or an orphan result appearing or disappearing in a
 * compacted history shifts every later checkpoint.
 *
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kSyntheticUser = Symbol("provider.message.syntheticUser");

/** Carries the synthetic-user marker without exposing a string-keyed property. */
export type SyntheticUserCarrier = object & { [kSyntheticUser]?: boolean };

/** True for `user` messages synthesized by message transformation. */
export function isSyntheticUser(message: SyntheticUserCarrier | null | undefined): boolean {
	return message?.[kSyntheticUser] === true;
}

/**
 * Marks a `role: "user"` message that came from a source user message.
 *
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kConversationalUser = Symbol("provider.message.conversationalUser");

/** Carries the conversational-user marker without exposing a string-keyed property. */
export type ConversationalUserCarrier = object & { [kConversationalUser]?: boolean };

/** True for wire messages serialized from a source `role: "user"` message. */
export function isConversationalUser(message: ConversationalUserCarrier | null | undefined): boolean {
	return message?.[kConversationalUser] === true;
}

/**
 * Marks a message synthesized by a per-call context transform rather than
 * loaded from persisted conversation history. Symbol-keyed so the marker never
 * persists or reaches the provider wire.
 */
export const kPerCallContextMessage = Symbol("agent.message.perCallContext");

/** Carries per-call context provenance without exposing a string-keyed property. */
export type PerCallContextMessageCarrier = object & { [kPerCallContextMessage]?: true };

/** Copies per-call context provenance to a converted or projected message. */
export function copyPerCallContextMessage(
	target: PerCallContextMessageCarrier,
	source: PerCallContextMessageCarrier,
): void {
	if (source[kPerCallContextMessage] === true) target[kPerCallContextMessage] = true;
}

/** True when a message was synthesized for the current provider call. */
export function isPerCallContextMessage(message: PerCallContextMessageCarrier | null | undefined): boolean {
	return message?.[kPerCallContextMessage] === true;
}
