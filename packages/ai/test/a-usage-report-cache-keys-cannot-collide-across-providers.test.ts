/**
 * WHY: The persisted usage-report key was `report:<cacheVersion>:<provider>:...` joined with ":", so
 * provider `a` + cacheVersion `x:y` and provider `y:a` + cacheVersion `x` (same key, same base URL)
 * shared a row and the second provider was served the first one's report without its backend running.
 * The aggregate flight key had the same shape. Both now encode their parts as a JSON array.
 * Drives the real AuthStorage over a real SQLite store; only the quota replies are fixed.
 * Gap: it pins the collision pair and the layout bump, not every possible delimiter pair; the
 * encoding makes the whole class impossible, which the second test samples with random-looking parts.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import {
	buildUsageCacheIdentity,
	buildUsageReportCacheKey,
	buildUsageReportsCacheKey,
} from "@veyyon/ai/auth-storage/usage-requests";
import type { UsageProvider } from "@veyyon/ai/usage";

const BASE_URL = "https://api.example.com";

function backend(id: string, cacheVersion: string, source: string, calls: string[]): UsageProvider {
	return {
		id,
		cacheVersion,
		async fetchUsage() {
			calls.push(source);
			return { provider: id, fetchedAt: 1, limits: [], metadata: { source } };
		},
	};
}

test("provider a/version x:y and provider y:a/version x do not share a persisted report", async () => {
	const calls: string[] = [];
	const providers = new Map<string, UsageProvider>([
		["a", backend("a", "x:y", "source-a", calls)],
		["y:a", backend("y:a", "x", "source-y-a", calls)],
	]);
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: provider => providers.get(provider),
	});
	const options = { baseUrlResolver: () => BASE_URL };
	try {
		await storage.set("a", { type: "api_key", key: "fake-shared-key" });
		const first = await storage.fetchUsageReports(options);
		expect(first?.map(report => report.metadata?.source)).toEqual(["source-a"]);

		await storage.remove("a");
		await storage.set("y:a", { type: "api_key", key: "fake-shared-key" });
		const second = await storage.fetchUsageReports(options);
		expect(second?.map(report => report.metadata?.source)).toEqual(["source-y-a"]);
		expect(calls).toEqual(["source-a", "source-y-a"]);
	} finally {
		storage.close();
	}
});

test("a report row persisted under the previous key layout is not served", async () => {
	const calls: string[] = [];
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const provider = backend("a", "v1", "fresh", calls);
	const storage = new AuthStorage(store, { usageProviderResolver: () => provider });
	try {
		await storage.set("a", { type: "api_key", key: "fake-stale-key" });
		// The legacy layout: `report:<version>:<provider>:<baseUrl>:<identity>`. Seed it with a
		// far-future expiry so only a key mismatch can keep it from being served.
		const staleEntry = JSON.stringify({
			value: { provider: "a", fetchedAt: 1, limits: [], metadata: { source: "stale-legacy-row" } },
			expiresAt: Date.now() + 3_600_000,
		});
		const legacyIdentity = buildUsageCacheIdentity({ type: "api_key", apiKey: "fake-stale-key" });
		store.setCache(
			`usage_cache:report:v1:a:${BASE_URL}:${legacyIdentity}`,
			staleEntry,
			Math.floor(Date.now() / 1000) + 3600,
		);

		const reports = await storage.fetchUsageReports({ baseUrlResolver: () => BASE_URL });
		expect(reports?.map(report => report.metadata?.source)).toEqual(["fresh"]);
		expect(calls).toEqual(["fresh"]);
	} finally {
		storage.close();
	}
});

test("keys differ for every way of moving a delimiter between provider and cacheVersion", () => {
	const credential = { type: "api_key" as const, apiKey: "fake-key" };
	const parts = ["a", "y", "x", "y:a", "a:x", "x:y", ""];
	const seen = new Map<string, string>();
	const seenAggregate = new Map<string, string>();
	for (const provider of parts) {
		for (const cacheVersion of parts) {
			const request = { provider, credential, baseUrl: BASE_URL, cacheVersion };
			const label = JSON.stringify([provider, cacheVersion]);
			for (const [map, key] of [
				[seen, buildUsageReportCacheKey(request)],
				[seenAggregate, buildUsageReportsCacheKey([request])],
			] as const) {
				expect(map.get(key)).toBeUndefined();
				map.set(key, label);
			}
		}
	}
});
