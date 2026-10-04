/**
 * Usage history contracts:
 *
 *   1. The SQLite store downsamples history to at most one row per hour per
 *      account window — a snapshot landing in the same hour bucket as the
 *      series' latest row overwrites it in place (latest value wins).
 *   2. Series are independent per (provider, account, limit window).
 *   3. `listUsageHistory` filters by provider / sinceMs and returns rows
 *      oldest-first.
 *   4. `cleanExpiredCache` purges expired cache rows but NEVER usage history
 *      (the hourly cap is the only storage bound; nothing else is pruned).
 *   5. AuthStorage appends one history row per limit, attributed to the
 *      fetched credential, whenever a fresh usage report lands.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import type { UsageHistoryEntry, UsageReport } from "@veyyon/ai/usage";
import * as claudeUsage from "@veyyon/ai/usage/claude";
import * as opencodeGoUsage from "@veyyon/ai/usage/opencode-go";

const HOUR = 3_600_000;
// Hour-aligned base so bucket boundaries in the tests are explicit.
const T0 = Math.floor(Date.parse("2026-06-12T10:00:00Z") / HOUR) * HOUR;

function entry(overrides: Partial<UsageHistoryEntry>): UsageHistoryEntry {
	return {
		recordedAt: T0,
		provider: "anthropic",
		accountKey: "oauth|account:account-1|email:a@example.com",
		email: "a@example.com",
		accountId: "account-1",
		limitId: "anthropic:5h",
		label: "5 Hour",
		windowLabel: "5 Hour",
		usedFraction: 0.1,
		status: "ok",
		resetsAt: T0 + 5 * HOUR,
		...overrides,
	};
}

describe("SqliteAuthCredentialStore usage history", () => {
	let store: SqliteAuthCredentialStore;

	beforeEach(() => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
	});

	afterEach(() => {
		store.close();
	});

	it("downsamples to one row per hour per series: same-bucket snapshots overwrite in place", () => {
		store.recordUsageSnapshots([entry({ recordedAt: T0, usedFraction: 0.1 })]);
		store.recordUsageSnapshots([entry({ recordedAt: T0 + 10 * 60_000, usedFraction: 0.5, status: "warning" })]);

		const sameBucket = store.listUsageHistory();
		expect(sameBucket).toHaveLength(1);
		expect(sameBucket[0]?.recordedAt).toBe(T0 + 10 * 60_000);
		expect(sameBucket[0]?.usedFraction).toBe(0.5);
		expect(sameBucket[0]?.status).toBe("warning");

		store.recordUsageSnapshots([entry({ recordedAt: T0 + HOUR + 60_000, usedFraction: 0.7 })]);
		const nextBucket = store.listUsageHistory();
		expect(nextBucket).toHaveLength(2);
		expect(nextBucket.map(row => row.usedFraction)).toEqual([0.5, 0.7]);
	});

	it("keeps independent series per account and per limit window", () => {
		store.recordUsageSnapshots([
			entry({ usedFraction: 0.2 }),
			entry({ limitId: "anthropic:7d", label: "7 Day", windowLabel: "7 Day", usedFraction: 0.4 }),
			entry({
				accountKey: "oauth|account:account-2|email:b@example.com",
				email: "b@example.com",
				usedFraction: 0.9,
			}),
		]);

		const rows = store.listUsageHistory();
		expect(rows).toHaveLength(3);
		expect(new Set(rows.map(row => `${row.accountKey}:${row.limitId}`)).size).toBe(3);
	});

	it("filters by provider and sinceMs, oldest first", () => {
		store.recordUsageSnapshots([
			entry({ recordedAt: T0 + 2 * HOUR, usedFraction: 0.6 }),
			entry({ provider: "openai-codex", limitId: "codex:5h", recordedAt: T0 }),
			entry({ recordedAt: T0, usedFraction: 0.2 }),
		]);

		expect(store.listUsageHistory({ provider: "openai-codex" })).toHaveLength(1);

		const anthropic = store.listUsageHistory({ provider: "anthropic" });
		expect(anthropic.map(row => row.recordedAt)).toEqual([T0, T0 + 2 * HOUR]);

		const recent = store.listUsageHistory({ sinceMs: T0 + HOUR });
		expect(recent).toHaveLength(1);
		expect(recent[0]?.usedFraction).toBe(0.6);
	});

	it("cleanExpiredCache purges expired cache rows but never usage history", () => {
		store.setCache("usage_cache:report:test", "{}", Math.floor(Date.now() / 1000) - 60);
		// Ancient row — must survive cleanup; there is no retention pruning.
		store.recordUsageSnapshots([entry({ recordedAt: T0 - 365 * 24 * HOUR })]);

		store.cleanExpiredCache();

		expect(store.getCache("usage_cache:report:test", { includeExpired: true })).toBeNull();
		expect(store.listUsageHistory()).toHaveLength(1);
	});
});

describe("AuthStorage usage history recording", () => {
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		store.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			access: "oat-1",
			refresh: "refresh-1",
			expires: Date.now() + HOUR,
			accountId: "account-1",
			email: "a@example.com",
		});
		// Restrict the resolver to anthropic so AuthStorage doesn't fan out real
		// network fetches for providers with *_API_KEY env vars on the test host.
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("appends one row per limit on a fresh fetch, attributed to the credential", async () => {
		const fetchedAt = Date.now();
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt,
			limits: [
				{
					id: "anthropic:5h",
					label: "5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", resetsAt: fetchedAt + 5 * HOUR },
					amount: { usedFraction: 0.42, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d",
					label: "7 Day",
					scope: { provider: "anthropic", windowId: "7d" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 84, limit: 100, unit: "percent" },
					status: "warning",
				},
			],
			metadata: { email: "a@example.com" },
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => report);

		await storage.fetchUsageReports();

		const rows = storage.listUsageHistory();
		expect(rows).toHaveLength(2);

		const fiveHour = rows.find(row => row.limitId === "anthropic:5h");
		expect(fiveHour?.provider).toBe("anthropic");
		expect(fiveHour?.usedFraction).toBe(0.42);
		expect(fiveHour?.email).toBe("a@example.com");
		expect(fiveHour?.windowLabel).toBe("5 Hour");
		expect(fiveHour?.resetsAt).toBe(fetchedAt + 5 * HOUR);
		expect(fiveHour?.recordedAt).toBe(fetchedAt);
		// Stable identity key derived from the credential, not the report.
		expect(fiveHour?.accountKey).toMatch(/^[0-9a-f]{32}$/);
		expect(fiveHour?.accountKey).not.toContain("a@example.com");

		// used/limit fallback resolves a fraction even without usedFraction.
		const sevenDay = rows.find(row => row.limitId === "anthropic:7d");
		expect(sevenDay?.usedFraction).toBeCloseTo(0.84);
		expect(sevenDay?.status).toBe("warning");
	});
});

describe("OpenCode Go usage via the upstream endpoint", () => {
	afterEach(() => {
		setSystemTime();
	});

	const WINDOWS = {
		rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T15:09:04.847Z" },
		weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.847Z" },
		monthly: { status: "ok", percent: 10, resetsAt: "2026-08-19T00:31:53.847Z" },
	};

	function json(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}

	async function storageFor(respond: () => Response): Promise<AuthStorage> {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: provider =>
				provider === "opencode-go" ? opencodeGoUsage.opencodeGoUsageProvider : undefined,
			usageFetch: (async () => respond()) as unknown as typeof fetch,
		});
		await storage.reload();
		await storage.set("opencode-go", { type: "api_key", key: "opencode-go-key" });
		return storage;
	}

	it("drops the last-good report when the key turns definitively unauthorized", async () => {
		// Transient failures serve the cached report; a 401/403 must not, or a revoked key
		// keeps rendering and ranking from stale quota until the process restarts.
		let unauthorized = false;
		const storage = await storageFor(() =>
			unauthorized ? json({ type: "error", error: { message: "Unauthorized" } }, 401) : json({ usage: WINDOWS }),
		);
		try {
			const nowMs = Date.now();
			setSystemTime(new Date(nowMs));
			const fresh = await storage.fetchUsageReports();
			expect(fresh?.some(report => report.provider === "opencode-go")).toBe(true);

			unauthorized = true;
			setSystemTime(new Date(nowMs + 10 * 60_000));
			const after = await storage.fetchUsageReports();
			expect(after?.some(report => report.provider === "opencode-go")).toBe(false);
		} finally {
			storage.close();
		}
	});

	it("retains the last-good report through a partial payload", async () => {
		let partial = false;
		const storage = await storageFor(() =>
			json({ usage: { ...WINDOWS, rolling: partial ? { status: "ok", percent: "abc" } : WINDOWS.rolling } }),
		);
		try {
			const nowMs = Date.now();
			setSystemTime(new Date(nowMs));
			const fresh = await storage.fetchUsageReports();
			expect(fresh?.find(report => report.provider === "opencode-go")?.limits).toHaveLength(3);

			partial = true;
			setSystemTime(new Date(nowMs + 10 * 60_000));
			const after = await storage.fetchUsageReports();
			const retained = after?.find(report => report.provider === "opencode-go");
			expect(retained?.limits.map(limit => limit.id)).toEqual(["rolling-5h", "weekly", "monthly"]);
		} finally {
			storage.close();
		}
	});
});
