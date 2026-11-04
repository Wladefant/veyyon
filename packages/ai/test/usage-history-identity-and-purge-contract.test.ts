/**
 * WHY: review of https://github.com/Wladefant/veyyon/pull/449 left two P3 notes, tracked in
 * https://github.com/Wladefant/veyyon/issues/495:
 *
 *   N1. the usage identity joined its parts with `|` and no escaping, so a stored accountId that holds
 *       `|email:` collided with a different account that has that accountId and email, and their history
 *       and cache rows merged;
 *   N2. a store with `listUsageHistory` but no `purgeUsageHistory` (or one whose purge throws) kept raw
 *       pre-redaction rows (which hold account ids and whatever a backend put in labels) and
 *       `AuthStorage.listUsageHistory()` returned them.
 *
 * Existing history keys stay readable (live repo) for every identity with no `|` or `\` in any field: it gives
 * the exact key the unescaped join gave. An identity that holds either character changes key, so its history
 * series restarts under the new key; before, it could collide with another account.
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

	it("keeps a backslash-ended accountId apart from an accountId that holds the escaped pipe (pipe-only escape collides)", () => {
		const backslashEnded = credential({ accountId: "a\\", email: "b" });
		const pipeEmbedded = credential({ accountId: "a|email:b" });
		expect(buildUsageCacheIdentity(backslashEnded)).not.toBe(buildUsageCacheIdentity(pipeEmbedded));
		expect(buildUsageHistoryAccountKey(backslashEnded)).not.toBe(buildUsageHistoryAccountKey(pipeEmbedded));
	});

	it("keeps a backslash-ended field apart from the field that follows it", () => {
		const a = credential({ accountId: "x\\", email: "y@z.io" });
		const b = credential({ accountId: "x", email: "\\y@z.io" });
		expect(buildUsageHistoryAccountKey(a)).not.toBe(buildUsageHistoryAccountKey(b));
	});

	const FIELD_CASES: Array<[string, Partial<UsageCredential>, Partial<UsageCredential>]> = [
		["email", { email: "a|org:b" }, { email: "a", orgId: "b" }],
		["orgId", { orgId: "a|project:b" }, { orgId: "a", projectId: "b" }],
		["projectId", { projectId: "a|enterprise:b" }, { projectId: "a", enterpriseUrl: "b" }],
	];
	for (const [field, embedded, split] of FIELD_CASES) {
		it(`keeps a ${field} that embeds the next part apart from the identity with the split fields`, () => {
			const a = credential(embedded);
			const b = credential(split);
			expect(buildUsageCacheIdentity(a)).not.toBe(buildUsageCacheIdentity(b));
			expect(buildUsageHistoryAccountKey(a)).not.toBe(buildUsageHistoryAccountKey(b));
		});
	}

	// `type` leads and `enterpriseUrl` ends the identity, and the part after enterpriseUrl is a fixed token, so no
	// second identity can collide through them. Their escape is still part of the contract: splitting the identity on
	// its unescaped pipes must give back exactly the parts that went in.
	function unescapedParts(identity: string): string[] {
		return identity.match(/(?:\\.|[^|])+/g) ?? [];
	}

	it("writes a pipe inside the type as one part", () => {
		const identity = buildUsageCacheIdentity(credential({ type: "oauth|account:x" as UsageCredential["type"] }));
		expect(unescapedParts(identity)).toEqual(["oauth\\|account:x", expect.stringMatching(/^secret:/)]);
	});

	it("writes a pipe inside the enterpriseUrl as one part", () => {
		const identity = buildUsageCacheIdentity(credential({ enterpriseUrl: "a|anonymous", accessToken: undefined }));
		expect(unescapedParts(identity)).toEqual(["oauth", "enterprise:a\\|anonymous", "anonymous"]);
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

describe("raw history rows never leave AuthStorage (N2)", () => {
	const legacy = "fake-legacy-secret-token-495495495";
	const digestKey = createHash("sha256").update("oauth|account:ok").digest("hex").slice(0, 32);

	/** A store holding one raw pre-redaction row and one digest-keyed row, with `purge` replacing the store's own. */
	function seededStore(purge: (() => void) | undefined): SqliteAuthCredentialStore {
		const real = new SqliteAuthCredentialStore(new Database(":memory:"));
		cleanups.push(() => real.close());
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
		expect(JSON.stringify(real.listUsageHistory())).toContain(legacy);
		return new Proxy(real, {
			get(target, prop) {
				if (prop === "purgeUsageHistory") return purge;
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	async function listed(store: SqliteAuthCredentialStore) {
		const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.reload();
		return storage.listUsageHistory();
	}

	it("lists no raw row from a store without purgeUsageHistory, and still lists digest-keyed rows", async () => {
		const store = seededStore(undefined);
		expect(store.purgeUsageHistory).toBeUndefined();
		const rows = await listed(store);
		expect(JSON.stringify(rows)).not.toContain(legacy);
		expect(rows.map(row => row.accountKey)).toEqual([digestKey]);
	});

	it("lists no raw row when purgeUsageHistory throws, so a failed purge cannot leak", async () => {
		const store = seededStore(() => {
			throw new Error("purge failed");
		});
		const rows = await listed(store);
		expect(JSON.stringify(rows)).not.toContain(legacy);
		expect(rows.map(row => row.accountKey)).toEqual([digestKey]);
	});
});
