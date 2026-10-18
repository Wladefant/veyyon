let interactiveHost = false;

/**
 * True when this process runs an interactive coding-agent host — the only
 * context where the operator can browse the Agent Hub and focus a live
 * subagent's session (`SessionFocusController`), so a subagent's session title
 * can become operator-visible. Off by default (print/RPC/ACP/eval/SDK/`bun
 * test` never render a focusable session tree); the interactive entrypoint
 * flips it on with {@link setInteractiveHost}.
 */
export function isInteractiveHost(): boolean {
	return interactiveHost;
}

/**
 * Set the interactive-host flag and return the previous value so callers can
 * restore exact prior state. See {@link isInteractiveHost}.
 */
export function setInteractiveHost(interactive: boolean): boolean {
	const previous = interactiveHost;
	interactiveHost = interactive;
	return previous;
}

/**
 * SQLite `busy_timeout` for the session-critical databases (agent.db,
 * history.db, stats.db).
 *
 * Interactive hosts tolerate a longer synchronous wait on lock contention
 * (SQLITE_BUSY during WAL recovery/checkpoint — see oh-my-pi#2421): the
 * operator sees a brief freeze and the statement eventually completes.
 * Headless hosts (print/RPC/ACP/eval/SDK) run a protocol on the same thread —
 * a multi-second synchronous busy-wait freezes their event loop and stalls
 * every in-flight frame with no liveness signal, so they use a short timeout
 * and rely on the existing asynchronous open/retry paths to recover from
 * contention instead of blocking.
 */
export function getDbBusyTimeoutMs(): number {
	return isInteractiveHost() ? 5000 : 1000;
}
