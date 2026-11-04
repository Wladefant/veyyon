/**
 * An Anthropic usage report must carry the account it was fetched for, not its organization.
 *
 * WHY. The usage fetcher used to fall back to the `anthropic-organization-id` response header for
 * the report's `accountId`, while the stored credential holds the account uuid. With two Anthropic
 * accounts, `limitMatchesActiveAccount` rejects a report whose account id differs from the row's,
 * so neither row received a window and the Accounts screen showed no bars at all although every
 * fetch succeeded. A single account hid the defect because attribution is skipped for a sole
 * credential.
 *
 * CLASS. Drives the real Claude usage provider and the real inventory merge together, so any
 * identity the provider writes that the matcher refuses fails here, whichever field it comes from.
 *
 * GAP. A mocked `fetch` stands in for api.anthropic.com; a live change in the payload's identity
 * fields is not caught.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type UsageReport } from "@veyyon/ai";
import type { UsageFetchContext } from "@veyyon/ai/usage";
import { claudeUsageProvider } from "@veyyon/ai/usage/claude";
import { applyUsageReports, buildAccountInventory } from "@veyyon/coding-agent/session/account-inventory";

const HOUR_MS = 60 * 60_000;

interface FixtureAccount {
	email: string;
	accountId: string;
	orgId: string;
	fiveHourPercent: number;
}

const FIRST: FixtureAccount = {
	email: "first@example.com",
	accountId: "11111111-aaaa-4aaa-8aaa-111111111111",
	orgId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
	fiveHourPercent: 7,
};
const SECOND: FixtureAccount = {
	email: "second@example.com",
	accountId: "22222222-bbbb-4bbb-8bbb-222222222222",
	orgId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
	fiveHourPercent: 31,
};

/** The usage endpoint as observed: bars in the body, the org id in a header, no account identity. */
function usageFetchFor(account: FixtureAccount): UsageFetchContext {
	const fetchMock = (async () =>
		new Response(JSON.stringify({ five_hour: { utilization: account.fiveHourPercent } }), {
			status: 200,
			headers: { "Content-Type": "application/json", "anthropic-organization-id": account.orgId },
		})) as unknown as typeof fetch;
	return { fetch: fetchMock };
}

async function fetchReportFor(account: FixtureAccount, withStoredAccountId = true): Promise<UsageReport> {
	const report = await claudeUsageProvider.fetchUsage(
		{
			provider: "anthropic",
			credential: {
				type: "oauth",
				accessToken: `access-${account.email}`,
				...(withStoredAccountId ? { accountId: account.accountId } : {}),
				email: account.email,
				expiresAt: Date.now() + HOUR_MS,
			},
		},
		usageFetchFor(account),
	);
	if (!report) throw new Error("usage fetch returned no report");
	return report;
}

describe("an Anthropic usage report names the account that fetched it", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		await authStorage.reload();
	});

	afterEach(() => {
		store?.close();
		store = null;
		authStorage = null;
	});

	test("the report keeps the credential's account uuid and carries the org id separately", async () => {
		const report = await fetchReportFor(FIRST);

		expect(report.metadata?.accountId).toBe(FIRST.accountId);
		expect(report.metadata?.orgId).toBe(FIRST.orgId);
	});

	test("two stored accounts each receive their own windows from their own reports", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		await storage.set("anthropic", [
			{
				type: "oauth",
				access: "access-first",
				refresh: "refresh-first",
				expires: Date.now() + HOUR_MS,
				accountId: FIRST.accountId,
				email: FIRST.email,
				orgId: FIRST.orgId,
				orgName: "First Org",
			},
			{
				type: "oauth",
				access: "access-second",
				refresh: "refresh-second",
				expires: Date.now() + HOUR_MS,
				accountId: SECOND.accountId,
				email: SECOND.email,
				orgId: SECOND.orgId,
				orgName: "Second Org",
			},
		]);
		const reports = [await fetchReportFor(FIRST), await fetchReportFor(SECOND)];

		const rows = applyUsageReports(buildAccountInventory(storage), reports).providers[0]?.rows ?? [];

		const fiveHourByEmail = new Map(rows.map(row => [row.email, row.usage.map(window => window.usedFraction)]));
		expect(fiveHourByEmail.get(FIRST.email)).toEqual([0.07]);
		expect(fiveHourByEmail.get(SECOND.email)).toEqual([0.31]);
	});
});
