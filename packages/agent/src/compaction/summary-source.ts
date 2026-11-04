/**
 * The span a history summary reads, measured without holding the event loop.
 *
 * WHY THIS EXISTS. Planning a summary request serialized the whole span synchronously, once as the
 * single request's conversation text and once message by message for the staged plan, and the
 * candidate estimate and the request each planned again. On a resumed 20,510-message span that was
 * about 200ms per plan in which the terminal drew nothing and read no key, paid by the estimate of
 * every candidate and again by the summary itself.
 *
 * A source transforms and serializes each message on its own, in slices that yield to the event
 * loop between messages. The staged plan groups those per-message counts. The same lengths bound
 * the joined transcript from below: joining messages removes at most
 * {@link SUMMARY_TRANSCRIPT_GLUE_BYTES} of framing per message (a transcript's opening token, the
 * shared wrapper of a tool-result run), so a span whose bound already exceeds the window is staged
 * without its joined text ever being built. The joined text is built only for a span whose bound
 * fits the window, which is the one synchronous pass left.
 */

import type { Message } from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";
import { TimeSlice } from "@veyyon/utils";
import { countTokens } from "../tokenizer";
import { serializeConversationForSummary, transformMessageForSummary } from "./utils";

/**
 * Most UTF-8 bytes of framing a message serialized on its own carries that the same message holds
 * in a joined transcript, in any dialect. The widest measured is 46, Anthropic's
 * `<function_results>` wrapper, which a run of tool results shares.
 */
export const SUMMARY_TRANSCRIPT_GLUE_BYTES = 128;

/** A span's provider-visible messages, and how long each serializes on its own. */
export interface SummarySource {
	/** Provider-visible messages, after the summary text transform. */
	readonly messages: Message[];
	readonly dialect: Dialect | undefined;
	/** Token estimate of each message serialized on its own: what the staged plan groups by. */
	readonly messageTokens: readonly number[];
	/** Fewest UTF-8 bytes `serializeConversationForSummary(messages, dialect)` returns. */
	readonly conversationBytesFloor: number;
}

/** Ids of the tool calls the serializer drops with their results, because a result was useless. */
function uselessCallIds(messages: readonly Message[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.useless === true && message.isError !== true) {
			ids.add(message.toolCallId);
		}
	}
	return ids;
}

/**
 * Whether the joined transcript renders less of `message` than its own transcript does: a call or
 * a result the span's useless results drop, which the message alone does not know to drop.
 */
function renderedShorterInSpan(message: Message, useless: ReadonlySet<string>): boolean {
	if (useless.size === 0) return false;
	if (message.role === "toolResult") return useless.has(message.toolCallId);
	if (message.role !== "assistant") return false;
	for (const block of message.content) if (block.type === "toolCall" && useless.has(block.id)) return true;
	return false;
}

/**
 * Transform `llmMessages` with `transform` and measure each serialized on its own, yielding to the
 * event loop whenever `slice` is due.
 */
export async function measureSummarySource(
	llmMessages: readonly Message[],
	dialect: Dialect | undefined,
	transform: ((text: string) => string) | undefined,
	slice: TimeSlice = new TimeSlice(),
): Promise<SummarySource> {
	// The transform leaves tool-call ids and the useless flag as they are, so the set is read
	// before it.
	const useless = uselessCallIds(llmMessages);
	const messages: Message[] = [];
	const messageTokens: number[] = [];
	let bytes = 0;
	for (const original of llmMessages) {
		if (slice.due) await slice.yield();
		const message = transform ? transformMessageForSummary(original, transform) : original;
		const text = serializeConversationForSummary([message], dialect);
		messages.push(message);
		messageTokens.push(countTokens(text));
		if (!renderedShorterInSpan(message, useless)) bytes += Buffer.byteLength(text, "utf-8");
	}
	const conversationBytesFloor = Math.max(0, bytes - messages.length * SUMMARY_TRANSCRIPT_GLUE_BYTES);
	return { messages, dialect, messageTokens, conversationBytesFloor };
}
