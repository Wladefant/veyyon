/**
 * Subject: `auth-storage/usage-ranking.ts`, driven through `CredentialRanking`.
 *
 * Credential ranking fetches every account's usage in parallel under one deadline, so a slow or
 * rate-limited usage endpoint cannot hold credential selection. Two defects lived on that deadline:
 * an OAuth ranking that missed it dropped every account's block and ranked them in storage order,
 * so a provider-wide quota wall put the longest-blocked account first; and the deadline timer was
 * cleared only when the race settled successfully, so a rejected usage fetch left it armed.
 *
 * This suite pins, for API keys and OAuth accounts alike: the deadline's bound, the block-aware
 * order past it, the timer cleared on every exit, and which blocked accounts are still fetched.
 * It does not cover the window scoring itself, which `auth-storage-codex-selection.test.ts` drives
 * through `AuthStorage`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ApiKeySelection, OAuthSelection } from "../src/auth-storage/credentials";
import type { RankingBlocks, RankingUsage } from "../src/auth-storage/usage-ranking";
import { CredentialRanking } from "../src/auth-storage/usage-ranking";
import type { CredentialRankingStrategy, UsageReport } from "../src/usage";

const STRATEGY: CredentialRankingStrategy = {
	findWindowLimits: () => ({}),
	windowDefaults: { primaryMs: 5 * 60 * 60 * 1000, secondaryMs: 7 * 24 * 60 * 60 * 1000 },
};

/** Blocks keyed by credential index; records every block a ranking pass writes. */
function recordingBlocks(
	initial: Record<number, number>,
): RankingBlocks & { marked: Array<[number, number]>; lift(index: number): void } {
	const until = new Map(Object.entries(initial).map(([index, at]) => [Number(index), at]));
	const marked: Array<[number, number]> = [];
	return {
		marked,
		lift: index => {
			until.delete(index);
		},
		getCredentialBlockedUntil: (_provider, _key, index) => until.get(index),
		markCredentialBlocked: (_provider, _key, index, blockedUntilMs) => {
			until.set(index, blockedUntilMs);
			marked.push([index, blockedUntilMs]);
		},
	};
}

/** A report whose one limit is spent until `resetsAt`, or has headroom when `resetsAt` is absent. */
function report(resetsAt?: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: 0,
		limits: [
			{
				id: "weekly",
				label: "Weekly",
				scope: { provider: "anthropic" },
				window: { id: "weekly", label: "Weekly", resetsAt },
				amount: { usedFraction: resetsAt === undefined ? 0.2 : 1, unit: "percent" },
			},
		],
	};
}

/** A usage fetch answered per credential label; an unanswered label never settles. */
function scriptedUsage(
	requestTimeoutMs: number,
	answers: Record<string, () => Promise<UsageReport | null>>,
): RankingUsage & { fetched: string[] } {
	const fetched: string[] = [];
	return {
		fetched,
		requestTimeoutMs,
		reportFor: (_provider, credential) => {
			const label = credential.type === "oauth" ? credential.access : credential.key;
			fetched.push(label);
			const answer = answers[label];
			return answer ? answer() : Promise.withResolvers<UsageReport | null>().promise;
		},
	};
}

function oauth(labels: string[]): OAuthSelection[] {
	return labels.map((label, index) => ({
		index,
		credential: { type: "oauth", access: label, refresh: `${label}-refresh`, expires: Number.MAX_SAFE_INTEGER },
	}));
}

function apiKeys(labels: string[]): ApiKeySelection[] {
	return labels.map((label, index) => ({ index, credential: { type: "api_key", key: label } }));
}

function request<S>(provider: string, credentials: S[]) {
	return {
		provider,
		providerKey: `${provider}:test`,
		order: credentials.map((_credential, index) => index),
		credentials,
		strategy: STRATEGY,
		rankingContext: {},
	};
}

function labelsOf(candidates: Array<{ selection: OAuthSelection | ApiKeySelection }>): string[] {
	return candidates.map(({ selection: { credential } }) =>
		credential.type === "oauth" ? credential.access : credential.key,
	);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("a usage ranking that misses its deadline", () => {
	it("waits one and a half usage request timeouts, and no less than five seconds", async () => {
		vi.useFakeTimers();
		for (const [requestTimeoutMs, deadlineMs] of [
			[10_000, 15_000],
			[1_000, 5_000],
		]) {
			const ranking = new CredentialRanking(recordingBlocks({}), scriptedUsage(requestTimeoutMs, {}));
			let settled = false;
			const ranked = ranking.rankApiKeySelections(request("anthropic", apiKeys(["k0"]))).then(result => {
				settled = true;
				return result;
			});
			vi.advanceTimersByTime(deadlineMs - 1);
			await Promise.resolve();
			expect(settled).toBe(false);
			vi.advanceTimersByTime(1);
			expect(labelsOf(await ranked)).toEqual(["k0"]);
		}
	});

	it("puts OAuth accounts that are not blocked first, then the blocked ones by the soonest reset", async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const ranking = new CredentialRanking(
			recordingBlocks({ 0: now + 60_000, 1: now + 10_000 }),
			scriptedUsage(1_000, {}),
		);
		const ranked = ranking.rankOAuthSelections({
			...request("anthropic", oauth(["longest-blocked", "soonest-reset", "free"])),
			planRequirement: "none",
		});
		vi.advanceTimersByTime(5_000);
		expect(labelsOf(await ranked)).toEqual(["free", "soonest-reset", "longest-blocked"]);
	});

	it("puts API keys that are not blocked first, then the blocked ones by the soonest reset", async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const ranking = new CredentialRanking(
			recordingBlocks({ 0: now + 60_000, 1: now + 10_000 }),
			scriptedUsage(1_000, {}),
		);
		const ranked = ranking.rankApiKeySelections(
			request("anthropic", apiKeys(["longest-blocked", "soonest-reset", "free"])),
		);
		vi.advanceTimersByTime(5_000);
		expect(labelsOf(await ranked)).toEqual(["free", "soonest-reset", "longest-blocked"]);
	});
});

describe("the usage deadline timer", () => {
	it("is cleared when every usage fetch answers in time, and the answers rank the accounts", async () => {
		vi.useFakeTimers();
		const ranking = new CredentialRanking(
			recordingBlocks({}),
			scriptedUsage(1_000, { unmeasured: async () => null, measured: async () => report() }),
		);
		const ranked = await ranking.rankOAuthSelections({
			...request("anthropic", oauth(["unmeasured", "measured"])),
			planRequirement: "none",
		});
		expect(labelsOf(ranked)).toEqual(["measured", "unmeasured"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("is cleared when a usage fetch fails, and the failure reaches the caller", async () => {
		vi.useFakeTimers();
		const ranking = new CredentialRanking(
			recordingBlocks({}),
			scriptedUsage(1_000, {
				a: async () => {
					throw new Error("usage fetch aborted");
				},
			}),
		);
		const outcome = await ranking.rankApiKeySelections(request("anthropic", apiKeys(["a"]))).then(
			() => "ranked",
			(error: Error) => error.message,
		);
		expect(outcome).toBe("usage fetch aborted");
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("a usage report that answers in time", () => {
	it("blocks the account until the window resets and ranks it behind one with headroom", async () => {
		const resetsAt = Date.now() + 30 * 60 * 1000;
		const blocks = recordingBlocks({});
		const ranked = await new CredentialRanking(
			blocks,
			scriptedUsage(1_000, { spent: async () => report(resetsAt), fresh: async () => report() }),
		).rankApiKeySelections(request("anthropic", apiKeys(["spent", "fresh"])));
		expect({ order: labelsOf(ranked), marked: blocks.marked }).toEqual({
			order: ["fresh", "spent"],
			marked: [[0, resetsAt]],
		});
	});

	it("ranks an OAuth account on the plan a model needs ahead of one on a lesser plan", async () => {
		const onPlan = (planType: string) => async () => ({ ...report(), metadata: { planType } });
		const ranked = await new CredentialRanking(
			recordingBlocks({}),
			scriptedUsage(1_000, { plus: onPlan("plus"), pro: onPlan("pro") }),
		).rankOAuthSelections({ ...request("openai-codex", oauth(["plus", "pro"])), planRequirement: "pro" });
		expect(labelsOf(ranked)).toEqual(["pro", "plus"]);
	});
});

describe("which blocked accounts a ranking still asks for usage", () => {
	it("skips a blocked API key and a blocked OAuth account, and asks for every other one", async () => {
		const now = Date.now();
		const answers = { free: async () => null, blocked: async () => null };
		const keyUsage = scriptedUsage(1_000, answers);
		await new CredentialRanking(recordingBlocks({ 0: now + 60_000 }), keyUsage).rankApiKeySelections(
			request("anthropic", apiKeys(["blocked", "free"])),
		);
		const oauthUsage = scriptedUsage(1_000, answers);
		await new CredentialRanking(recordingBlocks({ 0: now + 60_000 }), oauthUsage).rankOAuthSelections({
			...request("anthropic", oauth(["blocked", "free"])),
			planRequirement: "none",
		});
		expect({ keys: keyUsage.fetched, oauth: oauthUsage.fetched }).toEqual({ keys: ["free"], oauth: ["free"] });
	});

	it("asks a blocked openai-codex account for usage once, and ranks it free when the report lifts the block", async () => {
		const now = Date.now();
		const blocks = recordingBlocks({ 0: now + 60_000, 1: now + 60_000 });
		const usage = scriptedUsage(1_000, {
			lifted: async () => {
				blocks.lift(0);
				return null;
			},
			"still-blocked": async () => null,
			free: async () => null,
		});
		const ranked = await new CredentialRanking(blocks, usage).rankOAuthSelections({
			...request("openai-codex", oauth(["lifted", "still-blocked", "free"])),
			planRequirement: "none",
		});
		expect({ fetched: usage.fetched, order: labelsOf(ranked) }).toEqual({
			fetched: ["lifted", "still-blocked", "free"],
			order: ["lifted", "free", "still-blocked"],
		});
	});
});
