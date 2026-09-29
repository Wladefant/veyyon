/**
 * Two Antigravity accounts share one GCP project (`aicode-consumers`), so the project cannot tell them
 * apart. Each is fetched with its own token and answers with its own quota; the reports that come back
 * from `AuthStorage.fetchUsageReports` must stay two, each carrying its own account's numbers.
 *
 * DEFECT: a report that named no email was identified by its project alone, so two such accounts
 * collapsed into one group and `mergeUsageReportGroup` kept the first account's limits and dropped the
 * second's (same limit ids), showing one account's usage for both (veyyon#102).
 *
 * CLASS: every way an Antigravity credential can lose the email that keys it - neither has one, only
 * one has one - crossed with the HTTP layer answering per token.
 *
 * GAP: this drives the real provider and store contract against a faked HTTP layer; it does not
 * exercise the renderers (see coding-agent's `antigravity-accounts-render-apart.test.ts`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@veyyon/ai/auth-storage";
import type { UsageReport } from "@veyyon/ai/usage";
import { antigravityUsageProvider } from "@veyyon/ai/usage/google-antigravity";

const PROJECT = "aicode-consumers";

interface Account {
	token: string;
	email?: string;
	geminiWeeklyRemaining: number;
	claudeWeeklyRemaining: number;
}

const FIRST: Account = {
	token: "token-first",
	email: "first@example.com",
	geminiWeeklyRemaining: 0.08,
	claudeWeeklyRemaining: 0,
};
const SECOND: Account = {
	token: "token-second",
	email: "second@example.com",
	geminiWeeklyRemaining: 0.47,
	claudeWeeklyRemaining: 0.9,
};

function quotaSummary(account: Account) {
	const group = (displayName: string, prefix: string, weekly: number) => ({
		displayName,
		description: "",
		buckets: [
			{
				bucketId: `${prefix}-weekly`,
				window: "weekly",
				resetTime: "2026-10-02T18:00:00Z",
				remainingFraction: weekly,
			},
			{ bucketId: `${prefix}-5h`, window: "5h", resetTime: "2026-09-30T18:00:00Z", remainingFraction: weekly },
		],
	});
	return {
		groups: [
			group("Gemini Models", "gemini", account.geminiWeeklyRemaining),
			group("Claude and GPT models", "3p", account.claudeWeeklyRemaining),
		],
	};
}

/** The HTTP layer: answers with the quota of whichever account owns the bearer token. */
function fakeAntigravityHttp(accounts: readonly Account[], seenTokens: string[]): typeof fetch {
	const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		const token = authorization.replace(/^Bearer /, "");
		seenTokens.push(token);
		const account = accounts.find(candidate => candidate.token === token);
		if (!account) return new Response("{}", { status: 401 });
		return new Response(JSON.stringify(quotaSummary(account)), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return impl as typeof fetch;
}

function makeStore(accounts: readonly Account[]): AuthCredentialStore {
	const rows: StoredAuthCredential[] = accounts.map((account, index) => ({
		id: index + 1,
		provider: "google-antigravity",
		credential: {
			type: "oauth",
			access: account.token,
			refresh: `refresh-${index}`,
			expires: Date.now() + 3_600_000,
			projectId: PROJECT,
			email: account.email,
		} satisfies AuthCredential,
		disabledCause: null,
	}));
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials: () => rows,
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider: () => rows,
		upsertAuthCredentialForProvider: () => rows,
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			return entry && entry.expiresAtSec * 1000 > Date.now() ? entry.value : null;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function limitFor(report: UsageReport, counter: "google" | "claude-gpt", window: "weekly" | "5h") {
	return report.limits.find(limit => limit.id.includes(`:${counter}:`) && limit.scope.windowId === window);
}

/** The reports as `[first, second]`, told apart by the Gemini weekly figure the fake HTTP layer gave each. */
function byAccount(reports: UsageReport[]): { first?: UsageReport; second?: UsageReport } {
	const geminiWeeklyUsed = (report: UsageReport) => limitFor(report, "google", "weekly")?.amount.usedFraction;
	return {
		first: reports.find(report => geminiWeeklyUsed(report) === 1 - FIRST.geminiWeeklyRemaining),
		second: reports.find(report => geminiWeeklyUsed(report) === 1 - SECOND.geminiWeeklyRemaining),
	};
}

describe("two Antigravity accounts sharing one project report apart", () => {
	let storage: AuthStorage | undefined;
	afterEach(() => {
		storage?.close();
		storage = undefined;
	});

	const identityShapes: Array<{ name: string; accounts: Account[] }> = [
		{ name: "both carry an email", accounts: [FIRST, SECOND] },
		{
			name: "neither carries an email",
			accounts: [
				{ ...FIRST, email: undefined },
				{ ...SECOND, email: undefined },
			],
		},
		{ name: "only the first carries an email", accounts: [FIRST, { ...SECOND, email: undefined }] },
		{ name: "only the second carries an email", accounts: [{ ...FIRST, email: undefined }, SECOND] },
	];

	for (const shape of identityShapes) {
		it(`keeps each account's own quota when ${shape.name}`, async () => {
			const seenTokens: string[] = [];
			storage = new AuthStorage(makeStore(shape.accounts), {
				usageFetch: fakeAntigravityHttp(shape.accounts, seenTokens),
				usageProviderResolver: provider =>
					provider === "google-antigravity" ? antigravityUsageProvider : undefined,
			});
			await storage.reload();

			const reports = ((await storage.fetchUsageReports()) ?? []).filter(
				report => report.provider === "google-antigravity",
			);

			expect(reports).toHaveLength(2);
			// Each account is asked with its own token, never one token twice.
			expect(new Set(seenTokens)).toEqual(new Set([FIRST.token, SECOND.token]));
			const { first, second } = byAccount(reports);
			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(limitFor(first!, "claude-gpt", "weekly")?.amount.usedFraction).toBe(1 - FIRST.claudeWeeklyRemaining);
			expect(limitFor(second!, "claude-gpt", "weekly")?.amount.usedFraction).toBe(1 - SECOND.claudeWeeklyRemaining);
		});
	}
});
