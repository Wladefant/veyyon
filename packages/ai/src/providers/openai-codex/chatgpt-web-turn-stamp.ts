import type { InputItem, RequestBody } from "./request-transformer";

/**
 * Per-item Codex turn provenance the `codex-chatgpt-web` bridge validates.
 *
 * The daemon reads `internal_chat_message_metadata_passthrough.turn_id` off the
 * current-turn user item and refuses the turn without it
 * (`extractChatGptTurnUserRevision` in its `adapters/chatgpt-web/environment.ts`:
 * a user item counts as the current revision only when `type === "message"` AND
 * either that `turn_id` is a string or the item carries a non-empty
 * server-owned `id`). Veyyon cannot supply the second alternative: the Codex
 * request transformer strips `id` from every input item by design
 * (`filterInput`), because OpenAI's own backend rejects client-minted item ids.
 * So the passthrough is the only shape that satisfies the validator, which is
 * why this stamp exists at all.
 *
 * `turn_id` must equal the `turn_id` inside the request's
 * `client_metadata["x-codex-turn-metadata"]` blob; the daemon throws
 * `CHATGPT_TURN_REVISION_CONFLICT_MESSAGE` when the two disagree, so the stamp
 * is always taken from the same metadata the request is about to send.
 *
 * This module deliberately imports nothing at run time (the two imports above
 * are types, which are erased) so the wire contract can be exercised against
 * the daemon's real validator without loading the rest of the provider.
 */

/**
 * Stamp the current turn's user item so the local `codex-chatgpt-web` bridge
 * accepts the request, and report whether an item was found.
 *
 * WHICH ITEM. The last `role: "user"` item in `input`. On a new user turn that
 * is the fresh instruction; on a tool-return continuation the input ends with
 * `function_call_output` items and the instruction sits further back, which is
 * exactly where the daemon's own backwards scan looks, so one rule covers both.
 * Items are replaced rather than mutated: a replayed history item is owned by
 * the session's stored `providerPayload`, and writing a turn id into that would
 * outlive this request and follow the conversation onto other providers.
 *
 * WHAT IS NOT FILTERED. The daemon additionally skips a user item whose text is
 * one of its three contextual envelopes (`<environment_context>`,
 * `<subagent_notification>`, a compaction summary note) before accepting it as
 * a revision. Veyyon emits none of those — nothing in this repo writes those
 * tags — so the last user item and the daemon's current-turn revision are the
 * same item. If Veyyon ever starts sending one, the daemon will skip it, land on
 * an unstamped earlier item and refuse the turn again; this function is where
 * that filter has to be added, not somewhere downstream.
 *
 * SCOPE. The caller decides this request is bridge-routed. Nothing here is
 * conditional on the model or the host, so the official Codex transport is
 * unaffected as long as it never calls this.
 *
 * A remote-compaction request is stamped too, and deliberately. Its execution
 * key is derived from the whole input array rather than this revision, so it
 * does not need the stamp to be accepted — but the daemon's compaction handoff
 * reads the source instruction through the same "type + provenance" filter
 * (`extractChatGptCompactionSourceRevision`) and would otherwise refuse to
 * canonicalize the summary. That extractor does not compare turn ids, and a
 * mid-turn compaction reuses the in-flight turn id anyway, so the id stamped
 * here is the one that locates the browser response the compaction replaces.
 */
export function stampChatGptWebCurrentTurnUserItem(body: RequestBody, turnId: string): boolean {
	if (turnId.length === 0) return false;
	const input = body.input;
	if (!Array.isArray(input)) return false;
	for (let index = input.length - 1; index >= 0; index -= 1) {
		const item: InputItem | undefined = input[index];
		if (!item || item.role !== "user") continue;
		// An item that already declares another type is not a message; the
		// daemon's scan skips it too, so it is not a candidate here either.
		if (item.type != null && item.type !== "message") continue;
		const passthrough = item.internal_chat_message_metadata_passthrough;
		input[index] = {
			...item,
			type: "message",
			internal_chat_message_metadata_passthrough: { ...passthrough, turn_id: turnId },
		};
		return true;
	}
	return false;
}
