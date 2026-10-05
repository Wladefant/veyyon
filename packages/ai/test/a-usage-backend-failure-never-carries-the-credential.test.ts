/**
 * WHY: a usage backend is handed the live credential, and anything it throws, logs or returns can echo
 * that credential back. Before this fix those strings went three places in plaintext: the debug log
 * (`AuthStorage usage fetch failed`), the backend's own `ctx.logger` warnings, the `usage_cache:` row the
 * credential store persists, and the reason text of `checkCredentials`. Extensions can register usage
 * backends, so the surface is no longer only first-party code.
 *
 * CLASS CLOSED: every backend in the usage registry (enumerated from `listRegisteredUsageProviders` at
 * run time, so a new backend is swept by default) is driven through the real `AuthStorage` over a real
 * SQLite store, with an upstream that echoes the credential in a response body and in a thrown network
 * error. For each, with both an API-key and an OAuth credential, neither the surfaced result, the logs
 * nor any persisted `usage_cache:` row may contain a credential value.
 *
 * GAP: redaction is by exact value of the credential in hand plus the credential-shaped families in
 * `redactProviderSecrets`. A backend that echoes a DIFFERENT secret of an unrecognisable shape (a
 * third-party token with no vendor prefix that is not the request's own credential) is not caught.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, type AuthStorageOptions, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import type { UsageLogger, UsageProvider, UsageReport } from "@veyyon/ai/usage";
import "@veyyon/ai/usage/defaults";
import { listRegisteredUsageProviders } from "@veyyon/ai/usage/registry";
import * as logger from "@veyyon/utils/logger";

// Deliberately NOT vendor-shaped: a `sk-...` sentinel would be caught by the shape layer and hide a
// regression in the exact-value layer, which is the one an extension's own key relies on.
const API_KEY = "fake-sentinel-key-123";
const ACCESS = "fake-sentinel-access-456";
const REFRESH = "fake-sentinel-refresh-789";
const SECRETS = [API_KEY, ACCESS, REFRESH];
/** What each credential type holds. The upstream echoes only the secrets of the credential in play. */
const SECRETS_BY_TYPE = { api_key: [API_KEY], oauth: [ACCESS, REFRESH] } as const;
const FAR_FUTURE = Date.now() + 24 * 3_600_000;

interface Rig {
	db: Database;
	store: SqliteAuthCredentialStore;
	storage: AuthStorage;
	logged: string[];
	fetchCalls: () => number;
}

function rig(
	provider: UsageProvider,
	usageFetch?: typeof fetch,
	refreshOAuthCredential?: AuthStorageOptions["refreshOAuthCredential"],
): Rig {
	const db = new Database(":memory:");
	const store = new SqliteAuthCredentialStore(db);
	const logged: string[] = [];
	const sink = (message: string, meta?: Record<string, unknown>) => logged.push(JSON.stringify({ message, meta }));
	const usageLogger: UsageLogger = { debug: sink, warn: sink };
	let calls = 0;
	const countingFetch: typeof fetch | undefined = usageFetch
		? Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					calls++;
					return usageFetch(input, init);
				},
				{ preconnect: () => {} },
			)
		: undefined;
	const storage = new AuthStorage(store, {
		usageProviderResolver: id => (id === provider.id ? provider : undefined),
		usageLogger,
		usageFetch: countingFetch,
		refreshOAuthCredential,
	});
	return { db, store, storage, logged, fetchCalls: () => calls };
}

/** Every `usage_cache:` row as text. The credential row itself legitimately holds the key, so it is not read. */
function persistedUsageRows(db: Database): string {
	const rows = db.query("SELECT key, value FROM cache WHERE key LIKE 'usage_cache:%'").all();
	return JSON.stringify(rows);
}

function expectNoSecret(label: string, text: string): void {
	for (const secret of SECRETS) {
		const at = text.indexOf(secret);
		const excerpt = at === -1 ? "" : text.slice(Math.max(0, at - 80), at + secret.length + 20);
		expect({ label, excerpt }).toEqual({ label, excerpt: "" });
	}
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function globalLogCapture(): string[] {
	const captured: string[] = [];
	for (const level of ["debug", "warn", "error", "info"] as const) {
		vi.spyOn(logger, level).mockImplementation((message: string, meta?: unknown) => {
			captured.push(JSON.stringify({ message, meta }));
		});
	}
	return captured;
}

describe("a usage backend that echoes the credential", () => {
	it("does not write the key into the log when fetchUsage throws it", async () => {
		const captured = globalLogCapture();
		const backend: UsageProvider = {
			id: "fake-usage-backend",
			async fetchUsage() {
				throw new Error(`upstream said: ${API_KEY}`);
			},
		};
		const r = rig(backend);
		cleanups.push(() => r.store.close());
		await r.storage.reload();
		await r.storage.set("fake-usage-backend", { type: "api_key", key: API_KEY });

		const reports = await r.storage.fetchUsageReports();

		expect(reports).toEqual([]);
		expectNoSecret("global log", captured.join("\n"));
		expectNoSecret("usage log", r.logged.join("\n"));
		expectNoSecret("persisted", persistedUsageRows(r.db));
		// The failure is still reported, with the message intact around the removed key.
		expect(captured.join("\n")).toContain("upstream said:");
	});

	it("does not persist or return a key a backend copied into report metadata", async () => {
		const backend: UsageProvider = {
			id: "fake-usage-backend",
			async fetchUsage(params): Promise<UsageReport> {
				return {
					provider: params.provider,
					fetchedAt: Date.now(),
					limits: [],
					notes: [`echo ${API_KEY}`],
					metadata: { echo: API_KEY, nested: { deep: [API_KEY] }, keep: "plain-value" },
				};
			},
		};
		const r = rig(backend);
		cleanups.push(() => r.store.close());
		await r.storage.reload();
		await r.storage.set("fake-usage-backend", { type: "api_key", key: API_KEY });

		const reports = await r.storage.fetchUsageReports();

		expect(reports).toHaveLength(1);
		expectNoSecret("returned report", JSON.stringify(reports));
		expectNoSecret("persisted", persistedUsageRows(r.db));
		expect(reports?.[0]?.metadata?.keep).toBe("plain-value");
		expect(persistedUsageRows(r.db)).toContain("plain-value");
	});

	it("does not put the key in the reason or report that checkCredentials returns", async () => {
		const backend: UsageProvider = {
			id: "fake-usage-backend",
			async fetchUsage() {
				throw new Error(`upstream said: ${API_KEY}`);
			},
		};
		const r = rig(backend);
		cleanups.push(() => r.store.close());
		await r.storage.reload();
		await r.storage.set("fake-usage-backend", { type: "api_key", key: API_KEY });

		const results = await r.storage.checkCredentials();

		expect(results).toHaveLength(1);
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.reason).toContain("upstream said:");
		expectNoSecret("check result", JSON.stringify(results));
	});

	it("does not put the key in the report metadata that checkCredentials returns", async () => {
		const backend: UsageProvider = {
			id: "fake-usage-backend",
			async fetchUsage(params): Promise<UsageReport> {
				return { provider: params.provider, fetchedAt: Date.now(), limits: [], metadata: { echo: API_KEY } };
			},
		};
		const r = rig(backend);
		cleanups.push(() => r.store.close());
		await r.storage.reload();
		await r.storage.set("fake-usage-backend", { type: "api_key", key: API_KEY });

		const results = await r.storage.checkCredentials();

		expect(results[0]?.ok).toBe(true);
		expectNoSecret("check result", JSON.stringify(results));
	});

	it("redacts a credential-shaped secret the backend echoes even when it is not the request's own key", async () => {
		const other = "sk-test-SENTINEL0000";
		const captured = globalLogCapture();
		const backend: UsageProvider = {
			id: "fake-usage-backend",
			async fetchUsage() {
				throw new Error(`proxy leaked ${other}`);
			},
		};
		const r = rig(backend);
		cleanups.push(() => r.store.close());
		await r.storage.reload();
		await r.storage.set("fake-usage-backend", { type: "api_key", key: API_KEY });

		await r.storage.fetchUsageReports();

		expect(captured.join("\n")).not.toContain(other);
		expect(captured.join("\n")).toContain("proxy leaked");
	});
	it("does not store or log the refresh token a failed usage-probe refresh echoed", async () => {
		const captured = globalLogCapture();
		const backend: UsageProvider = {
			id: "fake-usage-backend",
			async fetchUsage(params): Promise<UsageReport> {
				return { provider: params.provider, fetchedAt: Date.now(), limits: [] };
			},
		};
		const r = rig(backend, undefined, async () => {
			throw new Error(`invalid_grant: refresh token ${REFRESH} is revoked`);
		});
		cleanups.push(() => r.store.close());
		await r.storage.reload();
		await r.storage.set("fake-usage-backend", {
			type: "oauth",
			access: ACCESS,
			refresh: REFRESH,
			expires: Date.now() - 60_000,
		});

		await r.storage.fetchUsageReports();

		const disabled = JSON.stringify(r.db.query("SELECT disabled_cause FROM auth_credentials").all());
		expect(disabled).toContain("oauth refresh failed during usage probe");
		expectNoSecret("disable reason", disabled);
		expectNoSecret("global log", captured.join("\n"));
		expectNoSecret("usage log", r.logged.join("\n"));
	});

	it("does not put the refresh token a failed credential-check refresh echoed into the result", async () => {
		const backend: UsageProvider = {
			id: "fake-usage-backend",
			async fetchUsage(params): Promise<UsageReport> {
				return { provider: params.provider, fetchedAt: Date.now(), limits: [] };
			},
		};
		const r = rig(backend, undefined, async () => {
			throw new Error(`temporary failure with ${REFRESH}`);
		});
		cleanups.push(() => r.store.close());
		await r.storage.reload();
		await r.storage.set("fake-usage-backend", {
			type: "oauth",
			access: ACCESS,
			refresh: REFRESH,
			expires: Date.now() - 60_000,
		});

		const results = await r.storage.checkCredentials();

		expect(results[0]?.reason).toContain("oauth refresh failed: temporary failure with");
		expectNoSecret("check result", JSON.stringify(results));
	});
});

// Providers whose registered backend never reaches the network for these credentials, so the sweep
// cannot make them echo anything. Pinned by exact equality: a backend that stops contacting upstream,
// or a new one that starts out unexercisable, turns this red until someone records a decision.
const UNEXERCISABLE_BACKENDS: string[] = ["ollama", "ollama-cloud"];

type Mode = "http-body" | "network-error";

function upstream(mode: Mode, secrets: readonly string[]): typeof fetch {
	const echo = secrets.join(" ");
	return Object.assign(
		async () => {
			if (mode === "network-error") throw new TypeError(`connect failed using ${echo}`);
			return new Response(JSON.stringify({ error: { message: `invalid credential ${echo}` } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		},
		{ preconnect: () => {} },
	);
}

describe("every registered usage backend", () => {
	const backends = listRegisteredUsageProviders();

	it("is enumerated from the registry and non-empty", () => {
		expect(backends.length).toBeGreaterThan(0);
	});

	it("never carries a credential into a log, a surfaced result or a persisted row", async () => {
		const exercised = new Set<string>();
		for (const backend of backends) {
			for (const credentialType of ["api_key", "oauth"] as const) {
				for (const mode of ["http-body", "network-error"] as const) {
					const captured = globalLogCapture();
					const r = rig(backend, upstream(mode, SECRETS_BY_TYPE[credentialType]));
					await r.storage.reload();
					if (credentialType === "api_key") {
						await r.storage.set(backend.id, { type: "api_key", key: API_KEY });
					} else {
						await r.storage.set(backend.id, {
							type: "oauth",
							access: ACCESS,
							refresh: REFRESH,
							expires: FAR_FUTURE,
							accountId: "acct-sweep",
							projectId: "project-sweep",
						});
					}

					const reports = await r.storage.fetchUsageReports();
					const checks = await r.storage.checkCredentials();
					if (r.fetchCalls() > 0) exercised.add(backend.id);

					const where = `${backend.id}/${credentialType}/${mode}`;
					expectNoSecret(`${where} reports`, JSON.stringify(reports));
					expectNoSecret(`${where} checks`, JSON.stringify(checks));
					expectNoSecret(`${where} usage log`, r.logged.join("\n"));
					expectNoSecret(`${where} global log`, captured.join("\n"));
					expectNoSecret(`${where} persisted`, persistedUsageRows(r.db));
					r.store.close();
					vi.restoreAllMocks();
				}
			}
		}
		const unexercised = backends.map(b => b.id as string).filter(id => !exercised.has(id));
		expect(unexercised.sort()).toEqual([...UNEXERCISABLE_BACKENDS].sort());
	}, 120_000);
});
