/**
 * Regression tests for https://github.com/Wladefant/veyyon/issues/452: after switching the active
 * account, the quota display must follow the selected account and its cached usage must be
 * evictable even when the provider is served through a base URL (the Antigravity sidecar).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "../../utils/src/temp";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import type { UsageProvider, UsageReport } from "../src/usage";

const PROVIDER = "google-antigravity";
const SIDECAR = "http://127.0.0.1:45123";

function oauth(email: string) {
	return {
		type: "oauth" as const,
		access: `access-${email}`,
		refresh: `refresh-${email}`,
		expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
		email,
	};
}

describe("AuthStorage active account and usage cache invalidation", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let fetchCount = 0;

	const usageProvider: UsageProvider = {
		id: PROVIDER,
		async fetchUsage(params) {
			fetchCount += 1;
			const report: UsageReport = {
				provider: PROVIDER,
				fetchedAt: Date.now(),
				limits: [],
				metadata: { email: params.credential.email },
			};
			return report;
		},
	};

	function createStorage(): AuthStorage {
		return new AuthStorage(store, {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
		});
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-active-account-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		fetchCount = 0;
	});

	afterEach(async () => {
		store.close();
		await removeWithRetries(tempDir);
	});

	test("the globally selected account is the active identity, not the first stored one", async () => {
		const storage = createStorage();
		await storage.set(PROVIDER, [oauth("exhausted@example.com"), oauth("healthy@example.com")]);
		expect(storage.getOAuthAccountIdentity(PROVIDER)?.email).toBe("exhausted@example.com");

		const healthyId = store.listAuthCredentials(PROVIDER).find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.email === "healthy@example.com";
		})?.id;
		if (healthyId === undefined) throw new Error("expected healthy credential id");
		expect(storage.selectProviderCredential(PROVIDER, healthyId)).toBe(true);

		expect(storage.getOAuthAccountIdentity(PROVIDER)?.email).toBe("healthy@example.com");
		expect(storage.getOAuthAccountIdentity(PROVIDER, "some-session")?.email).toBe("healthy@example.com");
	});

	test("invalidateUsageCache evicts the report cached under the provider base URL", async () => {
		const storage = createStorage();
		await storage.set(PROVIDER, [oauth("healthy@example.com")]);
		const baseUrlResolver = (provider: string) => (provider === PROVIDER ? SIDECAR : undefined);

		await storage.fetchUsageReports({ baseUrlResolver });
		await storage.fetchUsageReports({ baseUrlResolver });
		expect(fetchCount).toBe(1);

		await storage.invalidateUsageCache(PROVIDER, undefined, baseUrlResolver);
		await storage.fetchUsageReports({ baseUrlResolver });
		expect(fetchCount).toBe(2);
	});

	test("invalidateUsageCache without a provider also evicts base-URL keyed entries", async () => {
		const storage = createStorage();
		await storage.set(PROVIDER, [oauth("healthy@example.com")]);
		const baseUrlResolver = (provider: string) => (provider === PROVIDER ? SIDECAR : undefined);

		await storage.fetchUsageReports({ baseUrlResolver });
		expect(fetchCount).toBe(1);

		await storage.invalidateUsageCache(undefined, undefined, baseUrlResolver);
		await storage.fetchUsageReports({ baseUrlResolver });
		expect(fetchCount).toBe(2);
	});
});
