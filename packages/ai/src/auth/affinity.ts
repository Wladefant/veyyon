import { logger } from "@veyyon/utils";
import { LRUCache } from "@veyyon/utils/lru";
import { getEnvApiKey } from "../env-api-key";
import type {
	AuthCredential,
	OAuthCredential,
	SessionCredentialRouting,
	SessionRestrictionLease,
	SessionsApi,
	StoredAuthCredential,
} from "./types";
import type { AuthCredentialStore } from "./store";
import type { CredentialPool } from "./pool";
import type { KeyOverrides } from "./cascade";
import { resolveAccountNameIdentity, resolveCredentialIdentityKey } from "../auth-credential-rows";
import { providerTypeKey, type CredentialBlocks } from "./blocks";

/** Prefix for persisted session-to-credential affinity. */
export const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
/** Prefix for persisted user account choices (session pins). */
export const SESSION_PIN_CACHE_PREFIX = "session:pin:";
/** Persisted sticky rows live this long past their last use. */
const SESSION_STICKY_TTL_SEC = 30 * 24 * 60 * 60;
/** Persisted pin rows live for 30 days. */
const SESSION_PIN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** In-memory TTL before re-reading provider selection from store. */
const PROVIDER_SELECTION_TTL_MS = 500;
/**
 * Same-credential re-records rewrite the persisted row at most this often. The
 * in-memory sticky stays exact; only the copy other processes resume from lags.
 */
const SESSION_STICKY_PERSIST_INTERVAL_MS = 60_000;
/**
 * In-memory pins kept per provider. Long-lived gateways mint a session id per
 * conversation; evicted sessions resume from their persisted sticky row.
 */
const SESSION_AFFINITY_MAX_SESSIONS_PER_PROVIDER = 256;

/** What this process last wrote (or read) for one persisted sticky row. */
type PersistedSticky = {
	type: AuthCredential["type"];
	credentialId: number;
	explicit: boolean;
	lastUsedAtMs: number;
};

/** A session's pinned credential (resolved index + durable row id). */
export type SessionCredential = {
	type: AuthCredential["type"];
	index: number;
	credentialId?: number;
	lastUsedAtMs?: number;
	/** Set only by the public user-facing pin API; automatic warm affinity leaves it absent. */
	explicit?: true;
};

/** Chosen account for a provider (session pin or global selection). */
export interface ChosenCredential {
	type: AuthCredential["type"];
	index: number;
	credentialId: number;
};

/** One installed restriction: the allowed OAuth identity keys and the lease that lifts it. */
type SessionRestriction = { readonly allowed: ReadonlySet<string>; readonly lease: SessionRestrictionLease };

/**
 * Provider → session id → installed restriction. Owned by `AuthStorage` so
 * restrictions outlive store replacement, which rebuilds every store-bound
 * module (pins included) around the same identities.
 */
export type SessionRestrictions = Map<string, Map<string, SessionRestriction>>;

/** Session → credential affinity (pins), persisted in the store cache. */
export class SessionAffinity implements SessionsApi {
	/** Tracks the last used credential per provider for a session (used for rate-limit switching). */
	#sessionLastCredential: Map<string, LRUCache<string, SessionCredential>> = new Map();
	/** Persisted sticky rows per provider, keyed by session id, so unchanged re-records skip the write. */
	#persistedSticky: Map<string, LRUCache<string, PersistedSticky>> = new Map();
	/** Explicit user pins per session, keyed by provider. */
	#sessionPinnedCredential: Map<string, LRUCache<string, number>> = new Map();
	/** Process-memoised global provider account choice. */
	#providerSelection: Map<string, { identity: string | null; readAtMs: number; persisted: boolean }> = new Map();
	/** Credentials with confirmed definitive authentication failure. */
	#authDeadCredentials: Set<number> = new Set();
	/** Round-robin index per provider key for deterministic prediction. */
	#providerRoundRobinIndex: Map<string, number> = new Map();
	#reportedStickyCacheFailures = new Set<string>();
	#store: AuthCredentialStore;
	#pool: CredentialPool;
	#overrides: KeyOverrides;
	#restrictions: SessionRestrictions;
	#loadBalancing?: boolean | (() => boolean);
	#blocks?: CredentialBlocks;

	constructor(
		store: AuthCredentialStore,
		pool: CredentialPool,
		overrides: KeyOverrides,
		restrictions: SessionRestrictions,
		options?: { loadBalancing?: boolean | (() => boolean) },
	) {
		this.#store = store;
		this.#pool = pool;
		this.#overrides = overrides;
		this.#restrictions = restrictions;
		this.#loadBalancing = options?.loadBalancing;
	}

	/** Whether multi-account load balancing is currently enabled. */
	isLoadBalancingEnabled(): boolean {
		const setting = this.#loadBalancing;
		if (setting === undefined) return false;
		return typeof setting === "function" ? setting() : Boolean(setting);
	}

	setBlocks(blocks: CredentialBlocks): void {
		this.#blocks = blocks;
	}

	markAuthDead(credentialId: number): void {
		this.#authDeadCredentials.add(credentialId);
	}

	unmarkAuthDead(credentialId: number): void {
		this.#authDeadCredentials.delete(credentialId);
	}

	reviveAuthDead(credentialId: number): void {
		this.#authDeadCredentials.delete(credentialId);
	}

	isAuthDead(credentialId: number): boolean {
		return this.#authDeadCredentials.has(credentialId);
	}

	restrict(provider: string, sessionId: string, identityKeys: readonly string[]): SessionRestrictionLease {
		if (!provider || !sessionId) throw new Error("sessions.restrict requires a provider and a session id");
		const lease = Symbol("sessions.restrict");
		const sessions = this.#restrictions.get(provider) ?? new Map<string, SessionRestriction>();
		sessions.set(sessionId, { allowed: new Set(identityKeys), lease });
		this.#restrictions.set(provider, sessions);
		return lease;
	}

	unrestrict(provider: string, sessionId: string, lease: SessionRestrictionLease): void {
		const sessions = this.#restrictions.get(provider);
		if (sessions?.get(sessionId)?.lease !== lease) return;
		sessions.delete(sessionId);
		if (sessions.size === 0) this.#restrictions.delete(provider);
	}

	/** True when {@link restrict} limits `sessionId` for `provider`. */
	isRestricted(provider: string, sessionId: string | undefined): boolean {
		return sessionId !== undefined && this.#restrictions.get(provider)?.has(sessionId) === true;
	}

	/**
	 * True when `credential` may serve `sessionId`: always for an unrestricted
	 * session, otherwise only an OAuth credential whose identity key is allowed.
	 */
	allows(provider: string, sessionId: string | undefined, credential: AuthCredential): boolean {
		const allowed = sessionId === undefined ? undefined : this.#restrictions.get(provider)?.get(sessionId)?.allowed;
		if (allowed === undefined) return true;
		if (credential.type !== "oauth") return false;
		const identityKey = resolveCredentialIdentityKey(provider, credential);
		return identityKey !== null && allowed.has(identityKey);
	}

	/** Whether the stored row at `index` may serve `sessionId` (see {@link allows}). */
	#permits(provider: string, sessionId: string, index: number): boolean {
		if (!this.isRestricted(provider, sessionId)) return true;
		const credential = this.#pool.credentials(provider)[index];
		return credential !== undefined && this.allows(provider, sessionId, credential);
	}

	permits(provider: string, sessionId: string, credentialId: number): boolean {
		if (!this.isRestricted(provider, sessionId)) return true;
		const entry = this.#pool.entries(provider).find(candidate => candidate.id === credentialId);
		return entry !== undefined && this.allows(provider, sessionId, entry.credential);
	}

	/** Bounded per-provider session map, created on first use. */
	static #sessionsFor<V>(maps: Map<string, LRUCache<string, V>>, provider: string): LRUCache<string, V> {
		let sessions = maps.get(provider);
		if (!sessions) {
			sessions = new LRUCache<string, V>({ max: SESSION_AFFINITY_MAX_SESSIONS_PER_PROVIDER });
			maps.set(provider, sessions);
		}
		return sessions;
	}

	/** Drop every pin for a provider, both in memory and in the persisted cache. */
	clearProvider(provider: string): void {
		this.#sessionLastCredential.delete(provider);
		this.#persistedSticky.delete(provider);
		this.#sessionPinnedCredential.delete(provider);
		this.#providerRoundRobinIndex.delete(provider);
		try {
			this.#store.deleteCachePrefix?.(`${SESSION_STICKY_CACHE_PREFIX}${provider}:`);
			this.#store.deleteCachePrefix?.(`${SESSION_PIN_CACHE_PREFIX}${provider}:`);
		} catch (err) {
			logger.debug("Failed to clear provider session sticky credentials from persistent store cache", { err });
		}
	}

	/** Drop only this in-memory session pin after OAuth selection falls through. */
	forget(provider: string, sessionId: string): void {
		this.#sessionLastCredential.get(provider)?.delete(sessionId);
	}

	/**
	 * Records which credential was used for a session (for rate-limit switching).
	 * `lastUsedAtMs` backdates the sticky (session-file pin restores on resume);
	 * it defaults to now for live selections. Automatic re-recording of the same
	 * durable row preserves an explicit user pin.
	 *
	 * The in-memory sticky is always exact. The persisted row is rewritten only
	 * when the credential, its type, or explicitness changes, or when the stored
	 * last-use drifts by {@link SESSION_STICKY_PERSIST_INTERVAL_MS} — per-request
	 * rewrites were pure database churn.
	 */
	record(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
		lastUsedAtMs?: number,
		explicit = false,
	): void {
		if (!sessionId || !this.#permits(provider, sessionId, index)) return;
		const nowMs = lastUsedAtMs ?? Date.now();
		const credentialId = this.#pool.entries(provider)[index]?.id;
		const sessionMap = SessionAffinity.#sessionsFor(this.#sessionLastCredential, provider);
		const previous = sessionMap.get(sessionId);
		const sameCredential =
			previous?.type === type &&
			(credentialId !== undefined ? previous.credentialId === credentialId : previous.index === index);
		const isExplicit = explicit || (sameCredential && previous?.explicit === true);
		const sessionCredential: SessionCredential = {
			type,
			index,
			credentialId,
			lastUsedAtMs: nowMs,
			...(isExplicit ? { explicit: true as const } : {}),
		};
		sessionMap.set(sessionId, sessionCredential);

		if (credentialId === undefined) return;
		const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
		const expiresAtSec = Math.floor(nowMs / 1000) + SESSION_STICKY_TTL_SEC;
		const persistedSessions = SessionAffinity.#sessionsFor(this.#persistedSticky, provider);
		const persisted = persistedSessions.get(sessionId);
		if (
			persisted &&
			persisted.type === type &&
			persisted.credentialId === credentialId &&
			persisted.explicit === isExplicit &&
			Math.abs(nowMs - persisted.lastUsedAtMs) < SESSION_STICKY_PERSIST_INTERVAL_MS
		) {
			return;
		}
		try {
			this.#store.setCache(cacheKey, JSON.stringify(sessionCredential), expiresAtSec);
			persistedSessions.set(sessionId, {
				type,
				credentialId,
				explicit: isExplicit,
				lastUsedAtMs: nowMs,
			});
		} catch (err) {
			persistedSessions.delete(sessionId);
			logger.debug("Failed to write session sticky credential to persistent store cache", { err });
		}
	}

	/**
	 * Retrieves the last credential used by a session. A restricted session
	 * never sees a pin outside its allowlist — inherited, restored, or recorded
	 * before the restriction — so it re-ranks inside the allowlist instead.
	 */
	get(provider: string, sessionId: string | undefined): SessionCredential | undefined {
		const pin = this.getSessionCredentialPin(provider, sessionId);
		if (pin && this.#permits(provider, sessionId ?? "", pin.index)) {
			return {
				type: pin.type,
				index: pin.index,
				credentialId: pin.credentialId,
				explicit: true,
			};
		}
		if (!sessionId) return undefined;
		const credential = this.#lookup(provider, sessionId);
		return credential && this.#permits(provider, sessionId, credential.index) ? credential : undefined;
	}

	getStickySessionCredential(provider: string, sessionId: string | undefined): SessionCredential | undefined {
		if (!sessionId) return undefined;
		return this.#lookup(provider, sessionId);
	}

	#lookup(provider: string, sessionId: string): SessionCredential | undefined {
		const live = this.#sessionLastCredential.get(provider)?.get(sessionId);
		if (live) {
			// Another process can add or drop rows mid-session and the pool is an
			// index-ordered snapshot, so re-resolve the pin through its durable row
			// id: a compacted array must not point the session at a different
			// account, and a deleted account must not hand its slot to a sibling.
			if (live.credentialId === undefined) return live;
			const stored = this.#pool.entries(provider);
			const actualIndex = stored.findIndex(entry => entry.id === live.credentialId);
			if (actualIndex === -1 || stored[actualIndex]?.credential.type !== live.type) {
				this.#sessionLastCredential.get(provider)?.delete(sessionId);
				return undefined;
			}
			live.index = actualIndex;
			return live;
		}
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			const raw = this.#store.getCache(cacheKey);
			if (raw) {
				const val = JSON.parse(raw) as SessionCredential;

				if (val.credentialId !== undefined) {
					const stored = this.#pool.entries(provider);
					const actualIndex = stored.findIndex(entry => entry.id === val.credentialId);
					if (actualIndex === -1 || stored[actualIndex]?.credential.type !== val.type) {
						this.#persistedSticky.get(provider)?.delete(sessionId);
						this.#store.setCache(cacheKey, "", 0);
						return undefined;
					}
					val.index = actualIndex;
				} else {
					// Fallback: drop unsafe index-only cache rows to prevent wrong-account routing
					this.#persistedSticky.get(provider)?.delete(sessionId);
					this.#store.setCache(cacheKey, "", 0);
					return undefined;
				}

				const sessionVal: SessionCredential = {
					type: val.type,
					index: val.index,
					credentialId: val.credentialId,
					lastUsedAtMs: val.lastUsedAtMs,
					...(val.explicit === true ? { explicit: true } : {}),
				};
				if (typeof val.lastUsedAtMs === "number") {
					SessionAffinity.#sessionsFor(this.#persistedSticky, provider).set(sessionId, {
						type: val.type,
						credentialId: val.credentialId,
						explicit: val.explicit === true,
						lastUsedAtMs: val.lastUsedAtMs,
					});
				}
				SessionAffinity.#sessionsFor(this.#sessionLastCredential, provider).set(sessionId, sessionVal);
				return sessionVal;
			}
		} catch (err) {
			logger.debug("Failed to read session sticky credential from persistent store cache", { err });
		}
		return undefined;
	}

	/** Clears the last credential used by a session for a provider. */
	clear(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap) {
			sessionMap.delete(sessionId);
			if (sessionMap.size === 0) {
				this.#sessionLastCredential.delete(provider);
			}
		}
		const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
		this.#persistedSticky.get(provider)?.delete(sessionId);
		try {
			this.#store.setCache(cacheKey, "", 0);
		} catch (err) {
			logger.debug("Failed to clear session sticky credential from persistent store cache", { err });
		}
	}

	activeOAuth(provider: string, sessionId?: string): OAuthCredential | undefined {
		const allCredentials = this.#pool.credentials(provider);
		const oauthCredentials = allCredentials.filter(
			(c): c is OAuthCredential => c.type === "oauth" && this.allows(provider, sessionId, c),
		);
		if (oauthCredentials.length === 0) return undefined;

		// Runtime / config overrides bypass OAuth account_uuid attribution — the
		// caller is authenticating with an explicit key, not the broker's OAuth.
		// A restricted session skips a runtime key, and a config key fails it
		// closed (see `KeyCascade.get`).
		const restricted = this.isRestricted(provider, sessionId);
		if (this.#overrides.suppressesOAuth(provider, restricted)) return undefined;

		// Prefer the session-sticky credential when available.
		const sessionPref = this.get(provider, sessionId);
		// If the session has been routed to a stored API key, do not inject OAuth account_uuid.
		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		// When no session-sticky credential is recorded yet (first call before any getApiKey,
		// or all stored credentials are unavailable), the request falls through to the env-key
		// path in getApiKey(), which is not OAuth-authenticated, so account_uuid injection
		// would misattribute traffic. Only apply this guard when sessionPref is absent; a
		// recorded OAuth sticky (sessionPref.type === "oauth") must NOT be blocked even if an
		// env key also happens to exist.
		if (!restricted && !sessionPref && getEnvApiKey(provider)) return undefined;
		// Resolve the sticky index against the full credential list — the index is
		// recorded against the unfiltered provider array (by record /
		// CredentialSelector.tryOAuth), not the OAuth-only subset, so dereferencing it into the
		// filtered array would be off-by-N when any non-OAuth credential precedes the
		// OAuth ones (e.g. [api_key, oauth_A, oauth_B] stored order).
		const stickyCredential = sessionPref?.type === "oauth" ? allCredentials[sessionPref.index] : undefined;
		return stickyCredential?.type === "oauth" ? stickyCredential : oauthCredentials[0];
	}

	/**
	 * Pin one stored OAuth account as this session's preferred credential.
	 *
	 * The durable credential id keeps the pin stable across credential refreshes,
	 * storage reordering, and process restarts. By default this is an explicit
	 * user pin: ranking and account reserve never evict it; hard unavailability
	 * and auth retry may still route around it.
	 *
	 * `options.restoredAtMs` instead restores an automatic affinity recorded by a
	 * persisted session, backdated to its last use, so it keeps the provider's
	 * warm-window semantics: a resume inside the prompt-cache TTL reuses the
	 * account, a stale resume re-ranks.
	 */
	pin(provider: string, sessionId: string, credentialId: number, options?: { restoredAtMs?: number }): boolean {
		if (!sessionId) return false;
		const stored = this.#pool.entries(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		if (index === -1) return false;
		const target = stored[index];
		if (!target) return false;
		if (target.credential.type === "oauth" && this.#overrides.suppressesOAuth(provider, this.isRestricted(provider, sessionId))) {
			return false;
		}
		if (!this.allows(provider, sessionId, target.credential)) return false;

		const restoredAtMs = options?.restoredAtMs;
		if (restoredAtMs !== undefined) {
			this.record(provider, sessionId, target.credential.type, index, restoredAtMs, false);
			return true;
		}

		// Explicit user pin
		const pinSessions = SessionAffinity.#sessionsFor(this.#sessionPinnedCredential, provider);
		pinSessions.set(sessionId, credentialId);
		try {
			this.#store.setCache(
				`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`,
				JSON.stringify({ credentialId }),
				Math.floor(Date.now() / 1000) + SESSION_PIN_TTL_SECONDS,
			);
		} catch (err) {
			this.reportStickyCacheFailure("pin-write", provider, err);
		}
		this.record(provider, sessionId, target.credential.type, index, undefined, true);
		return true;
	}

	clearPin(provider: string, sessionId: string): void {
		if (!sessionId) return;
		const pinMap = this.#sessionPinnedCredential.get(provider);
		if (pinMap) {
			pinMap.delete(sessionId);
			if (pinMap.size === 0) this.#sessionPinnedCredential.delete(provider);
		}
		try {
			this.#store.setCache(`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`, "", 0);
		} catch (err) {
			this.reportStickyCacheFailure("pin-clear", provider, err);
		}
		const live = this.#sessionLastCredential.get(provider)?.get(sessionId);
		if (live && live.explicit) {
			delete live.explicit;
		}
		const persisted = this.#persistedSticky.get(provider)?.get(sessionId);
		if (persisted && persisted.explicit) {
			persisted.explicit = false;
		}
	}

	selectProviderCredential(provider: string, credentialId: number, options?: { sessionId?: string }): boolean {
		const sessionId = options?.sessionId;
		const stored = this.#pool.entries(provider);
		const entry = stored.find(row => row.id === credentialId);
		if (!entry) return false;
		if (!this.allows(provider, sessionId, entry.credential)) return false;

		if (this.isLoadBalancingEnabled()) {
			if (!sessionId) return false;
			return this.pin(provider, sessionId, credentialId);
		}

		const identity = resolveAccountNameIdentity(provider, entry);
		let persisted = false;
		const write = this.#store.setProviderSelection;
		if (write) {
			try {
				write.call(this.#store, provider, identity);
				persisted = this.#store.getProviderSelection !== undefined;
			} catch (err) {
				this.reportStickyCacheFailure("selection-write", provider, err);
			}
		}
		this.#providerSelection.set(provider, { identity, readAtMs: Date.now(), persisted });
		if (sessionId) {
			this.clearPin(provider, sessionId);
			this.clear(provider, sessionId);
		} else {
			this.clearProvider(provider);
		}
		return true;
	}

	selectedProviderCredentialId(provider: string): number | undefined {
		if (this.isLoadBalancingEnabled()) return undefined;
		return this.getSelectedCredential(provider)?.credentialId;
	}

	clearProviderSelection(provider: string, options?: { sessionId?: string }): void {
		const sessionId = options?.sessionId;
		if (this.isLoadBalancingEnabled()) {
			if (sessionId) this.clearPin(provider, sessionId);
		}
		let persisted = false;
		const clear = this.#store.clearProviderSelection;
		if (clear) {
			try {
				clear.call(this.#store, provider);
				persisted = this.#store.getProviderSelection !== undefined;
			} catch (err) {
				this.reportStickyCacheFailure("selection-clear", provider, err);
			}
		}
		this.#providerSelection.set(provider, { identity: null, readAtMs: Date.now(), persisted });
		if (sessionId) {
			this.clear(provider, sessionId);
		} else {
			this.clearProvider(provider);
		}
	}

	#readProviderSelection(provider: string): string | undefined {
		const now = Date.now();
		const memo = this.#providerSelection.get(provider);
		if (memo !== undefined && (!memo.persisted || now - memo.readAtMs < PROVIDER_SELECTION_TTL_MS)) {
			return memo.identity ?? undefined;
		}
		const read = this.#store.getProviderSelection;
		const identity = read ? read.call(this.#store, provider) : undefined;
		this.#providerSelection.set(provider, {
			identity: identity ?? null,
			readAtMs: now,
			persisted: read !== undefined,
		});
		return identity;
	}

	getSelectedCredential(provider: string): ChosenCredential | undefined {
		const identity = this.#readProviderSelection(provider);
		if (!identity) return undefined;
		const stored = this.#pool.entries(provider);
		const index = stored.findIndex(entry => resolveAccountNameIdentity(provider, entry) === identity);
		const entry = index === -1 ? undefined : stored[index];
		if (!entry) return undefined;
		return { type: entry.credential.type, index, credentialId: entry.id };
	}

	getSessionCredentialPin(provider: string, sessionId: string | undefined): ChosenCredential | undefined {
		if (!sessionId) return this.getSelectedCredential(provider);
		let credentialId = this.#sessionPinnedCredential.get(provider)?.get(sessionId);
		if (credentialId === undefined) {
			try {
				const raw = this.#store.getCache(`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`);
				if (!raw) return this.getSelectedCredential(provider);
				const parsed = JSON.parse(raw) as { credentialId?: number };
				if (typeof parsed.credentialId !== "number") return this.getSelectedCredential(provider);
				credentialId = parsed.credentialId;
				const pinMap = SessionAffinity.#sessionsFor(this.#sessionPinnedCredential, provider);
				pinMap.set(sessionId, credentialId);
			} catch (err) {
				this.reportStickyCacheFailure("pin-read", provider, err);
				return this.getSelectedCredential(provider);
			}
		}
		const stored = this.#pool.entries(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		if (index === -1) {
			this.clearPin(provider, sessionId);
			return this.getSelectedCredential(provider);
		}
		const entry = stored[index];
		if (!entry || !this.allows(provider, sessionId, entry.credential)) {
			return this.getSelectedCredential(provider);
		}
		return { type: entry.credential.type, index, credentialId };
	}

	explicitChoiceIndex(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
	): number | undefined {
		const chosen = this.getSessionCredentialPin(provider, sessionId);
		if (chosen?.type !== type) return undefined;
		const credentialId = chosen.credentialId;
		if (credentialId !== undefined && this.isAuthDead(credentialId)) return undefined;
		return chosen.index;
	}

	homeIndex(provider: string, sessionId: string | undefined, type: AuthCredential["type"]): number | undefined {
		const chosen = this.explicitChoiceIndex(provider, sessionId, type);
		if (chosen !== undefined || this.isLoadBalancingEnabled()) return chosen;
		const sticky = this.getStickySessionCredential(provider, sessionId);
		if (sticky?.type !== type) return undefined;
		const credentialId = sticky.credentialId;
		if (credentialId === undefined || this.isAuthDead(credentialId)) return undefined;
		return sticky.index;
	}

	routing(provider: string, sessionId: string | undefined): SessionCredentialRouting | undefined {
		const stored = this.#pool.entries(provider);
		if (stored.length === 0) return undefined;
		const routing: SessionCredentialRouting = { provider };
		const pin = this.getSessionCredentialPin(provider, sessionId);
		const sticky = this.getStickySessionCredential(provider, sessionId);
		const stickyEntry = sticky ? stored[sticky.index] : undefined;

		if (pin) {
			routing.selectedCredentialId = pin.credentialId;
			const blockedUntil = this.#credentialBlockedUntil(
				provider,
				pin.credentialId,
				stored[pin.index]!.credential.type,
				pin.index,
			);
			if (blockedUntil !== undefined) routing.selectedBlockedUntilMs = blockedUntil;

			const choiceStillLeads =
				this.explicitChoiceIndex(provider, sessionId, stored[pin.index]!.credential.type) === pin.index;
			if (choiceStillLeads) {
				routing.activeCredentialId = pin.credentialId;
				return routing;
			}
		}

		if (
			sticky &&
			stickyEntry &&
			(!this.isLoadBalancingEnabled() || this.#credentialUsableNow(provider, stickyEntry.id, stickyEntry.credential.type, sticky.index)) &&
			!this.isAuthDead(stickyEntry.id)
		) {
			routing.activeCredentialId = stickyEntry.id;
			return routing;
		}

		const predicted = this.#predictNextCredentialId(provider, sessionId);
		if (predicted !== undefined) {
			routing.activeCredentialId = predicted;
			routing.activeIsPrediction = true;
			return routing;
		}

		if (stickyEntry) routing.activeCredentialId = stickyEntry.id;
		return routing;
	}

	#predictNextCredentialId(provider: string, sessionId: string | undefined): number | undefined {
		const stored = this.#pool.entries(provider);
		if (stored.length === 0) return undefined;
		let refused: number | undefined;
		for (const type of ["oauth", "api_key"] as const) {
			const candidates = stored
				.map((entry, index) => ({ entry, index }))
				.filter(
					candidate =>
						candidate.entry.credential.type === type &&
						this.allows(provider, sessionId, candidate.entry.credential),
				);
			if (candidates.length === 0) continue;
			const providerKey = providerTypeKey(provider, type);
			const start = !this.isLoadBalancingEnabled()
				? 0
				: sessionId
					? this.#getHashedIndex(sessionId, candidates.length)
					: ((((this.#providerRoundRobinIndex.get(providerKey) ?? -1) + 1) % candidates.length) +
							candidates.length) %
						candidates.length;
			const rotated = candidates.map((_, offset) => candidates[(start + offset) % candidates.length]!);
			const ordered = this.#orderByBlockAvailability(provider, providerKey, rotated);
			const chosen = ordered.find(candidate => !this.isAuthDead(candidate.entry.id));
			if (chosen) return chosen.entry.id;
			refused ??= ordered[0]?.entry.id;
		}
		return refused;
	}

	#credentialBlockedUntil(
		provider: string,
		credentialId: number,
		type: AuthCredential["type"],
		index: number,
	): number | undefined {
		const providerKey = providerTypeKey(provider, type);
		if (this.#blocks) {
			const until = this.#blocks.blockedUntil(provider, providerKey, index);
			if (until !== undefined) return until;
		}
		if (this.#store.getCredentialBlockScopes) {
			try {
				const scopes = this.#store.getCredentialBlockScopes(credentialId, providerKey);
				let maxBlockedUntil: number | undefined;
				for (const blockedUntil of scopes.values()) {
					if (blockedUntil > Date.now()) {
						if (maxBlockedUntil === undefined || blockedUntil > maxBlockedUntil) {
							maxBlockedUntil = blockedUntil;
						}
					}
				}
				if (maxBlockedUntil !== undefined) return maxBlockedUntil;
			} catch {}
		}
		if (this.#store.getCredentialBlock) {
			try {
				const blockedUntil = this.#store.getCredentialBlock(credentialId, providerKey, "");
				if (blockedUntil && blockedUntil > Date.now()) return blockedUntil;
			} catch {}
		}
		return undefined;
	}

	#credentialUsableNow(
		provider: string,
		credentialId: number,
		type: AuthCredential["type"],
		index: number,
	): boolean {
		return this.#credentialBlockedUntil(provider, credentialId, type, index) === undefined;
	}

	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	#orderByBlockAvailability<C extends { entry: StoredAuthCredential; index: number }>(
		provider: string,
		providerKey: string,
		candidates: readonly C[],
	): C[] {
		if (!this.isLoadBalancingEnabled()) {
			const refused = (candidate: C): boolean => this.isAuthDead(candidate.entry.id);
			return [...candidates.filter(candidate => !refused(candidate)), ...candidates.filter(refused)];
		}
		return [...candidates]
			.map((candidate, position) => ({
				candidate,
				position,
				blockedUntil:
					this.#credentialBlockedUntil(
						provider,
						candidate.entry.id,
						candidate.entry.credential.type,
						candidate.index,
					) ?? 0,
			}))
			.sort((left, right) =>
				left.blockedUntil === right.blockedUntil
					? left.position - right.position
					: left.blockedUntil - right.blockedUntil,
			)
			.map(entry => entry.candidate);
	}

	reportStickyCacheFailure(operation: string, provider: string, error: unknown): void {
		const key = `${operation}:${provider}`;
		const alreadyReported = this.#reportedStickyCacheFailures.has(key);
		this.#reportedStickyCacheFailures.add(key);
		const detail = { provider, operation, error: String(error) };
		if (alreadyReported) {
			logger.debug("Session sticky credential cache still failing", detail);
			return;
		}
		logger.warn(
			"Session sticky credential cache failed; this session is no longer pinned to one credential and may route to a different account",
			detail,
		);
	}

	/**
	 * Copy stored credential affinities from one live session to another.
	 *
	 * The target receives its own sticky entries, so request resolution, usage
	 * blocking, credential rotation, metadata, and persisted pins all continue
	 * through the target session id without retaining a live dependency on the
	 * source session. `include` limits the copy to the providers it accepts,
	 * given whether the source's affinity is an explicit user pin.
	 */
	inherit(
		sourceSessionId: string,
		targetSessionId: string,
		include?: (provider: string, explicit: boolean) => boolean,
	): number {
		if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) return 0;
		let inherited = 0;
		for (const provider of this.#pool.providers()) {
			const credential = this.get(provider, sourceSessionId);
			if (!credential || !this.#permits(provider, targetSessionId, credential.index)) continue;
			if (include && !include(provider, credential.explicit === true)) continue;
			this.record(
				provider,
				targetSessionId,
				credential.type,
				credential.index,
				credential.lastUsedAtMs,
				credential.explicit === true,
			);
			inherited += 1;
		}
		return inherited;
	}

	/**
	 * Release a session's sticky credential so its next `KeyCascade.get` call
	 * re-runs native pool ranking. This never blocks or penalizes the released
	 * account; usage-aware routing uses it when another sibling has more
	 * headroom, before considering a model/provider fallback.
	 */
	release(provider: string, sessionId: string): boolean {
		if (!this.get(provider, sessionId)) return false;
		this.clear(provider, sessionId);
		return true;
	}
}
