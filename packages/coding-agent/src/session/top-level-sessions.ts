/**
 * The top-level sessions of this process that have not begun disposal.
 *
 * Several run at once: a conversation `/new` left running in the background, the one on screen,
 * and every session an ACP client opened. The process-wide agent lifecycle and the shared worker
 * subprocesses (tiny title model, memory embeddings) serve all of them, so only the disposal of
 * the last one releases them. An earlier disposal ends its own conversation and leaves them to
 * the sessions still running.
 */

const live = new Set<object>();

export function enterTopLevelSession(session: object): void {
	live.add(session);
}

/**
 * Remove `session`. Returns true when it was live and no other top-level session is, so the
 * caller releases the process-wide resources. Synchronous, so two disposals that overlap still
 * agree on which one is last.
 */
export function leaveTopLevelSession(session: object): boolean {
	return live.delete(session) && live.size === 0;
}

/** How many top-level sessions have not begun disposal. */
export function liveTopLevelSessionCount(): number {
	return live.size;
}
