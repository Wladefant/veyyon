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

async function rig(backend: UsageProvider, key: string = KEY): Promise<Rig> {
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
	await storage.set(PROVIDER, { type: "api_key", key });
	return { db, storage, usageLog, globalLog };
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

async function drive(
	r: Rig,
	completionProbe?: CompletionProbe,
): Promise<{ reports: UsageReport[]; checks: CredentialHealthResult[] }> {
	const reports = await r.storage.fetchUsageReports();
	const checks = await r.storage.checkCredentials(completionProbe ? { completionProbe } : undefined);
	return { reports: reports ?? [], checks };
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
		const bytes = Array.from(Buffer.from(KEY)).join(",");
		const r = await rig(
			reporting(() => ({
				metadata: { blob: Buffer.from(KEY), view: new Uint8Array(Buffer.from(KEY)), keep: "plain-value" },
			})),
		);
		const out = await drive(r);
		expectClean(observe(r, out), [KEY, bytes]);
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

	it("replaces a value that throws on inspection with a fixed placeholder, never the error text", async () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error(KEY);
				},
			},
		);
		const r = await rig(reporting(() => ({ metadata: { hostile, keep: "plain-value" } })));
		const out = await drive(r);
		expect(out.checks[0]?.ok).toBe(true);
		expectClean(observe(r, out), [KEY]);
		expect(out.reports[0]?.metadata?.keep).toBe("plain-value");
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
		const r = await rig(
			throwing("GET https://api.example.com/usage?key=sec%2Bret%2Fkey%3D%3D123 failed"),
			key,
		);
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
			const row = r.db.query("SELECT key FROM cache WHERE key LIKE 'usage_cache:%'").get() as
				| { key: string }
				| null;
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
});
