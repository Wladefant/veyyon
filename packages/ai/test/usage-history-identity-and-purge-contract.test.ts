/**
 * WHY: review of https://github.com/Wladefant/veyyon/pull/449 left two P3 notes, tracked in
 * https://github.com/Wladefant/veyyon/issues/495:
 *
 *   N1. the usage identity joined its parts with `|` and no escaping, so a stored accountId that holds
 *       `|email:` collided with a different account that has that accountId and email, and their history
 *       and cache rows merged;
 *   N2. a store with `listUsageHistory` but no `purgeUsageHistory` kept raw pre-redaction rows (which hold
 *       account ids and whatever a backend put in labels) and `AuthStorage.listUsageHistory()` returned them.
 *
 * Existing history keys must stay readable (live repo): an identity with no `|` or `\` in any field must give
 * the exact key the unescaped join gave.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { buildUsageCacheIdentity, buildUsageHistoryAccountKey } from "@veyyon/ai/auth-storage/usage-requests";
import type { UsageCredential } from "@veyyon/ai/usage";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function credential(fields: Partial<UsageCredential>): UsageCredential {
	return { type: "oauth", accessToken: "tok", ...fields } as UsageCredential;
}

describe("usage identity is unambiguous (N1)", () => {
	it("keeps an accountId that embeds `|email:` apart from the account with that accountId and email", () => {
		const embedded = credential({ accountId: "x|email:y@z.io" });
		const split = credential({ accountId: "x", email: "y@z.io" });
		expect(buildUsageCacheIdentity(embedded)).not.toBe(buildUsageCacheIdentity(split));
		expect(buildUsageHistoryAccountKey(embedded)).not.toBe(buildUsageHistoryAccountKey(split));
	});

	it("keeps a backslash-ended field apart from the field that follows it", () => {
		const a = credential({ accountId: "x\\", email: "y@z.io" });
		const b = credential({ accountId: "x", email: "\\y@z.io" });
		expect(buildUsageHistoryAccountKey(a)).not.toBe(buildUsageHistoryAccountKey(b));
	});

	it("keeps existing history keys for identities that need no escaping", () => {
		const legacyIdentity = "oauth|account:acct-1|email:a@example.com|org:org-1";
		const legacyKey = createHash("sha256").update(legacyIdentity).digest("hex").slice(0, 32);
		const key = buildUsageHistoryAccountKey(
			credential({ accountId: "acct-1", email: "A@Example.com", orgId: "org-1" }),
		);
		expect(key).toBe(legacyKey);
	});
});

describe("a store without purgeUsageHistory (N2)", () => {
	it("never lists raw pre-redaction rows, and still lists digest-keyed rows", async () => {
		const legacy = "fake-legacy-secret-token-495495495";
		const db = new Database(":memory:");
		const real = new SqliteAuthCredentialStore(db);
		cleanups.push(() => real.close());
		const digestKey = createHash("sha256").update("oauth|account:ok").digest("hex").slice(0, 32);
		real.recordUsageSnapshots([
			{
				recordedAt: Date.now(),
				provider: "fake-usage-backend",
				accountKey: `oauth|account:${legacy}`,
				email: `${legacy}@example.test`,
				accountId: legacy,
				limitId: "five",
				label: `Window ${legacy}`,
				usedFraction: 0.5,
				status: "ok",
			},
			{
				recordedAt: Date.now(),
				provider: "fake-usage-backend",
				accountKey: digestKey,
				limitId: "five",
				label: "Five hour",
				usedFraction: 0.1,
				status: "ok",
			},
		]);
		// A custom store: reads history, has no purge.
		const store = new Proxy(real, {
			get(target, prop) {
				if (prop === "purgeUsageHistory") return undefined;
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		expect(store.purgeUsageHistory).toBeUndefined();
		expect(JSON.stringify(real.listUsageHistory())).toContain(legacy);

		const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.reload();
		const rows = storage.listUsageHistory();
		expect(JSON.stringify(rows)).not.toContain(legacy);
		expect(rows.map(row => row.accountKey)).toEqual([digestKey]);
	});
});
