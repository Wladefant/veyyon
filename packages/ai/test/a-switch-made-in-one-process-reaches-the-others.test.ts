/**
 * WHY THIS EXISTS.
 *
 * On 2026-10-03 the operator re-selected the healthy Antigravity account while the other account
 * was held, and long-running veyyon processes (lanes) kept spending the held one: each had read
 * the global account choice once at its first resolve and memoised it for the life of the
 * process. The choice lives in the shared database, so a switch made by one process must reach
 * the others, not only the process that made it.
 *
 * WHAT IT DOES NOT CATCH. It pins the staleness bound loosely (a bit over one TTL); it says
 * nothing about which account the provider accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "../../utils/src/temp";
import { AuthStorage } from "../src/auth-storage";
import { SqliteAuthCredentialStore } from "../src/auth-storage-sqlite";

const PROVIDER = "anthropic";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("an account switch made in another process", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-switch-reaches-peers-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("is spent by a process that already resolved the earlier choice", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const storeA = await SqliteAuthCredentialStore.open(dbPath);
		storeA.saveOAuth(PROVIDER, oauthCredential("first"));
		storeA.saveOAuth(PROVIDER, oauthCredential("second"));
		const switcher = new AuthStorage(storeA, { loadBalancing: true });
		await switcher.reload();
		const [first, second] = storeA.listAuthCredentials(PROVIDER).map(row => row.id);

		const lane = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath), { loadBalancing: true });
		await lane.reload();
		try {
			expect(switcher.selectProviderCredential(PROVIDER, first!)).toBe(true);
			expect(await lane.getApiKey(PROVIDER, "lane-session")).toBe("access-first");

			expect(switcher.selectProviderCredential(PROVIDER, second!)).toBe(true);
			const realNow = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(realNow + 700);
			expect(await lane.getApiKey(PROVIDER, "lane-session")).toBe("access-second");
		} finally {
			vi.restoreAllMocks();
			lane.close();
			switcher.close();
		}
	});
});
