/**
 * `fetchWithRetry` with the registry's verdict already installed.
 *
 * `@veyyon/utils` owns the retry LOOP — the attempt bound, the backoff, the `Retry-After` hint, the
 * HTTP/2 verdict — and it cannot own the DECISION, because a status means something only next to the
 * body and the classifier that reads bodies lives here. So the loop's own gate admits the canonical
 * transient set and every caller was free to narrow it, which meant a provider that passed no gate at
 * all silently accepted the loop's reading: a bare 429 was re-sent against the same spent credential
 * while the credential layer, looking at the identical failure, was rotating away from it.
 *
 * A THROWN failure is the same decision with no response to read. The loop's reading of one was "retry
 * anything that threw", so a host that does not resolve, a certificate that does not verify and a port
 * nothing listens on were each dialed six times over fifteen seconds before the turn heard of them,
 * and the turn ladder then ran that whole ladder again inside each of its own attempts. The registry
 * answers it instead: the transport stage repeats what its family says the transport stage repeats.
 *
 * Every provider in this package fetches through this function, so the decision has one home for the
 * whole package and a provider states only what is genuinely its own — its {@link ResponseRetryPolicy},
 * or a `shouldRetryError` that vetoes a retry the registry would allow. A provider that needs the loop
 * without the response verdict passes its own `shouldRetryResponse`, which is still honoured; nothing
 * here can widen the loop's gate, which is why a policy's `alsoRetry` belongs to a ladder that runs its
 * own loop.
 */
import { type FetchWithRetryOptions, fetchWithRetry } from "@veyyon/utils/fetch-retry";
import { type ResponseRetryPolicy, retryResponse } from "../error/response";
import { isProviderRetryableError } from "../error/retryable";

export interface ProviderFetchOptions extends FetchWithRetryOptions {
	/** What this provider states about its own responses; the registry decides the rest. */
	retry?: ResponseRetryPolicy;
}

export function fetchProviderWithRetry(
	url: string | URL | ((attempt: number) => string | URL),
	options: ProviderFetchOptions = {},
): Promise<Response> {
	const { retry, shouldRetryResponse, shouldRetryError, ...rest } = options;
	return fetchWithRetry(url, {
		...rest,
		shouldRetryResponse:
			shouldRetryResponse ?? ((response, bodyText) => retryResponse(response, bodyText, retry ?? {})),
		shouldRetryError: async (error, attempt) =>
			isProviderRetryableError(error) &&
			(shouldRetryError === undefined || (await shouldRetryError(error, attempt))),
	});
}
