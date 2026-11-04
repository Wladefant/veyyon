import { isAbsolute } from "node:path";
import { stampChatGptWebCurrentTurnUserItem } from "./chatgpt-web-turn-stamp";
import type { InputItem, RequestBody } from "./request-transformer";

/**
 * The trusted Codex environment envelope the local `codex-chatgpt-web` daemon
 * requires, built from facts this host owns.
 *
 * WHY IT IS SENT. Ordinary Full-mode turns resolve trusted environment context
 * before browser work, including text-only turns. Without an envelope or other
 * trusted/cached context, they fail with `MissingTrustedCodexEnvironmentError`.
 * Supplying the host envelope avoids relying on the daemon's instruction or
 * thread-cache fallbacks. Compaction explicitly disables local tools before
 * mode resolution and does not require this envelope.
 *
 * WHAT THE DAEMON ACCEPTS, and the one shape Veyyon can satisfy. Of the paths
 * in `rawEnvironmentText` (`adapters/chatgpt-web/environment.ts`), the others
 * need a non-empty server-owned item `id` on both items
 * (`canonicalMetadataEnvironmentBeforeUser`) or a server-set `_replayPrefixLen`
 * — and the Codex request transformer strips `id` from every input item by
 * design, because OpenAI's backend rejects client-minted ids. That leaves
 * `environmentBeforeUser`, which requires, at the LAST `role: "user"` input
 * item: that item declaring `type: "message"` and carrying
 * `internal_chat_message_metadata_passthrough.turn_id` equal to the `turn_id`
 * in `client_metadata["x-codex-turn-metadata"]`, and the item IMMEDIATELY
 * BEFORE it being another such user message whose content array holds a text
 * part that is exactly one `<environment_context>…</environment_context>`
 * element. Hence one insertion, bound to the index the stamp reports.
 *
 * ONLY HOST-OWNED FACTS CROSS THIS BOUNDARY. The envelope carries the caller's
 * session working directory and nothing else that could be mistaken for
 * authority. It is never derived from a user or model message, never read from
 * `process.cwd()` (the provider can be embedded in a process whose cwd is
 * unrelated to the session), and never synthesized when the caller supplied
 * none — see {@link resolveChatGptWebTrustedEnvironment}.
 */
export interface ChatGptWebTrustedEnvironment {
	/**
	 * Absolute session working directory, as the host supplied it. Sent verbatim:
	 * the daemon resolves and case-folds it itself, and normalizing here would
	 * mean transforming a fact this module does not own.
	 */
	cwd: string;
}

/** What {@link applyChatGptWebTurnContract} was able to send. */
export type ChatGptWebTurnContractOutcome =
	/** Current-turn user item stamped and the trusted envelope inserted before it. */
	| "sent"
	/** No `role: "user"` item to stamp; the daemon refuses the turn for that reason. */
	| "no-current-turn-user-item"
	/** Stamped, but the host supplied no absolute cwd, so a Full-mode daemon refuses the turn. */
	| "no-trusted-host-cwd";

/**
 * Promote the caller's session working directory to a trusted environment, or
 * report that there is none.
 *
 * A relative path is refused rather than resolved. `resolve()` would silently
 * join it onto the current process's cwd and hand the daemon a workspace root
 * this module invented; the daemon would accept that as filesystem authority
 * for the whole turn. An absent or relative cwd is a missing prerequisite, and
 * the honest outcome is the daemon's own explicit refusal.
 */
export function resolveChatGptWebTrustedEnvironment(cwd: string | undefined): ChatGptWebTrustedEnvironment | undefined {
	if (typeof cwd !== "string") return undefined;
	const trimmed = cwd.trim();
	if (trimmed.length === 0 || !isAbsolute(trimmed)) return undefined;
	return { cwd: trimmed };
}

/** The five entities the daemon's `decodeXmlText` reverses, and no others. */
function escapeXmlText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Render the `<environment_context>` element for one host environment.
 *
 * THE SANDBOX DECLARATION IS A NEGATIVE CLAIM, WHICH IS THE ONLY TRUTHFUL ONE
 * AVAILABLE. `sandboxTypeFromEnvironment` accepts exactly one of three
 * policies, and two of them (`workspace-write`, `read-only`) assert that
 * filesystem access outside the writable roots is PREVENTED. Veyyon enforces no
 * such boundary: its tools run as the host user with the host user's authority,
 * and this repository contains no sandbox mechanism to appeal to (there is no
 * `sandbox_mode`, seatbelt, seccomp or job-object layer anywhere in it). So the
 * envelope declares `permission_profile type="disabled"` with
 * `file_system type="unrestricted"` — the daemon's `dangerFullAccess`, i.e. "no
 * sandbox is in force" — which is the absence of an isolation claim rather than
 * one this module cannot back. Declaring either restricted policy would tell
 * the daemon, and through it the browser side, that writes are contained when
 * they are not. The same element is what the daemon's own reference client
 * emits (`src/dev-chat/driver.ts`), and it also accepts the older
 * `<sandbox_mode>danger-full-access</sandbox_mode>` spelling for the same
 * policy.
 *
 * `<network_access>` is omitted rather than guessed: the daemon ignores it for
 * this policy, so stating it would add an unowned fact with no effect.
 *
 * The single `<root>` is the session cwd, because that is the only root the
 * host told us about. The daemon requires the cwd to sit inside the declared
 * roots, which a one-root envelope satisfies by construction.
 */
export function renderChatGptWebEnvironmentContext(environment: ChatGptWebTrustedEnvironment): string {
	const cwd = escapeXmlText(environment.cwd);
	return [
		"<environment_context>",
		`  <cwd>${cwd}</cwd>`,
		"  <filesystem>",
		`    <workspace_roots><root>${cwd}</root></workspace_roots>`,
		'    <permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>',
		"  </filesystem>",
		"</environment_context>",
	].join("\n");
}

/**
 * Apply both halves of the bridge's turn contract to a request body: stamp the
 * current-turn user item, then insert the trusted environment immediately
 * before it.
 *
 * WHY ONE FUNCTION. The daemon reads the envelope only at `activeUserIndex - 1`
 * (allowing between them nothing but developer items that carry the same turn
 * id, which Veyyon never stamps). Adjacency is the contract, so the insertion
 * is bound to the index the stamp just returned rather than recomputed by a
 * second scan that could drift from it.
 *
 * HISTORY IMMUTABILITY IS PRESERVED. `body.input` is an array the request
 * transformer already rebuilt (`filterInput` maps it), so splicing into it
 * cannot reach the session's stored `providerPayload`. The inserted item is
 * freshly constructed and the stamp replaces an array slot instead of mutating
 * the item in it, so no item shared with the stored conversation is touched.
 *
 * IT RUNS ON EVERY REQUEST, INCLUDING CONTINUATIONS AND COMPACTION. The daemon
 * caches the last trusted authority per thread, but that cache expires, is
 * capped, and is lost when the daemon restarts; re-sending is a few hundred
 * bytes and makes a directory move between turns take effect on the next turn.
 * A change within an active daemon tool loop is refused by the daemon.
 * Compaction does not require the envelope, but sending it is harmless: its
 * source key stays unchanged, so it still identifies the browser response it
 * supersedes. Its execution key can change deterministically with the envelope.
 */
export function applyChatGptWebTurnContract(
	body: RequestBody,
	turnId: string,
	hostCwd: string | undefined,
): ChatGptWebTurnContractOutcome {
	const userIndex = stampChatGptWebCurrentTurnUserItem(body, turnId);
	if (userIndex < 0) return "no-current-turn-user-item";
	const environment = resolveChatGptWebTrustedEnvironment(hostCwd);
	if (!environment) return "no-trusted-host-cwd";
	const input = body.input;
	if (!Array.isArray(input)) return "no-current-turn-user-item";
	const item: InputItem = {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: renderChatGptWebEnvironmentContext(environment) }],
		internal_chat_message_metadata_passthrough: { turn_id: turnId },
	};
	input.splice(userIndex, 0, item);
	return "sent";
}
