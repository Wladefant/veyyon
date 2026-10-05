/**
 * WHY: the first redaction pass for #445 removed the exact credential from error text, but left the
 * boundary leaky: a short key, an encoded key, a key used as an object property NAME, identity fields
 * copied before redaction, a resolved completion probe, a label rule that ate "Bearer" and left the
 * token, `usage_cache` rows written before the fix, and a cycle guard that crashed on a shared object.
 *
 * CLASS CLOSED: every output channel of the real `AuthStorage` (returned reports, the credential-check
 * results, the usage logger, the global logger and every persisted `usage_cache:` row) is collected by
 * `observe()` and each is asserted free of the credential, for each shape of leak. A new channel is
 * added to `observe()`; a channel nobody lists is not asserted, so keep that list the one place.
 *
 * GAP: a DIFFERENT secret with no recognisable shape, and a truncated prefix of the key, are not caught.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	AuthStorage,
	type CompletionProbe,
	type CredentialHealthResult,
	SqliteAuthCredentialStore,
} from "@veyyon/ai/auth-storage";
import { redactUsageError } from "@veyyon/ai/auth-storage/usage-redaction";
import { ProviderHttpError } from "@veyyon/ai/error";
import { redactProviderSecrets } from "@veyyon/ai/error/error-body";
import type { UsageLimit, UsageLogger, UsageProvider, UsageReport } from "@veyyon/ai/usage";
import * as logger from "@veyyon/utils/logger";

const KEY = "fake-sentinel-key-123";
const PROVIDER = "fake-usage-backend";

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Rig {
	db: Database;
	storage: AuthStorage;
	usageLog: string[];
	globalLog: string[];
}

type StoredCredential = Parameters<AuthStorage["set"]>[1];

async function rig(backend: UsageProvider, key: string = KEY, credential?: StoredCredential): Promise<Rig> {
	const globalLog: string[] = [];
	for (const level of ["debug", "warn", "error", "info"] as const) {
		vi.spyOn(logger, level).mockImplementation((message: string, meta?: unknown) => {
			globalLog.push(JSON.stringify({ message, meta }));
		});
	}
	const db = new Database(":memory:");
	const store = new SqliteAuthCredentialStore(db);
	cleanups.push(() => store.close());
	const usageLog: string[] = [];
	const sink = (message: string, meta?: Record<string, unknown>) => usageLog.push(JSON.stringify({ message, meta }));
	const usageLogger: UsageLogger = { debug: sink, warn: sink };
	const storage = new AuthStorage(store, {
		usageProviderResolver: id => (id === PROVIDER ? backend : undefined),
		usageLogger,
	});
	await storage.reload();
	await storage.set(PROVIDER, credential ?? { type: "api_key", key });
	return { db, storage, usageLog, globalLog };
}

function historyRows(r: Rig): string {
	const persisted = r.db.query("SELECT * FROM usage_history").all();
	return JSON.stringify({ persisted, listed: r.storage.listUsageHistory() });
}

function usageRows(db: Database): string {
	return JSON.stringify(db.query("SELECT key, value FROM cache WHERE key LIKE 'usage_cache:%'").all());
}

/** Every output channel, by name. This is the one list: a new channel is added here. */
function observe(
	r: Rig,
	outputs: { reports?: UsageReport[]; checks?: CredentialHealthResult[] },
): Record<string, string> {
	return {
		reports: JSON.stringify(outputs.reports ?? []),
		checks: JSON.stringify(outputs.checks ?? []),
		usageLog: r.usageLog.join("\n"),
		globalLog: r.globalLog.join("\n"),
		persistedUsageRows: usageRows(r.db),
		usageHistory: historyRows(r),
	};
}

function expectClean(channels: Record<string, string>, needles: readonly string[]): void {
	for (const [channel, text] of Object.entries(channels)) {
		for (const needle of needles) {
			const at = text.indexOf(needle);
			const excerpt = at === -1 ? "" : text.slice(Math.max(0, at - 60), at + needle.length + 20);
			expect({ channel, needle, excerpt }).toEqual({ channel, needle, excerpt: "" });
		}
	}
}

/**
 * No channel may hold the secret's bytes in any numeric spelling: a JSON array of byte values, or an
 * object keyed by index. Both utf8 and latin1 decodings are checked.
 */
function expectNoBytesOf(channels: Record<string, string>, secret: string): void {
	for (const [channel, text] of Object.entries(channels)) {
		const spellings = [text.match(/\d+/g) ?? [], [...text.matchAll(/:(\d+)/g)].map(match => match[1])];
		for (const numbers of spellings) {
			const joined = `,${numbers.join(",")},`;
			for (const encoding of ["utf8", "latin1"] as const) {
				const bytes = `,${Array.from(Buffer.from(secret, encoding)).join(",")},`;
				expect({ channel, encoding, found: joined.includes(bytes) }).toEqual({ channel, encoding, found: false });
			}
		}
	}
}

async function drive(
	r: Rig,
	completionProbe?: CompletionProbe,
): Promise<{ reports: UsageReport[]; checks: CredentialHealthResult[] }> {
	const reports = await r.storage.fetchUsageReports();
	const checks = await r.storage.checkCredentials(completionProbe ? { completionProbe } : undefined);
	return { reports: reports ?? [], checks };
}

function expireRows(r: Rig): void {
	const row = r.db.query("SELECT key, value FROM cache WHERE key LIKE 'usage_cache:%'").get() as {
		key: string;
		value: string;
	} | null;
	const entry = JSON.parse(row?.value ?? "{}") as { expiresAt: number };
	entry.expiresAt = Date.now() - 1000;
	r.db.query("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify(entry), row?.key ?? "");
}

function throwing(message: string): UsageProvider {
	return {
		id: PROVIDER,
		async fetchUsage() {
			throw new Error(message);
		},
	} as UsageProvider;
}

function reporting(build: (provider: UsageReport["provider"]) => Partial<UsageReport>): UsageProvider {
	return {
		id: PROVIDER,
		async fetchUsage(params): Promise<UsageReport> {
			return { provider: params.provider, fetchedAt: Date.now(), limits: [], ...build(params.provider) };
		},
	} as UsageProvider;
}

describe("the usage credential boundary", () => {
	it("redacts a short key from a thrown error", async () => {
		const r = await rig(throwing("upstream said: abc123"), "abc123");
		const out = await drive(r);
		expectClean(observe(r, out), ["abc123"]);
		expect(out.checks[0]?.reason).toContain("upstream said:");
	});

	it("redacts a three-character key whatever its length", async () => {
		const r = await rig(throwing("upstream said: xq7"), "xq7");
		const out = await drive(r);
		expectClean(observe(r, out), ["xq7"]);
		expect(out.checks[0]?.reason).toContain("upstream said:");
	});

	it("does not let an object's own toJSON bring the key back into a report, a log or the cache", async () => {
		const withToJson = (): Record<string, unknown> => ({ safe: "plain-value", toJSON: () => ({ leaked: KEY }) });
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(params, ctx): Promise<UsageReport> {
				ctx.logger?.debug("probing", withToJson());
				return {
					provider: params.provider,
					fetchedAt: Date.now(),
					limits: [],
					metadata: withToJson(),
				} as UsageReport;
			},
		} as UsageProvider;
		const r = await rig(backend);
		const out = await drive(r);
		expectClean(observe(r, out), [KEY]);
		expect(out.reports[0]?.metadata?.safe).toBe("plain-value");
	});

	it("keeps the key's bytes out of a report that carries a Buffer or a typed array", async () => {
		const r = await rig(
			reporting(() => ({
				metadata: { blob: Buffer.from(KEY), view: new Uint8Array(Buffer.from(KEY)), keep: "plain-value" },
			})),
		);
		const out = await drive(r);
		const channels = observe(r, out);
		expectClean(channels, [KEY]);
		expectNoBytesOf(channels, KEY);
		expect(out.reports[0]?.metadata?.keep).toBe("plain-value");
	});

	it("does not call a Date's own toISOString, which can return the key", async () => {
		const stamp = new Date(1_700_000_000_000);
		stamp.toISOString = () => KEY;
		const r = await rig(reporting(() => ({ metadata: { stamp } })));
		const out = await drive(r);
		expectClean(observe(r, out), [KEY]);
		expect(out.reports[0]?.metadata?.stamp).toBe("2023-11-14T22:13:20.000Z");
	});

	it("does not run an enumerable getter that throws an Error holding the key", async () => {
		const metadata: Record<string, unknown> = { keep: "plain-value" };
		Object.defineProperty(metadata, "boom", {
			enumerable: true,
			get() {
				throw new Error(KEY);
			},
		});
		const r = await rig(reporting(() => ({ metadata })));
		const out = await drive(r);
		expect(out.checks[0]?.ok).toBe(true);
		expectClean(observe(r, out), [KEY]);
		expect(out.reports[0]?.metadata?.keep).toBe("plain-value");
	});

	it("never reflects on a Proxy, and shows a fixed placeholder for it", async () => {
		const traps = { ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 };
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					traps.ownKeys++;
					throw new Error(KEY);
				},
				getOwnPropertyDescriptor() {
					traps.getOwnPropertyDescriptor++;
					throw new Error(KEY);
				},
				get() {
					traps.get++;
					throw new Error(KEY);
				},
			},
		);
		const r = await rig(reporting(() => ({ metadata: { hostile, keep: "plain-value" } })));
		const out = await drive(r);
		expect(out.checks[0]?.ok).toBe(true);
		expectClean(observe(r, out), [KEY]);
		expect(out.reports[0]?.metadata?.hostile).toBe("[unreadable]");
		expect(out.reports[0]?.metadata?.keep).toBe("plain-value");
		expect(traps).toEqual({ ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 });
	});

	it("shows a placeholder for a value that throws on inspection, never the error text", async () => {
		const fakeDate = Object.create(Date.prototype) as Date;
		const r = await rig(reporting(() => ({ metadata: { fakeDate, keep: "plain-value" } })));
		const out = await drive(r);
		expect(out.reports[0]?.metadata?.fakeDate).toBe("[unreadable]");
		expect(out.reports[0]?.metadata?.keep).toBe("plain-value");
	});

	it("redacts the credential bytes the org fallback copies into a report (orgName holding the access token) after the backend returned it", async () => {
		const credential: StoredCredential = {
			type: "oauth",
			access: KEY,
			refresh: "fake-refresh-token-456",
			expires: Date.now() + 3_600_000,
			orgId: "org-1",
			orgName: KEY,
		};
		const r = await rig(
			reporting(() => ({ metadata: {} })),
			KEY,
			credential,
		);
		const out = await drive(r);
		expect(out.reports.length).toBeGreaterThan(0);
		expectClean(observe(r, out), [KEY]);
	});

	it("does not let an error whose message getter throws escape checkCredentials with the key", async () => {
		const hostileError = (): Error => {
			const error = new Error("placeholder");
			Object.defineProperty(error, "message", {
				get() {
					throw new Error(KEY);
				},
			});
			return error;
		};
		const backend = {
			id: PROVIDER,
			fetchUsage: async () => {
				throw hostileError();
			},
		} as unknown as UsageProvider;
		const r = await rig(backend);
		const probe: CompletionProbe = async () => {
			throw hostileError();
		};
		const out = await drive(r, probe);
		expect(out.checks[0]?.ok).toBe(false);
		expect(out.checks[0]?.completion?.ok).toBe(false);
		expectClean(observe(r, out), [KEY]);
	});

	const unreadableRoots: Array<[string, () => unknown]> = [
		[
			"a Proxy",
			() =>
				new Proxy(
					{},
					{
						ownKeys() {
							throw new Error(KEY);
						},
					},
				),
		],
		["a string", () => KEY],
		["a number", () => 42],
		["undefined", () => undefined],
		["an array", () => []],
		["an object with no limits", () => ({ provider: PROVIDER, fetchedAt: 1 })],
		[
			"an object whose limits is a getter",
			() => ({
				provider: PROVIDER,
				fetchedAt: 1,
				get limits() {
					return [];
				},
			}),
		],
		["an object without a provider", () => ({ fetchedAt: 1, limits: [] })],
		["an object without fetchedAt", () => ({ provider: PROVIDER, limits: [] })],
		["an object whose limits is a Proxy", () => ({ provider: PROVIDER, fetchedAt: 1, limits: new Proxy([], {}) })],
	];
	for (const [name, root] of unreadableRoots) {
		it(`fails closed when the report is ${name}`, async () => {
			const backend = { id: PROVIDER, fetchUsage: async () => root() } as unknown as UsageProvider;
			const r = await rig(backend);
			const out = await drive(r);
			expect(out.reports).toEqual([]);
			expect(out.checks[0]?.ok).toBe(false);
			expect(out.checks[0]?.report).toBeUndefined();
			expect(out.checks[0]?.reason).toBe("usage probe returned a report that could not be read");
			expectClean(observe(r, out), [KEY]);
		});
	}

	it("drops a limit that is not an object instead of crashing the reader", async () => {
		const limits = [
			() => 1,
			undefined,
			"text",
			{
				id: "kept",
				label: "Kept",
				scope: { provider: "anthropic" },
				amount: { unit: "percent", used: 1, limit: 100 },
			},
		];
		const r = await rig(reporting(() => ({ limits: limits as unknown as UsageLimit[] })));
		const out = await drive(r);
		expect(out.reports[0]?.limits.map(limit => limit.id)).toEqual(["kept"]);
	});

	it("redacts a key used as an object property name in a report and in logger metadata", async () => {
		const backend: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(params, ctx): Promise<UsageReport> {
				ctx.logger?.debug("probing", { [KEY]: "echo" });
				return {
					provider: params.provider,
					fetchedAt: Date.now(),
					limits: [],
					metadata: { [KEY]: "echo", keep: "plain-value" },
				};
			},
		} as UsageProvider;
		const r = await rig(backend);
		const out = await drive(r);
		expectClean(observe(r, out), [KEY]);
		expect(out.reports[0]?.metadata?.keep).toBe("plain-value");
	});

	it("redacts a key echoed into metadata accountId and email before checkCredentials copies them", async () => {
		const r = await rig(reporting(() => ({ metadata: { accountId: KEY, email: KEY } })));
		const out = await drive(r);
		expect(out.checks[0]?.ok).toBe(true);
		expectClean(observe(r, out), [KEY]);
	});

	it("redacts a reason from a completion probe that resolves instead of throwing", async () => {
		const r = await rig(reporting(() => ({})));
		const probe: CompletionProbe = async () => ({ ok: false, reason: `upstream said: ${KEY}` });
		const out = await drive(r, probe);
		expect(out.checks[0]?.completion?.ok).toBe(false);
		expectClean(observe(r, out), [KEY]);
	});

	it("redacts a URL-encoded key in an error", async () => {
		const key = "sec+ret/key==123";
		const r = await rig(throwing("GET https://api.example.com/usage?key=sec%2Bret%2Fkey%3D%3D123 failed"), key);
		const out = await drive(r);
		expectClean(observe(r, out), [key, "sec%2Bret%2Fkey%3D%3D123", "sec%2bret%2fkey%3d%3d123"]);
	});

	it("redacts a key echoed as a form field, a whole-URL path or a JSON string", async () => {
		const key = 'pa ss"word&1';
		const spellings = ["pa+ss%22word%261", "pa%20ss%22word&1", 'pa ss\\"word&1', "pa%20ss%22word%261"];
		// "word&1" is the tail of the key: the log channels re-escape what they hold, so only a
		// fragment that survives escaping can show a leftover from the JSON-string spelling.
		const r = await rig(throwing(`echo ${spellings.join(" | ")}`), key);
		const out = await drive(r);
		expectClean(observe(r, out), [key, ...spellings, "word&1"]);
	});

	it("redacts the token of an Authorization: Bearer header that is not the request's key", async () => {
		const r = await rig(throwing("proxy echoed Authorization: Bearer abcdefghijk end"));
		const out = await drive(r);
		expectClean(observe(r, out), ["abcdefghijk"]);
		expect(redactProviderSecrets("Authorization: Bearer abcdefghijk")).not.toContain("abcdefghijk");
		// A scheme word with no token after it must not swallow the next line.
		expect(redactProviderSecrets("Authorization: Bearer\nHost: api")).toContain("Host: api");
	});

	describe("a usage_cache row written before the fix", () => {
		async function seedLegacyRow(r: Rig, expiresAt: number): Promise<void> {
			const row = r.db.query("SELECT key FROM cache WHERE key LIKE 'usage_cache:%'").get() as { key: string } | null;
			expect(row).not.toBeNull();
			const legacy = {
				value: { provider: PROVIDER, fetchedAt: Date.now(), limits: [], metadata: { echo: KEY } },
				expiresAt,
			};
			r.db
				.query("UPDATE cache SET value = ?, expires_at = ? WHERE key = ?")
				.run(JSON.stringify(legacy), Math.floor((Date.now() + 86_400_000) / 1000), row?.key ?? "");
		}

		it("is not served fresh and is rewritten without the key", async () => {
			const r = await rig(reporting(() => ({ metadata: { echo: "clean" } })));
			await r.storage.fetchUsageReports();
			await seedLegacyRow(r, Date.now() + 3_600_000);
			const reports = await r.storage.fetchUsageReports();
			expectClean(observe(r, { reports: reports ?? [] }), [KEY]);
			expect(JSON.stringify(reports)).toContain("clean");
		});

		it("is not served stale after a network failure and is not re-persisted", async () => {
			let fail = false;
			const backend: UsageProvider = {
				id: PROVIDER,
				async fetchUsage(params): Promise<UsageReport> {
					if (fail) throw new Error("network down");
					return { provider: params.provider, fetchedAt: Date.now(), limits: [], metadata: { echo: "clean" } };
				},
			} as UsageProvider;
			const r = await rig(backend);
			await r.storage.fetchUsageReports();
			await seedLegacyRow(r, Date.now() - 1000);
			fail = true;
			const reports = await r.storage.fetchUsageReports();
			expectClean(observe(r, { reports: reports ?? [] }), [KEY]);
		});
	});

	it("keeps a shared acyclic reference instead of crashing on it", async () => {
		const shared: UsageLimit = {
			id: "shared",
			label: "Shared",
			scope: { provider: "anthropic" },
			amount: { unit: "percent", used: 1, limit: 100 },
		} as UsageLimit;
		const sharedMeta = { note: "plain" };
		const r = await rig(reporting(() => ({ limits: [shared, shared], metadata: { a: sharedMeta, b: sharedMeta } })));
		const out = await drive(r);
		expect(out.reports[0]?.limits).toHaveLength(2);
		expect(out.reports[0]?.limits[1]?.scope).toEqual({ provider: "anthropic" });
		expect(out.reports[0]?.metadata).toEqual({ a: { note: "plain" }, b: { note: "plain" } });
	});

	describe("the cache row key", () => {
		const oauth = {
			type: "oauth",
			access: KEY,
			refresh: "refresh-token-placeholder",
			expires: Date.now() + 3_600_000,
			accountId: KEY,
			email: `${KEY}@example.test`,
		} as StoredCredential;

		it("carries a digest of the account identity, never the identity", async () => {
			const r = await rig(
				reporting(() => ({ metadata: { echo: "clean" } })),
				KEY,
				oauth,
			);
			await r.storage.fetchUsageReports();
			expect(usageRows(r.db)).toContain("clean");
			expectClean(observe(r, {}), [KEY]);
		});

		it("keeps one row per account across repeated fetches", async () => {
			const r = await rig(
				reporting(() => ({ metadata: { echo: "clean" } })),
				KEY,
				oauth,
			);
			await r.storage.fetchUsageReports();
			await r.storage.fetchUsageReports();
			const rows = r.db.query("SELECT key FROM cache WHERE key LIKE 'usage_cache:%'").all();
			expect(rows).toHaveLength(1);
		});

		it("deletes a raw-identity row left by an earlier version instead of serving it", async () => {
			const r = await rig(reporting(() => ({ metadata: { echo: "clean" } })));
			const legacyKey = `usage_cache:report:2:${PROVIDER}:default:oauth|account:${KEY}|email:${KEY}@example.test`;
			const payload = JSON.stringify({
				v: 2,
				value: { provider: PROVIDER, fetchedAt: Date.now(), limits: [], metadata: { echo: "stale" } },
				expiresAt: Date.now() + 3_600_000,
			});
			const exp = Math.floor((Date.now() + 86_400_000) / 1000);
			r.db.query("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)").run(legacyKey, payload, exp);
			const reopened = new SqliteAuthCredentialStore(r.db);
			cleanups.push(() => reopened.close());
			const next = new AuthStorage(reopened, { usageProviderResolver: () => undefined });
			await next.reload();
			expectClean({ persistedUsageRows: usageRows(r.db) }, [KEY]);
		});
	});

	it("does not run a trap on a proxied Error thrown by a backend", async () => {
		let traps = 0;
		const proxied = new Proxy(new Error(`rejected ${KEY}`), {
			getPrototypeOf(target) {
				traps++;
				return Reflect.getPrototypeOf(target);
			},
			get(target, prop) {
				traps++;
				return Reflect.get(target, prop);
			},
		});
		const r = await rig({
			id: PROVIDER,
			async fetchUsage() {
				throw proxied;
			},
		} as UsageProvider);
		const out = await drive(r);
		expect(traps).toBe(0);
		expectClean(observe(r, out), [KEY]);
	});

	it("keeps a base URL query string out of the cache row key", async () => {
		const r = await rig(reporting(() => ({ metadata: { echo: "clean" } })));
		await r.storage.fetchUsageReports({ baseUrlResolver: () => `https://usage.example.test/v1?key=${KEY}` });
		expect(usageRows(r.db)).toContain("clean");
		expectClean({ persistedUsageRows: usageRows(r.db) }, [KEY]);
	});

	describe("classifying a thrown HTTP error runs no user code", () => {
		function failing(error: unknown): UsageProvider {
			return {
				id: PROVIDER,
				async fetchUsage() {
					throw error;
				},
			} as UsageProvider;
		}

		it("does not call a throwing status getter", async () => {
			const error = new ProviderHttpError("neutral", 500);
			Object.defineProperty(error, "status", {
				get() {
					throw new Error(KEY);
				},
			});
			const r = await rig(failing(error));
			const out = await drive(r);
			expectClean(observe(r, out), [KEY]);
		});

		it("does not read status through a prototype getter either", async () => {
			const proto = Object.create(ProviderHttpError.prototype, {
				status: {
					get() {
						throw new Error(KEY);
					},
				},
			});
			const error = Object.setPrototypeOf(new Error("neutral"), proto);
			const r = await rig(failing(error));
			const out = await drive(r);
			expectClean(observe(r, out), [KEY]);
		});

		it("does not run a trap on a Proxy prototype", async () => {
			let traps = 0;
			const proto = new Proxy(ProviderHttpError.prototype, {
				get(target, prop, receiver) {
					traps++;
					return Reflect.get(target, prop, receiver);
				},
				getOwnPropertyDescriptor(target, prop) {
					traps++;
					return Reflect.getOwnPropertyDescriptor(target, prop);
				},
				getPrototypeOf(target) {
					traps++;
					return Reflect.getPrototypeOf(target);
				},
			});
			const error = Object.setPrototypeOf(new Error(`rejected ${KEY}`), proto);
			const r = await rig(failing(error));
			const out = await drive(r);
			expect(traps).toBe(0);
			expectClean(observe(r, out), [KEY]);
		});

		const unauthorized: Array<[string, () => Error]> = [
			["an own data status", () => new ProviderHttpError("unauthorized", 401)],
			[
				"a status data property inherited from the prototype",
				() =>
					Object.setPrototypeOf(
						new Error("unauthorized"),
						Object.create(ProviderHttpError.prototype, { status: { value: 401 } }),
					),
			],
		];
		for (const [label, build] of unauthorized) {
			it(`still purges the last-good report on ${label}`, async () => {
				let fail = false;
				const backend: UsageProvider = {
					id: PROVIDER,
					async fetchUsage(params): Promise<UsageReport> {
						if (fail) throw build();
						return { provider: params.provider, fetchedAt: Date.now(), limits: [], metadata: { echo: "good" } };
					},
				} as UsageProvider;
				const r = await rig(backend);
				expect(JSON.stringify(await r.storage.fetchUsageReports())).toContain("good");
				expireRows(r);
				fail = true;
				expect(JSON.stringify((await r.storage.fetchUsageReports()) ?? [])).not.toContain("good");
			});
		}
	});

	describe("a usage backend's supports() throwing", () => {
		function unsupportedBy(): UsageProvider {
			return {
				id: PROVIDER,
				supports(params: { credential: { apiKey?: string } }): boolean {
					throw new Error(`unsupported credential: ${params.credential.apiKey}`);
				},
				async fetchUsage(): Promise<UsageReport> {
					throw new Error("never reached");
				},
			} as unknown as UsageProvider;
		}

		it("is redacted and does not escape fetchUsageReports", async () => {
			const r = await rig(unsupportedBy());
			const reports = await r.storage.fetchUsageReports();
			expect(reports ?? []).toEqual([]);
			expectClean(observe(r, { reports: reports ?? [] }), [KEY]);
		});

		it("is redacted and does not escape checkCredentials", async () => {
			const r = await rig(unsupportedBy());
			const checks = await r.storage.checkCredentials();
			expect(checks.map(check => check.ok)).toEqual([false]);
			expectClean(observe(r, { checks }), [KEY]);
		});

		it("fails closed for that provider only and leaves the others running", async () => {
			const OTHER = "fake-usage-backend-ok";
			const working: UsageProvider = {
				id: OTHER,
				async fetchUsage(params): Promise<UsageReport> {
					return { provider: params.provider, fetchedAt: Date.now(), limits: [], metadata: { echo: "other-ok" } };
				},
			} as UsageProvider;
			const db = new Database(":memory:");
			const store = new SqliteAuthCredentialStore(db);
			cleanups.push(() => store.close());
			const storage = new AuthStorage(store, {
				usageProviderResolver: id => (id === PROVIDER ? unsupportedBy() : id === OTHER ? working : undefined),
			});
			await storage.reload();
			await storage.set(PROVIDER, { type: "api_key", key: KEY });
			await storage.set(OTHER, { type: "api_key", key: "other-key-456" });
			const reports = await storage.fetchUsageReports();
			expect(JSON.stringify(reports)).toContain("other-ok");
			const checks = await storage.checkCredentials();
			expect(checks.map(check => [check.provider, check.ok]).sort()).toEqual([
				[PROVIDER, false],
				[OTHER, true],
			]);
			expect(JSON.stringify({ reports, checks })).not.toContain(KEY);
		});
	});

	describe("every hostile value through every entry point", () => {
		const boom = (): never => {
			throw new Error(KEY);
		};
		/** Values a backend may throw or return. Reading any of them the ordinary way throws the key. */
		const hostile: Array<[string, () => unknown]> = [
			[
				"an Error whose message getter throws the key",
				() => Object.defineProperty(new Error("x"), "message", { get: boom }),
			],
			[
				"an object whose Symbol.toPrimitive and toString throw the key",
				() => ({ [Symbol.toPrimitive]: boom, toString: boom }),
			],
			[
				"an Error with a Proxy prototype",
				() =>
					Object.setPrototypeOf(
						new Error(`rejected ${KEY}`),
						new Proxy(Error.prototype, { get: boom, getPrototypeOf: boom, getOwnPropertyDescriptor: boom }),
					),
			],
			[
				"a callable Proxy",
				() =>
					new Proxy(() => undefined, {
						get: boom,
						apply: boom,
						ownKeys: boom,
						getPrototypeOf: boom,
						getOwnPropertyDescriptor: boom,
					}),
			],
			["a bigint", () => 10n ** 30n],
			["a symbol described by the key", () => Symbol(KEY)],
			["undefined", () => undefined],
			["null", () => null],
			["a number", () => 42],
			["a string holding the key", () => `bad ${KEY}`],
			["an Error whose cause holds the key", () => new Error("outer", { cause: new Error(KEY) })],
			["an object keyed and valued by the key", () => ({ [KEY]: KEY })],
		];
		const oauth = {
			type: "oauth",
			access: KEY,
			refresh: "refresh-token-placeholder",
			expires: Date.now() + 3_600_000,
			accountId: "account-placeholder",
			email: "person@example.test",
		} as StoredCredential;
		const okReport = (provider: UsageReport["provider"], extra: Partial<UsageReport> = {}): UsageReport =>
			({ provider, fetchedAt: Date.now(), limits: [], ...extra }) as UsageReport;

		type Entry = (value: () => unknown) => UsageProvider & { parseRateLimitHeaders?: unknown };
		const entries: Array<[string, Entry, { ingest?: boolean; completionThrows?: boolean }]> = [
			[
				"a fetchUsage that throws it",
				value =>
					({
						id: PROVIDER,
						async fetchUsage() {
							throw value();
						},
					}) as UsageProvider,
				{},
			],
			[
				"a supports() that throws it",
				value =>
					({
						id: PROVIDER,
						supports() {
							throw value();
						},
						async fetchUsage() {
							return okReport("anthropic");
						},
					}) as unknown as UsageProvider,
				{},
			],
			[
				"a fetchUsage that returns it in metadata",
				value =>
					({
						id: PROVIDER,
						async fetchUsage(params: { provider: UsageReport["provider"] }) {
							return okReport(params.provider, { metadata: { value: value() } });
						},
					}) as unknown as UsageProvider,
				{},
			],
			[
				"a completion probe that throws it",
				() =>
					({
						id: PROVIDER,
						async fetchUsage(params: { provider: UsageReport["provider"] }) {
							return okReport(params.provider);
						},
					}) as unknown as UsageProvider,
				{ completionThrows: true },
			],
			[
				"a header parser that throws it",
				value =>
					({
						id: PROVIDER,
						async fetchUsage(params: { provider: UsageReport["provider"] }) {
							return okReport(params.provider);
						},
						parseRateLimitHeaders() {
							throw value();
						},
					}) as unknown as UsageProvider,
				{ ingest: true },
			],
			[
				"a header parser that returns a report whose limits getter throws it",
				value =>
					({
						id: PROVIDER,
						async fetchUsage(params: { provider: UsageReport["provider"] }) {
							return okReport(params.provider);
						},
						parseRateLimitHeaders() {
							return Object.defineProperty(okReport("anthropic"), "limits", {
								get() {
									value();
								},
							});
						},
					}) as unknown as UsageProvider,
				{ ingest: true },
			],
			[
				"a header parser that returns it in metadata",
				value =>
					({
						id: PROVIDER,
						async fetchUsage(params: { provider: UsageReport["provider"] }) {
							return okReport(params.provider);
						},
						parseRateLimitHeaders() {
							return okReport("anthropic", { metadata: { value: value() } });
						},
					}) as unknown as UsageProvider,
				{ ingest: true },
			],
		];

		for (const [entryLabel, build, mode] of entries) {
			for (const [valueLabel, value] of hostile) {
				it(`keeps the key out of every channel: ${entryLabel}, ${valueLabel}`, async () => {
					const r = await rig(build(value), KEY, oauth);
					if (mode.ingest) {
						expect(() => r.storage.ingestUsageHeaders(PROVIDER, {}, {})).not.toThrow();
					}
					const probe = mode.completionThrows
						? async () => {
								throw value();
							}
						: undefined;
					const out = await drive(r, probe);
					expectClean(observe(r, out), [KEY]);
				});
			}
		}
	});

	it("redacts a store failure while recording usage history", async () => {
		vi.spyOn(SqliteAuthCredentialStore.prototype, "recordUsageSnapshots").mockImplementation(() => {
			throw new Error(`history store rejected ${KEY}`);
		});
		const limit = {
			id: "history",
			label: "History",
			scope: { provider: "anthropic" },
			amount: { unit: "percent", used: 1, limit: 100 },
		} as UsageLimit;
		const r = await rig(reporting(() => ({ limits: [limit] })));
		const out = await drive(r);
		expect(out.reports).toHaveLength(1);
		expectClean(observe(r, out), [KEY]);
	});

	it("redacts stored identity copied into ingested header metadata", async () => {
		const backend = {
			id: PROVIDER,
			async fetchUsage(params: { provider: UsageReport["provider"] }): Promise<UsageReport> {
				return { provider: params.provider, fetchedAt: Date.now(), limits: [] };
			},
			parseRateLimitHeaders(): UsageReport {
				return { provider: "anthropic", fetchedAt: Date.now(), limits: [] } as UsageReport;
			},
		} as unknown as UsageProvider;
		const r = await rig(backend, KEY, {
			type: "oauth",
			access: KEY,
			refresh: "refresh-token-placeholder",
			expires: Date.now() + 3_600_000,
			orgId: "org-placeholder",
			orgName: `Team ${KEY}`,
		} as StoredCredential);
		expect(r.storage.ingestUsageHeaders(PROVIDER, {}, {})).toBe(true);
		const out = await drive(r);
		expectClean(observe(r, out), [KEY]);
	});

	it("formats every kind of thrown value without throwing and without the key", () => {
		const boom = (): never => {
			throw new Error(KEY);
		};
		const values: unknown[] = [
			10n ** 30n,
			Symbol(KEY),
			undefined,
			null,
			42,
			true,
			`bad ${KEY}`,
			() => KEY,
			new Proxy(() => undefined, { get: boom, apply: boom, getPrototypeOf: boom }),
			new Proxy({}, { get: boom, ownKeys: boom, getPrototypeOf: boom }),
			Object.defineProperty(new Error("x"), "message", { get: boom }),
			{ [Symbol.toPrimitive]: boom, toString: boom, [KEY]: KEY },
			new Error("outer", { cause: new Error(KEY) }),
		];
		for (const value of values) {
			const text = redactUsageError(value, [KEY]);
			expect(typeof text).toBe("string");
			expect(text).not.toContain(KEY);
		}
	});

	it("keeps the credential out of recorded usage history and keeps an account's rows grouped", async () => {
		const limit = (id: string): UsageLimit =>
			({
				id,
				label: `Window ${KEY}`,
				scope: { provider: "anthropic", accountId: KEY, windowId: KEY },
				window: { label: KEY },
				amount: { unit: "percent", used: 1, limit: 100 },
			}) as UsageLimit;
		const r = await rig(
			reporting(() => ({ limits: [limit(`five-${KEY}`)], metadata: { email: KEY, accountId: KEY } })),
			KEY,
			{
				type: "oauth",
				access: KEY,
				refresh: "refresh-token-placeholder",
				expires: Date.now() + 3_600_000,
				accountId: KEY,
				email: `${KEY}@example.test`,
			} as StoredCredential,
		);
		const out = await drive(r);
		const rows = r.storage.listUsageHistory();
		expect(rows.length).toBeGreaterThan(0);
		expect(new Set(rows.map(row => row.accountKey)).size).toBe(1);
		expectClean(observe(r, out), [KEY]);
	});
});
