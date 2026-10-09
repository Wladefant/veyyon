/**
 * WHY: redacting a usage credential must remove the credential and nothing else. Review of
 * https://github.com/Wladefant/veyyon/pull/449 found three ways the first design got that wrong:
 *
 *   1. a backend that echoes a CUT-SHORT credential (`prefix...`) or its base64 spelling left both in the
 *      log, the check reason and the persisted `usage_cache:` row;
 *   2. redacting a short key rewrote the report's own property names and enum values, so a valid report
 *      with key `provider`, `scope` or `e` was dropped and a check result lost its `ok` field;
 *   3. usage history grouped on the redacted identity, so two accounts whose ids were their (equal-length)
 *      keys shared one row, and history written before redaction kept raw tokens.
 *
 * The keys below are fake sentinels, deliberately not vendor-shaped so the exact-value layer is the one tested.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { redactUsageText } from "@veyyon/ai/auth-storage/usage-redaction";
import type { UsageLimit, UsageLogger, UsageProvider, UsageReport } from "@veyyon/ai/usage";

const PROVIDER = "fake-usage-backend";
const LONG_KEY = "fake-prefix-only-credential-445-1234567890";
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Rig {
	db: Database;
	store: SqliteAuthCredentialStore;
	storage: AuthStorage;
	logged: string[];
}

function rig(backend: UsageProvider, db = new Database(":memory:")): Rig {
	const store = new SqliteAuthCredentialStore(db);
	cleanups.push(() => store.close());
	const logged: string[] = [];
	const sink = (message: string, meta?: Record<string, unknown>) => logged.push(JSON.stringify({ message, meta }));
	const usageLogger: UsageLogger = { debug: sink, warn: sink };
	const storage = new AuthStorage(store, {
		usageProviderResolver: id => (id === backend.id ? backend : undefined),
		usageLogger,
	});
	return { db, store, storage, logged };
}

function limit(id: string, status: UsageLimit["status"] = "ok"): UsageLimit {
	return {
		id,
		label: "Five hour",
		scope: { provider: PROVIDER },
		amount: { unit: "percent", used: 25, limit: 100, usedFraction: 0.25 },
		status,
	};
}

function persisted(r: Rig): string {
	return JSON.stringify(r.db.query("SELECT key, value FROM cache WHERE key LIKE 'usage_cache:%'").all());
}

function everything(r: Rig, extra: unknown): string {
	return `${r.logged.join("\n")}\n${persisted(r)}\n${JSON.stringify(extra)}`;
}

describe("a backend that echoes a cut-short or encoded credential", () => {
	const echoes: Array<[string, string]> = [
		["a truncated prefix", `${LONG_KEY.slice(0, 30)}...`],
		["a truncated suffix", `...${LONG_KEY.slice(-25)}`],
		["the base64 of the key", Buffer.from(LONG_KEY).toString("base64")],
		["the unpadded url-safe base64 of the key", Buffer.from(LONG_KEY).toString("base64url")],
		["the base64 of the key embedded after one other byte", Buffer.from(`x${LONG_KEY}`).toString("base64")],
		["the base64 of the key embedded after two other bytes", Buffer.from(`xy${LONG_KEY}`).toString("base64")],
	];
	for (const [name, echo] of echoes) {
		it(`removes ${name} from the log, the check reason and the cache row`, async () => {
			const backend: UsageProvider = {
				id: PROVIDER,
				async fetchUsage() {
					throw new Error(`upstream rejected ${echo} with 401`);
				},
			};
			const r = rig(backend);
			await r.storage.reload();
			await r.storage.set(PROVIDER, { type: "api_key", key: LONG_KEY });
			await r.storage.fetchUsageReports();
			const checks = await r.storage.checkCredentials();
			const text = everything(r, checks);
			expect(text).not.toContain(echo);
			// The distinguishing core of the echo, not just its whole spelling.
			expect(text).not.toContain(echo.replace(/^\.+|\.+$/g, "").slice(0, 16));
			expect(checks[0]?.reason).toContain("rejected");
		});
	}

	it("removes an encoded echo from report metadata before the cache row is written", async () => {
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(): Promise<UsageReport> {
				return {
					provider: PROVIDER,
					fetchedAt: Date.now(),
					limits: [limit("five")],
					metadata: {
						authorization: `Basic ${Buffer.from(LONG_KEY).toString("base64")}`,
						hint: LONG_KEY.slice(0, 20),
					},
				};
			},
		};
		const r = rig(backend);
		await r.storage.reload();
		await r.storage.set(PROVIDER, { type: "api_key", key: LONG_KEY });
		const reports = await r.storage.fetchUsageReports();
		expect(reports).toHaveLength(1);
		const text = everything(r, reports);
		expect(text).not.toContain(Buffer.from(LONG_KEY).toString("base64").slice(0, 16));
		expect(text).not.toContain(LONG_KEY.slice(0, 16));
	});
});

describe("a short credential does not damage the public report shape", () => {
	for (const key of ["provider", "scope", "e", "ok", "status", "limits"]) {
		it(`keeps a valid report, its status and the check result when the key is "${key}"`, async () => {
			const backend: UsageProvider = {
				id: PROVIDER,
				async fetchUsage(): Promise<UsageReport> {
					return { provider: PROVIDER, fetchedAt: Date.now(), limits: [limit("five", "ok")] };
				},
			};
			const r = rig(backend);
			await r.storage.reload();
			await r.storage.set(PROVIDER, { type: "api_key", key });
			const reports = await r.storage.fetchUsageReports();
			expect(reports).toHaveLength(1);
			expect(reports?.[0]?.limits).toHaveLength(1);
			expect(reports?.[0]?.limits[0]?.status).toBe("ok");
			expect(reports?.[0]?.limits[0]?.amount.unit).toBe("percent");
			const checks = await r.storage.checkCredentials();
			expect(checks[0]?.ok).toBe(true);
			expect(checks[0]?.provider).toBe(PROVIDER);
			// The check result's report is sanitized once: a second pass would turn "percent" into text.
			expect(checks[0]?.report?.limits[0]?.amount.unit).toBe("percent");
			expect(r.storage.listUsageHistory()[0]?.status).toBe("ok");
		});
	}

	it("still redacts a key echoed into free-form metadata, by name and by value", async () => {
		const key = "scope";
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(): Promise<UsageReport> {
				return {
					provider: PROVIDER,
					fetchedAt: Date.now(),
					limits: [limit("five")],
					metadata: { [key]: "x", note: `the key is ${key}` },
				};
			},
		};
		const r = rig(backend);
		await r.storage.reload();
		await r.storage.set(PROVIDER, { type: "api_key", key });
		const reports = await r.storage.fetchUsageReports();
		expect(reports?.[0]?.metadata).toBeDefined();
		expect(Object.keys(reports?.[0]?.metadata ?? {})).not.toContain(key);
		expect(JSON.stringify(reports?.[0]?.metadata)).not.toContain("the key is scope");
	});
});

describe("usage history", () => {
	it("keeps two accounts whose identity is their key apart, and one account grouped across a token refresh", async () => {
		const keys = ["fake-secret-key-probe-11111111111111", "fake-secret-key-probe-22222222222222"];
		const fraction = new Map([
			[keys[0] as string, 0.25],
			[keys[1] as string, 0.85],
		]);
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(params): Promise<UsageReport> {
				const token = params.credential.accessToken ?? "";
				return {
					provider: PROVIDER,
					fetchedAt: 1_800_000_000_000,
					limits: [
						{
							...limit("shared-quota-limit-5h"),
							amount: { unit: "percent", usedFraction: fraction.get(token) ?? 0 },
						},
					],
				};
			},
		};
		const r = rig(backend);
		await r.storage.reload();
		await r.storage.set(
			PROVIDER,
			keys.map(key => ({
				type: "oauth" as const,
				access: key,
				refresh: `${key}-refresh`,
				expires: Date.now() + 3_600_000,
				accountId: key,
				orgId: key,
			})),
		);
		await r.storage.fetchUsageReports();
		const rows = r.storage.listUsageHistory();
		expect(rows.map(row => row.usedFraction).sort()).toEqual([0.25, 0.85]);
		expect(new Set(rows.map(row => row.accountKey)).size).toBe(2);
		for (const key of keys) expect(JSON.stringify(rows)).not.toContain(key);
	});

	it("drops history written before redaction once, and leaves credentials and the cache alone", async () => {
		const legacy = "fake-legacy-secret-token-999999999999";
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage() {
				return null;
			},
		};
		const db = new Database(":memory:");
		const seed = new SqliteAuthCredentialStore(db);
		seed.recordUsageSnapshots([
			{
				recordedAt: Date.now(),
				provider: PROVIDER,
				accountKey: `oauth|account:${legacy}`,
				email: `${legacy}@example.test`,
				accountId: legacy,
				limitId: "five",
				label: `Window ${legacy}`,
				windowLabel: legacy,
				usedFraction: 0.5,
				status: "ok",
			},
		]);
		seed.setCache("unrelated:key", "kept", Math.floor(Date.now() / 1000) + 3600);
		expect(JSON.stringify(seed.listUsageHistory())).toContain(legacy);

		const storage = new AuthStorage(seed, { usageProviderResolver: () => backend });
		await storage.reload();
		expect(storage.listUsageHistory()).toEqual([]);
		expect(JSON.stringify(db.query("SELECT * FROM usage_history").all())).not.toContain(legacy);
		expect(seed.getCache("unrelated:key")).toBe("kept");

		// The purge is once per store: history recorded afterwards survives the next start.
		seed.recordUsageSnapshots([
			{
				recordedAt: Date.now(),
				provider: PROVIDER,
				accountKey: "0123456789abcdef0123456789abcdef",
				limitId: "five",
				label: "Five hour",
				usedFraction: 0.1,
			},
		]);
		const again = new AuthStorage(seed, { usageProviderResolver: () => backend });
		await again.reload();
		expect(again.listUsageHistory()).toHaveLength(1);
		seed.close();
	});
});

describe("review round 2 of https://github.com/Wladefant/veyyon/pull/449", () => {
	it("removes the whole base64 of a short accepted key from the log, the check reason, the metadata and the cache", async () => {
		const key = "short445";
		const encoded = Buffer.from(key).toString("base64");
		expect(encoded).toBe("c2hvcnQ0NDU=");
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(_params, ctx): Promise<UsageReport> {
				ctx.logger?.debug("sent", { header: `Basic ${encoded}` });
				return {
					provider: PROVIDER,
					fetchedAt: Date.now(),
					limits: [limit("five")],
					metadata: { echoed: encoded, unpadded: encoded.replace(/=+$/, "") },
				};
			},
		};
		const failing: UsageProvider = {
			id: "fake-failing-backend",
			async fetchUsage() {
				throw new Error(`rejected ${encoded}`);
			},
		};
		const r = rig(backend);
		await r.storage.reload();
		await r.storage.set(PROVIDER, { type: "api_key", key });
		const reports = await r.storage.fetchUsageReports();
		const checks = await r.storage.checkCredentials();
		const text = everything(r, { reports, checks });
		expect(text).not.toContain(encoded);
		expect(text).not.toContain(encoded.replace(/=+$/, ""));
		expect(reports).toHaveLength(1);

		const r2 = rig(failing);
		await r2.storage.reload();
		await r2.storage.set("fake-failing-backend", { type: "api_key", key });
		await r2.storage.fetchUsageReports();
		const checks2 = await r2.storage.checkCredentials();
		expect(everything(r2, checks2)).not.toContain(encoded);
	});

	it("does not trust a completion callback's extra property names or its provider/type/status values", async () => {
		const key = "completion-secret-445-abcdef";
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(): Promise<UsageReport> {
				return { provider: PROVIDER, fetchedAt: Date.now(), limits: [limit("five")] };
			},
		};
		const r = rig(backend);
		await r.storage.reload();
		await r.storage.set(PROVIDER, { type: "api_key", key });
		const checks = await r.storage.checkCredentials({
			completionProbe: async () =>
				({ ok: true, [key]: "x", provider: key, type: key, status: key, nested: { status: key } }) as never,
		});
		expect(JSON.stringify(checks)).not.toContain(key);
		expect(checks[0]?.provider).toBe(PROVIDER);
		expect(checks[0]?.type).toBe("api_key");
		expect(checks[0]?.ok).toBe(true);
	});

	it("keeps a report whose payload has data keys named like Object.prototype members", async () => {
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(): Promise<UsageReport> {
				return {
					provider: PROVIDER,
					fetchedAt: Date.now(),
					toString: "x",
					valueOf: "y",
					limits: [{ ...limit("five"), constructor: "z", hasOwnProperty: "w" }],
				} as unknown as UsageReport;
			},
		};
		const r = rig(backend);
		await r.storage.reload();
		await r.storage.set(PROVIDER, { type: "api_key", key: "any-key-445" });
		const reports = await r.storage.fetchUsageReports();
		expect(reports).toHaveLength(1);
		expect(reports?.[0]?.limits).toHaveLength(1);
		const checks = await r.storage.checkCredentials();
		expect(checks[0]?.ok).toBe(true);
	});

	it("removes the base64 of a three-character key where it stands alone, and keeps ordinary text intact", async () => {
		const key = "abc";
		const encoded = Buffer.from(key).toString("base64");
		expect(encoded).toBe("YWJj");
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(_params, ctx): Promise<UsageReport> {
				ctx.logger?.debug("sent", { header: `Basic ${encoded}`, note: "alphabet and cab and YWJjZGVm stay" });
				return {
					provider: PROVIDER,
					fetchedAt: Date.now(),
					limits: [limit("five")],
					metadata: { echoed: encoded, sentence: "a cab ride" },
				};
			},
		};
		const r = rig(backend);
		await r.storage.reload();
		await r.storage.set(PROVIDER, { type: "api_key", key });
		const reports = await r.storage.fetchUsageReports();
		const checks = await r.storage.checkCredentials();
		const text = everything(r, { reports, checks });
		expect(text).not.toMatch(/(?<![A-Za-z0-9+/_=-])YWJj(?![A-Za-z0-9+/_=-])/);
		expect(reports).toHaveLength(1);
		expect(reports?.[0]?.limits[0]?.amount.unit).toBe("percent");
		expect(checks[0]?.ok).toBe(true);
	});

	it("keeps the declared latencyMs of a completion probe result", async () => {
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(): Promise<UsageReport> {
				return { provider: PROVIDER, fetchedAt: Date.now(), limits: [limit("five")] };
			},
		};
		const r = rig(backend);
		await r.storage.reload();
		await r.storage.set(PROVIDER, { type: "api_key", key: "latency-key-445" });
		const checks = await r.storage.checkCredentials({
			completionProbe: async () => ({ ok: true, modelId: "m1", latencyMs: 42 }),
		});
		expect(checks[0]?.completion).toEqual({ ok: true, modelId: "m1", latencyMs: 42 });
	});

	it("removes a refreshed token that equals the base64 of the old short token, wherever it is embedded", () => {
		const oldAccess = "abc";
		const refreshed = Buffer.from(oldAccess).toString("base64"); // "YWJj"
		// Both orders: the literal must win over the other secret's whole-token form whichever comes first.
		for (const secrets of [
			[oldAccess, refreshed],
			[refreshed, oldAccess],
		]) {
			expect(redactUsageText(`x${refreshed}Z9 and ${refreshed}`, secrets)).not.toContain(refreshed);
			expect(redactUsageText("a plain abc", secrets)).not.toContain("abc");
		}
	});
});
