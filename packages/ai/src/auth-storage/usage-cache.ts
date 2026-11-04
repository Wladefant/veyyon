/**
 * The usage-report cache, persisted through the credential store's cache table.
 */

import type { AuthCredentialStore } from "./types";

const USAGE_CACHE_PREFIX = "usage_cache:";

const USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000;

type UsageCacheEntry<T> = {
	value: T;
	expiresAt: number;
};

export interface UsageCache {
	get<T>(key: string): UsageCacheEntry<T> | undefined;
	getStale<T>(key: string): UsageCacheEntry<T> | undefined;
	set<T>(key: string, entry: UsageCacheEntry<T>): void;
	cleanup?(): void;
}

/**
 * Stamped on every entry this code writes. Rows written before redaction existed carry no stamp and may
 * hold a credential a backend echoed into a report; an unstamped row reads as a miss, so it is neither
 * served fresh nor offered as the stale last-good report, and the next fetch overwrites it. Raise it
 * whenever the persisted entry shape or what is allowed in it changes.
 */
const USAGE_CACHE_ENTRY_VERSION = 2;

function parseUsageCacheEntry<T>(raw: string): UsageCacheEntry<T> | undefined {
	try {
		const parsed = JSON.parse(raw) as { value?: T; expiresAt?: unknown; v?: unknown };
		if (parsed.v !== USAGE_CACHE_ENTRY_VERSION) return undefined;
		const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined;
		if (!expiresAt || !Number.isFinite(expiresAt)) return undefined;
		return { value: parsed.value as T, expiresAt };
	} catch {
		// A cache entry we cannot read is a cache MISS, which is the same answer an absent entry gives and
		// the caller handles by fetching fresh. Never a wrong answer, only a slower one.
		return undefined;
	}
}

/**
 * Prefixes of report rows written before keys carried an identity digest. Their keys hold the raw
 * accountId, email and orgId, and their values predate redaction, so they are deleted rather than
 * left to age out: nothing reads them any more.
 */
const LEGACY_USAGE_CACHE_PREFIXES = [`${USAGE_CACHE_PREFIX}report:`];

export class AuthStorageUsageCache implements UsageCache {
	constructor(private store: AuthCredentialStore) {
		for (const prefix of LEGACY_USAGE_CACHE_PREFIXES) {
			try {
				this.store.deleteCachePrefix?.(prefix);
			} catch {
				// The rows are unreadable under the new keys either way; a failed purge only delays it.
			}
		}
	}

	get<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`);
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	getStale<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`, { includeExpired: true });
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	set<T>(key: string, entry: UsageCacheEntry<T>): void {
		const payload = JSON.stringify({ v: USAGE_CACHE_ENTRY_VERSION, value: entry.value, expiresAt: entry.expiresAt });
		const durableExpiresAt =
			entry.value === null ? entry.expiresAt : Math.max(entry.expiresAt, Date.now() + USAGE_LAST_GOOD_RETENTION_MS);
		this.store.setCache(`${USAGE_CACHE_PREFIX}${key}`, payload, Math.floor(durableExpiresAt / 1000));
	}

	cleanup(): void {
		this.store.cleanExpiredCache();
	}
}
