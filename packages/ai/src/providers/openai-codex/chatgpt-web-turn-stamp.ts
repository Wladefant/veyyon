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
 * accepts the request, and report WHERE it landed.
 *
 * The index matters to the caller, not just the fact of a hit: the daemon's
 * trusted-environment envelope has to be the input item immediately before
 * this one (`chatgpt-web-trusted-context.ts`), so the position is part of the
 * contract rather than a diagnostic. `-1` means no candidate existed, and the
 * daemon will refuse the turn for the reason it always did.
 *
 * WHICH ITEM. The last `role: "user"` item in `input`. On a new user turn that
 * is the fresh instruction; on a tool-return continuation the input ends with
 * `function_call_output` items and the instruction sits further back, which is
 * exactly where the daemon's own backwards scan looks, so one rule covers both.
 * Items are replaced rather than mutated: a replayed history item is owned by
 * the session's stored `providerPayload`, and writing a turn id into that would
 * outlive this request and follow the conversation onto other providers.
 *
 * WHAT IS NOT FILTERED, AND WHY IT STAYS THAT WAY. The daemon additionally
 * skips a user item whose text is one of its contextual envelopes
 * (`<environment_context>`, `<subagent_notification>`, or one of its two
 * compaction-summary texts) before accepting it as a revision. The two
 * compaction texts are daemon-internal strings nothing in this repo produces —
 * Veyyon's own summary framing is a different sentence
 * (`packages/agent/src/prompts/compaction/compaction-summary-context.md`). The
 * two XML shapes are reachable, though, because a user can type one.
 *
 * The filter is deliberately NOT applied here, and adding it would open a real
 * hole. Exactly one item carries the current turn id, and it is the item the
 * daemon reads as `user` in `environmentBeforeUser` — never the `candidate`
 * whose content that function scans for `<environment_context>`. Skipping a
 * contextual item would stamp an EARLIER user item instead, putting a stamped,
 * user-authored item into the candidate slot, and a user-supplied
 * `<environment_context>` part inside it would then be read as trusted
 * filesystem authority. So a user message shaped exactly like one of those
 * envelopes is refused by the daemon (it skips it, lands on an unstamped item
 * and reports "requires a current-turn user message"), which is the safe
 * failure and is chosen over accepting user text as host authority.
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
export function stampChatGptWebCurrentTurnUserItem(body: RequestBody, turnId: string): number {
	if (turnId.length === 0) return -1;
	const input = body.input;
	if (!Array.isArray(input)) return -1;
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
		return index;
	}
	return -1;
}
