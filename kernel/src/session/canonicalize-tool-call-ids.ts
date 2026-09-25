/**
 * Session-local tool-call ID canonicalization for outbound provider Context.
 *
 * Provider tool-call IDs are opaque to OpenAI-style APIs — only call↔result
 * match matters — but compound Responses IDs (`call_…|fc_…`) average ~80 chars
 * and are re-sent every turn. Mapping each distinct provider ID to a short
 * `tc_<n>` handle at the `transformProviderContext` boundary cuts that carry
 * while keeping prior-history bytes stable for prompt cache.
 *
 * Stored session history keeps the original IDs; only the outbound Context
 * snapshot is rewritten. The map is rebuilt identically on resume by walking
 * history in order (no schema change).
 *
 * A call whose ID is also recorded in the message's native provider payload
 * (`openaiResponsesHistory` items carry `call_id`) keeps its original ID, and
 * so does its result. Responses providers replay those items verbatim instead
 * of re-encoding the blocks, so a renamed result would answer a call ID the
 * request no longer contains, and the provider folds every such result into a
 * stale-output note after a placeholder output.
 */

import type { AssistantMessage, Message } from "@veyyon/ai";

const CANONICAL_ID = /^tc_\d+$/;

export type ToolCallIdMap = Map<string, string>;

/**
 * Allocate the next session-local handle. Counter is 1-based (`tc_1`, `tc_2`, …).
 */
export function allocateCanonicalToolCallId(counter: { value: number }): string {
	counter.value += 1;
	return `tc_${counter.value}`;
}

/**
 * Resolve a provider ID to its session-local handle, assigning on first sight.
 *
 * IDs that already look like `tc_<n>` are still remapped so the session-local
 * namespace stays unambiguous (a provider-emitted `tc_1` must not collide with
 * our allocated `tc_1`).
 */
export function resolveCanonicalToolCallId(id: string, map: ToolCallIdMap, allocate: () => string): string {
	if (!id) return id;
	const existing = map.get(id);
	if (existing !== undefined) return existing;
	const canonical = allocate();
	map.set(id, canonical);
	return canonical;
}

/**
 * Rewrite one message through the session-local ID map.
 *
 * The returned reference is unchanged when the message contains no mapped ID.
 */
export function canonicalizeToolCallIdsInMessage(
	message: Message,
	map: ToolCallIdMap,
	allocate: () => string,
): Message {
	if (message.role === "assistant") {
		const payloadItems =
			message.providerPayload?.type === "openaiResponsesHistory" ? message.providerPayload.items : undefined;
		let content: typeof message.content | undefined;
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i];
			if (block.type !== "toolCall") continue;
			if (payloadItems && payloadBindsCallId(payloadItems, block.id)) {
				if (!map.has(block.id)) map.set(block.id, block.id);
				continue;
			}
			const canonical = resolveCanonicalToolCallId(block.id, map, allocate);
			if (canonical === block.id) continue;
			content ??= message.content.slice();
			content[i] = { ...block, id: canonical };
		}
		return content ? { ...message, content } : message;
	}
	if (message.role === "toolResult") {
		const canonical = resolveCanonicalToolCallId(message.toolCallId, map, allocate);
		return canonical === message.toolCallId ? message : { ...message, toolCallId: canonical };
	}
	return message;
}

/**
 * Whether a native payload item records the call `id` names. A Responses block
 * id is `call_…|fc_…` while the item's `call_id` is the part before the bar, so
 * both spellings match. An id shaped like an allocated handle is never pinned:
 * keeping it would let it collide with the handle the map allocates.
 */
function payloadBindsCallId(items: NonNullable<AssistantMessage["providerPayload"]>["items"], id: string): boolean {
	if (CANONICAL_ID.test(id)) return false;
	for (const item of items) {
		const callId = item.call_id;
		if (typeof callId !== "string" || callId.length === 0 || !id.startsWith(callId)) continue;
		if (id.length === callId.length || id.charCodeAt(callId.length) === 124 /* | */) return true;
	}
	return false;
}

/**
 * Rewrite `assistant.toolCall.id` and `toolResult.toolCallId` through `map`.
 *
 * Walks messages in order; first appearance of a provider ID assigns the next
 * handle. Call and result IDs that share a provider ID receive the same handle.
 * Returns the input array reference when nothing changed.
 */
export function canonicalizeToolCallIds(messages: Message[], map: ToolCallIdMap, allocate: () => string): Message[] {
	let out: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const next = canonicalizeToolCallIdsInMessage(messages[i], map, allocate);
		if (next === messages[i]) continue;
		out ??= messages.slice();
		out[i] = next;
	}
	return out ?? messages;
}
