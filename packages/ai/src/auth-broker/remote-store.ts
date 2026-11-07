/**
 * Client-side {@link AuthCredentialStore} that mirrors a remote broker's
 * snapshot. Refresh tokens never leave the broker; mutating methods (`replace*`,
 * `upsert*`, `delete*ForProvider`) throw because login flows are server-side.
 *
 * Cache (`getCache`/`setCache`/`cleanExpiredCache`) is in-memory and ephemeral —
 * usage reports cache TTL is 5 minutes per credential, so durability across
 * runs isn't required.
 */
import { scheduler } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { exponentialBackoffDelay } from "@veyyon/utils/backoff";
import * as logger from "@veyyon/utils/logger";
import {
	type AuthCredential,
	type AuthCredentialSnapshotEntry,
	type AuthCredentialStore,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type StoredAuthCredential,
	type StoredCredentialBlock,
} from "../auth-storage";
import { isRecordFromFutureClock } from "../credential-clock";
import * as AIError from "../error";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type { UsageReport } from "../usage";
import { raceWithSignal } from "../utils/abort";
import type { AuthBrokerClient } from "./client";
import type {
	CredentialBlockSnapshot,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEvent,
} from "./types";

/**
 * Client-side TTL for the aggregate `/v1/usage` response. The broker dedups
 * upstream `/usage` hits via AuthStorage's 5-minute per-credential cache plus
 * single-flight, so this short client TTL mainly folds the parallel fan-out
 * from `CredentialRanking.rankOAuthSelections` into a single round-trip — a ranking pass issues
 * one broker call instead of N.
 */
const USAGE_CACHE_TTL_MS = 15_000;
const CREDENTIAL_BLOCK_RECONCILE_DELAY_MS = 5 * 60_000;
const MAX_FAILED_BLOCK_RECONCILE_ATTEMPTS = 3;
const WAIT_THRESHOLD_MS = 1_000;
const MAX_WAIT_MS = 5_000;
const BACKGROUND_WAIT_MS = 30_000;
// Reconcile an idle but still-open SSE transport against the canonical broker.
const SNAPSHOT_STREAM_IDLE_VERIFY_MS = 60_000;
const BACKGROUND_BACKOFF = { baseMs: 500, maxMs: 30_000, jitter: 0 };

function compareCredentialBlockSnapshots(a: CredentialBlockSnapshot, b: CredentialBlockSnapshot): number {
	const provider = a.providerKey.localeCompare(b.providerKey);
	if (provider !== 0) return provider;
	const scope = a.blockScope.localeCompare(b.blockScope);
	if (scope !== 0) return scope;
	const blockedUntil = a.blockedUntilMs - b.blockedUntilMs;
	if (blockedUntil !== 0) return blockedUntil;
	return (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0);
}

function toCredentialBlockSnapshot(block: StoredCredentialBlock): CredentialBlockSnapshot {
	return {
		providerKey: block.providerKey,
		blockScope: block.blockScope,
		blockedUntilMs: block.blockedUntilMs,
		...(block.updatedAtMs !== undefined ? { updatedAtMs: block.updatedAtMs } : {}),
	};
}

function credentialBlockSnapshotsEqual(
	left: readonly CredentialBlockSnapshot[] | undefined,
	right: readonly CredentialBlockSnapshot[] | undefined,
): boolean {
	const leftBlocks = left ?? [];
	const rightBlocks = right ?? [];
	if (leftBlocks.length !== rightBlocks.length) return false;
	for (let index = 0; index < leftBlocks.length; index += 1) {
		const leftBlock = leftBlocks[index]!;
		const rightBlock = rightBlocks[index]!;
		if (
			leftBlock.providerKey !== rightBlock.providerKey ||
			leftBlock.blockScope !== rightBlock.blockScope ||
			leftBlock.blockedUntilMs !== rightBlock.blockedUntilMs ||
			leftBlock.updatedAtMs !== rightBlock.updatedAtMs
		) {
			return false;
		}
	}
	return true;
}

/**
 * Only durable broker state can reset the SSE idle reconciliation deadline.
 * These time-relative countdowns change on every server snapshot even with
 * identical generation, grants, safety blocks, and refresh policy. Keep their
 * original values in the stored snapshot; exclude them only from progress tests.
 */
function credentialSseProgressState(entry: SnapshotEntry): SnapshotEntry {
	return { ...entry, rotatesInMs: null };
}

function refresherSseProgressState(schedule: RefresherSchedule): RefresherSchedule {
	return { ...schedule, nextSweepInMs: 0 };
}

function snapshotBlocksChanged(previous: readonly SnapshotEntry[], next: readonly SnapshotEntry[]): boolean {
	const previousBlocksById = new Map<number, readonly CredentialBlockSnapshot[] | undefined>();
	for (const entry of previous) previousBlocksById.set(entry.id, entry.blocks);
	for (const entry of next) {
		const previousBlocks = previousBlocksById.get(entry.id);
		if (!credentialBlockSnapshotsEqual(previousBlocks, entry.blocks)) return true;
		previousBlocksById.delete(entry.id);
	}
	for (const previousBlocks of previousBlocksById.values()) {
		if (previousBlocks && previousBlocks.length > 0) return true;
	}
	return false;
}

/** Key of one credential block in the reconcile map: the credential id, provider key and block scope. */
function credentialBlockKey(credentialId: number, providerKey: string, blockScope: string): string {
	return `${credentialId}\0${providerKey}\0${blockScope}`;
}

/** Every block in `entries` by {@link credentialBlockKey}; a later block under one key replaces an earlier one. */
function credentialBlocksByKey(entries: readonly SnapshotEntry[]): Map<string, CredentialBlockSnapshot> {
	const blocks = new Map<string, CredentialBlockSnapshot>();
	for (const entry of entries) {
		for (const block of entry.blocks ?? []) {
			blocks.set(credentialBlockKey(entry.id, block.providerKey, block.blockScope), block);
		}
	}
	return blocks;
}

function credentialEntryWithBlocks(
	entry: AuthCredentialSnapshotEntry,
	blocks: readonly CredentialBlockSnapshot[] | undefined,
): SnapshotEntry {
	const incoming: SnapshotEntry = { ...entry, rotatesInMs: null };
	if (blocks && blocks.length > 0) incoming.blocks = blocks.slice().sort(compareCredentialBlockSnapshots);
	return incoming;
}

/**
 * Bind a broker refresh reply to the exact grant that requested it. A schema-valid OAuth
 * response for another row/provider, or one exposing a refresh token, is not usable by
 * this client. The broker remains the only writer/owner of the refresh credential.
 */
function assertBrokerOAuthRefresh(
	entry: AuthCredentialSnapshotEntry,
	credentialId: number,
	provider: string,
): asserts entry is AuthCredentialSnapshotEntry & { credential: OAuthCredential } {
	if (entry.id !== credentialId || entry.provider !== provider) {
		throw new AIError.AuthBrokerError(
			`Broker refresh identity mismatch for credential id=${credentialId} provider=${provider}`,
		);
	}
	if (entry.credential.type !== "oauth") {
		throw new AIError.AuthBrokerError(`Broker returned non-OAuth credential for id=${credentialId}`);
	}
	if (entry.credential.refresh !== REMOTE_REFRESH_SENTINEL) {
		throw new AIError.AuthBrokerError(`Broker returned unredacted OAuth refresh credential for id=${credentialId}`);
	}
}

/**
 * Refuse an unrelated grant before broker-side refresh and a revoked grant after reply.
 * The broker alone rotates refresh credentials; this is a client identity fence.
 */
function requireLocalOAuthRefresh(snapshot: SnapshotResponse, credentialId: number, provider?: string): SnapshotEntry & { credential: OAuthCredential } {
	const current = snapshot.credentials.find(candidate => candidate.id === credentialId);
	if (
		!current ||
		(provider !== undefined && current.provider !== provider) ||
		current.credential.type !== "oauth" ||
		current.credential.refresh !== REMOTE_REFRESH_SENTINEL
	) {
		throw new AIError.AuthBrokerError(`Broker refresh refused unknown or mismatched OAuth credential id=${credentialId}`);
	}
	return current as SnapshotEntry & { credential: OAuthCredential };
}

function emptySnapshot(): SnapshotResponse {
	return {
		generation: 0,
		generatedAt: 0,
		serverNowMs: 0,
		refresher: {
			enabled: false,
			intervalMs: 0,
			skewMs: 0,
			nextSweepInMs: Number.MAX_SAFE_INTEGER,
		},
		credentials: [],
	};
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface UsageCacheEntry {
	/**
	 * `null` means the last aggregate `/v1/usage` fetch failed. Callers treat
	 * this the same as a successful empty-report response ("no usage signal
	 * for this cycle"), and the same 15s TTL applies so transient broker
	 * outages don't turn every ranking pass into a broker retry storm.
	 */
	reports: UsageReport[] | null;
	fetchedAt: number;
}

function usageOverlayKey(
	provider: Provider,
	ids: { accountId?: string; email?: string; projectId?: string; orgId?: string },
): string | undefined {
	// Org first: one account email can hold several organizations (Anthropic
	// Team seat + personal Max), each with its own limit pools. Keying the
	// overlay by account/email would merge the two pools' header ingests.
	// But the org alone is not enough either: two Team members share the org
	// id while drawing on per-user pools, so the key stays qualified by the
	// member's own base identity whenever one is known.
	let base: string | undefined;
	const accountId = ids.accountId?.trim().toLowerCase();
	const email = ids.email?.trim().toLowerCase();
	const projectId = ids.projectId?.trim().toLowerCase();
	if (accountId) base = `account:${accountId}`;
	else if (email) base = `email:${email}`;
	else if (projectId) base = `project:${projectId}`;
	const orgId = ids.orgId?.trim().toLowerCase();
	if (orgId) return base ? `${provider}\0org:${orgId}|${base}` : `${provider}\0org:${orgId}`;
	if (base) return `${provider}\0${base}`;
	return undefined;
}

function mergeUsageReports(base: UsageReport, overlay: UsageReport): UsageReport {
	const overlayLimitsById = new Map(overlay.limits.map(limit => [limit.id, limit]));
	const limits = [];
	for (const limit of base.limits) {
		const replacement = overlayLimitsById.get(limit.id);
		if (replacement) {
			limits.push(replacement);
			overlayLimitsById.delete(limit.id);
		} else {
			limits.push(limit);
		}
	}
	for (const limit of overlayLimitsById.values()) limits.push(limit);
	const overlayMetadata = (overlay.metadata ?? {}) as Record<string, unknown>;
	return {
		...base,
		fetchedAt: Math.max(base.fetchedAt, overlay.fetchedAt),
		limits,
		metadata: {
			...overlayMetadata,
			...(base.metadata ?? {}),
			...(overlayMetadata.headersUpdatedAt !== undefined
				? { headersUpdatedAt: overlayMetadata.headersUpdatedAt }
				: {}),
		},
	};
}

export interface RemoteAuthCredentialStoreOptions {
	client: AuthBrokerClient;
	/**
	 * Initial snapshot. When omitted, callers must call
	 * {@link RemoteAuthCredentialStore.refreshSnapshot} before the first read.
	 */
	initialSnapshot?: SnapshotResponse;
	/**
	 * Subscribe to the broker's SSE snapshot stream when available. Falls back
	 * to long-poll permanently when the broker returns 404. Default `true`.
	 */
	streamSnapshots?: boolean;
	/** Internal synthetic-test seam; production verifies idle SSE once per minute. */
	snapshotStreamVerifyIntervalMs?: number;
	/**
	 * Called after broker-sourced full snapshots are applied. The constructor's
	 * initial snapshot intentionally does not trigger this hook.
	 */
	onSnapshot?: (snapshot: SnapshotResponse, generation: number) => void;
}

export class RemoteAuthCredentialStore implements AuthCredentialStore {
	readonly #client: AuthBrokerClient;
	readonly #streamSnapshots: boolean;
	readonly #snapshotStreamVerifyIntervalMs: number;
	readonly #onSnapshot?: (snapshot: SnapshotResponse, generation: number) => void;
	#snapshot: SnapshotResponse = emptySnapshot();
	/** Wall time remains necessary for broker-provided rotatesInMs deadlines. */
	#snapshotReceivedAt = Date.now();
	/** Inactivity is elapsed time and must survive backward system-clock steps. */
	#snapshotReceivedMonotonicAt = performance.now();
	#generation = 0;
	/** Monotonic revision of accepted broker state AND local edits; fences stale GETs across restarts and disables. */
	#appliedSnapshotRevision = 0;
	/**
	 * Broker-confirmed revocations outrank SSE from an existing transport even
	 * when a stale relay advertises a numerically higher generation from an old
	 * broker incarnation. Only a later canonical GET may reauthorize the ID.
	 */
	#canonicallyRemovedCredentialIds = new Set<number>();
	/** Canonical credential roster or material changes must retire the prior SSE connection. */
	#activeSnapshotStreamAbort?: AbortController;
	#usageOverlays: Map<string, UsageReport> = new Map();
	#backgroundAbort = new AbortController();
	#cache: Map<string, CacheEntry> = new Map();
	#usageCache?: UsageCacheEntry;
	#usageInflight?: Promise<UsageReport[] | null>;
	#credentialBlockReconcileAfter: Map<string, number> = new Map();
	#pendingCredentialBlockMutations = new Map<number, Set<symbol>>();
	#credentialBlockReconciliationPending = new Set<number>();
	#credentialBlockReconciliationInFlight = false;
	/** Also fences GETs against non-speculative DELETE requests begun during the read. */
	#credentialBlockMutationEpoch = 0;
	#usageCacheEpoch = 0;
	#closed = false;
	/**
	 * `true` once the SSE consumer received its first frame and hasn't dropped
	 * since. Writes consult this to suppress the otherwise-mandatory
	 * `refreshSnapshot()` follow-up — the stream will deliver the new
	 * generation without an extra GET.
	 */
	#streamingActive = false;
	/** Latched once the broker has answered 404 — never try the stream again. */
	#streamingUnsupported = false;
	/** Stale-view causes already warned about, so each one is shouted exactly once. */
	#reportedStaleSnapshotCauses = new Set<string>();

	constructor(opts: RemoteAuthCredentialStoreOptions) {
		this.#client = opts.client;
		this.#streamSnapshots = opts.streamSnapshots ?? true;
		const intervalMs = opts.snapshotStreamVerifyIntervalMs ?? SNAPSHOT_STREAM_IDLE_VERIFY_MS;
		if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
			throw new RangeError("Auth broker idle snapshot verification interval must be a positive integer");
		}
		this.#snapshotStreamVerifyIntervalMs = intervalMs;
		this.#applySnapshot(opts.initialSnapshot ?? emptySnapshot(), opts.initialSnapshot?.generation ?? 0);
		this.#onSnapshot = opts.onSnapshot;
		void this.#runBackground();
	}

	get client(): AuthBrokerClient {
		return this.#client;
	}

	get snapshot(): SnapshotResponse {
		return this.#snapshot;
	}

	#applySnapshot(snapshot: SnapshotResponse, generation: number, protectNewBlocks = true): void {
		const nowMs = Date.now();
		const previousCredentials = this.#snapshot.credentials;
		const previousById = new Map<number, SnapshotEntry>(previousCredentials.map(entry => [entry.id, entry] as const));
		const credentials = snapshot.credentials.map(entry =>
			this.#retainPendingCredentialBlocks(normalizeSnapshotEntryBlocks(entry, nowMs), previousById.get(entry.id)),
		);
		if (snapshotBlocksChanged(previousCredentials, credentials)) this.#invalidateUsageCache();
		if (protectNewBlocks) this.#protectNewSnapshotBlocks(previousCredentials, credentials, nowMs);
		this.#snapshot = { ...snapshot, credentials };
		this.#generation = generation;
		this.#appliedSnapshotRevision += 1;
		this.#snapshotReceivedAt = nowMs;
		this.#snapshotReceivedMonotonicAt = performance.now();
		const onSnapshot = this.#onSnapshot;
		if (!onSnapshot) return;
		try {
			onSnapshot(this.#snapshot, generation);
		} catch (error) {
			this.#reportStaleSnapshot("snapshot-callback", error, { generation });
		}
	}

	/**
	 * A broker restart may reset the numeric generation. Only the local applied-state
	 * revision can prove whether an in-flight GET predates newer client state.
	 */
	/**
	 * An incoming SSE/GET frame can describe broker state from before an in-flight
	 * block POST completed. Keep local speculative restrictions while accepting
	 * distinct broker-authoritative scopes (and the stricter deadline for a shared
	 * scope). Discarding all incoming blocks would temporarily unblock a peer's
	 * already-committed restriction while our own POST is still held.
	 * After all writes settle, reconcile against the canonical broker to retire
	 * any speculative block that was never accepted.
	 */
	#retainPendingCredentialBlocks(incoming: SnapshotEntry, previous: SnapshotEntry | undefined): SnapshotEntry {
		if (!previous || !this.#pendingCredentialBlockMutations.has(incoming.id)) return incoming;
		this.#credentialBlockReconciliationPending.add(incoming.id);
		const merged = new Map<string, CredentialBlockSnapshot>();
		for (const block of incoming.blocks ?? []) {
			merged.set(credentialBlockKey(incoming.id, block.providerKey, block.blockScope), block);
		}
		for (const block of previous.blocks ?? []) {
			const key = credentialBlockKey(incoming.id, block.providerKey, block.blockScope);
			const authoritative = merged.get(key);
			if (!authoritative || block.blockedUntilMs > authoritative.blockedUntilMs) {
				merged.set(key, block);
			}
		}
		const blocks = [...merged.values()].sort(compareCredentialBlockSnapshots);
		if (blocks.length > 0) return { ...incoming, blocks };
		const next: SnapshotEntry = { ...incoming };
		delete next.blocks;
		return next;
	}

	#applyFetchedSnapshot(snapshot: SnapshotResponse, generation: number, revisionAtRequest: number): boolean {
		if (revisionAtRequest !== this.#appliedSnapshotRevision) {
			logger.debug("auth-broker stale snapshot response ignored", {
				currentGeneration: this.#generation,
				responseGeneration: generation,
			});
			return false;
		}

		const incomingIds = new Set(snapshot.credentials.map(entry => entry.id));
		let canonicallyRemoved = false;
		for (const previous of this.#snapshot.credentials) {
			if (!incomingIds.has(previous.id)) {
				this.#canonicallyRemovedCredentialIds.add(previous.id);
				canonicallyRemoved = true;
			}
		}
		// A fresh canonical broker response, unlike an old SSE replay, can
		// legitimately reintroduce the same ID after a broker restart.
		const previousById = new Map(this.#snapshot.credentials.map(entry => [entry.id, entry] as const));
		const canonicallyAdded = snapshot.credentials.some(entry => !previousById.has(entry.id));
		const reauthorized = [...incomingIds].some(id => this.#canonicallyRemovedCredentialIds.has(id));
		const replaced = snapshot.credentials.some(entry => {
			const previous = previousById.get(entry.id);
			return previous !== undefined && (
				previous.provider !== entry.provider || !isDeepStrictEqual(previous.credential, entry.credential)
			);
		});
		for (const id of incomingIds) this.#canonicallyRemovedCredentialIds.delete(id);
		this.#applySnapshot(snapshot, generation);
		// The existing SSE connection cannot prove broker incarnation: after
		// canonical roster additions/removals it might remove a newly added ID
		// or a *surviving* ID
		// under a reused or higher old-stream generation. Retire that stream,
		// just as for reauthorization or credential replacement. Unchanged
		// GETs, countdown churn and safety-block-only changes keep their stream.
		if (canonicallyRemoved || canonicallyAdded || reauthorized || replaced) this.#activeSnapshotStreamAbort?.abort();
		return true;
	}

	#isCanonicallyRemovedFromStream(id: number): boolean {
		return this.#canonicallyRemovedCredentialIds.has(id);
	}

	/**
	 * Hold every block that is new or changed against `previous` for reconciliation, and drop the
	 * reconcile deadline of every block `next` no longer carries.
	 */
	#protectNewSnapshotBlocks(previous: readonly SnapshotEntry[], next: readonly SnapshotEntry[], nowMs: number): void {
		const previousBlocks = credentialBlocksByKey(previous);
		const activeKeys = new Set<string>();
		for (const entry of next) {
			for (const block of entry.blocks ?? []) {
				const key = credentialBlockKey(entry.id, block.providerKey, block.blockScope);
				activeKeys.add(key);
				const before = previousBlocks.get(key);
				if (before?.blockedUntilMs === block.blockedUntilMs && before.updatedAtMs === block.updatedAtMs) continue;
				const updatedAtMs = block.updatedAtMs ?? nowMs;
				this.#credentialBlockReconcileAfter.set(
					key,
					Math.min(block.blockedUntilMs, updatedAtMs + CREDENTIAL_BLOCK_RECONCILE_DELAY_MS),
				);
			}
		}
		for (const key of this.#credentialBlockReconcileAfter.keys()) {
			if (!activeKeys.has(key)) this.#credentialBlockReconcileAfter.delete(key);
		}
	}

	async #runBackground(): Promise<void> {
		let failures = 0;
		while (!this.#closed && !this.#backgroundAbort.signal.aborted) {
			const streaming = this.#streamSnapshots && !this.#streamingUnsupported;
			try {
				await (streaming ? this.#consumeSnapshotStream() : this.#pollSnapshot());
				failures = 0;
			} catch (error) {
				if (this.#closed || this.#backgroundAbort.signal.aborted) break;
				if (await this.#backOffAfter(error, streaming, failures)) failures += 1;
			}
		}
	}

	/**
	 * A snapshot is not durable broker progress when its effective credential
	 * state and refresh policy have not changed. A stale SSE relay can advertise
	 * increasing generations as well as changing timestamps. The broker recomputes
	 * timestamps and countdowns on every response; those cannot postpone an
	 * authoritative reconciliation. Preserve pending local safety blocks while
	 * comparing broker frames, just as for SSE, without changing wire values.
	 */
	#isNoProgressSnapshot(snapshot: SnapshotResponse, ignoreGeneration = false): boolean {
		if (!ignoreGeneration && snapshot.generation !== this.#generation) return false;
		const previousById = new Map(this.#snapshot.credentials.map(entry => [entry.id, entry] as const));
		return (
			isDeepStrictEqual(
				snapshot.credentials
					.map(entry =>
						credentialSseProgressState(this.#retainPendingCredentialBlocks(
							normalizeSnapshotEntryBlocks(entry, Date.now()), previousById.get(entry.id),
						)),
					)
					.sort((a, b) => a.id - b.id),
				this.#snapshot.credentials.map(credentialSseProgressState).sort((a, b) => a.id - b.id),
			) &&
			isDeepStrictEqual(
				refresherSseProgressState(snapshot.refresher),
				refresherSseProgressState(this.#snapshot.refresher),
			)
		);
	}

	async #pollSnapshot(): Promise<void> {
		const generationAtRequest = this.#generation;
		const revisionAtRequest = this.#appliedSnapshotRevision;
		// Broker generations are process-local: after a restart, a changed
		// credential set can reuse our last numeric generation. Conditional
		// polls would then return 304 forever. Reuse the idle verifier's
		// monotonic deadline to periodically fetch canonical broker truth,
		// while preserving ordinary 30s conditional long-polls between checks.
		const pollStartedAt = performance.now();
		const needsCanonicalVerification =
			pollStartedAt - this.#snapshotReceivedMonotonicAt >= this.#snapshotStreamVerifyIntervalMs;
		const result = await this.#client.fetchSnapshot(
			needsCanonicalVerification
				? { signal: this.#backgroundAbort.signal }
				: {
						ifGenerationGt: generationAtRequest,
						waitMs: BACKGROUND_WAIT_MS,
						signal: this.#backgroundAbort.signal,
					},
		);
		if (result.status === 200) {
			// A conditional 200 with no durable progress is no fresher than a 304:
			// a broken relay may replay only different timestamps/countdowns forever.
			// Unconditional canonical GETs are authoritative even at a reused generation.
			if (needsCanonicalVerification || !this.#isNoProgressSnapshot(result.snapshot)) {
				this.#applyFetchedSnapshot(result.snapshot, result.generation, revisionAtRequest);
				return;
			}
		} else if (needsCanonicalVerification) {
			// An unconditional read must return broker truth; a 304 cannot establish freshness.
			throw new AIError.AuthBrokerError("Unconditional broker snapshot verification returned no snapshot");
		}
		// A faulty proxy may return 304 or an unchanged 200 immediately instead
		// of holding the requested long-poll. Pace only the unused wait window,
		// capped by the monotonic canonical-GET deadline.
		const remainingPollMs = BACKGROUND_WAIT_MS - (performance.now() - pollStartedAt);
		const remainingVerifyMs =
			this.#snapshotStreamVerifyIntervalMs - (performance.now() - this.#snapshotReceivedMonotonicAt);
		const paceMs = Math.min(remainingPollMs, remainingVerifyMs);
		// Promise timers may truncate fractional milliseconds. Round UP to avoid
		// another conditional poll just before the canonical verification deadline.
		if (paceMs > 0) await scheduler.wait(Math.ceil(paceMs), { signal: this.#backgroundAbort.signal });
	}

	/**
	 * Record a failed background sync and sleep through its backoff. Returns `false` without
	 * sleeping when the broker has no snapshot stream: the stream is latched off and the loop moves
	 * to long-poll at once.
	 */
	async #backOffAfter(error: unknown, streaming: boolean, failures: number): Promise<boolean> {
		if (streaming && error instanceof AIError.AuthBrokerStreamUnsupportedError) {
			this.#streamingUnsupported = true;
			logger.debug("auth-broker snapshot stream unsupported; falling back to long-poll");
			return false;
		}
		const backoffMs = exponentialBackoffDelay(failures, BACKGROUND_BACKOFF);
		if (streaming) logger.debug("auth-broker snapshot stream failed; backing off", { error: String(error) });
		else this.#reportStaleSnapshot("background-sync", error, { backoffMs });
		// The sleep rejects for one reason: the background abort fired, meaning shutdown. The loop
		// re-checks `#closed` and the signal and exits, and the failure behind this backoff is recorded
		// above.
		await scheduler.wait(backoffMs, { signal: this.#backgroundAbort.signal }).catch(() => {});
		return true;
	}

	/**
	 * Heartbeat comments are filtered by the SSE parser, and a half-open proxy
	 * can hold a stream forever. An idle canonical GET bounds stale views while
	 * retaining the existing applied-revision fence and pending safety blocks.
	 */
	async #verifyIdleSnapshotStream(signal: AbortSignal): Promise<void> {
		while (!this.#closed && !signal.aborted) {
			try {
				await scheduler.wait(this.#snapshotStreamVerifyIntervalMs, { signal });
			} catch {
				return; // Stream closed or store shutdown; never leave an orphan timer.
			}
			if (this.#closed || signal.aborted) return;
			if (performance.now() - this.#snapshotReceivedMonotonicAt < this.#snapshotStreamVerifyIntervalMs) continue;
			const revisionAtRequest = this.#appliedSnapshotRevision;
			try {
				const result = await this.#client.fetchSnapshot({ signal });
				if (result.status === 200) {
					this.#applyFetchedSnapshot(result.snapshot, result.generation, revisionAtRequest);
				} else {
					this.#reportStaleSnapshot(
						"snapshot-stream-idle-verify",
						new AIError.AuthBrokerError("Unconditional broker snapshot verification returned no snapshot"),
					);
				}
			} catch (error) {
				if (!signal.aborted) this.#reportStaleSnapshot("snapshot-stream-idle-verify", error);
			}
		}
	}

	async #consumeSnapshotStream(): Promise<void> {
		const revisionAtConnect = this.#appliedSnapshotRevision;
		let firstFrame = true;
		// Generation is broker-incarnation-local. Bound ordering to this SSE connection,
		// separately from accepted-state freshness: ignored no-op frames must not
		// make an older, reordered credential mutation eligible later on this stream.
		let highestGenerationSeenOnStream: number | undefined;
		const streamAbort = new AbortController();
		const streamSignal = AbortSignal.any([this.#backgroundAbort.signal, streamAbort.signal]);
		this.#activeSnapshotStreamAbort = streamAbort;
		const iterator = this.#client.openSnapshotStream({ signal: streamSignal });
		const watchdogAbort = new AbortController();
		const watchdogSignal = AbortSignal.any([streamSignal, watchdogAbort.signal]);
		// Verify broker truth even when the SSE connection never yields its first
		// frame (for example a proxy holding the initial response body open).
		// The existing revision fence rejects a late superseded initial frame.
		const watchdog = this.#verifyIdleSnapshotStream(watchdogSignal);
		try {
			for await (const event of iterator) {
				if (this.#closed || streamSignal.aborted) break;
				// Even a higher-generation *unchanged* event establishes the order of
				// later frames on this transport, but must NOT renew the idle canonical
				// GET deadline or advance the accepted snapshot revision. A new SSE
				// connection gets a new watermark so broker generation resets still work.
				if (!firstFrame && highestGenerationSeenOnStream !== undefined &&
					event.generation < highestGenerationSeenOnStream) continue;
				if (highestGenerationSeenOnStream === undefined || event.generation > highestGenerationSeenOnStream) {
					highestGenerationSeenOnStream = event.generation;
				}
				if (firstFrame && event.kind === "snapshot") {
					// A reconnect starts with an authoritative full snapshot, even after
					// the broker resets its generation. A newer local GET during connect
					// instead supersedes that frame; reconnect rather than revert it.
					if (revisionAtConnect !== this.#appliedSnapshotRevision) {
						throw new AIError.AuthBrokerError("Auth broker stream initial snapshot superseded during connection");
					}
					const { kind: _kind, ...snapshot } = event;
					// A reconnect can itself be served by a stale relay. Do not
					// trust a lower-generation first frame that revives a grant
					// whose removal was verified by a newer canonical GET.
					if (snapshot.credentials.some(entry =>
						this.#isCanonicallyRemovedFromStream(entry.id)
					)) {
						throw new AIError.AuthBrokerError("Broker stream first frame conflicts with canonical revocation");
					}
					// A first frame cannot establish broker incarnation by itself.
					// If it differs from the accepted view OR numeric generation, only
					// a canonical GET may authorize that change. The old stream might
					// belong to a stale relay even when its generation is higher.
					if (snapshot.generation !== this.#generation || !this.#isNoProgressSnapshot(snapshot, true)) {
						const revisionAtVerification = this.#appliedSnapshotRevision;
						const canonical = await this.#client.fetchSnapshot({ signal: streamSignal });
						if (canonical.status !== 200) {
							throw new AIError.AuthBrokerError("Broker stream initial snapshot verification returned no snapshot");
						}
						if (!this.#applyFetchedSnapshot(canonical.snapshot, canonical.generation, revisionAtVerification)) {
							throw new AIError.AuthBrokerError("Broker stream initial snapshot superseded during verification");
						}
						// A canonical read can verify the selected view, not that future
						// events on this old transport share its authority. Reconnect
						// before accepting more SSE mutations from this stream.
						throw new AIError.AuthBrokerError("Broker stream initial snapshot requires canonical reconnection");
					}
					// Identical same-generation first frames are not fresh progress.
					this.#applyStreamEvent(event);
				} else {
					this.#applyStreamEvent(event);
				}
				firstFrame = false;
				this.#streamingActive = true;
			}
		} finally {
			this.#streamingActive = false;
			if (this.#activeSnapshotStreamAbort === streamAbort) this.#activeSnapshotStreamAbort = undefined;
			streamAbort.abort();
			watchdogAbort.abort();
			await watchdog;
		}
		if (!this.#closed && !this.#backgroundAbort.signal.aborted) {
			// A broken relay can complete 200-SSE responses before *any* frame.
			// Each reconnect cancels the per-stream watchdog before its first tick.
			// Probe canonical broker truth once the monotonic freshness deadline
			// has elapsed, then use the existing stream failure backoff rather than
			// hot-looping through more immediately completed connections.
			if (performance.now() - this.#snapshotReceivedMonotonicAt >= this.#snapshotStreamVerifyIntervalMs) {
				const revisionAtRequest = this.#appliedSnapshotRevision;
				const result = await this.#client.fetchSnapshot({ signal: this.#backgroundAbort.signal });
				if (result.status === 200) {
					this.#applyFetchedSnapshot(result.snapshot, result.generation, revisionAtRequest);
				} else {
					this.#reportStaleSnapshot(
						"snapshot-stream-early-eof",
						new AIError.AuthBrokerError("Unexpected broker snapshot verification response after SSE EOF"),
					);
				}
			}
			throw new AIError.AuthBrokerError("Auth broker snapshot stream ended unexpectedly");
		}
	}

	#applyStreamEvent(event: SnapshotStreamEvent): void {
		switch (event.kind) {
			case "snapshot": {
				// Strip the discriminator so we store the wire-shape SnapshotResponse.
				const { kind: _kind, ...snapshot } = event;
				if (snapshot.generation < this.#generation) {
					logger.debug("auth-broker stream snapshot older than local; ignoring", {
						local: this.#generation,
						incoming: snapshot.generation,
					});
					return;
				}
				// A stale full frame from an old stream must not put a
				// canonically revoked grant back into the local selection set.
				if (snapshot.credentials.some(entry =>
					this.#isCanonicallyRemovedFromStream(entry.id)
				)) return;
				// Replayed unchanged state is not progress, even when a stale relay
				// advertises increasing generations: accepting it repeatedly would
				// starve the canonical idle GET and invalidate
				// in-flight GETs through the applied-revision fence.
				// Compare the effective view: a locally pending safety block can be
				// absent from an unchanged broker frame without being fresh state.
				if (this.#isNoProgressSnapshot(snapshot, true)) return;
				this.#applySnapshot(snapshot, snapshot.generation);
				return;
			}
			case "entry": {
				if (event.generation < this.#generation) return;
				if (this.#isCanonicallyRemovedFromStream(event.entry.id)) return;
				const current = this.#snapshot.credentials.find(entry => entry.id === event.entry.id);
				const effectiveIncoming = this.#retainPendingCredentialBlocks(
					normalizeSnapshotEntryBlocks(event.entry, Date.now()), current,
				);
				if (
					current &&
					isDeepStrictEqual(credentialSseProgressState(current), credentialSseProgressState(effectiveIncoming)) &&
					isDeepStrictEqual(refresherSseProgressState(event.refresher), refresherSseProgressState(this.#snapshot.refresher))
				) return;
				this.#applyStreamEntry(event.entry, event.refresher, event.generation, event.serverNowMs);
				return;
			}
			case "removed": {
				if (event.generation < this.#generation) return;
				// Removing an already-absent ID does not change the accepted credential view.
				// In particular, a stale relay must not keep renewing the SSE freshness
				// deadline by inventing successively higher-generation phantom removals.
				if (!this.#snapshot.credentials.some(entry => entry.id === event.id)) return;
				this.#removeStreamCredential(event.id, event.refresher, event.generation, event.serverNowMs);
				return;
			}
		}
	}
	#applyStreamEntry(
		entry: SnapshotEntry,
		refresher: RefresherSchedule,
		generation: number,
		serverNowMs: number,
	): void {
		const normalized = normalizeSnapshotEntryBlocks(entry, Date.now());
		const index = this.#snapshot.credentials.findIndex(candidate => candidate.id === normalized.id);
		const incoming = this.#retainPendingCredentialBlocks(
			normalized,
			index === -1 ? undefined : this.#snapshot.credentials[index],
		);
		const previousBlocks = index === -1 ? undefined : this.#snapshot.credentials[index]?.blocks;
		const blocksChanged = !credentialBlockSnapshotsEqual(previousBlocks, incoming.blocks);
		if (blocksChanged) this.#invalidateUsageCache();
		const credentials =
			index === -1
				? this.#snapshot.credentials.concat([incoming])
				: this.#snapshot.credentials.map((candidate, i) => (i === index ? incoming : candidate));
		if (blocksChanged) this.#protectNewSnapshotBlocks(this.#snapshot.credentials, credentials, Date.now());
		this.#snapshot = { ...this.#snapshot, generation, serverNowMs, refresher, credentials };
		this.#generation = generation;
		this.#appliedSnapshotRevision += 1;
		this.#snapshotReceivedAt = Date.now();
		this.#snapshotReceivedMonotonicAt = performance.now();
	}

	#removeStreamCredential(id: number, refresher: RefresherSchedule, generation: number, serverNowMs: number): void {
		const removed = this.#snapshot.credentials.find(entry => entry.id === id);
		if (removed?.blocks && removed.blocks.length > 0) this.#invalidateUsageCache();
		const credentials = this.#snapshot.credentials.filter(entry => entry.id !== id);
		this.#snapshot = { ...this.#snapshot, generation, serverNowMs, refresher, credentials };
		this.#generation = generation;
		this.#appliedSnapshotRevision += 1;
		this.#snapshotReceivedAt = Date.now();
		this.#snapshotReceivedMonotonicAt = performance.now();
	}

	/** Re-hydrate the in-memory snapshot from the broker. */
	async refreshSnapshot(): Promise<SnapshotResponse> {
		const revisionAtRequest = this.#appliedSnapshotRevision;
		const result = await this.#client.fetchSnapshot();
		// An explicit unconditional refresh cannot establish broker truth from
		// a 304: returning a cached snapshot would misreport stale state as fresh.
		if (result.status !== 200) {
			throw new AIError.AuthBrokerError("Unconditional broker snapshot verification returned no snapshot");
		}
		this.#applyFetchedSnapshot(result.snapshot, result.generation, revisionAtRequest);
		return this.#snapshot;
	}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const out: StoredAuthCredential[] = [];
		for (const entry of this.#snapshot.credentials) {
			if (provider !== undefined && entry.provider !== provider) continue;
			out.push({
				id: entry.id,
				provider: entry.provider,
				credential: entry.credential as AuthCredential,
				disabledCause: null,
			});
		}
		return out;
	}

	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		const nowMs = Date.now();
		this.cleanExpiredCredentialBlocks(nowMs);
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (!entry?.blocks) return undefined;
		const block = entry.blocks.find(
			candidate => candidate.providerKey === providerKey && candidate.blockScope === blockScope,
		);
		if (!block || block.blockedUntilMs <= nowMs) return undefined;
		// The snapshot was produced by the broker host, which may be a different
		// machine or a process that started before the clock synced. A block
		// stamped ahead of this reader cannot be measured against this clock, so
		// it is dropped rather than held; see credential-clock.
		if (isRecordFromFutureClock(block.updatedAtMs, nowMs)) return undefined;
		return block.blockedUntilMs;
	}

	getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		if (this.getCredentialBlock(credentialId, providerKey, blockScope) === undefined) return undefined;
		return this.#credentialBlockReconcileAfter.get(credentialBlockKey(credentialId, providerKey, blockScope));
	}

	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		const nowMs = Date.now();
		this.cleanExpiredCredentialBlocks(nowMs);
		const ids = new Set(credentialIds);
		const blocks: StoredCredentialBlock[] = [];
		for (const entry of this.#snapshot.credentials) {
			if (!ids.has(entry.id) || !entry.blocks) continue;
			for (const block of entry.blocks) {
				if (block.blockedUntilMs <= nowMs) continue;
				if (isRecordFromFutureClock(block.updatedAtMs, nowMs)) continue;
				blocks.push({
					credentialId: entry.id,
					providerKey: block.providerKey,
					blockScope: block.blockScope,
					blockedUntilMs: block.blockedUntilMs,
					updatedAtMs: block.updatedAtMs,
				});
			}
		}
		blocks.sort((a, b) => a.credentialId - b.credentialId || compareCredentialBlockSnapshots(a, b));
		return blocks;
	}

	/**
	 * A broker GET represents the entire credential snapshot. Never apply it
	 * while any block POST/DELETE remains unsettled, even for another scope or
	 * credential: an uncommitted speculative block would disappear from the view.
	 */
	#startCredentialBlockMutation(id: number, mutation: symbol): void {
		let pending = this.#pendingCredentialBlockMutations.get(id);
		if (!pending) {
			pending = new Set<symbol>();
			this.#pendingCredentialBlockMutations.set(id, pending);
		}
		pending.add(mutation);
		this.#credentialBlockMutationEpoch += 1;
	}

	#settleCredentialBlockMutation(id: number, mutation: symbol, failed: boolean): void {
		// Even if a newer same-key block succeeds, an older failed speculative
		// deadline may be longer. Do not retire its failure until a canonical
		// broker snapshot has replaced every settled local projection.
		if (failed) this.#credentialBlockReconciliationPending.add(id);
		const pending = this.#pendingCredentialBlockMutations.get(id);
		pending?.delete(mutation);
		if (pending?.size === 0) {
			this.#pendingCredentialBlockMutations.delete(id);
		}
		if (this.#pendingCredentialBlockMutations.size > 0) return;
		if (this.#credentialBlockReconciliationPending.size > 0) {
			void this.#reconcileFailedCredentialBlockMutations();
		} else if (!failed) {
			this.#maybeRefreshSnapshot("credential block");
		}
	}

	/**
	 * A failed write emits no SSE frame. Once ALL speculative writes settle,
	 * reconcile their scopes from one authoritative broker snapshot. Retry if
	 * unrelated SSE, local edits or newer write starts supersede the GET.
	 */
	async #reconcileFailedCredentialBlockMutations(): Promise<void> {
		if (
			this.#credentialBlockReconciliationInFlight ||
			this.#pendingCredentialBlockMutations.size > 0 ||
			this.#credentialBlockReconciliationPending.size === 0
		) return;
		this.#credentialBlockReconciliationInFlight = true;
		// A newer write can settle while an earlier reconciliation GET is still
		// in flight, preventing its settlement from starting a fresh read.
		const epochAtStart = this.#credentialBlockMutationEpoch;
		const cause = "credential-block-mutation-reconcile";
		try {
			for (let attempt = 0; attempt < MAX_FAILED_BLOCK_RECONCILE_ATTEMPTS; attempt += 1) {
				if (this.#pendingCredentialBlockMutations.size > 0) return;
				const revisionAtRequest = this.#appliedSnapshotRevision;
				const mutationEpochAtRequest = this.#credentialBlockMutationEpoch;
				const result = await this.#client.fetchSnapshot();
				// Even a DELETE that makes no speculative edit must supersede
				// a GET started before that write was sent.
				if (this.#pendingCredentialBlockMutations.size > 0) return;
				if (mutationEpochAtRequest !== this.#credentialBlockMutationEpoch) continue;
				if (result.status === 200 && this.#applyFetchedSnapshot(result.snapshot, result.generation, revisionAtRequest)) {
					this.#credentialBlockReconciliationPending.clear();
					return;
				}
			}
			this.#reportStaleSnapshot(
				cause,
				new AIError.AuthBrokerError("Broker credential block reconciliation superseded repeatedly"),
				{ credentialIds: [...this.#credentialBlockReconciliationPending], attempts: MAX_FAILED_BLOCK_RECONCILE_ATTEMPTS },
			);
		} catch (error) {
			this.#reportStaleSnapshot(cause, error, { credentialIds: [...this.#credentialBlockReconciliationPending] });
		} finally {
			this.#credentialBlockReconciliationInFlight = false;
			// An overlapping write may have settled while the previous GET was
			// awaiting a response. If that GET failed, its caller cannot schedule
			// a replacement while the in-flight flag was set. Retry once for the
			// newer mutation epoch, but never spin on an unchanged broker outage.
			if (
				this.#credentialBlockMutationEpoch !== epochAtStart &&
				this.#pendingCredentialBlockMutations.size === 0 &&
				this.#credentialBlockReconciliationPending.size > 0
			) {
				void this.#reconcileFailedCredentialBlockMutations();
			}
		}
	}


	upsertCredentialBlock(block: StoredCredentialBlock): void {
		const mutation = Symbol("block-upsert");
		const key = credentialBlockKey(block.credentialId, block.providerKey, block.blockScope);
		this.#startCredentialBlockMutation(block.credentialId, mutation);
		this.#upsertSnapshotBlock(block);
		this.#invalidateUsageCache();
		this.#credentialBlockReconcileAfter.set(
			key,
			Math.min(block.blockedUntilMs, Date.now() + CREDENTIAL_BLOCK_RECONCILE_DELAY_MS),
		);
		const body = toCredentialBlockSnapshot(block);
		void this.#client
			.upsertCredentialBlock(block.credentialId, body)
			.then(response => {
				if (!response.ok) {
					throw new AIError.AuthBrokerError(`Broker refused credential block upsert id=${block.credentialId}`);
				}
				// Never fetch an older broker view while any speculative block is
				// still awaiting its own server acknowledgment.
				this.#settleCredentialBlockMutation(block.credentialId, mutation, false);
			})
			.catch(error => {
				logger.warn("auth-broker credential block propagation failed", {
					id: block.credentialId,
					providerKey: block.providerKey,
					blockScope: block.blockScope,
					error: String(error),
				});
				this.#settleCredentialBlockMutation(block.credentialId, mutation, true);
			});
	}


	deleteCredentialBlocks(credentialId: number): void {
		// A DELETE covers every block scope for this ID. Its success cannot
		// unblock a still-pending upsert or a newer accepted local block.
		const mutation = Symbol("block-delete");
		this.#startCredentialBlockMutation(credentialId, mutation);
		void this.#client
			.deleteCredentialBlocks(credentialId)
			.then(response => {
				if (!response.ok) {
					throw new AIError.AuthBrokerError(`Broker refused credential block deletion id=${credentialId}`);
				}
				// A successful DELETE acknowledges its own commit, not the absence
				// of newer peer safety blocks. With stalled SSE, the local mutation
				// epoch and applied revision cannot detect broker writes by a peer.
				// Retain the known restriction until the canonical broker GET is
				// applied; failed reads remain restrictive and report stale state.
				this.#credentialBlockReconciliationPending.add(credentialId);
				this.#settleCredentialBlockMutation(credentialId, mutation, false);
			})
			.catch(error => {
				logger.warn("auth-broker credential blocks delete propagation failed", {
					id: credentialId,
					error: String(error),
				});
				// The broker may have committed before its reply was lost.
				this.#settleCredentialBlockMutation(credentialId, mutation, true);
			});
	}

	cleanExpiredCredentialBlocks(nowMs: number): void {
		this.#pruneExpiredCredentialBlocks(nowMs);
		for (const [key, reconcileAfterMs] of this.#credentialBlockReconcileAfter) {
			if (reconcileAfterMs <= nowMs) this.#credentialBlockReconcileAfter.delete(key);
		}
	}

	/**
	 * In-memory update from a successful refresh through the broker. AuthStorage
	 * calls this after `#replaceCredentialAt`; the broker already persisted the
	 * authoritative row, so we just mirror it.
	 */
	updateAuthCredential(id: number, credential: AuthCredential): void {
		for (const entry of this.#snapshot.credentials) {
			if (entry.id !== id) continue;
			const credentialStateChanged = !isDeepStrictEqual(entry.credential, credential);
			entry.credential = credential as typeof entry.credential;
			this.#appliedSnapshotRevision += 1;
			// AuthStorage calls this after a broker refresh; its acknowledgment
			// outranks old SSE frames without transferring refresh ownership.
			if (credentialStateChanged) this.#activeSnapshotStreamAbort?.abort();
			return;
		}
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		if (!this.#snapshot.credentials.some(entry => entry.id === id)) return;
		const revisionAtDisable = this.#appliedSnapshotRevision;
		// The legacy synchronous API cannot confirm a remote disable. Retain the grant
		// until the broker acknowledges it; stale replies must not erase newer state.
		void this.#disableCredentialConfirmed(id, disabledCause)
			.then(() => {
				if (revisionAtDisable === this.#appliedSnapshotRevision) this.#removeCredentialById(id);
				this.#maybeRefreshSnapshot("delete credential");
			})
			.catch(error => {
				logger.warn("auth-broker disable propagation failed", { id, error: String(error) });
			});
	}

	/** A 2xx response is not revocation confirmation unless the broker reports ok:true. */
	async #disableCredentialConfirmed(id: number, disabledCause: string): Promise<void> {
		const response = await this.#client.disableCredential(id, disabledCause);
		if (!response.ok) {
			throw new AIError.AuthBrokerError(`Broker refused credential disable id=${id}`);
		}
	}

	async deleteAuthCredentialRemote(id: number, disabledCause: string): Promise<boolean> {
		const found = this.#snapshot.credentials.some(entry => entry.id === id);
		if (!found) return false;
		const revisionAtDisable = this.#appliedSnapshotRevision;
		await this.#disableCredentialConfirmed(id, disabledCause);
		// A newer broker snapshot or local edit may have replaced this same ID while
		// the disable response was pending. Acknowledging the earlier request does
		// not authorize evicting the subsequently accepted credential.
		if (revisionAtDisable !== this.#appliedSnapshotRevision) {
			this.#maybeRefreshSnapshot("delete credential superseded");
			throw new AIError.AuthBrokerError(`Broker credential disable superseded by newer state id=${id}`);
		}
		this.#removeCredentialById(id);
		this.#maybeRefreshSnapshot("delete credential");
		return true;
	}

	tryDisableAuthCredentialIfMatches(_id: number, _expectedData: string, _disabledCause: string): boolean {
		// A redacted local snapshot cannot compare the broker's serialized grant.
		// Never turn a synchronous CAS into an unconditional remote disable or claim
		// success before the broker has checked the current refresh-token owner.
		return false;
	}

	async waitForFreshSnapshot(maxWaitMs: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
		const previousGeneration = this.#generation;
		const revisionAtRequest = this.#appliedSnapshotRevision;
		const result = await this.#client.fetchSnapshot({
			ifGenerationGt: previousGeneration,
			waitMs: maxWaitMs,
			signal: opts.signal,
		});
		if (result.status === 200) this.#applyFetchedSnapshot(result.snapshot, result.generation, revisionAtRequest);
		return this.#generation !== previousGeneration;
	}

	async prepareForRequest(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (entry?.credential.type !== "oauth" || entry.rotatesInMs === null) return false;
		const remainingMs = this.#snapshotReceivedAt + entry.rotatesInMs - Date.now();
		if (remainingMs > WAIT_THRESHOLD_MS) return false;
		return this.waitForFreshSnapshot(MAX_WAIT_MS, opts);
	}

	async markCredentialSuspect(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
		const current = requireLocalOAuthRefresh(this.#snapshot, credentialId);
		const selectedAccess = current.credential.access;
		const { entry } = await this.#client.refreshCredential(credentialId, opts.signal);
		assertBrokerOAuthRefresh(entry, credentialId, current.provider);
		const reconciled = requireLocalOAuthRefresh(this.#snapshot, credentialId, current.provider);
		if (reconciled.credential.access !== selectedAccess && reconciled.credential.access !== entry.credential.access) {
			throw new AIError.AuthBrokerError(`Broker suspect refresh superseded by newer OAuth credential id=${credentialId}`);
		}
		this.#applyCredentialEntry(entry);
		this.#maybeRefreshSnapshot("suspect credential refresh");
	}

	replaceAuthCredentialsForProvider(_provider: string, _credentials: AuthCredential[]): StoredAuthCredential[] {
		throw new AIError.AuthBrokerError(
			"RemoteAuthCredentialStore is read-only on the client. Use `veyyon auth-broker login <provider>` to mutate credentials.",
		);
	}

	upsertAuthCredentialForProvider(_provider: string, _credential: AuthCredential): StoredAuthCredential[] {
		throw new AIError.AuthBrokerError(
			"RemoteAuthCredentialStore is read-only on the client. Use `veyyon auth-broker login <provider>` to mutate credentials.",
		);
	}

	deleteAuthCredentialsForProvider(_provider: string, _disabledCause: string): void {
		throw new AIError.AuthBrokerError(
			"RemoteAuthCredentialStore is read-only on the client. Use `veyyon auth-broker logout <provider>` to mutate credentials.",
		);
	}

	/**
	 * Upsert a single credential through the broker. The broker server is the
	 * canonical writer — see `POST /v1/credential`. The redacted snapshot
	 * entries returned by the server replace the provider's rows in our local
	 * snapshot, and the global snapshot is then refreshed in the background so
	 * any concurrent peer (refresh, generation bump) stays in sync.
	 */
	async upsertAuthCredentialRemote(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
		const revisionAtUpload = this.#appliedSnapshotRevision;
		const { entries } = await this.#client.uploadCredential(provider, credential);
		this.#applyProviderEntries(provider, entries, revisionAtUpload);
		this.#maybeRefreshSnapshot("upload");
		return this.listAuthCredentials(provider);
	}

	/**
	 * Replace-all semantics: disable every active credential for the provider,
	 * then upload each of the new credentials. Used by API-key login so a new
	 * key clobbers any previously stored key for the same provider.
	 */
	async replaceAuthCredentialsRemote(
		provider: string,
		credentials: AuthCredential[],
	): Promise<StoredAuthCredential[]> {
		const existing = this.listAuthCredentials(provider);
		let changed = false;
		try {
			for (const entry of existing) {
				// Abort replacement if the broker cannot disable an old grant.
				// Only broker-confirmed removes may disappear from the local view.
				const revisionAtDisable = this.#appliedSnapshotRevision;
				await this.#disableCredentialConfirmed(entry.id, "replaced by newer credential");
				// A delayed confirmation may refer to the old grant while another
				// broker snapshot has accepted a newer grant under the same ID.
				if (
					revisionAtDisable !== this.#appliedSnapshotRevision &&
					this.#snapshot.credentials.some(current => current.id === entry.id)
				) {
					this.#maybeRefreshSnapshot("replace disable superseded");
					throw new AIError.AuthBrokerError(`Broker credential disable superseded by newer state id=${entry.id}`);
				}
				this.#removeCredentialById(entry.id);
				changed = true;
			}
			// Every old grant was disabled before a replacement can be uploaded.
			for (const credential of credentials) {
				const revisionAtUpload = this.#appliedSnapshotRevision;
				const { entries } = await this.#client.uploadCredential(provider, credential);
				this.#applyProviderEntries(provider, entries, revisionAtUpload);
				changed = true;
			}
		} finally {
			if (changed) this.#maybeRefreshSnapshot("replace");
		}
		return this.listAuthCredentials(provider);
	}

	/**
	 * Logout: disable every active credential for the provider on the broker,
	 * then drop them from the local snapshot. Refresh fetches the authoritative
	 * post-state in the background.
	 */
	async deleteAuthCredentialsRemote(provider: string, disabledCause: string): Promise<void> {
		const existing = this.listAuthCredentials(provider);
		let disabledAny = false;
		try {
			for (const entry of existing) {
				const revisionAtDisable = this.#appliedSnapshotRevision;
				await this.#disableCredentialConfirmed(entry.id, disabledCause);
				if (
					revisionAtDisable !== this.#appliedSnapshotRevision &&
					this.#snapshot.credentials.some(current => current.id === entry.id)
				) {
					this.#maybeRefreshSnapshot("logout disable superseded");
					throw new AIError.AuthBrokerError(`Broker credential disable superseded by newer state id=${entry.id}`);
				}
				this.#removeCredentialById(entry.id);
				disabledAny = true;
			}
		} finally {
			// Reconcile confirmed partial disables even when a later broker call failed.
			if (disabledAny) this.#maybeRefreshSnapshot("delete");
		}
	}

	#applyProviderEntries(provider: string, entries: AuthCredentialSnapshotEntry[], revisionAtUpload: number): void {
		// Upload replies are a trust boundary: validate the *whole* list before
		// replacing any local rows, even when the broker normally redacts it.
		// IDs are global across providers: refresh, disable, and block use the ID.
		// Refuse duplicates and IDs belonging to retained other-provider rows.
		const retainedIds = new Set(
			this.#snapshot.credentials.filter(entry => entry.provider !== provider).map(entry => entry.id),
		);
		const returnedIds = new Set<number>();
		for (const entry of entries) {
			if (entry.provider !== provider) {
				throw new AIError.AuthBrokerError(`Broker upload identity mismatch for provider=${provider}`);
			}
			if (returnedIds.has(entry.id) || retainedIds.has(entry.id)) {
				throw new AIError.AuthBrokerError(`Broker upload identity collision for credential id=${entry.id} provider=${provider}`);
			}
			returnedIds.add(entry.id);
			if (entry.credential.type === "oauth" && entry.credential.refresh !== REMOTE_REFRESH_SENTINEL) {
				throw new AIError.AuthBrokerError(`Broker upload returned unredacted OAuth refresh for provider=${provider}`);
			}
		}
		// A later GET/SSE or local write can supersede a response formed before
		// revocation while the POST reply is in flight. Do not restore its old
		// provider list; the normal stream/GET reconciliation remains authoritative.
		if (revisionAtUpload !== this.#appliedSnapshotRevision) {
			logger.debug("auth-broker stale credential upload response ignored", { provider });
			return;
		}
		// `entries` is the broker's authoritative post-upsert list of rows for
		// `provider`. Drop our existing rows for the same provider and splice in
		// the fresh set — preserving every other provider's rows in place.
		const existingBlocks = new Map(
			this.#snapshot.credentials
				.filter(entry => entry.provider === provider && entry.blocks !== undefined)
				.map(entry => [entry.id, entry.blocks] as const),
		);
		const others = this.#snapshot.credentials.filter(entry => entry.provider !== provider);
		const incoming = entries.map(entry => credentialEntryWithBlocks(entry, existingBlocks.get(entry.id)));
		const priorProviderById = new Map(
			this.#snapshot.credentials.filter(entry => entry.provider === provider).map(entry => [entry.id, entry] as const),
		);
		const credentialStateChanged = priorProviderById.size !== incoming.length || incoming.some(entry => {
			const prior = priorProviderById.get(entry.id);
			return !prior || !isDeepStrictEqual(prior.credential, entry.credential);
		});
		this.#snapshot = { ...this.#snapshot, credentials: others.concat(incoming) };
		this.#appliedSnapshotRevision += 1;
		// A broker-acknowledged upload outranks already queued frames on the old
		// SSE transport, even when the remote relay advertises a higher generation.
		if (credentialStateChanged) this.#activeSnapshotStreamAbort?.abort();
	}
	#applyCredentialEntry(entry: AuthCredentialSnapshotEntry): void {
		const index = this.#snapshot.credentials.findIndex(candidate => candidate.id === entry.id);
		const previous = index === -1 ? undefined : this.#snapshot.credentials[index];
		const incoming = credentialEntryWithBlocks(entry, previous?.blocks);
		const credentialStateChanged = !previous ||
			previous.provider !== entry.provider || !isDeepStrictEqual(previous.credential, entry.credential);
		if (index === -1) {
			this.#snapshot = { ...this.#snapshot, credentials: this.#snapshot.credentials.concat([incoming]) };
			this.#appliedSnapshotRevision += 1;
			if (credentialStateChanged) this.#activeSnapshotStreamAbort?.abort();
			return;
		}
		const credentials = this.#snapshot.credentials.slice();
		credentials[index] = incoming;
		this.#snapshot = { ...this.#snapshot, credentials };
		this.#appliedSnapshotRevision += 1;
		if (credentialStateChanged) this.#activeSnapshotStreamAbort?.abort();
	}

	#removeCredentialById(id: number): void {
		const next = this.#snapshot.credentials.filter(entry => entry.id !== id);
		if (next.length === this.#snapshot.credentials.length) return;
		// Every caller already received a broker-confirmed disable. An old SSE
		// frame at the current generation is no more authoritative than this
		// acknowledgement, even before a later canonical GET arrives.
		this.#canonicallyRemovedCredentialIds.add(id);
		this.#snapshot = { ...this.#snapshot, credentials: next };
		this.#appliedSnapshotRevision += 1;
		// A broker-confirmed local disable also changes the canonical roster.
		// Retire old SSE: its stale removed(B) must not evict a surviving B.
		this.#activeSnapshotStreamAbort?.abort();
	}

	#upsertSnapshotBlock(block: StoredCredentialBlock): void {
		const index = this.#snapshot.credentials.findIndex(entry => entry.id === block.credentialId);
		if (index === -1) return;
		const entry = this.#snapshot.credentials[index]!;
		const incoming = toCredentialBlockSnapshot(block);
		const blocks = entry.blocks ? entry.blocks.slice() : [];
		const blockIndex = blocks.findIndex(
			candidate => candidate.providerKey === incoming.providerKey && candidate.blockScope === incoming.blockScope,
		);
		if (blockIndex === -1) {
			blocks.push(incoming);
		} else {
			const existing = blocks[blockIndex]!;
			blocks[blockIndex] = {
				...existing,
				blockedUntilMs: Math.max(existing.blockedUntilMs, incoming.blockedUntilMs),
			};
		}
		blocks.sort(compareCredentialBlockSnapshots);
		const credentials = this.#snapshot.credentials.slice();
		credentials[index] = { ...entry, blocks };
		this.#snapshot = { ...this.#snapshot, credentials };
		this.#appliedSnapshotRevision += 1;
	}

	#pruneExpiredCredentialBlocks(nowMs: number): void {
		let changed = false;
		const credentials = this.#snapshot.credentials.map(entry => {
			if (!entry.blocks || entry.blocks.length === 0) return entry;
			const blocks = entry.blocks.filter(block => block.blockedUntilMs > nowMs);
			if (blocks.length === entry.blocks.length) return entry;
			changed = true;
			if (blocks.length > 0) return { ...entry, blocks };
			const next: SnapshotEntry = { ...entry };
			delete next.blocks;
			return next;
		});
		if (changed) {
			this.#snapshot = { ...this.#snapshot, credentials };
			this.#appliedSnapshotRevision += 1;
		}
	}

	/**
	 * Report that this process's view of the broker's credentials has gone stale.
	 *
	 * Every caller here is a path that already succeeded at the thing the user
	 * asked for and then failed to bring the local snapshot back in line. That
	 * combination is what makes silence dangerous: nothing looks wrong, yet the
	 * next decision taken from the snapshot (which credential is blocked, which
	 * token is current) is made against data known to be out of date. Warned once
	 * per cause, because the cause is normally a broker that is down for the whole
	 * process and a per-request warning would bury itself.
	 */
	#reportStaleSnapshot(cause: string, error: unknown, fields: Record<string, unknown> = {}): void {
		const detail = { cause, error: String(error), ...fields };
		if (this.#reportedStaleSnapshotCauses.has(cause)) {
			logger.debug("auth-broker credential view still stale", detail);
			return;
		}
		this.#reportedStaleSnapshotCauses.add(cause);
		logger.warn(
			"auth-broker credential view is stale; this process may keep using outdated credential or block state until the broker responds again",
			detail,
		);
	}

	/**
	 * Fire-and-forget `refreshSnapshot()` after a write. When the SSE stream is
	 * active the broker will deliver the new generation push, so the extra GET
	 * is wasted bandwidth and we skip it.
	 */
	#maybeRefreshSnapshot(reason: string): void {
		if (this.#streamingActive) return;
		void this.refreshSnapshot().catch(error => {
			this.#reportStaleSnapshot("refresh-after-write", error, { reason });
		});
	}

	getCache(key: string): string | null {
		const entry = this.#cache.get(key);
		if (!entry) return null;
		if (entry.expiresAtSec * 1000 <= Date.now()) {
			this.#cache.delete(key);
			return null;
		}
		return entry.value;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#cache.set(key, { value, expiresAtSec });
	}

	/** Drop all cache rows whose keys start with the supplied prefix. */
	deleteCachePrefix(prefix: string): void {
		for (const key of this.#cache.keys()) {
			if (key.startsWith(prefix)) this.#cache.delete(key);
		}
	}

	cleanExpiredCache(): void {
		const nowSec = Math.floor(Date.now() / 1000);
		for (const [key, entry] of this.#cache) {
			if (entry.expiresAtSec <= nowSec) this.#cache.delete(key);
		}
	}

	async invalidateUsageCache(signal?: AbortSignal): Promise<void> {
		this.#invalidateUsageCache();
		await this.#client.notifyUsageStale(signal).catch(err => {
			logger.warn("auth-broker notification of stale usage failed", { error: String(err) });
		});
	}

	#invalidateUsageCache(): void {
		this.#usageCache = undefined;
		this.#usageInflight = undefined;
		this.#usageCacheEpoch += 1;
	}

	/**
	 * Store-level hook consumed by `AuthStorage` — routes refresh through the
	 * broker so the actual refresh token never leaves the broker host. Returns
	 * the broker-redacted credential with {@link REMOTE_REFRESH_SENTINEL} in
	 * the `refresh` slot.
	 */
	async refreshOAuthCredential(
		provider: Provider,
		credentialId: number,
		_credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		const current = requireLocalOAuthRefresh(this.#snapshot, credentialId, provider);
		const selectedAccess = current.credential.access;
		const { entry } = await this.#client.refreshCredential(credentialId, signal);
		assertBrokerOAuthRefresh(entry, credentialId, current.provider);
		requireLocalOAuthRefresh(this.#snapshot, credentialId, provider);
		if (!this.#streamingActive) {
			await this.refreshSnapshot().catch(error => {
				this.#reportStaleSnapshot("refresh-after-credential-refresh", error, { credentialId });
			});
		}
		// A non-streaming reconciliation is another await after response validation: it may
		// observe a disable or a newer access token that must not be overwritten by this reply.
		const reconciled = requireLocalOAuthRefresh(this.#snapshot, credentialId, provider);
		if (reconciled.credential.access !== selectedAccess && reconciled.credential.access !== entry.credential.access) {
			throw new AIError.AuthBrokerError(`Broker refresh superseded by newer OAuth credential id=${credentialId}`);
		}
		const refreshed = entry.credential;
		return {
			access: refreshed.access,
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: refreshed.expires,
			accountId: refreshed.accountId,
			email: refreshed.email,
			projectId: refreshed.projectId,
			enterpriseUrl: refreshed.enterpriseUrl,
		};
	}

	/**
	 * Store-level hook consumed by `AuthStorage.fetchUsageReports()` — proxies
	 * to the broker's `/v1/usage` endpoint. The broker's egress IP isn't
	 * rate-limited by Anthropic's per-IP `/usage` cap the way a heavy
	 * residential laptop is, so all credentials surface every cycle.
	 */
	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		const reports = await raceWithSignal(this.#loadUsageReports(), signal, "auth-broker request aborted");
		return reports ? this.#applyUsageOverlays(reports) : null;
	}

	/**
	 * Per-credential usage hook consumed by `UsageReporting.reportFor`. Pulls
	 * the aggregate broker `/v1/usage` once and serves all callers from the
	 * same response (coalesced + cached), then overlays any client-observed
	 * header hints for the matching credential.
	 *
	 * The broker already aggregates with its own 30s TTL on the server side; our
	 * 15s client TTL is below that so we usually re-use the broker's cache too.
	 */
	async getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<UsageReport | null> {
		const reports = await raceWithSignal(this.#loadUsageReports(), signal, "auth-broker request aborted");
		const matched = reports ? matchUsageReport(reports, provider, credential) : null;
		const overlay = this.#getActiveUsageOverlay(provider, credential);
		if (matched && overlay) return mergeUsageReports(matched, overlay);
		return overlay ?? matched;
	}

	ingestUsageReport(provider: Provider, credential: OAuthCredential, report: UsageReport): boolean {
		const key = usageOverlayKey(provider, credential);
		if (!key) return false;
		const activeOverlay = this.#getActiveUsageOverlay(provider, credential);
		this.#usageOverlays.set(key, activeOverlay ? mergeUsageReports(activeOverlay, report) : report);
		return true;
	}

	#getActiveUsageOverlay(provider: Provider, credential: OAuthCredential): UsageReport | undefined {
		const key = usageOverlayKey(provider, credential);
		if (!key) return undefined;
		const overlay = this.#usageOverlays.get(key);
		if (!overlay) return undefined;
		if (Date.now() - overlay.fetchedAt >= USAGE_CACHE_TTL_MS) {
			this.#usageOverlays.delete(key);
			return undefined;
		}
		return overlay;
	}

	#applyUsageOverlays(reports: UsageReport[]): UsageReport[] {
		const overlays = Array.from(this.#usageOverlays.values()).filter(
			overlay => Date.now() - overlay.fetchedAt < USAGE_CACHE_TTL_MS,
		);
		if (overlays.length === 0) return reports;
		const merged = reports.slice();
		for (const overlay of overlays) {
			const matchIndex = findMatchingReportIndex(merged, overlay);
			if (matchIndex === -1) {
				merged.push(overlay);
			} else {
				merged[matchIndex] = mergeUsageReports(merged[matchIndex]!, overlay);
			}
		}
		return merged;
	}

	#loadUsageReports(): Promise<UsageReport[] | null> {
		const cached = this.#usageCache;
		if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
			return Promise.resolve(cached.reports);
		}
		if (this.#usageInflight) return this.#usageInflight;
		const epoch = this.#usageCacheEpoch;
		const inflight = this.#client
			.fetchUsage()
			.then(body => {
				if (epoch !== this.#usageCacheEpoch) return this.#loadUsageReports();
				this.#usageCache = { reports: body.reports, fetchedAt: Date.now() };
				return body.reports;
			})
			.catch(error => {
				logger.warn("auth-broker usage fetch failed", { error: String(error) });
				// Documented 15s TTL fallback: cache the null so sequential callers
				// don't re-hit the broker while it's still down. See
				// docs/internal/auth-broker-gateway.md § "Client-side single-flight".
				if (epoch !== this.#usageCacheEpoch) return this.#loadUsageReports();
				this.#usageCache = { reports: null, fetchedAt: Date.now() };
				return null;
			})
			.finally(() => {
				if (this.#usageInflight === inflight) this.#usageInflight = undefined;
			});
		this.#usageInflight = inflight;
		return inflight;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#backgroundAbort.abort();
		this.#cache.clear();
		this.#usageOverlays.clear();
	}
}

function normalizeSnapshotEntryBlocks(entry: SnapshotEntry, nowMs: number): SnapshotEntry {
	if (!entry.blocks || entry.blocks.length === 0) return entry;
	const blocks = entry.blocks
		.filter(block => block.blockedUntilMs > nowMs)
		.map(block => ({
			providerKey: block.providerKey,
			blockScope: block.blockScope,
			blockedUntilMs: block.blockedUntilMs,
			...(block.updatedAtMs !== undefined ? { updatedAtMs: block.updatedAtMs } : {}),
		}))
		.sort(compareCredentialBlockSnapshots);
	if (blocks.length > 0) return { ...entry, blocks };
	const next: SnapshotEntry = { ...entry };
	delete next.blocks;
	return next;
}

/**
 * Lower-cased, trimmed identity a usage report is matched against. An empty or
 * absent field matches nothing.
 */
interface UsageIdentity {
	orgId: string | undefined;
	accountId: string | undefined;
	email: string | undefined;
	projectId: string | undefined;
}

/**
 * Match a broker-supplied usage report to a specific OAuth credential. The
 * broker returns aggregate reports across all credentials it manages, so we
 * pick the one whose identity (accountId / email / projectId) lines up with
 * the credential the caller is asking about.
 *
 * Falls back to the lone candidate when only one matches the provider; falls
 * through to `null` when nothing matches, which `AuthStorage` treats as "no
 * usage data" (ranking proceeds without a usage signal for this credential).
 */
function matchUsageReport(
	reports: readonly UsageReport[],
	provider: Provider,
	credential: OAuthCredential,
): UsageReport | null {
	const index = findIdentityReportIndex(reports, provider, {
		orgId: credential.orgId?.trim().toLowerCase(),
		accountId: credential.accountId?.trim().toLowerCase(),
		email: credential.email?.trim().toLowerCase(),
		projectId: credential.projectId?.trim().toLowerCase(),
	});
	return index === -1 ? null : reports[index]!;
}

/** Index of the report a usage overlay merges into, by the identity in the overlay's metadata, or -1. */
function findMatchingReportIndex(reports: readonly UsageReport[], overlay: UsageReport): number {
	const { metadata } = overlay;
	return findIdentityReportIndex(reports, overlay.provider, {
		orgId: readMetadataString(metadata, "orgId")?.toLowerCase(),
		accountId: readMetadataString(metadata, "accountId")?.toLowerCase(),
		email: readMetadataString(metadata, "email")?.toLowerCase(),
		projectId: readMetadataString(metadata, "projectId")?.toLowerCase(),
	});
}

/**
 * Org precedence, decisive on EITHER side: an org-scoped identity may only
 * take its own org's report, and an org-less (legacy) identity may only take
 * org-less reports. The shared email/account would otherwise hand one
 * subscription the OTHER subscription's pool (e.g. mark healthy Max exhausted
 * via Team's report, or rank a legacy row on a sibling's numbers), and a usage
 * overlay would merge into another subscription's report row.
 */
function findIdentityReportIndex(reports: readonly UsageReport[], provider: Provider, identity: UsageIdentity): number {
	return identity.orgId
		? findSameOrgReportIndex(reports, provider, identity, identity.orgId)
		: findOrglessReportIndex(reports, provider, identity);
}

/**
 * The shared org is a GATE, not a match. Two Team members share the org id
 * while drawing on per-user pools, so the identity's own base fields must
 * still line up inside the same-org reports: a lone sibling report is NOT
 * ours. An org-only identity (no base fields) takes the lone same-org report
 * and treats several as ambiguous. No report in the org, including when no
 * report carries an org at all, is "no usage data" rather than another org's
 * pool or a legacy sibling row's.
 */
function findSameOrgReportIndex(
	reports: readonly UsageReport[],
	provider: Provider,
	identity: UsageIdentity,
	orgId: string,
): number {
	const matchesBaseIdentity = Boolean(identity.accountId || identity.email || identity.projectId);
	let loneIndex = -1;
	for (let index = 0; index < reports.length; index += 1) {
		const report = reports[index]!;
		if (report.provider !== provider) continue;
		if (readMetadataString(report.metadata, "orgId")?.toLowerCase() !== orgId) continue;
		if (matchesBaseIdentity) {
			if (reportMatchesIdentity(report, identity)) return index;
			continue;
		}
		if (loneIndex !== -1) return -1;
		loneIndex = index;
	}
	return loneIndex;
}

/** The first org-less report matching the identity, or the provider's only report when it is org-less. */
function findOrglessReportIndex(reports: readonly UsageReport[], provider: Provider, identity: UsageIdentity): number {
	let providerReports = 0;
	let orglessIndex = -1;
	for (let index = 0; index < reports.length; index += 1) {
		const report = reports[index]!;
		if (report.provider !== provider) continue;
		providerReports += 1;
		if (readMetadataString(report.metadata, "orgId")) continue;
		if (reportMatchesIdentity(report, identity)) return index;
		orglessIndex = index;
	}
	return providerReports === 1 ? orglessIndex : -1;
}

function reportMatchesIdentity(report: UsageReport, identity: UsageIdentity): boolean {
	const { metadata } = report;
	const { accountId, email, projectId } = identity;
	if (
		accountId &&
		(metadataMatches(metadata, accountId, "accountId", "account_id") ||
			limitScopeMatches(report, "accountId", accountId))
	) {
		return true;
	}
	if (email && metadataMatches(metadata, email, "email")) return true;
	return Boolean(
		projectId &&
			(metadataMatches(metadata, projectId, "projectId", "project_id") ||
				limitScopeMatches(report, "projectId", projectId)),
	);
}

/** Whether the metadata string at `key`, or at `alias` when `key` holds none, lower-cases to `value`. */
function metadataMatches(
	metadata: Record<string, unknown> | undefined,
	value: string,
	key: string,
	alias?: string,
): boolean {
	const found =
		readMetadataString(metadata, key) ?? (alias === undefined ? undefined : readMetadataString(metadata, alias));
	return found?.toLowerCase() === value;
}

function limitScopeMatches(report: UsageReport, field: "accountId" | "projectId", value: string): boolean {
	for (const limit of report.limits) {
		if (limit.scope[field]?.toLowerCase() === value) return true;
	}
	return false;
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = metadata?.[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
