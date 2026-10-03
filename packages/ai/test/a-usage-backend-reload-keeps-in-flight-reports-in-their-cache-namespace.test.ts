/**
 * WHY: A backend reload must not join the old backend's flight or cache its report under the new namespace.
 * Uses the real credential store and AuthStorage; only the remote quota replies are fixed.
 * This covers process-local replacement, not cross-process broker refresh leases.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import type { UsageProvider } from "@veyyon/ai/usage";
import { AUTH_HTTP_CONCURRENCY_LIMIT, withAuthHttpConcurrency } from "../src/auth-storage/http-concurrency";

test("a queued usage probe retains its backend while a replacement gets a separate flight and cache", async () => {
	const original: UsageProvider = {
		id: "anthropic",
		cacheVersion: "original",
		async fetchUsage() {
			return { provider: "anthropic", fetchedAt: 1, limits: [], metadata: { source: "original" } };
		},
	};
	const replacement: UsageProvider = {
		id: "anthropic",
		cacheVersion: "replacement",
		async fetchUsage() {
			return { provider: "anthropic", fetchedAt: 1, limits: [], metadata: { source: "replacement" } };
		},
	};
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: () => original,
	});
	await storage.set("anthropic", { type: "api_key", key: "fake-usage-key" });
	const queueReleased = Promise.withResolvers<void>();
	const blockers = Array.from({ length: AUTH_HTTP_CONCURRENCY_LIMIT }, () =>
		withAuthHttpConcurrency(() => queueReleased.promise),
	);
	const first = storage.fetchUsageReports();
	storage.setUsageProvider("anthropic", replacement);
	const second = storage.fetchUsageReports();
	queueReleased.resolve();
	try {
		const reports = await second;
		expect(reports?.[0]?.metadata?.source).toBe("replacement");
		expect((await first)?.[0]?.metadata?.source).toBe("original");
		storage.removeUsageProvider("anthropic");
		expect((await storage.fetchUsageReports())?.[0]?.metadata?.source).toBe("original");
		storage.setUsageProvider("anthropic", replacement);
		expect((await storage.fetchUsageReports())?.[0]?.metadata?.source).toBe("replacement");
	} finally {
		queueReleased.resolve();
		await Promise.all([first, second, ...blockers]);
		storage.close();
	}
});
