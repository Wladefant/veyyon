import { withScopedTimeoutSignal } from "../utils/fetch-timeout";

/**
 * How long any single Smithery HTTP request may take.
 *
 * One value for the three entrypoints that talk to Smithery, because they are one
 * service reached at three hosts: `smithery.ai` for the CLI auth handshake,
 * `api.smithery.ai` for connect, `registry.smithery.ai` for search and install.
 * Each of them used to declare its own `SMITHERY_*_TIMEOUT_MS = 10_000`, so
 * "Smithery gets ten seconds" was written in three places and could drift into
 * three different answers without anything noticing.
 *
 * Ten seconds is a deadline for a small JSON exchange, not a download: every
 * caller fetches a config, a token, or a page of search results.
 */
export const SMITHERY_HTTP_TIMEOUT_MS = 10_000;

/**
 * Run one Smithery request under the Smithery deadline, optionally combined with
 * the caller's own signal.
 *
 * Read the response body inside `request`: the deadline covers the body too, and
 * its timer is cleared the moment `request` settles, so no armed timer outlives a
 * finished request. Pass the caller's signal when there is one so a cancelled
 * command stops the request instead of waiting out the deadline.
 */
export function withSmitheryDeadline<T>(
	request: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return withScopedTimeoutSignal(SMITHERY_HTTP_TIMEOUT_MS, request, signal);
}
