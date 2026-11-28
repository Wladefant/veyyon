/**
 * Antigravity OAuth ranking smoke test. Proves the
 * `antigravityRankingStrategy` is wired into `DEFAULT_RANKING_STRATEGIES`
 * (issue #2198): a credential whose usage report shows an exhausted
 * counter must be skipped in favour of a healthy sibling on the next
 * `getApiKey` call.
 *
 * Without the registration `getApiKey` would round-robin between
 * credentials and could pin a session to the exhausted account.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthBrokerClient } from "@veyyon/ai/auth-broker/client";
import { RemoteAuthCredentialStore } from "@veyyon/ai/auth-broker/remote-store";
import { withAuth } from "@veyyon/ai/auth-retry";
import { type AuthCredentialStore, AuthStorage } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import type { OAuthCredentials } from "@veyyon/ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@veyyon/ai/usage";
import { antigravityRankingStrategy } from "@veyyon/ai/usage/google-antigravity";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;

type AntigravityWindowSpec = {
	counter: "google" | "claude-gpt" | "anthropic" | "openai" | "default";
	usedFraction: number;
	resetInMs: number;
	windowId?: string;
};

function createAntigravityLimit(spec: AntigravityWindowSpec, projectId: string): UsageLimit {
	const used = Math.min(Math.max(spec.usedFraction, 0), 1);
	const windowId = spec.windowId ?? "WINDOW_DAILY";
	return {
		id: `google-antigravity:${spec.counter}:default:${windowId}`,
		label: `Usage (${spec.counter})`,
		scope: {
			provider: "google-antigravity",
			projectId,
			windowId,
		},
		window: {
			id: windowId,
			label: "Default",
			resetsAt: Date.now() + spec.resetInMs,
		},
		amount: {
			unit: "percent",
			used: used * 100,
			limit: 100,
			remaining: (1 - used) * 100,
			usedFraction: used,
			remainingFraction: 1 - used,
		},
		status: used >= 1 ? "exhausted" : used >= 0.9 ? "warning" : "ok",
	};
}

function createAntigravityReport(args: {
	projectId: string;
	accountId: string;
	windows: AntigravityWindowSpec[];
}): UsageReport {
	// fetchAntigravityUsage sorts ascending by remainingFraction; mirror
	// that here so the strategy sees the same shape it would in production.
	const limits = args.windows
		.map(w => createAntigravityLimit(w, args.projectId))
		.sort((a, b) => (a.amount.remainingFraction ?? 1) - (b.amount.remainingFraction ?? 1));
	return {
		provider: "google-antigravity",
		fetchedAt: Date.now(),
		limits,
		metadata: { accountId: args.accountId, projectId: args.projectId },
	};
}

function createCredential(accountId: string, projectId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		projectId,
		email,
	};
}

describe("AuthStorage google-antigravity oauth ranking", () => {
	test("Gemini selects the 83-percent-used sibling despite its exhausted Claude quota", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
		]);
		for (const [accountId, gemini, claude] of [
			["acct-a", 1, 0],
			["acct-b", 0.83, 1],
		] as const) {
			usageByAccount.set(
				accountId,
				createAntigravityReport({
					accountId,
					projectId: `proj-${accountId}`,
					windows: [
						{ counter: "google", usedFraction: gemini, resetInMs: HOUR_MS },
						{ counter: "claude-gpt", usedFraction: claude, resetInMs: HOUR_MS },
					],
				}),
			);
		}
		expect(
			await authStorage.getApiKey("google-antigravity", "family-scoped", {
				modelId: "gemini-3.8-flash",
			}),
		).toBe("api-acct-b");
		const accountA = authStorage.listStoredCredentials("google-antigravity")[0]!.id;
		authStorage.pinSessionCredential("google-antigravity", "quota-message", accountA);
		await authStorage.getApiKey("google-antigravity", "quota-message", { modelId: "gemini-3.8-flash" });
		const outcome = await authStorage.markUsageLimitReached("google-antigravity", "quota-message", {
			credentialId: accountA,
			modelId: "gemini-3.8-flash",
			retryAfterMs: HOUR_MS,
		});
		expect(outcome.switched).toBe(true);
		expect(outcome.quotaMessage).toContain("a@example.com");
		expect(outcome.quotaMessage).toContain("1 other account available");
		expect(outcome.quotaMessage).toContain("balancer will try");
		expect(
			await authStorage.getApiKey("google-antigravity", "quota-message", {
				modelId: "gemini-3.8-flash",
			}),
		).toBe("api-acct-b");
	});

	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "google-antigravity",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-antigravity-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		// Headroom ranking is movement; the library holds it off unless a host opts in.
		authStorage = new AuthStorage(store, {
			loadBalancing: true,
			usageProviderResolver: provider => (provider === "google-antigravity" ? usageProvider : undefined),
			rankingStrategyResolver: provider =>
				provider === "google-antigravity" ? antigravityRankingStrategy : undefined,
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["google-antigravity"] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return {
				apiKey: `api-${credential.accountId}`,
				newCredentials: credential,
			};
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("confirmed Gemini quota failure moves a pinned request to a sibling without losing the pin", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const provider = "google-antigravity";
		const sessionId = "confirmed-quota-pin";
		await storage.set(provider, [
			{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
		]);
		const selectedId = storage.listStoredCredentials(provider)[0]!.id;
		expect(storage.pinSessionCredential(provider, sessionId, selectedId)).toBe(true);
		usageByAccount.set(
			"acct-a",
			createAntigravityReport({
				accountId: "acct-a",
				projectId: "proj-a",
				windows: [{ counter: "google", usedFraction: 1, resetInMs: HOUR_MS }],
			}),
		);
		// A usage prediction must not displace the pin before the provider refuses it.
		expect(await storage.getApiKey(provider, sessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");
		const attempts: string[] = [];
		const quota = Object.assign(
			new Error(
				'Cloud Code Assist API error (429): {"error":{"message":"Individual quota reached","status":"RESOURCE_EXHAUSTED","details":[{"reason":"QUOTA_EXHAUSTED"}]}}',
			),
			{ status: 429 },
		);
		const result = await withAuth(
			storage.resolver(provider, { sessionId, modelId: "gemini-3.8-flash" }),
			async key => {
				attempts.push(key);
				if (key === "api-acct-a") throw quota;
				return "ACCOUNT-B-OK";
			},
		);
		expect(result).toBe("ACCOUNT-B-OK");
		expect(attempts).toEqual(["api-acct-a", "api-acct-b"]);
		expect(storage.sessionCredentialRouting(provider, sessionId)?.selectedCredentialId).toBe(selectedId);
		expect(await storage.getApiKey(provider, sessionId, { modelId: "claude-sonnet-4-5" })).toBe("api-acct-a");
	});

	test("blocks exhausted Antigravity Gemini counter without blocking healthy Claude counter", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("google-antigravity", [
			{
				type: "oauth",
				...createCredential("acct-gemini-exhausted", "proj-gemini-exhausted", "exhausted@example.com"),
			},
			{ type: "oauth", ...createCredential("acct-gemini-healthy", "proj-gemini-healthy", "healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-gemini-exhausted",
			createAntigravityReport({
				accountId: "acct-gemini-exhausted",
				projectId: "proj-gemini-exhausted",
				windows: [
					{ counter: "google", usedFraction: 1, resetInMs: 12 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0.05, resetInMs: 12 * HOUR_MS },
				],
			}),
		);
		usageByAccount.set(
			"acct-gemini-healthy",
			createAntigravityReport({
				accountId: "acct-gemini-healthy",
				projectId: "proj-gemini-healthy",
				windows: [
					{ counter: "google", usedFraction: 0.3, resetInMs: 20 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0.7, resetInMs: 20 * HOUR_MS },
				],
			}),
		);

		const geminiKey = await authStorage.getApiKey("google-antigravity", "session-antigravity-gemini", {
			modelId: "gemini-3-flash",
		});
		expect(geminiKey).toBe("api-acct-gemini-healthy");

		const counts = new Map<string, number>();
		for (let i = 0; i < 80; i += 1) {
			const apiKey = await authStorage.getApiKey("google-antigravity", `session-antigravity-claude-${i}`, {
				modelId: "claude-sonnet-4-5",
			});
			if (!apiKey) continue;
			counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}

		expect(counts.get("api-acct-gemini-exhausted") ?? 0).toBeGreaterThan(counts.get("api-acct-gemini-healthy") ?? 0);
	});

	test("ranks by bottleneck counter instead of healthier secondary counter", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-gemini-hot", "proj-gemini-hot", "hot@example.com") },
			{ type: "oauth", ...createCredential("acct-balanced", "proj-balanced", "balanced@example.com") },
		]);

		usageByAccount.set(
			"acct-gemini-hot",
			createAntigravityReport({
				accountId: "acct-gemini-hot",
				projectId: "proj-gemini-hot",
				windows: [
					{ counter: "google", usedFraction: 0.95, resetInMs: 8 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0, resetInMs: 8 * HOUR_MS },
				],
			}),
		);
		usageByAccount.set(
			"acct-balanced",
			createAntigravityReport({
				accountId: "acct-balanced",
				projectId: "proj-balanced",
				windows: [
					{ counter: "google", usedFraction: 0.8, resetInMs: 8 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0.7, resetInMs: 8 * HOUR_MS },
				],
			}),
		);

		const counts = new Map<string, number>();
		for (let i = 0; i < 80; i += 1) {
			const apiKey = await authStorage.getApiKey("google-antigravity", `session-antigravity-bottleneck-${i}`, {
				modelId: "gemini-3-flash",
			});
			if (!apiKey) continue;
			counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}

		expect(counts.get("api-acct-balanced") ?? 0).toBeGreaterThan(counts.get("api-acct-gemini-hot") ?? 0);
	});
	test("prefers less-pressured antigravity account when neither is exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-loaded", "proj-loaded", "loaded@example.com") },
			{ type: "oauth", ...createCredential("acct-fresh", "proj-fresh", "fresh@example.com") },
		]);

		usageByAccount.set(
			"acct-loaded",
			createAntigravityReport({
				accountId: "acct-loaded",
				projectId: "proj-loaded",
				windows: [{ counter: "google", usedFraction: 0.8, resetInMs: 4 * HOUR_MS }],
			}),
		);
		usageByAccount.set(
			"acct-fresh",
			createAntigravityReport({
				accountId: "acct-fresh",
				projectId: "proj-fresh",
				windows: [{ counter: "google", usedFraction: 0.05, resetInMs: 4 * HOUR_MS }],
			}),
		);

		// Sample several sessions; the weighted picker must favour the fresh
		// account by a clear margin even though both are unblocked.
		const counts = new Map<string, number>();
		for (let i = 0; i < 60; i += 1) {
			const apiKey = await authStorage.getApiKey("google-antigravity", `session-antigravity-fresh-${i}`, {
				modelId: "gemini-3-flash",
			});
			if (!apiKey) continue;
			counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}

		const fresh = counts.get("api-acct-fresh") ?? 0;
		const loaded = counts.get("api-acct-loaded") ?? 0;
		expect(fresh).toBeGreaterThan(loaded);
	});

	test("peer extended quota block preserves confirmed rotation while explicit clear defends pin from predicted holds", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const storageX = authStorage;
		const provider = "google-antigravity";
		const pinnedSessionId = "session-pinned-a";

		await storageX.set(provider, [
			{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
		]);
		const stored = storageX.listStoredCredentials(provider);
		const credentialIdA = stored[0]!.id;

		expect(storageX.pinSessionCredential(provider, pinnedSessionId, credentialIdA)).toBe(true);
		expect(await storageX.getApiKey(provider, pinnedSessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");

		await storageX.markUsageLimitReached(provider, pinnedSessionId, {
			credentialId: credentialIdA,
			modelId: "gemini-3.8-flash",
			retryAfterMs: HOUR_MS,
		});

		const storageY = new AuthStorage(store, {
			loadBalancing: true,
			usageProviderResolver: p => (p === "google-antigravity" ? usageProvider : undefined),
			rankingStrategyResolver: p => (p === "google-antigravity" ? antigravityRankingStrategy : undefined),
		});
		await storageY.reload();

		await storageY.markUsageLimitReached(provider, undefined, {
			credentialId: credentialIdA,
			modelId: "gemini-3.8-flash",
			retryAfterMs: 2 * HOUR_MS,
		});

		expect(storageX.sessionCredentialRouting(provider, pinnedSessionId)?.selectedCredentialId).toBe(credentialIdA);
		expect(await storageX.getApiKey(provider, pinnedSessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-b");

		storageX.clearCredentialBlocks(provider, credentialIdA);
		usageByAccount.set(
			"acct-a",
			createAntigravityReport({
				accountId: "acct-a",
				projectId: "proj-a",
				windows: [{ counter: "google", usedFraction: 1, resetInMs: 8 * HOUR_MS }],
			}),
		);
		await storageX.invalidateUsageCache(provider);

		const unpinnedSessionId = "session-unpinned-different";
		expect(await storageX.getApiKey(provider, unpinnedSessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-b");
		expect(await storageX.getApiKey(provider, pinnedSessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");
	});

	test.each([
		["fresh exact summary", "api-acct-a"],
		["fallback listing", "api-acct-b"],
		["header overlay", "api-acct-b"],
		["different counter", "api-acct-b"],
		["same counter, different authoritative window", "api-acct-b"],
		["old summary", "api-acct-b"],
		["confirmed 429", "api-acct-b"],
		["legacy block", "api-acct-b"],
		["unscoped block", "api-acct-b"],
	])("rechecks an old Antigravity prediction with a %s", async (evidence, expected) => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "google-antigravity";
		const modelId = "gemini-3.8-flash";
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		await authStorage.set(provider, [
			{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
		]);
		const report = (accountId: string, usedFraction: number) =>
			createAntigravityReport({
				accountId,
				projectId: `proj-${accountId}`,
				windows: [{ counter: "google", usedFraction, resetInMs: 8 * HOUR_MS, windowId: "5h" }],
			});
		usageByAccount.set("acct-a", report("acct-a", 1));
		usageByAccount.set("acct-b", report("acct-b", 0));
		expect(await authStorage.getApiKey(provider, "before-reset", { modelId })).toBe("api-acct-b");
		const credentialId = authStorage.listStoredCredentials(provider)[0]!.id;
		if (evidence === "confirmed 429") {
			await authStorage.markUsageLimitReached(provider, "confirmed-refusal", {
				credentialId,
				modelId,
				retryAfterMs: 8 * HOUR_MS,
			});
		}
		const providerKey = `${provider}:oauth`;
		const unrelatedScopes = ["counter:claude-gpt", "model-not-in-plan:gemini-test"];
		if (evidence === "legacy block" || evidence === "unscoped block") {
			store.upsertCredentialBlock?.({
				credentialId,
				providerKey,
				blockScope: evidence === "legacy block" ? "counter:google" : "",
				blockedUntilMs: now + HOUR_MS,
			});
		}
		for (const blockScope of unrelatedScopes) {
			store.upsertCredentialBlock?.({ credentialId, providerKey, blockScope, blockedUntilMs: now + HOUR_MS });
		}

		now += 10 * 60 * 1000;
		const healthy = report("acct-a", 0);
		const authoritative =
			evidence === "same counter, different authoritative window"
				? createAntigravityLimit(
						{ counter: "google", usedFraction: 0, resetInMs: HOUR_MS, windowId: "weekly" },
						"proj-acct-a",
					)
				: healthy.limits[0]!;
		if (authoritative !== healthy.limits[0]) healthy.limits.push(authoritative);
		if (evidence !== "fallback listing") {
			healthy.metadata = {
				...healthy.metadata,
				authoritativeLimitIds: [
					evidence === "different counter"
						? authoritative.id.replace(":google:", ":claude-gpt:")
						: authoritative.id,
				],
				...(evidence === "header overlay" ? { headersUpdatedAt: now } : {}),
			};
		}
		if (evidence === "old summary") healthy.fetchedAt -= 7 * 60 * 1000;
		usageByAccount.set("acct-a", healthy);
		usageByAccount.set("acct-b", report("acct-b", 0.4));
		const peer = new AuthStorage(store, {
			loadBalancing: true,
			usageProviderResolver: p => (p === provider ? usageProvider : undefined),
			rankingStrategyResolver: p => (p === provider ? antigravityRankingStrategy : undefined),
		});
		await peer.reload();
		expect(await peer.getApiKey(provider, "after-reset", { modelId })).toBe(expected);
		for (const blockScope of unrelatedScopes) {
			expect(store.getCredentialBlock?.(credentialId, providerKey, blockScope)).toBeDefined();
		}
	});

	test("an older quota proof cannot hide a newer pending broker prediction", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "google-antigravity";
		await authStorage.set(provider, [{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") }]);
		const initial = authStorage.exportSnapshot();
		const entry = initial.credentials[0]!;
		const now = Date.now();
		const block = {
			providerKey: `${provider}:oauth`,
			blockScope: "predicted:counter:google:5h",
			blockedUntilMs: now + 60_000,
			updatedAtMs: now - 600_000,
		};
		const snapshot = {
			...initial,
			serverNowMs: now,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
			credentials: [{ ...entry, rotatesInMs: null, blocks: [block] }],
		};
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:1", token: "fixture" });
		const pending = Promise.withResolvers<{ ok: boolean }>();
		vi.spyOn(client, "upsertCredentialBlock").mockReturnValue(pending.promise);
		vi.spyOn(client, "fetchSnapshot").mockResolvedValue({
			status: 200,
			generation: snapshot.generation + 1,
			snapshot: { ...snapshot, generation: snapshot.generation + 1 },
		});
		const remote = new RemoteAuthCredentialStore({ client, initialSnapshot: snapshot, streamSnapshots: false });
		try {
			const { providerKey, blockScope, blockedUntilMs } = block;
			const cutoff = now - 300_000;
			expect(remote.getCredentialBlock(entry.id, providerKey, blockScope, cutoff)).toBeUndefined();
			expect(remote.getCredentialBlock(entry.id, providerKey, blockScope)).toBe(blockedUntilMs);
			remote.upsertCredentialBlock({ ...block, credentialId: entry.id, updatedAtMs: now });
			await remote.refreshSnapshot();
			expect(remote.getCredentialBlock(entry.id, providerKey, blockScope, cutoff)).toBe(blockedUntilMs);
		} finally {
			pending.resolve({ ok: true });
			remote.close();
		}
	});

	test("expired confirmation does not promote a later peer prediction", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const storageX = authStorage;
		const provider = "google-antigravity";
		const sessionId = "expired-confirmation-pin";
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		await storageX.set(provider, [
			{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
		]);
		const credentialIdA = storageX.listStoredCredentials(provider)[0]!.id;
		expect(storageX.pinSessionCredential(provider, sessionId, credentialIdA)).toBe(true);
		expect(await storageX.getApiKey(provider, sessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");
		await storageX.markUsageLimitReached(provider, sessionId, {
			credentialId: credentialIdA,
			modelId: "gemini-3.8-flash",
			retryAfterMs: 1000,
		});

		now += 2000;
		usageByAccount.set(
			"acct-a",
			createAntigravityReport({
				accountId: "acct-a",
				projectId: "proj-a",
				windows: [{ counter: "google", usedFraction: 1, resetInMs: 8 * HOUR_MS }],
			}),
		);
		const storageY = new AuthStorage(store, {
			loadBalancing: true,
			usageProviderResolver: p => (p === provider ? usageProvider : undefined),
			rankingStrategyResolver: p => (p === provider ? antigravityRankingStrategy : undefined),
		});
		await storageY.reload();
		expect(await storageY.getApiKey(provider, "peer-prediction", { modelId: "gemini-3.8-flash" })).toBe("api-acct-b");
		expect(await storageX.getApiKey(provider, sessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");
	});

	test("shorter confirmed refusal preserves the existing confirmation deadline", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "google-antigravity";
		const sessionId = "decreasing-confirmation-pin";
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		await authStorage.set(provider, [
			{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
		]);
		const credentialIdA = authStorage.listStoredCredentials(provider)[0]!.id;
		expect(authStorage.pinSessionCredential(provider, sessionId, credentialIdA)).toBe(true);
		expect(await authStorage.getApiKey(provider, sessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");
		for (const retryAfterMs of [HOUR_MS, 1000]) {
			await authStorage.markUsageLimitReached(provider, sessionId, {
				credentialId: credentialIdA,
				modelId: "gemini-3.8-flash",
				retryAfterMs,
			});
		}
		now += 2000;
		expect(await authStorage.getApiKey(provider, sessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-b");
	});

	test("shorter confirmed refusal completing later preserves the live deadline", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "google-antigravity";
		const sessionId = "delayed-confirmation-pin";
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		await authStorage.set(provider, [
			{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
		]);
		const credentialIdA = authStorage.listStoredCredentials(provider)[0]!.id;
		expect(authStorage.pinSessionCredential(provider, sessionId, credentialIdA)).toBe(true);
		expect(await authStorage.getApiKey(provider, sessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");
		let releaseReport!: () => void;
		let reportEntered!: () => void;
		const delayedReport = new Promise<null>(resolve => {
			releaseReport = () => resolve(null);
		});
		const enteredReport = new Promise<void>(resolve => {
			reportEntered = resolve;
		});
		let delayNextReport = true;
		Object.assign(store, {
			async getUsageReport(): Promise<UsageReport | null> {
				if (!delayNextReport) return null;
				delayNextReport = false;
				reportEntered();
				return delayedReport;
			},
		});
		const shortRefusal = authStorage.markUsageLimitReached(provider, sessionId, {
			credentialId: credentialIdA,
			modelId: "gemini-3.8-flash",
			retryAfterMs: 1000,
		});
		await enteredReport;
		await authStorage.markUsageLimitReached(provider, sessionId, {
			credentialId: credentialIdA,
			modelId: "gemini-3.8-flash",
			retryAfterMs: HOUR_MS,
		});
		now += 2000;
		releaseReport();
		await shortRefusal;
		expect(await authStorage.getApiKey(provider, sessionId, { modelId: "gemini-3.8-flash" })).toBe("api-acct-b");
	});
});
