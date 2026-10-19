/**
 * OAuth token refresh for `AuthStorage`: the per-credential single-flight, the cross-process
 * refresh lease with its renewal loop, adoption of a token a peer process already rotated, and
 * the bounded call to the provider's token endpoint.
 */

import * as logger from "@veyyon/utils/logger";
import { clamp } from "@veyyon/utils/math";
import { settleWithin } from "@veyyon/utils/scoped-timeout";
import * as AIError from "../error";
import { getOAuthProvider, refreshOAuthToken } from "../registry/oauth";
import type { OAuthCredentials, OAuthProvider } from "../registry/oauth/types";
import type { Provider } from "../types";
import { raceWithSignal } from "../utils/abort";
import type { AuthCredential, AuthCredentialStore, AuthStorageOptions, OAuthCredential } from "./types";

/**
 * How long a CALLER waits for a refresh before it gives up on it. A slow token endpoint must not
 * stall credential selection or an MCP connection; the refresh itself runs on behind the caller.
 */
export const OAUTH_REFRESH_CALLER_WAIT_MS = 10_000;
/**
 * How long a lease-fenced refresh FLIGHT may run, which is longer than any caller waits for it.
 *
 * The flight spends a single-use refresh token. Ending it when the first caller gives up released
 * the lease and the in-flight entry while the provider was still minting the rotation, so the next
 * request refreshed again with the old token (which providers with reuse detection answer by
 * revoking the whole grant), and the rotation that arrived a moment later was dropped on the floor.
 * The flight runs to this ceiling and persists whatever it gets; only the callers stop waiting.
 */
export const OAUTH_REFRESH_FLIGHT_CEILING_MS = 120_000;
/**
 * Refresh OAuth access tokens this many ms before their stated expiry. The
 * skew exists so callers downstream of {@link AuthStorage} (stream providers,
 * usage probes, web_search) never observe a credential that is expired or
 * about to expire mid-request — there's a single rotation point and everyone
 * downstream trusts the token they receive.
 *
 * Set to 60s: comfortably absorbs request RTT + a clock-skew window without
 * triggering a refresh on every request. Provider token endpoints typically
 * mint access tokens with 30-60min lifetimes, so refreshing 60s early changes
 * the rotation cadence by <4%.
 */
export const OAUTH_REFRESH_SKEW_MS = 60_000;
export const OAUTH_REFRESH_LEASE_TTL_MS = 15_000;
export const OAUTH_REFRESH_LEASE_POLL_MS = 50;
const OAUTH_REFRESH_LEASE_RENEW_MS = 5_000;

/** One credential's in-process refresh, and how many callers are still waiting on its result. */
interface RefreshFlight {
	promise: Promise<OAuthCredentials>;
	waiting: number;
}

export class OAuthRefresher {
	readonly #store: AuthCredentialStore;
	readonly #override: AuthStorageOptions["refreshOAuthCredential"];
	readonly #persistRefreshedCredentialById: (provider: string, id: number, credential: AuthCredential) => void;
	#oauthCredentialRefreshInFlight: Map<number, RefreshFlight> = new Map();

	/**
	 * `override` replaces the store hook and the local provider refresh when set.
	 * `persistRefreshedCredentialById` writes a rotated credential onto its row.
	 */
	constructor(
		store: AuthCredentialStore,
		override: AuthStorageOptions["refreshOAuthCredential"],
		persistRefreshedCredentialById: (provider: string, id: number, credential: AuthCredential) => void,
	) {
		this.#store = store;
		this.#override = override;
		this.#persistRefreshedCredentialById = persistRefreshedCredentialById;
	}

	/** Whether the store exposes the full durable-lease surface both fenced paths need. */
	storeSupportsDurableLease(): boolean {
		return (
			!!this.#store.tryAcquireCredentialRefreshLease &&
			!!this.#store.getCredentialRefreshLeaseExpiresAt &&
			!!this.#store.releaseCredentialRefreshLease &&
			!!this.#store.renewCredentialRefreshLease
		);
	}

	/**
	 * Run `fn` while holding a refresh lease, renewing it in the background so a
	 * refresh slower than the lease TTL does not lose ownership mid-flight.
	 *
	 * The ownership loss is REPORTED alongside the result, never thrown. By the time
	 * it is known the provider has usually already spent the single-use refresh token,
	 * and throwing would discard a rotation that can never be obtained again, which is
	 * the "logged out after a rebuild" failure the lease exists to prevent. Each caller
	 * decides what a lost lease means for its own persist.
	 *
	 * `credentialId === undefined` means the refresh is not lease-fenced at all (the
	 * store lacks the durable-lease surface, or the row was never leased), so no
	 * renewal loop runs and `ownershipLost` is always undefined.
	 *
	 * This is the one renewal loop. Both fenced refresh paths, `#leaseFencedRefresh`
	 * for model providers and `refreshStoredOAuthCredential` for MCP, go through it.
	 */
	async withRefreshLeaseRenewal<T>(
		credentialId: number | undefined,
		owner: string,
		fn: () => Promise<T>,
	): Promise<{ result: T; ownershipLost: unknown }> {
		if (credentialId === undefined) return { result: await fn(), ownershipLost: undefined };
		let stop = false;
		let ownershipLost: unknown;
		// The renewal loop must wake IMMEDIATELY when the refresh finishes, not at the
		// end of its current sleep. Waiting out a full renew interval would delay the
		// rotation's persistence by seconds — long enough for a caller that already
		// aborted to be gone, and long enough to be a latency bug on every refresh even
		// when nothing goes wrong.
		const stopped = Promise.withResolvers<void>();
		const renewal = (async () => {
			while (!stop) {
				await settleWithin(stopped.promise, OAUTH_REFRESH_LEASE_RENEW_MS, undefined);
				if (stop) return;
				const renewed = this.#store.renewCredentialRefreshLease?.(
					credentialId,
					owner,
					Date.now() + OAUTH_REFRESH_LEASE_TTL_MS,
				);
				if (!renewed) {
					ownershipLost = new AIError.ConfigurationError("OAuth refresh ownership was lost before persistence");
					return;
				}
			}
		})().catch(error => {
			ownershipLost = error;
		});

		// The teardown runs in `finally` so it happens on every path, but nothing is
		// raised from inside it: a `throw` in `finally` replaces whatever the block was
		// already doing, so when `fn` itself fails it would discard that error and
		// report a generic ownership one in its place, hiding the actual cause.
		let result: T;
		try {
			result = await fn();
		} catch (error) {
			stop = true;
			stopped.resolve();
			await renewal;
			if (ownershipLost !== undefined) {
				// `fn`'s error is the one that explains the failure and the one the caller
				// gets. This one is real too and only one can be thrown, so surface it
				// rather than dropping it (Law 10).
				logger.warn("OAuth refresh lost its lease while already failing", {
					credentialId,
					owner,
					ownershipError: String(ownershipLost),
				});
			}
			throw error;
		}
		stop = true;
		stopped.resolve();
		await renewal;
		return { result, ownershipLost };
	}

	/**
	 * The credential a PEER already rotated, if one exists and is usable.
	 *
	 * Reads by id including disabled rows, because the peer's winning row may be the
	 * one a loser disabled. Returns it only when the row still belongs to the provider
	 * we are refreshing, the refresh token actually differs from what we hold (proof of
	 * a rotation, not a re-read of our own row), and it is not about to expire, so we
	 * never hand back a token that would immediately need refreshing again.
	 *
	 * The provider check is what makes reading by a bare id safe. Nothing in the
	 * lookup constrains WHICH provider the returned row belongs to: `readAuthCredentialById`
	 * is an optional method on the `AuthCredentialStore` interface, so the row comes
	 * from whatever store is plugged in, and the ids in the shipped SQLite store are
	 * not the only ones that can appear there — the explicit-id INSERT paths used by
	 * migration and import write ids chosen elsewhere. A row for another provider is
	 * a live, unexpired OAuth credential whose refresh token differs from ours, which
	 * is exactly the signature this function reads as "a peer rotated it", so without
	 * the check that provider's token would be returned here and sent upstream as
	 * ours. Refuse, loudly (Law 10), instead of falling through to a credential that
	 * merely has the right shape.
	 *
	 * (The shipped `SqliteAuthCredentialStore` declares `id INTEGER PRIMARY KEY
	 * AUTOINCREMENT`, so it will not hand a freed id back on its own. This is a
	 * boundary check on the interface, not a fix for a race in that one store.)
	 */
	#freshRotatedCredential(
		provider: Provider,
		credentialId: number,
		previous: OAuthCredential,
	): OAuthCredentials | undefined {
		const readById = this.#store.readAuthCredentialById?.bind(this.#store);
		if (!readById) return undefined;
		const latest = readById(credentialId);
		if (latest?.credential.type !== "oauth") return undefined;
		if (latest.provider !== provider) {
			// Names only: the row is somebody else's credential, and nothing about its
			// contents belongs in a log.
			logger.warn("OAuth credential row changed provider mid-refresh; refusing the peer's token", {
				credentialId,
				expectedProvider: provider,
				storedProvider: latest.provider,
			});
			return undefined;
		}
		const rotated = latest.credential;
		if (rotated.refresh === previous.refresh) return undefined;
		if (Date.now() + OAUTH_REFRESH_SKEW_MS >= rotated.expires) return undefined;
		return rotated;
	}

	/**
	 * Merge a rotated credential onto the row and persist it, independently of
	 * whatever the caller is doing.
	 *
	 * This exists because the caller's `await` can be abandoned — a shutdown, a
	 * rebuild, or an ESC aborts the caller while the refresh itself keeps going and
	 * resolves a moment later with a rotated, single-use token. If only the caller
	 * persisted, that token would be lost while the provider had already invalidated
	 * the old one, and the NEXT run would refresh with a dead token, be told
	 * `invalid_grant`, and permanently disable a perfectly good login. Committing
	 * here, inside the single-flight, makes the rotation durable no matter who is
	 * still listening.
	 */
	#commitRotatedOAuthCredential(
		provider: Provider,
		credentialId: number,
		previous: OAuthCredential,
		refreshed: OAuthCredentials,
	): void {
		// Never clobber a peer that rotated FORWARD while we were in flight. Our write
		// can land arbitrarily late (the caller may have aborted seconds ago), and the
		// stored row may by then hold a strictly newer single-use token. Overwriting it
		// with ours would spend the peer's rotation for nothing and put a dead token on
		// disk, which is the very failure this path exists to prevent.
		const peerFresh = this.#freshRotatedCredential(provider, credentialId, previous);
		if (peerFresh && peerFresh.refresh !== refreshed.refresh) return;

		const merged: OAuthCredential = { ...previous, ...refreshed, type: "oauth" };
		this.#persistRefreshedCredentialById(provider, credentialId, merged);
	}

	/**
	 * Refresh under a CROSS-PROCESS lease, so a single-use refresh token is spent
	 * exactly once even when several veyyon processes share one credential store.
	 *
	 * The in-process single-flight cannot help here: the racing refreshes live in
	 * different processes. Whoever takes the lease refreshes; everyone else waits and
	 * then reads the peer's rotated token instead of burning their own now-dead one.
	 * That converts the rotation race from something to be healed after the fact into
	 * something that cannot happen.
	 *
	 * No caller signal reaches this function. The ownership wait and the refresh both
	 * run under {@link OAUTH_REFRESH_FLIGHT_CEILING_MS}, because aborting after the
	 * provider has rotated the token would strand it — the same loss this whole path
	 * exists to prevent. At the ceiling the token request is aborted, and the lease and the
	 * in-flight entry are held until that request settles: while it is open the provider may
	 * still rotate the grant, so no second flight in this process or a peer spends the same
	 * refresh token. Callers stay bounded by their own wait.
	 */
	async #leaseFencedRefresh(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number,
	): Promise<OAuthCredentials> {
		if (!this.storeSupportsDurableLease()) {
			return this.#refreshOAuthCredentialUnshared(
				provider,
				credential,
				credentialId,
				undefined,
				OAUTH_REFRESH_FLIGHT_CEILING_MS,
				true,
			);
		}

		const owner = crypto.randomUUID();
		const ownershipDeadline = Date.now() + OAUTH_REFRESH_FLIGHT_CEILING_MS;
		for (;;) {
			// A peer may have finished while we waited; prefer its token over spending ours.
			const peerFresh = this.#freshRotatedCredential(provider, credentialId, credential);
			if (peerFresh) return peerFresh;
			if (
				this.#store.tryAcquireCredentialRefreshLease?.(credentialId, owner, Date.now() + OAUTH_REFRESH_LEASE_TTL_MS)
			) {
				break;
			}
			if (Date.now() >= ownershipDeadline) {
				throw new AIError.OAuthError(`OAuth token refresh timed out waiting for a peer: ${provider}`, {
					kind: "timeout",
					provider,
				});
			}
			const leaseExpiresAt = this.#store.getCredentialRefreshLeaseExpiresAt?.(credentialId);
			const waitMs =
				leaseExpiresAt === undefined
					? OAUTH_REFRESH_LEASE_POLL_MS
					: clamp(leaseExpiresAt - Date.now(), OAUTH_REFRESH_LEASE_POLL_MS, 250);
			await Bun.sleep(waitMs);
		}

		try {
			// Re-check under the lease: a peer may have rotated between our last check
			// and acquiring ownership.
			const peerFresh = this.#freshRotatedCredential(provider, credentialId, credential);
			if (peerFresh) return peerFresh;

			const { result: refreshed, ownershipLost } = await this.withRefreshLeaseRenewal(credentialId, owner, () =>
				this.#refreshOAuthCredentialUnshared(
					provider,
					credential,
					credentialId,
					undefined,
					OAUTH_REFRESH_FLIGHT_CEILING_MS,
					true,
				),
			);

			if (ownershipLost !== undefined) {
				// The token is already rotated and the old one is dead at the provider, so
				// discarding it here would guarantee the logout. Commit on the data CAS
				// alone, then prefer whatever the store ended up holding.
				logger.warn("OAuth refresh lease lost mid-rotation; reconciling against the stored row", {
					provider,
					credentialId,
				});
				this.#commitRotatedOAuthCredential(provider, credentialId, credential, refreshed);
				const winner = this.#freshRotatedCredential(provider, credentialId, credential);
				if (winner) return winner;
			}
			return refreshed;
		} finally {
			this.#store.releaseCredentialRefreshLease?.(credentialId, owner);
		}
	}

	/**
	 * The credential with a usable access token: `credential` itself while it is outside the
	 * refresh skew, else a refreshed one. Concurrent refreshes of one row share one flight.
	 *
	 * The flight belongs to the row, not to the caller that started it. It takes no caller signal
	 * and runs under {@link OAUTH_REFRESH_FLIGHT_CEILING_MS}, so a caller that aborts or stops
	 * waiting after {@link OAUTH_REFRESH_CALLER_WAIT_MS} neither fails the other callers waiting on
	 * the same flight nor strands the rotated token: a caller that receives the rotation MUST
	 * persist it, and the flight commits it itself when no caller is left to receive it.
	 */
	async refreshOAuthCredential(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		if (credentialId !== undefined) {
			const existing = this.#oauthCredentialRefreshInFlight.get(credentialId);
			if (existing) return this.#awaitFlight(existing, provider, signal);
		}
		if (Date.now() + OAUTH_REFRESH_SKEW_MS < credential.expires) return credential;
		if (credentialId === undefined) {
			// No row to persist onto and no lease to hold, so nothing outlives the caller.
			return this.#refreshOAuthCredentialUnshared(
				provider,
				credential,
				undefined,
				signal,
				OAUTH_REFRESH_CALLER_WAIT_MS,
			);
		}
		const id = credentialId;
		const flight: RefreshFlight = { promise: Promise.resolve(credential), waiting: 0 };
		flight.promise = this.#leaseFencedRefresh(provider, credential, id)
			.then(refreshed => {
				// Every caller that receives the rotation persists it, often with more than this flight
				// knows (the usage path adds the provider's `apiEndpoint`). When every caller has already
				// aborted or stopped waiting, nobody would, and the provider has invalidated the old
				// refresh token, so the flight commits the rotation itself.
				if (flight.waiting === 0) this.#commitRotatedOAuthCredential(provider, id, credential, refreshed);
				return refreshed;
			})
			.finally(() => {
				this.#oauthCredentialRefreshInFlight.delete(id);
			});
		this.#oauthCredentialRefreshInFlight.set(id, flight);
		return this.#awaitFlight(flight, provider, signal);
	}

	/** One caller's bounded wait on a shared flight. The flight itself keeps running. */
	async #awaitFlight(
		flight: RefreshFlight,
		provider: Provider,
		signal: AbortSignal | undefined,
	): Promise<OAuthCredentials> {
		const expired = Promise.withResolvers<never>();
		const timer = setTimeout(
			() =>
				expired.reject(
					new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					}),
				),
			OAUTH_REFRESH_CALLER_WAIT_MS,
		);
		flight.waiting += 1;
		try {
			return await raceWithSignal(
				Promise.race([flight.promise, expired.promise]),
				signal,
				"credential refresh aborted",
			);
		} finally {
			// Settled either way: a caller that received the rotation persists it on return, and one that
			// gave up will not, so neither counts as waiting by the time the flight decides to commit.
			flight.waiting -= 1;
			clearTimeout(timer);
		}
	}

	async #refreshOAuthCredentialUnshared(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		holdUntilSettled = false,
	): Promise<OAuthCredentials> {
		let providerRefresh: Promise<OAuthCredentials>;
		// Aborts the token request when the caller aborts or the bound fires, so an abandoned request
		// does not stay open beside the next flight.
		const request = new AbortController();
		// Caller override > store-level hook > local per-provider refresh.
		// `RemoteAuthCredentialStore` exposes the hook so a broker-backed gateway
		// routes refresh through the broker without explicit wiring.
		const storeRefresh = this.#store.refreshOAuthCredential?.bind(this.#store);
		const overrideRefresh = this.#override ?? storeRefresh;
		if (overrideRefresh && credentialId !== undefined) {
			providerRefresh = overrideRefresh(provider, credentialId, credential, request.signal);
		} else {
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				if (!customProvider.refreshToken) {
					throw new AIError.OAuthError(`OAuth provider "${provider}" does not support token refresh`, {
						kind: "configuration",
						provider,
					});
				}
				providerRefresh = customProvider.refreshToken(credential, request.signal);
			} else {
				providerRefresh = refreshOAuthToken(provider as OAuthProvider, credential, request.signal);
			}
		}
		const refreshPromise = providerRefresh.then(refreshed => requireUsableRefresh(provider, refreshed));
		// Bound the refresh so a hanging token endpoint cannot hold the flight forever.
		// Caller-driven abort jumps the gun on the timeout — the agent's ESC must
		// take priority over the floor timeout.
		let timeout: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const cancellation = Promise.withResolvers<never>();
		timeout = setTimeout(
			() =>
				cancellation.reject(
					new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					}),
				),
			timeoutMs,
		);
		if (signal) {
			if (signal.aborted) {
				cancellation.reject(new AIError.RequestAbortError("OAuth token refresh aborted by caller"));
			} else {
				onAbort = () => cancellation.reject(new AIError.RequestAbortError("OAuth token refresh aborted by caller"));
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		let providerSettled = false;
		const observed = refreshPromise.finally(() => {
			providerSettled = true;
		});
		try {
			return await Promise.race([observed, cancellation.promise]);
		} catch (error) {
			if (providerSettled) throw error;
			request.abort(error);
			if (!holdUntilSettled) throw error;
			// Lease-fenced: the provider may already have rotated the grant. The flight holds the lease
			// and the in-flight entry until the aborted request settles, so no second flight spends the
			// same refresh token beside it. A refresher that honours its signal settles at once; one
			// that ignores it holds its row for as long as its request stays open. A rotation it returns
			// is the only valid token for the grant and is handed back to be persisted; a rejection
			// after the abort reports the ceiling, never an account fact.
			const settled = await observed.then(
				refreshed => refreshed,
				() => undefined,
			);
			if (settled) {
				logger.warn("OAuth refresh answered after its ceiling; persisting the late rotation", { provider });
				return settled;
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}
}

/**
 * `refreshed` when it holds an access token a request can send, else a validation error.
 *
 * Every refresh path lands here, so a token endpoint answering 200 with an empty or missing access
 * token never reaches the row: storing it sent an empty bearer on every request, which the provider
 * answered 401, which disabled a login whose refresh token still worked. The error is not a
 * definitive refusal, so the row stays and the next request refreshes again.
 */
function requireUsableRefresh(provider: Provider, refreshed: OAuthCredentials): OAuthCredentials {
	if (typeof refreshed.access === "string" && refreshed.access.length > 0 && Number.isFinite(refreshed.expires)) {
		return refreshed;
	}
	throw new AIError.OAuthError(`OAuth token refresh for ${provider} returned no usable access token`, {
		kind: "validation",
		provider,
	});
}
