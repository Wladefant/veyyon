/**
 * WHY: a stalled usage endpoint must not hold credential selection past its bounded wait, and a timeout
 * must preserve block-aware ordering. This suite drives the live API-key selector and proves that blocked
 * rows are not fetched, a free row wins after the deadline, and an answered exhausted report marks its
 * reset before selection. It does not cover OAuth ranking or plan gates; the Codex selection suite does.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { CredentialSelector, type CredentialSelectorDeps } from "../src/auth/select";
import type { ApiKeyCredential } from "../src/auth/types";
import type { CredentialRankingStrategy, UsageReport } from "../src/usage";

const STRATEGY: CredentialRankingStrategy = {
	findWindowLimits: report => ({ primary: report.limits[0] }),
	windowDefaults: { primaryMs: 5 * 60 * 60 * 1000, secondaryMs: 7 * 24 * 60 * 60 * 1000 },
};

function report(usedFraction: number, resetsAt?: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "weekly",
				label: "Weekly",
				scope: { provider: "anthropic" },
				window: { id: "weekly", label: "Weekly", resetsAt },
				amount: { usedFraction, unit: "percent" },
				status: usedFraction >= 1 ? "exhausted" : "ok",
			},
		],
	};
}

function selectionHarness(args: {
	labels: string[];
	requestTimeoutMs: number;
	blocked?: Record<number, number>;
	fetch: (key: string) => Promise<UsageReport | null>;
}) {
	const credentials: ApiKeyCredential[] = args.labels.map(key => ({ type: "api_key", key }));
	const blocked = new Map<number, number>(
		Object.entries(args.blocked ?? {}).map(([index, until]) => [Number(index), until]),
	);
	const marked: Array<[number, number]> = [];
	const fetched: string[] = [];
	const deps = {
		store: {},
		pool: { credentials: () => credentials },
		policies: {},
		blocks: {
			blockedUntil: (_provider: string, _providerKey: string, index: number) => blocked.get(index),
			mark: (_provider: string, _providerKey: string, index: number, until: number) => {
				blocked.set(index, until);
				marked.push([index, until]);
			},
		},
		affinity: {
			isLoadBalancingEnabled: () => true,
			homeIndex: () => undefined,
		},
		usage: {
			requestTimeoutMs: args.requestTimeoutMs,
			report: (_provider: string, credential: ApiKeyCredential) => {
				fetched.push(credential.key);
				return args.fetch(credential.key);
			},
		},
		refresher: {},
		strategies: () => STRATEGY,
	} as unknown as CredentialSelectorDeps;
	return { selector: new CredentialSelector(deps), blocked, marked, fetched };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("a usage ranking that misses its deadline", () => {
	it("returns a free account at the five-second minimum without fetching blocked accounts", async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const pending = Promise.withResolvers<UsageReport | null>();
		const harness = selectionHarness({
			labels: ["longest-blocked", "soonest-reset", "free"],
			requestTimeoutMs: 1_000,
			blocked: { 0: now + 60_000, 1: now + 10_000 },
			fetch: () => pending.promise,
		});
		const selectedPromise = harness.selector.selectApiKey("anthropic", undefined, undefined);
		let settled = false;
		void selectedPromise.then(() => {
			settled = true;
		});

		expect(harness.fetched).toEqual(["free"]);
		vi.advanceTimersByTime(4_999);
		await Promise.resolve();
		expect(settled).toBe(false);
		vi.advanceTimersByTime(1);
		expect((await selectedPromise)?.credential.key).toBe("free");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ranks already-blocked accounts by the soonest reset", async () => {
		const now = Date.now();
		const harness = selectionHarness({
			labels: ["longest-blocked", "soonest-reset", "middle-reset"],
			requestTimeoutMs: 1_000,
			blocked: { 0: now + 60_000, 1: now + 10_000, 2: now + 30_000 },
			fetch: async () => null,
		});

		const selected = await harness.selector.selectApiKey("anthropic", undefined, undefined);
		expect(selected?.credential.key).toBe("soonest-reset");
		expect(harness.fetched).toEqual([]);
	});

	it("marks an exhausted report through its reset and selects an account with headroom", async () => {
		const resetsAt = Date.now() + 30 * 60 * 1000;
		const harness = selectionHarness({
			labels: ["spent", "fresh"],
			requestTimeoutMs: 1_000,
			fetch: async key => (key === "spent" ? report(1, resetsAt) : report(0.2)),
		});

		const selected = await harness.selector.selectApiKey("anthropic", undefined, undefined);
		expect({
			selected: selected?.credential.key,
			fetched: harness.fetched,
			marked: harness.marked,
		}).toEqual({
			selected: "fresh",
			fetched: ["spent", "fresh"],
			marked: [[0, resetsAt]],
		});
	});
});
