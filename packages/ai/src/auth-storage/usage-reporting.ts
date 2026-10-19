/**
 * Provider usage reports for the credentials `AuthStorage` holds: the per-credential fetch with
 * refresh-on-expiry, the persisted report cache and its failure backoff, rate-limit header ingest,
 * recorded history and cost, the coalesced fan-out over every stored credential, and the
 * credential health check that probes each stored row against its usage endpoint.
 *
 * Row writes, credential disabling, routing and rate-limit block reconciliation are defined in
 * `AuthStorage`; this module reaches them through {@link UsageReportingHost}.
 */

import * as logger from "@veyyon/utils/logger";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { errorMessage } from "@veyyon/utils/type-guards";
import { USAGE_REPORT_TTL_MS } from "../auth-credential-rows";
import { getEnvApiKey } from "../env-api-key";
import * as AIError from "../error";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type {
	UsageCostHistoryEntry,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLimit,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "../usage";
import { resolveUsedFraction } from "../usage";
import { listRegisteredUsageProviders, resolveRegisteredUsageProvider } from "../usage/registry";
import { raceWithSignal } from "../utils/abort";
import type { StoredCredential } from "./credentials";
import { buildCompletionProbeCredential } from "./credentials";
import { withAuthHttpConcurrency } from "./http-concurrency";
import { OAUTH_REFRESH_SKEW_MS } from "./oauth-refresh";
import type {
	AuthCredential,
	AuthCredentialStore,
	AuthStorageOptions,
	CheckCredentialsOptions,
	CredentialHealthResult,
	OAuthCredential,
} from "./types";
import { REMOTE_REFRESH_SENTINEL } from "./types";
import type { UsageCache } from "./usage-cache";
import { AuthStorageUsageCache } from "./usage-cache";
import {
	getUsageReportIdentifiers,
	getUsageReportMetadataValue,
	getUsageReportScopeAccountId,
	isUsageLimitExhausted,
	mergeUsageReportGroup,
} from "./usage-reports";
import type { UsageRequestDescriptor } from "./usage-requests";
import {
	buildRefreshableOauthCredential,
	buildUsageCacheIdentity,
	buildUsageCredential,
	buildUsageReportCacheKey,
	buildUsageReportsCacheKey,
	buildUsageRequest,
	buildUsageRequestForOauth,
	isUsageCredentialRow,
	mergeRefreshedUsageCredential,
} from "./usage-requests";

// The two usage-row constants live in `auth-credential-rows.ts`; both halves of the split read them.
const USAGE_HEADER_INGEST_INTERVAL_MS = 60_000;

/**
 * Per-credential cool-down after a usage fetch fails. While this window is
 * active we serve the last successful value to avoid dropping the credential
 * from the report; without a previous value we just return null and retry
 * on the next poll.
 */
const USAGE_FAILURE_BACKOFF_MS = 10_000;
// Bumped from 3s — Claude usage retries up to 3 times with exponential backoff
// (~3.5s total worst case); a tight per-request budget aborts retries mid-cycle.
const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 10_000;

/** The in-flight key the caller override and the store hook coalesce under. */
const OVERRIDE_KEY = "__override__";

/** The credential state usage reporting reads and the row operations it requests. */
export interface UsageReportingHost {
	/** The in-memory rows for `provider`, in rotation order. */
	storedCredentials(provider: string): StoredCredential[];
	/** The rows for `provider` with duplicate logins pruned, the pruned list stored back. */
	dedupedStoredCredentials(provider: string): StoredCredential[];
	/** Every provider that holds in-memory rows. */
	storedProviders(): Iterable<string>;
	/** The runtime API key override for `provider`. */
	runtimeApiKey(provider: string): string | undefined;
	/** The row index a session, or the provider-wide selection, routes `provider` to. */
	routedCredentialIndex(provider: string, sessionId: string | undefined): number | undefined;
	/** The OAuth credential the next request for `provider` in `sessionId` resolves to. */
	activeOAuthCredential(provider: string, sessionId: string | undefined): OAuthCredential | undefined;
	refreshOAuthCredential(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<OAuthCredentials>;
	/** Write a refreshed usage credential onto the row `credentialId` (or `previous`) addresses. */
	persistRefreshedUsageCredential(
		provider: Provider,
		previous: UsageCredential,
		next: UsageCredential,
		credentialId: number | undefined,
	): void;
	/** Disable row `credentialId` when it still holds `expected`; true when it was disabled. */
	disableCredentialIfMatches(
		provider: Provider,
		credentialId: number,
		expected: AuthCredential,
		cause: string,
	): boolean;
	/** Lift a stale Codex usage-limit block that a healthy report contradicts. */
	reconcileCodexUsageBlock(request: UsageRequestDescriptor, report: UsageReport): void;
	/** The same reconciliation for reports the store hook returned without a request. */
	reconcileCodexUsageBlocksFromReports(reports: UsageReport[]): void;
	/** Resolve a stored API key value (an env var name or a literal). */
	resolveConfigValue(config: string): Promise<string | undefined>;
	/** Record that the provider refused row `credentialId`'s grant. */
	markAuthDead(credentialId: number): void;
}

export class UsageReporting {
	readonly #store: AuthCredentialStore;
	readonly #host: UsageReportingHost;
	readonly #providerResolver: (provider: Provider) => UsageProvider | undefined;
	readonly #cache: UsageCache;
	#cacheEpoch = 0;
	readonly #requestInFlight = new Map<string, Promise<UsageReport | null>>();
	readonly #headerIngestAt = new Map<string, number>();
	readonly #reportsInFlight = new Map<string, Promise<UsageReport[] | null>>();
	readonly #fetchReportsOverride: AuthStorageOptions["fetchUsageReports"];
	readonly #logger: UsageLogger;
	/** The fetch every usage and reset-credit request goes through. */
	readonly fetch: typeof fetch;
	/** The default per-request budget for a usage probe. */
	readonly requestTimeoutMs: number;

	constructor(store: AuthCredentialStore, host: UsageReportingHost, options: AuthStorageOptions) {
		this.#store = store;
		this.#host = host;
		this.#providerResolver = options.usageProviderResolver ?? resolveRegisteredUsageProvider;
		this.#cache = new AuthStorageUsageCache(store);
		this.#fetchReportsOverride = options.fetchUsageReports;
		this.#logger =
			options.usageLogger ??
			({
				debug: (message, meta) => logger.debug(message, meta),
				warn: (message, meta) => logger.warn(message, meta),
			} satisfies UsageLogger);
		this.fetch = options.usageFetch ?? fetch;
		this.requestTimeoutMs = options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS;
	}

	/** See {@link AuthStorage.usageProviderFor}. */
	providerFor(provider: Provider): UsageProvider | undefined {
		return this.#providerResolver(provider);
	}

	/** The context a {@link UsageProvider.fetchUsage} call receives. */
	fetchContext(): UsageFetchContext {
		return {
			fetch: this.fetch,
			logger: this.#logger,
			listUsageCosts: query => this.#store.listUsageCosts?.(query) ?? [],
		};
	}

	/** The stored row a {@link UsageCredential} was built from, so a refresh can address it. */
	#storedCredentialId(provider: Provider, credential: UsageCredential): number | undefined {
		return this.#host.storedCredentials(provider).find(isUsageCredentialRow(credential))?.id;
	}

	async #fetchUncached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		// The scoped handle clears its backing timer once the probe settles
		// instead of leaving it armed like a bare AbortSignal.timeout.
		const scopedTimeout =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? scopedTimeoutSignal(timeoutMs)
				: undefined;
		try {
			return await this.#fetchUncachedWithSignal(request, scopedTimeout?.signal);
		} finally {
			scopedTimeout?.cancel();
		}
	}

	async #fetchUncachedWithSignal(
		request: UsageRequestDescriptor,
		timeoutSignal: AbortSignal | undefined,
	): Promise<UsageReport | null> {
		const providerImpl = this.#providerResolver(request.provider);
		if (!providerImpl) return null;

		let params: UsageFetchParams = {
			...request,
			accountKey: buildUsageCacheIdentity(request.credential),
			signal: timeoutSignal,
		};

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() + OAUTH_REFRESH_SKEW_MS >= request.credential.expiresAt
		) {
			const refreshableCredential = buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshableCredentialId = this.#storedCredentialId(request.provider, request.credential);
					const refreshed = await this.#host.refreshOAuthCredential(
						request.provider,
						refreshableCredential,
						refreshableCredentialId,
						timeoutSignal,
					);
					const refreshedCredential = mergeRefreshedUsageCredential(request.credential, refreshed);
					this.#host.persistRefreshedUsageCredential(
						request.provider,
						request.credential,
						refreshedCredential,
						refreshableCredentialId,
					);
					params = {
						...request,
						credential: refreshedCredential,
						accountKey: buildUsageCacheIdentity(refreshedCredential),
						signal: timeoutSignal,
					};
				} catch (error) {
					const errorMsg = String(error);
					// Definitive failure (invalid_grant / 401 not from a network blip) means
					// the refresh token itself is dead — probing with the original credential
					// will 401, the catch below will return null, and #fetchCached's
					// last-good fallback will surface yesterday's report indefinitely
					// (including its already-elapsed `resetsAt`). CAS-disable the row and
					// clear the cache so the credential drops out of the report instead of
					// freezing in place until the user notices and re-logs in.
					if (AIError.isDefinitiveOAuthFailure(errorMsg)) {
						const credentialId = this.#storedCredentialId(request.provider, request.credential);
						if (
							credentialId !== undefined &&
							this.#host.disableCredentialIfMatches(
								request.provider,
								credentialId,
								refreshableCredential,
								`oauth refresh failed during usage probe: ${errorMsg}`,
							)
						) {
							this.#logger.warn("Usage credential refresh failed definitively; credential disabled", {
								provider: request.provider,
								credentialId,
								error: errorMsg,
							});
							// Neutralize last-good for this cache key: write a null
							// entry with an immediately-elapsed expiry so a future
							// getStale lookup (e.g. on re-login under the same
							// account identity) can't replay the stale report.
							this.#cache.set(buildUsageReportCacheKey(request), { value: null, expiresAt: 0 });
							return null;
						}
					}
					this.#logger.debug("Usage credential refresh failed, using original credential", {
						provider: request.provider,
						error: errorMsg,
					});
				}
			}
		}

		if (providerImpl.supports && !providerImpl.supports(params)) return null;

		try {
			const report = await providerImpl.fetchUsage(params, this.fetchContext());
			// Attribute the report to the credential's organization. The orgId and
			// orgName fallbacks apply independently: Claude's usage endpoint stamps
			// orgId from the `anthropic-organization-id` response header but never
			// carries a display name, so the stored name must still be attached.
			// Never attach the stored name over a DIFFERENT org's report.
			if (report && params.credential.orgId !== undefined) {
				const metadata = report.metadata ?? {};
				const sameOrg = metadata.orgId === undefined || metadata.orgId === params.credential.orgId;
				const needsOrgId = metadata.orgId === undefined;
				const needsOrgName = sameOrg && params.credential.orgName !== undefined && metadata.orgName === undefined;
				if (needsOrgId || needsOrgName) {
					report.metadata = {
						...metadata,
						...(needsOrgId ? { orgId: params.credential.orgId } : {}),
						...(needsOrgName ? { orgName: params.credential.orgName } : {}),
					};
				}
			}
			return report;
		} catch (error) {
			logger.debug("AuthStorage usage fetch failed", {
				provider: request.provider,
				error: String(error),
			});
			return null;
		}
	}

	async #fetchCached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const cacheKey = buildUsageReportCacheKey(request);
		const now = Date.now();
		const cached = this.#cache.get<UsageReport | null>(cacheKey);
		// Fresh cache hit: return whatever's there (success or null fallback).
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const inFlight = this.#requestInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const cacheEpoch = this.#cacheEpoch;
		const promise = (async () => {
			const report = await withAuthHttpConcurrency(() => this.#fetchUncached(request, timeoutMs));
			if (cacheEpoch !== this.#cacheEpoch) return report;
			const ttlJitter = USAGE_REPORT_TTL_MS * (Math.random() * 0.5 - 0.25);
			if (report !== null) {
				// Success: stagger per-credential cache expiry so all accounts don't
				// refresh in the same window — Anthropic / OpenAI rate-limit `/usage`
				// per source IP regardless of account, and synchronized 5-credential
				// fan-out trips 429s every cycle. With ±25% jitter on TTL the refresh
				// times decorrelate within a few cycles.
				this.#cache.set(cacheKey, { value: report, expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter });
				this.#recordHistory(request, report);
				this.#host.reconcileCodexUsageBlock(request, report);
				return report;
			}
			// Failure: apply a short jittered cool-down so the credential doesn't
			// re-hit the endpoint on every poll. Serve the last good value when we
			// have one (keeps the credential in the report); otherwise cache null
			// so a cold or throttled credential stops re-bursting until the window
			// expires and the next poll retries.
			const lastGood = this.#cache.getStale<UsageReport | null>(cacheKey)?.value ?? null;
			const backoffJitter = USAGE_FAILURE_BACKOFF_MS * (Math.random() * 0.5 - 0.25);
			const coolDown = Date.now() + USAGE_FAILURE_BACKOFF_MS + backoffJitter;
			this.#cache.set(cacheKey, { value: lastGood, expiresAt: coolDown });
			return lastGood;
		})().finally(() => {
			this.#requestInFlight.delete(cacheKey);
		});

		this.#requestInFlight.set(cacheKey, promise);
		return promise;
	}

	/**
	 * Append a freshly fetched report to durable usage history (when the store
	 * supports it). The usage cache is latest-snapshot-only — these rows are
	 * the only place limit utilization is kept over time.
	 */
	#recordHistory(request: UsageRequestDescriptor, report: UsageReport): void {
		const record = this.#store.recordUsageSnapshots;
		if (!record || report.limits.length === 0) return;
		const recordedAt = Number.isFinite(report.fetchedAt) && report.fetchedAt > 0 ? report.fetchedAt : Date.now();
		const accountKey = buildUsageCacheIdentity(request.credential);
		const metadata = report.metadata ?? {};
		const metaEmail = typeof metadata.email === "string" ? metadata.email : undefined;
		const metaAccountId = typeof metadata.accountId === "string" ? metadata.accountId : undefined;
		const entries: UsageHistoryEntry[] = report.limits.map(limit => ({
			recordedAt,
			provider: request.provider,
			accountKey,
			email: request.credential.email ?? metaEmail,
			accountId: request.credential.accountId ?? limit.scope.accountId ?? metaAccountId,
			limitId: limit.id,
			label: limit.label,
			windowLabel: limit.window?.label ?? limit.scope.windowId,
			usedFraction: resolveUsedFraction(limit),
			status: limit.status,
			resetsAt: limit.window?.resetsAt,
		}));
		try {
			record.call(this.#store, entries);
		} catch (error) {
			this.#logger.debug("usage history record failed", {
				provider: request.provider,
				error: String(error),
			});
		}
	}

	/** See {@link AuthStorage.listUsageHistory}. */
	listHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.#store.listUsageHistory?.(query) ?? [];
	}

	/** See {@link AuthStorage.recordUsageCost}. */
	recordCost(
		provider: Provider,
		costUsd: number,
		options?: { sessionId?: string; recordedAt?: number; baseUrl?: string },
	): boolean {
		if (!Number.isFinite(costUsd) || costUsd <= 0) return false;
		const record = this.#store.recordUsageCosts;
		if (!record) return false;
		const credential = this.#observedCredential(provider, options?.sessionId);
		if (!credential) return false;
		const entry: UsageCostHistoryEntry = {
			recordedAt: options?.recordedAt ?? Date.now(),
			provider,
			accountKey: buildUsageCacheIdentity(credential),
			costUsd,
		};
		try {
			record.call(this.#store, [entry]);
			const cacheKey = buildUsageReportCacheKey({
				provider,
				credential,
				baseUrl: options?.baseUrl,
			});
			const existing = this.#cache.getStale<UsageReport | null>(cacheKey);
			this.#cache.set(cacheKey, { value: existing?.value ?? null, expiresAt: Date.now() - 1 });
			return true;
		} catch (error) {
			this.#logger.debug("usage cost record failed", {
				provider,
				error: String(error),
			});
			return false;
		}
	}

	#observedCredential(provider: Provider, sessionId?: string): UsageCredential | undefined {
		const entries = this.#host.storedCredentials(provider);
		const routedIndex = this.#host.routedCredentialIndex(provider, sessionId);
		if (routedIndex !== undefined) {
			const credential = entries[routedIndex]?.credential;
			if (credential) {
				return credential.type === "api_key"
					? { type: "api_key", apiKey: credential.key }
					: buildUsageCredential(credential);
			}
		}
		if (entries.length === 1) {
			const credential = entries[0]!.credential;
			return credential.type === "api_key"
				? { type: "api_key", apiKey: credential.key }
				: buildUsageCredential(credential);
		}
		const envKey = getEnvApiKey(provider);
		if (envKey) return { type: "api_key", apiKey: envKey };
		return undefined;
	}

	/** See {@link AuthStorage.ingestUsageHeaders}. */
	ingestHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string },
	): boolean {
		if (this.#fetchReportsOverride) return false;
		const parseHeaders = this.#providerResolver(provider)?.parseRateLimitHeaders;
		if (!parseHeaders) return false;

		const credential = this.#host.activeOAuthCredential(provider, options?.sessionId);
		if (!credential) return false;

		const cacheKey = buildUsageReportCacheKey(buildUsageRequestForOauth(provider, credential, options?.baseUrl));
		const now = Date.now();
		const parsedReport = parseHeaders(headers, now);
		if (!parsedReport) return false;
		// Throttled to one ingest per interval — except when a window reads
		// exhausted: that snapshot must land immediately so the next getApiKey
		// blocks the credential instead of burning a wire 429 on the wall.
		const exhausted = parsedReport.limits.some(limit => isUsageLimitExhausted(limit));
		const last = this.#headerIngestAt.get(cacheKey);
		if (!exhausted && last !== undefined && now - last < USAGE_HEADER_INGEST_INTERVAL_MS) return false;
		const metadata: Record<string, unknown> = { ...(parsedReport.metadata ?? {}) };
		if (credential.accountId && metadata.accountId === undefined) metadata.accountId = credential.accountId;
		if (credential.email && metadata.email === undefined) metadata.email = credential.email;
		if (credential.projectId && metadata.projectId === undefined) metadata.projectId = credential.projectId;
		if (credential.orgId && metadata.orgId === undefined) metadata.orgId = credential.orgId;
		if (credential.orgName && metadata.orgName === undefined) metadata.orgName = credential.orgName;
		const report: UsageReport = { ...parsedReport, metadata };

		const storeIngest = this.#store.ingestUsageReport?.bind(this.#store);
		if (storeIngest) {
			const ingested = storeIngest(provider, credential, report);
			if (ingested) this.#headerIngestAt.set(cacheKey, now);
			return ingested;
		}

		if (this.#store.fetchUsageReports) return false;
		const prior = this.#cache.getStale<UsageReport | null>(cacheKey)?.value;
		let merged = report;
		if (prior && Array.isArray(prior.limits)) {
			const headerLimitsById = new Map(report.limits.map(limit => [limit.id, limit]));
			const limits: UsageLimit[] = [];
			for (const limit of prior.limits) {
				const replacement = headerLimitsById.get(limit.id);
				if (replacement) {
					limits.push(replacement);
					headerLimitsById.delete(limit.id);
				} else {
					limits.push(limit);
				}
			}
			for (const limit of headerLimitsById.values()) {
				limits.push(limit);
			}
			merged = {
				...prior,
				fetchedAt: now,
				limits,
				metadata: {
					...(report.metadata ?? {}),
					...(prior.metadata ?? {}),
					headersUpdatedAt: now,
				},
			};
		}

		this.#cache.set(cacheKey, { value: merged, expiresAt: now + USAGE_REPORT_TTL_MS });
		this.#headerIngestAt.set(cacheKey, now);
		return true;
	}

	#collectRequests(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
	}): UsageRequestDescriptor[] {
		const requests: UsageRequestDescriptor[] = [];
		// Providers with no stored credential still need a request built, because a usage backend can
		// report a quota for an account the store has not seen yet. The set of them comes from the
		// registry rather than a local table; see `usage/registry.ts`.
		const providers = new Set<string>([
			...this.#host.storedProviders(),
			...listRegisteredUsageProviders().map(provider => provider.id),
		]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			const providerImpl = this.#providerResolver(provider);
			if (!providerImpl) continue;
			// The base URL resolver builds the provider's model list, so it is read only once a request is
			// built, never for a registered usage provider that holds no credential.
			const entries = this.#host.dedupedStoredCredentials(providerId);

			if (entries.length === 0) {
				const runtimeKey = this.#host.runtimeApiKey(providerId);
				const envKey = getEnvApiKey(providerId);
				const apiKey = runtimeKey ?? envKey;
				if (!apiKey) continue;
				const request = buildUsageRequest(
					provider,
					{ type: "api_key", apiKey },
					options?.baseUrlResolver?.(provider),
				);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			const baseUrl = options?.baseUrlResolver?.(provider);
			for (const entry of entries) {
				const credential = entry.credential;
				const request =
					credential.type === "api_key"
						? buildUsageRequest(provider, { type: "api_key", apiKey: credential.key }, baseUrl)
						: buildUsageRequestForOauth(provider, credential, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
			}
		}

		return requests;
	}

	#dedupeReports(reports: UsageReport[]): UsageReport[] {
		const groups: UsageReport[][] = [];
		const idToGroup = new Map<string, number>();

		for (const report of reports) {
			const identifiers = getUsageReportIdentifiers(report);
			let groupIndex: number | undefined;
			for (const identifier of identifiers) {
				const existing = idToGroup.get(identifier);
				if (existing !== undefined) {
					groupIndex = existing;
					break;
				}
			}
			if (groupIndex === undefined) {
				groupIndex = groups.length;
				groups.push([]);
			}
			groups[groupIndex].push(report);
			for (const identifier of identifiers) {
				idToGroup.set(identifier, groupIndex);
			}
		}

		const deduped = groups.map(group => mergeUsageReportGroup(group));
		if (deduped.length !== reports.length) {
			this.#logger.debug("Usage reports deduped", {
				before: reports.length,
				after: deduped.length,
			});
		}
		return deduped;
	}

	/** The usage report for one credential, through the store hook or the cached provider fetch. */
	async reportFor(
		provider: Provider,
		credential: AuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		// Store-level hook (e.g. `RemoteAuthCredentialStore`) is authoritative
		// when present for OAuth: the broker already aggregates usage from a
		// less-throttled IP, and falling back to the local per-credential fetch
		// would defeat the point of routing through it. API-key credentials do
		// not have a broker per-credential hook, so they use the normal cached
		// provider fetch path.
		if (credential.type === "oauth") {
			const storeHook = this.#store.getUsageReport?.bind(this.#store);
			if (storeHook) {
				const report = await withAuthHttpConcurrency(() => storeHook(provider, credential, options?.signal));
				if (report) {
					this.#host.reconcileCodexUsageBlock(
						buildUsageRequestForOauth(provider, credential, options?.baseUrl),
						report,
					);
				}
				return report;
			}
		}
		const usageCredential = buildUsageCredential(credential);
		if (credential.type === "api_key") {
			const resolvedApiKey = await this.#host.resolveConfigValue(credential.key);
			if (!resolvedApiKey) return null;
			usageCredential.apiKey = resolvedApiKey;
		}
		return this.#fetchCached(
			buildUsageRequest(provider, usageCredential, options?.baseUrl),
			options?.timeoutMs ?? this.requestTimeoutMs,
		);
	}

	/** See {@link AuthStorage.fetchUsageReports}. */
	async fetchReports(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
		signal?: AbortSignal;
	}): Promise<UsageReport[] | null> {
		// Caller override > store-level hook > local per-credential fan-out.
		// `RemoteAuthCredentialStore` implements the store hook so a gateway
		// backed by a broker automatically routes usage to the broker without
		// needing the caller to wire it explicitly.
		const storeOverride = this.#store.fetchUsageReports?.bind(this.#store);
		const override = this.#fetchReportsOverride ?? storeOverride;
		const shouldReconcileStoreHookReports = this.#fetchReportsOverride === undefined && storeOverride !== undefined;
		if (override) {
			// Reuse the in-flight map so concurrent callers (widget poll + format
			// dispatch + credential selection) coalesce into one upstream call.
			// Each caller's `signal` only cancels THAT caller's await; the
			// shared upstream fetch runs to completion so peers aren't punished.
			let shared = this.#reportsInFlight.get(OVERRIDE_KEY);
			if (!shared) {
				// Don't forward the caller signal into the shared fetch — first caller's
				// abort would otherwise cancel the upstream for every peer.
				shared = withAuthHttpConcurrency(override).finally(() => {
					this.#reportsInFlight.delete(OVERRIDE_KEY);
				});
				this.#reportsInFlight.set(OVERRIDE_KEY, shared);
			}
			const reports = await raceWithSignal(shared, options?.signal, "usage fetch aborted");
			if (shouldReconcileStoreHookReports && reports) this.#host.reconcileCodexUsageBlocksFromReports(reports);
			return reports;
		}

		const requests = this.#collectRequests(options);
		if (requests.length === 0) return [];

		this.#logger.debug("Usage fetch requested", {
			providers: [...new Set(requests.map(request => request.provider))].sort(),
		});

		// Per-credential caching with jitter lives in #fetchCached, so we
		// don't store the aggregated result here — doing so locks the widget to
		// a single decorrelation snapshot for 30s, defeating the jitter (some
		// accounts can be missing from one fetch and present in the next; the
		// aggregate cache freezes whichever set landed first).
		const cacheKey = buildUsageReportsCacheKey(requests);

		const inFlight = this.#reportsInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const promise = (async () => {
			for (const request of requests) {
				this.#logger.debug("Usage fetch queued", {
					provider: request.provider,
					credentialType: request.credential.type,
					baseUrl: request.baseUrl,
					accountId: request.credential.accountId,
					email: request.credential.email,
				});
			}

			const results = await Promise.all(requests.map(request => this.#fetchCached(request, this.requestTimeoutMs)));
			const reports = results.filter((report): report is UsageReport => report !== null);
			const deduped = this.#dedupeReports(reports);
			this.#logger.debug("Usage fetch resolved", {
				reports: deduped.map(report => {
					const accountLabel =
						getUsageReportMetadataValue(report, "email") ??
						getUsageReportMetadataValue(report, "accountId") ??
						getUsageReportMetadataValue(report, "account") ??
						getUsageReportMetadataValue(report, "user") ??
						getUsageReportMetadataValue(report, "username") ??
						getUsageReportScopeAccountId(report);
					return {
						provider: report.provider,
						limits: report.limits.length,
						account: accountLabel,
					};
				}),
			});
			return deduped;
		})().finally(() => {
			this.#reportsInFlight.delete(cacheKey);
		});

		this.#reportsInFlight.set(cacheKey, promise);
		return promise;
	}

	/** See {@link AuthStorage.checkCredentials}. */
	async checkCredentials(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		options?.signal?.throwIfAborted();
		const active = this.#store.listAuthCredentials();
		// Filtered here rather than by the caller, so the per-row deadline, the refresh-on-expiry and
		// the sequential pacing below all apply unchanged to a one-row probe.
		const wanted = options?.credentialIds;
		const stored = wanted === undefined ? active : active.filter(row => wanted.includes(row.id));
		const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
		const completionProbe = options?.completionProbe;
		const completionTimeoutMs = options?.completionTimeoutMs ?? timeoutMs;
		const ctx = this.fetchContext();

		const results: CredentialHealthResult[] = [];
		for (const row of stored) {
			options?.signal?.throwIfAborted();
			const base: CredentialHealthResult = {
				id: row.id,
				provider: row.provider,
				type: row.credential.type,
				ok: null,
			};
			if (row.credential.type === "oauth") {
				if (row.credential.email) base.email = row.credential.email;
				if (row.credential.accountId) base.accountId = row.credential.accountId;
				if (row.credential.orgId) base.orgId = row.credential.orgId;
				if (row.credential.orgName) base.orgName = row.credential.orgName;
				if (row.credential.refresh === REMOTE_REFRESH_SENTINEL) base.remoteRefresh = true;
			}

			const baseUrl = options?.baseUrlResolver?.(row.provider as Provider);
			const cred = row.credential;
			const initialRequest: UsageRequestDescriptor =
				cred.type === "api_key"
					? buildUsageRequest(row.provider as Provider, { type: "api_key", apiKey: cred.key }, baseUrl)
					: buildUsageRequestForOauth(row.provider as Provider, cred, baseUrl);

			// Scoped per-row deadline: cancelled at both loop exits below so the
			// backing timer never outlives the row's probes (a bare
			// AbortSignal.timeout stays armed for the full timeout). Every await
			// in between is individually try/caught, so the exits are exhaustive.
			const probeTimeout = scopedTimeoutSignal(timeoutMs, options?.signal);
			const probeSignal = probeTimeout.signal;
			let params: UsageFetchParams & { signal: AbortSignal } = {
				...initialRequest,
				accountKey: buildUsageCacheIdentity(initialRequest.credential),
				signal: probeSignal,
			};
			let refreshFailure: { reason: string; definitive: boolean } | undefined;

			// Refresh expired OAuth before probing — without this an expired access
			// token reports as `false` when the credential is actually healthy
			// (broker would happily refresh it on the next real request). The
			// refreshed bytes feed BOTH the usage probe and the optional
			// completion probe; we do it up-front so it runs even when no
			// `UsageProvider` is registered for this provider.
			if (
				cred.type === "oauth" &&
				initialRequest.credential.type === "oauth" &&
				initialRequest.credential.expiresAt !== undefined &&
				Date.now() >= initialRequest.credential.expiresAt
			) {
				const refreshable = buildRefreshableOauthCredential(initialRequest.credential);
				if (refreshable) {
					try {
						const refreshed = await this.#host.refreshOAuthCredential(
							row.provider as Provider,
							refreshable,
							row.id,
							probeSignal,
						);
						const refreshedCredential = mergeRefreshedUsageCredential(initialRequest.credential, refreshed);
						this.#host.persistRefreshedUsageCredential(
							row.provider as Provider,
							initialRequest.credential,
							refreshedCredential,
							row.id,
						);
						params = {
							...params,
							credential: refreshedCredential,
							accountKey: buildUsageCacheIdentity(refreshedCredential),
						};
					} catch (error) {
						const message = errorMessage(error);
						refreshFailure = AIError.isDefinitiveOAuthFailure(message)
							? { reason: `oauth refresh failed: ${message}`, definitive: true }
							: {
									reason: `access token refresh did not complete: ${message}; the next request retries it`,
									definitive: false,
								};
					}
				}
			}

			if (refreshFailure) {
				probeTimeout.cancel();
				base.reason = refreshFailure.reason;
				if (refreshFailure.definitive) {
					base.ok = false;
					// The provider refused this grant, and that is the same verdict the request path records
					// when a turn dies on one. The mark belongs here too, because a probe is how a surface
					// learns of the refusal BEFORE any request is sent: without it the account card could
					// label a revoked grant as what serves next on the very row that printed the refusal,
					// and the session's first request was then guaranteed to fail on an account the product
					// had already been told about.
					this.#host.markAuthDead(row.id);
				}
				// A refresh that timed out, hit the network, or met a provider outage says nothing about
				// the grant, so the row stays `ok: null` and keeps serving: marking it dead would move a
				// session off a working login because the probe's own deadline elapsed. Either way the
				// access token is expired, so both probes are skipped; they would only re-surface the
				// same failure.
				results.push(base);
				continue;
			}

			const providerImpl = this.providerFor(row.provider as Provider);
			if (!providerImpl) {
				base.reason = `no usage probe configured for provider ${row.provider}`;
			} else if (providerImpl.supports && !providerImpl.supports(initialRequest)) {
				base.reason = `usage probe does not support ${cred.type} credentials for ${row.provider}`;
			} else if (providerImpl.validatesCredentials === false) {
				base.reason = `usage probe for ${row.provider} does not validate credentials`;
			} else {
				try {
					const report = await providerImpl.fetchUsage(params, ctx);
					if (report === null) {
						base.reason = "usage probe returned no data for this credential";
					} else {
						base.ok = true;
						const accountId = getUsageReportMetadataValue(report, "accountId");
						const email = getUsageReportMetadataValue(report, "email");
						if (accountId) base.accountId = accountId;
						if (email) base.email = email;
						const { raw: _raw, ...trimmed } = report;
						base.report = trimmed;
					}
				} catch (error) {
					base.ok = false;
					base.reason = errorMessage(error);
				}
			}
			probeTimeout.cancel();

			if (completionProbe) {
				const probeCred = buildCompletionProbeCredential(params.credential);
				if (!probeCred) {
					base.completion = {
						ok: null,
						reason: `no bearer bytes available for ${row.credential.type} credential`,
					};
				} else {
					const completionTimeout = scopedTimeoutSignal(completionTimeoutMs, options?.signal);
					try {
						base.completion = await completionProbe({
							provider: row.provider as Provider,
							credentialId: row.id,
							credential: probeCred,
							signal: completionTimeout.signal,
						});
					} catch (error) {
						base.completion = {
							ok: false,
							reason: errorMessage(error),
						};
					} finally {
						completionTimeout.cancel();
					}
				}
			}

			results.push(base);
		}

		return results;
	}

	/**
	 * Force the next usage fetch for `provider` to bypass the 5-min cache, so
	 * `/usage` reflects a freshly-redeemed reset instead of stale numbers.
	 */
	invalidateProvider(provider: string, baseUrl?: string): void {
		this.#cacheEpoch += 1;
		const expired = Date.now() - 1;
		for (const entry of this.#host.storedCredentials(provider)) {
			if (entry.credential.type !== "oauth") continue;
			this.#expire(
				buildUsageReportCacheKey(buildUsageRequestForOauth(provider, entry.credential, baseUrl)),
				expired,
			);
		}
	}

	/** {@link invalidateProvider} for a `provider:<type>` block key; only OAuth keys hold cached reports. */
	invalidateProviderKey(providerKey: string): void {
		const oauthSuffix = ":oauth";
		if (!providerKey.endsWith(oauthSuffix)) return;
		this.invalidateProvider(providerKey.slice(0, -oauthSuffix.length));
	}

	/** See {@link AuthStorage.invalidateUsageCache}. */
	async invalidate(provider?: string, signal?: AbortSignal): Promise<void> {
		if (provider) {
			this.invalidateProvider(provider);
		} else {
			this.#cacheEpoch += 1;
			const expired = Date.now() - 1;
			try {
				for (const entry of this.#store.listAuthCredentials()) {
					if (entry.credential.type !== "oauth") continue;
					this.#expire(
						buildUsageReportCacheKey(buildUsageRequestForOauth(entry.provider, entry.credential)),
						expired,
					);
				}
			} catch (err) {
				logger.debug("Failed to list auth credentials for complete usage cache invalidation", { err });
			}
		}

		if (this.#store.invalidateUsageCache) {
			await this.#store.invalidateUsageCache(signal).catch(err => {
				logger.debug("Failed to notify store of stale usage", { err });
			});
		}
	}

	/** Expire one cached report while keeping its value as the last-good fallback. */
	#expire(cacheKey: string, expiresAt: number): void {
		const existing = this.#cache.getStale<UsageReport | null>(cacheKey);
		this.#cache.set(cacheKey, { value: existing?.value ?? null, expiresAt });
	}
}
