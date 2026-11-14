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
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withAuth } from "@veyyon/ai/auth-retry";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@veyyon/ai/auth-broker";
import { type AuthCredentialStore, AuthStorage } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import type { OAuthCredentials } from "@veyyon/ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@veyyon/ai/usage";
import { antigravityRankingStrategy, antigravityUsageProvider } from "@veyyon/ai/usage/google-antigravity";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;

type AntigravityWindowSpec = {
	counter: "google" | "claude-gpt" | "anthropic" | "openai" | "default";
	usedFraction: number;
	resetInMs: number;
};

function createAntigravityLimit(spec: AntigravityWindowSpec, projectId: string): UsageLimit {
	const used = Math.min(Math.max(spec.usedFraction, 0), 1);
	return {
		id: `google-antigravity:${spec.counter}:default:WINDOW_DAILY`,
		label: `Usage (${spec.counter})`,
		scope: {
			provider: "google-antigravity",
			projectId,
			windowId: "WINDOW_DAILY",
		},
		window: {
			id: "WINDOW_DAILY",
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

describe("Antigravity predicted vs confirmed block reconciliation", () => {
	const PROVIDER = "google-antigravity";
	const PROVIDER_KEY = "google-antigravity:oauth";
	const MINUTE_MS = 60_000;

	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let now = Date.now();

	type EndpointResponse = {
		summary?: { status: number; body: unknown };
		listing?: { status: number; body: unknown };
	};

	const responsesByToken = new Map<string, EndpointResponse>();

	function makeFetch(): typeof fetch {
		return (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			const auth = headers.get("authorization") ?? "";
			const token = auth.replace(/^Bearer\s+/i, "");
			const config = responsesByToken.get(token);
			if (url.includes("retrieveUserQuotaSummary")) {
				const reply = config?.summary ?? { status: 503, body: { error: "unavailable" } };
				return new Response(JSON.stringify(reply.body), {
					status: reply.status,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("fetchAvailableModels")) {
				const reply = config?.listing ?? { status: 503, body: { error: "unavailable" } };
				return new Response(JSON.stringify(reply.body), {
					status: reply.status,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
	}

	function summaryResponse(groups: Array<{ displayName: string; buckets: Array<{ bucketId: string; window: string; remainingFraction: number; resetTime?: string }> }>) {
		return { status: 200, body: { groups } };
	}

	function geminiSummary(remainingFraction: number, resetTime?: string) {
		return {
			displayName: "Gemini Models",
			buckets: [
				{ bucketId: "gemini-5h", window: "5h", remainingFraction, ...(resetTime ? { resetTime } : {}) },
				{ bucketId: "gemini-weekly", window: "weekly", remainingFraction, ...(resetTime ? { resetTime } : {}) },
			],
		};
	}

	function claudeSummary(remainingFraction: number, resetTime?: string) {
		return {
			displayName: "Claude and GPT models",
			buckets: [
				{ bucketId: "3p-5h", window: "5h", remainingFraction, ...(resetTime ? { resetTime } : {}) },
				{ bucketId: "3p-weekly", window: "weekly", remainingFraction, ...(resetTime ? { resetTime } : {}) },
			],
		};
	}

	function openStorage(backingStore: AuthCredentialStore): AuthStorage {
		return new AuthStorage(backingStore, {
			loadBalancing: true,
			usageProviderResolver: provider => (provider === PROVIDER ? antigravityUsageProvider : undefined),
			rankingStrategyResolver: provider => (provider === PROVIDER ? antigravityRankingStrategy : undefined),
			usageFetch: makeFetch(),
		});
	}

	beforeEach(async () => {
		now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-antigravity-reconcile-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		responsesByToken.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("heals a stale predicted counter:google block after reconcileAfter when live summary is healthy", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = openStorage(store);
		try {
			await storage.set(PROVIDER, [
				{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
				{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
			]);
			const [rowA, rowB] = storage.listStoredCredentials(PROVIDER);
			if (!rowA || !rowB) throw new Error("expected stored rows");

			const resetIso = new Date(now + 24 * HOUR_MS).toISOString();
			// Ranking observes acct-b Gemini exhausted and writes a predicted counter:google block;
			// acct-a is confirmed 429 so later selection has every candidate blocked on counter:google.
			responsesByToken.set("access-acct-a", { summary: summaryResponse([geminiSummary(0.2)]) });
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0, resetIso)]) });

			expect(await storage.getApiKey(PROVIDER, "seed-predicted", { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBeDefined();

			await storage.markUsageLimitReached(PROVIDER, "seed-confirmed", {
				credentialId: rowA.id,
				modelId: "gemini-3.8-flash",
				retryAfterMs: 12 * HOUR_MS,
			});
			expect(store.getCredentialBlock(rowA.id, PROVIDER_KEY, "counter:google")).toBeDefined();

			// Inside the 5-minute reconcileAfter window, a healthy live summary must NOT clear the block.
			now += 2 * MINUTE_MS;
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0.95)]) });
			await storage.invalidateUsageCache(PROVIDER);
			await storage.fetchUsageReports();
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBeDefined();

			// Past reconcileAfter, live authoritative summary heals acct-b even while all candidates are blocked.
			now += 5 * MINUTE_MS;
			await storage.invalidateUsageCache(PROVIDER);
			expect(await storage.getApiKey(PROVIDER, "after-reconcile", { modelId: "gemini-3.8-flash" })).toBe("api-acct-b");
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBeUndefined();
			expect(store.getCredentialBlock(rowA.id, PROVIDER_KEY, "counter:google")).toBeDefined();
		} finally {
			storage.close();
		}
	});

	test("keeps a confirmed429 counter:google block on low summary, including across a fresh peer reload", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = openStorage(store);
		const peerStore = await SqliteAuthCredentialStore.open(dbPath);
		const peerStorage = openStorage(peerStore);
		try {
			await storage.set(PROVIDER, [
				{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
				{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
			]);
			const [rowA] = storage.listStoredCredentials(PROVIDER);
			if (!rowA) throw new Error("expected stored row");

			// Simulate cred13: real 429 with low 5h/weekly summary hiding a daily cap.
			responsesByToken.set("access-acct-a", { summary: summaryResponse([geminiSummary(0.994)]) });
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0.95)]) });

			expect(storage.pinSessionCredential(PROVIDER, "pinned-orig", rowA.id)).toBe(true);
			await storage.markUsageLimitReached(PROVIDER, "pinned-orig", {
				credentialId: rowA.id,
				modelId: "gemini-3.8-flash",
				retryAfterMs: 12 * HOUR_MS,
			});
			const blockedUntil = store.getCredentialBlock(rowA.id, PROVIDER_KEY, "counter:google");
			expect(blockedUntil).toBeDefined();

			now += 10 * MINUTE_MS;
			await storage.invalidateUsageCache(PROVIDER);
			await storage.fetchUsageReports();
			expect(store.getCredentialBlock(rowA.id, PROVIDER_KEY, "counter:google")).toBe(blockedUntil);
			expect(await storage.getApiKey(PROVIDER, "pinned-orig", { modelId: "gemini-3.8-flash" })).toBe("api-acct-b");

			// Fresh peer process reloads from SQLite: must still keep the confirmed429 hold and rotate off pin.
			await peerStorage.reload();
			expect(peerStorage.pinSessionCredential(PROVIDER, "pinned-peer", rowA.id)).toBe(true);
			await peerStorage.fetchUsageReports();
			expect(peerStore.getCredentialBlock(rowA.id, PROVIDER_KEY, "counter:google")).toBe(blockedUntil);
			expect(await peerStorage.getApiKey(PROVIDER, "pinned-peer", { modelId: "gemini-3.8-flash" })).toBe("api-acct-b");
		} finally {
			peerStorage.close();
			peerStore.close();
			storage.close();
		}
	});

	test("treats legacy untagged blocks conservatively and leaves them intact on healthy summary", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = openStorage(store);
		try {
			await storage.set(PROVIDER, [
				{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
				{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
			]);
			const [rowA] = storage.listStoredCredentials(PROVIDER);
			if (!rowA) throw new Error("expected stored row");

			const legacyUntil = now + 12 * HOUR_MS;
			// Simulate a pre-provenance (untagged) row written before provenance tracking existed.
			const db = new Database(dbPath);
			try {
				db.prepare(
					"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
				).run(rowA.id, PROVIDER_KEY, "counter:google", legacyUntil, Math.floor(now / 1000) - 600);
			} finally {
				db.close();
			}

			now += 10 * MINUTE_MS;
			responsesByToken.set("access-acct-a", { summary: summaryResponse([geminiSummary(0.95)]) });
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0.9)]) });
			await storage.fetchUsageReports();

			expect(store.getCredentialBlock(rowA.id, PROVIDER_KEY, "counter:google")).toBe(legacyUntil);
		} finally {
			storage.close();
		}
	});

	test("does not heal predicted block from fetchAvailableModels fallback or summary omitting that counter", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = openStorage(store);
		try {
			await storage.set(PROVIDER, [
				{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
				{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
			]);
			const [, rowB] = storage.listStoredCredentials(PROVIDER);
			if (!rowB) throw new Error("expected stored row");

			const resetIso = new Date(now + 24 * HOUR_MS).toISOString();
			responsesByToken.set("access-acct-a", { summary: summaryResponse([geminiSummary(0.8)]) });
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0, resetIso)]) });
			await storage.getApiKey(PROVIDER, "seed-fallback", { modelId: "gemini-3.8-flash" });
			const predictedUntil = store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google");
			expect(predictedUntil).toBeDefined();

			now += 10 * MINUTE_MS;
			// Case A: summary fails (503) and listing fallback claims Gemini is 90% remaining.
			responsesByToken.set("access-acct-b", {
				summary: { status: 503, body: { error: "unavailable" } },
				listing: {
					status: 200,
					body: {
						models: {
							"gemini-3-flash": {
								modelProvider: "MODEL_PROVIDER_GOOGLE",
								quotaInfos: [{ remainingFraction: 0.9, windowId: "5h" }],
							},
						},
					},
				},
			});
			await storage.invalidateUsageCache(PROVIDER);
			await storage.fetchUsageReports();
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBe(predictedUntil);

			// Case B: summary names only claude-gpt, while Gemini comes from fetchAvailableModels fallback.
			responsesByToken.set("access-acct-b", {
				summary: summaryResponse([claudeSummary(0.9)]),
				listing: {
					status: 200,
					body: {
						models: {
							"gemini-3-flash": {
								modelProvider: "MODEL_PROVIDER_GOOGLE",
								quotaInfos: [{ remainingFraction: 0.95, windowId: "5h" }],
							},
						},
					},
				},
			});
			await storage.invalidateUsageCache(PROVIDER);
			await storage.fetchUsageReports();
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBe(predictedUntil);
		} finally {
			storage.close();
		}
	});

	test("reconciling counter:google preserves counter:claude-gpt, model blocks, counter:unknown, and sibling blocks", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = openStorage(store);
		try {
			await storage.set(PROVIDER, [
				{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
				{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
			]);
			const [rowA, rowB] = storage.listStoredCredentials(PROVIDER);
			if (!rowA || !rowB) throw new Error("expected stored rows");

			const resetIso = new Date(now + 24 * HOUR_MS).toISOString();
			responsesByToken.set("access-acct-a", { summary: summaryResponse([geminiSummary(0, resetIso)]) });
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0, resetIso)]) });

			// Trigger predicted counter:google on acct-b via ranking.
			responsesByToken.set("access-acct-a", { summary: summaryResponse([geminiSummary(0.5)]) });
			await storage.getApiKey(PROVIDER, "seed-b-gemini", { modelId: "gemini-3.8-flash" });
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBeDefined();

			// Set confirmed counter:claude-gpt on acct-b, model:gemini-3.8-flash on acct-b,
			// counter:unknown on acct-b, and predicted counter:google on acct-a.
			expect(storage.pinSessionCredential(PROVIDER, "pinned-b-claude", rowB.id)).toBe(true);
			await storage.markUsageLimitReached(PROVIDER, "pinned-b-claude", {
				credentialId: rowB.id,
				modelId: "claude-sonnet-4-5",
				retryAfterMs: 6 * HOUR_MS,
			});
			await storage.markUsageLimitReached(PROVIDER, undefined, {
				credentialId: rowB.id,
				modelId: "gemini-3.8-flash",
				modelNotInPlan: true,
			});
			const unknownUntil = now + 4 * HOUR_MS;
			storage.upsertCredentialBlock({
				credentialId: rowB.id,
				providerKey: PROVIDER_KEY,
				blockScope: "counter:unknown",
				blockedUntilMs: unknownUntil,
			});
			const siblingUntil = now + 8 * HOUR_MS;
			storage.upsertCredentialBlock({
				credentialId: rowA.id,
				providerKey: PROVIDER_KEY,
				blockScope: "counter:google",
				blockedUntilMs: siblingUntil,
			});

			const claudeUntil = store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:claude-gpt");
			const modelUntil = store.getCredentialBlock(rowB.id, PROVIDER_KEY, "model-not-in-plan:gemini-3.8-flash");
			expect(claudeUntil).toBeDefined();
			expect(modelUntil).toBeDefined();

			now += 10 * MINUTE_MS;
			// acct-b Gemini summary is now healthy, Claude+GPT is omitted/exhausted, acct-a Gemini stays exhausted.
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0.92), claudeSummary(0, resetIso)]) });
			responsesByToken.set("access-acct-a", { summary: summaryResponse([geminiSummary(0, resetIso)]) });
			await storage.invalidateUsageCache(PROVIDER);
			await storage.fetchUsageReports();

			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBeUndefined();
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:claude-gpt")).toBe(claudeUntil);
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "model-not-in-plan:gemini-3.8-flash")).toBe(modelUntil);
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:unknown")).toBe(unknownUntil);
			expect(store.getCredentialBlock(rowA.id, PROVIDER_KEY, "counter:google")).toBe(siblingUntil);

			// Confirmed Claude+GPT pin rotation on acct-b must still work after counter:google healed.
			expect(await storage.getApiKey(PROVIDER, "pinned-b-claude", { modelId: "claude-sonnet-4-5" })).toBe("api-acct-a");
		} finally {
			storage.close();
		}
	});

	test("remote broker heals only stale predicted scope and ignores header overlays", async () => {
		if (!store) throw new Error("test setup failed");
		const brokerStorage = openStorage(store);
		let handle: AuthBrokerServerHandle | undefined;
		let remote: RemoteAuthCredentialStore | undefined;
		let remoteStorage: AuthStorage | undefined;
		try {
			await brokerStorage.set(PROVIDER, [
				{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
				{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
			]);
			const [, rowB] = brokerStorage.listStoredCredentials(PROVIDER);
			if (!rowB) throw new Error("expected stored row");

			handle = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: ["test-token"],
				disableRefresher: true,
			});
			const pendingBlockRequests: Promise<unknown>[] = [];
			const trackingFetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
				const pending = fetch(input, init);
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes("/block")) {
					pendingBlockRequests.push(pending);
				}
				return pending;
			}) as typeof fetch;
			const client = new AuthBrokerClient({ url: handle.url, token: "test-token", fetchImpl: trackingFetch });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected initial snapshot");

			remote = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: initial.snapshot,
				streamSnapshots: false,
			});
			remoteStorage = new AuthStorage(remote, {
				loadBalancing: true,
				usageProviderResolver: provider => (provider === PROVIDER ? antigravityUsageProvider : undefined),
				rankingStrategyResolver: provider => (provider === PROVIDER ? antigravityRankingStrategy : undefined),
			});
			await remoteStorage.reload();

			const resetIso = new Date(now + 24 * HOUR_MS).toISOString();
			responsesByToken.set("access-acct-a", { summary: summaryResponse([geminiSummary(0.5)]) });
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0, resetIso)]) });

			// Remote ranking writes predicted counter:google on acct-b, plus unrelated counter:claude-gpt.
			expect(await remoteStorage.getApiKey(PROVIDER, "remote-seed", { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");
			await remoteStorage.markUsageLimitReached(PROVIDER, "remote-claude", {
				credentialId: rowB.id,
				modelId: "claude-sonnet-4-5",
				retryAfterMs: 6 * HOUR_MS,
			});

			await Promise.all(pendingBlockRequests);
			pendingBlockRequests.length = 0;
			const predictedUntil = store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google");
			const claudeUntil = store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:claude-gpt");
			expect(predictedUntil).toBeDefined();
			expect(claudeUntil).toBeDefined();

			// Past reconcileAfter, header-ingested overlay alone must NOT heal the predicted block.
			now += 10 * MINUTE_MS;
			const bCred = remoteStorage.listStoredCredentials(PROVIDER).find(entry => entry.id === rowB.id)?.credential;
			if (!bCred || bCred.type !== "oauth") throw new Error("expected oauth credential");
			expect(
				remote.ingestUsageReport(PROVIDER, bCred, {
					provider: PROVIDER,
					fetchedAt: now,
					limits: [createAntigravityLimit({ counter: "google", usedFraction: 0.05, resetInMs: HOUR_MS }, "proj-b")],
					metadata: { accountId: "acct-b", projectId: "proj-b", headersUpdatedAt: now },
				}),
			).toBe(true);
			await remoteStorage.getApiKey(PROVIDER, "remote-header-check", { modelId: "gemini-3.8-flash" });
			await Promise.all(pendingBlockRequests);
			pendingBlockRequests.length = 0;
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBe(predictedUntil);

			// Now authoritative broker /v1/usage reports Gemini healthy and Claude+GPT exhausted.
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0.95), claudeSummary(0, resetIso)]) });
			await brokerStorage.invalidateUsageCache(PROVIDER);
			await remote.invalidateUsageCache();
			await remoteStorage.fetchUsageReports();
			await Promise.all(pendingBlockRequests);

			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBeUndefined();
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:claude-gpt")).toBe(claudeUntil);
		} finally {
			remoteStorage?.close();
			remote?.close();
			await handle?.close();
			brokerStorage.close();
		}
	});

	test("rechecks stale predicted blocks with bounded cadence and skips recheck for confirmed429 holds", async () => {
		if (!store) throw new Error("test setup failed");
		let summaryCalls = 0;
		const countingFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("retrieveUserQuotaSummary")) {
				summaryCalls += 1;
			}
			return makeFetch()(input, init);
		}) as typeof fetch;
		const storage = new AuthStorage(store, {
			loadBalancing: true,
			usageProviderResolver: provider => (provider === PROVIDER ? antigravityUsageProvider : undefined),
			rankingStrategyResolver: provider => (provider === PROVIDER ? antigravityRankingStrategy : undefined),
			usageFetch: countingFetch,
		});
		try {
			await storage.set(PROVIDER, [
				{ type: "oauth", ...createCredential("acct-a", "proj-a", "a@example.com") },
				{ type: "oauth", ...createCredential("acct-b", "proj-b", "b@example.com") },
			]);
			const [rowA, rowB] = storage.listStoredCredentials(PROVIDER);
			if (!rowA || !rowB) throw new Error("expected stored rows");

			const resetIso = new Date(now + 24 * HOUR_MS).toISOString();
			responsesByToken.set("access-acct-a", { summary: summaryResponse([geminiSummary(0.4)]) });
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0, resetIso)]) });

			// Seed predicted counter:google on acct-b, then confirmed429 counter:google on acct-a.
			expect(await storage.getApiKey(PROVIDER, "recheck-seed", { modelId: "gemini-3.8-flash" })).toBe("api-acct-a");
			await storage.markUsageLimitReached(PROVIDER, "recheck-seed", {
				credentialId: rowA.id,
				modelId: "gemini-3.8-flash",
				retryAfterMs: 12 * HOUR_MS,
			});

			// Past reconcileAfter while summary is temporarily unavailable (503) — only the predicted
			// acct-b is probed, never confirmed acct-a; a second immediate getApiKey is throttled.
			now += 10 * MINUTE_MS;
			responsesByToken.set("access-acct-b", { summary: { status: 503, body: { error: "unavailable" } } });
			await storage.invalidateUsageCache(PROVIDER);
			summaryCalls = 0;
			await storage.getApiKey(PROVIDER, "recheck-1", { modelId: "gemini-3.8-flash" });
			expect(summaryCalls).toBe(1);

			await storage.getApiKey(PROVIDER, "recheck-2", { modelId: "gemini-3.8-flash" });
			expect(summaryCalls).toBe(1);

			// Once the 5-minute recheck cooldown elapses and summary recovers, acct-b heals cleanly.
			now += 6 * MINUTE_MS;
			responsesByToken.set("access-acct-b", { summary: summaryResponse([geminiSummary(0.9)]) });
			await storage.invalidateUsageCache(PROVIDER);
			summaryCalls = 0;
			expect(await storage.getApiKey(PROVIDER, "recheck-3", { modelId: "gemini-3.8-flash" })).toBe("api-acct-b");
			expect(summaryCalls).toBe(1);
			expect(store.getCredentialBlock(rowB.id, PROVIDER_KEY, "counter:google")).toBeUndefined();
			expect(store.getCredentialBlock(rowA.id, PROVIDER_KEY, "counter:google")).toBeDefined();
		} finally {
			storage.close();
		}
	});
});
