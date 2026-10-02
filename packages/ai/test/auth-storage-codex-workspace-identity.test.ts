/**
 * OpenAI Codex workspace-scoped credential identity.
 * Identity composes `email|org:<ws>`:
 *   - same email + same workspace  => replace in place (re-login);
 *   - same email + diff workspace  => coexist (personal + enterprise seat);
 *   - diff email + same workspace  => coexist (two Team members, #197);
 *   - workspace-less legacy rows keep bare email key and are claimed in place.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@veyyon/ai/auth-storage";
import type { UsageReport } from "@veyyon/ai/usage";
import * as codexUsage from "@veyyon/ai/usage/openai-codex";

const EMAIL = "shared@example.com";
const PERSONAL_WS = "ws-personal-1111";
const TEAM_WS = "ws-team-2222";

function codexCredential(args: {
	suffix: string;
	accountId: string;
	orgId?: string;
	orgName?: string;
	email?: string;
}): AuthCredential {
	return {
		type: "oauth",
		access: `access-${args.suffix}`,
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: args.accountId,
		email: args.email ?? EMAIL,
		orgId: args.orgId,
		orgName: args.orgName,
	};
}

function readIdentityRows(dbPath: string): Array<{ identity_key: string | null; disabled_cause: string | null }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT identity_key, disabled_cause FROM auth_credentials WHERE provider = 'openai-codex' ORDER BY id ASC",
			)
			.all() as Array<{ identity_key: string | null; disabled_cause: string | null }>;
	} finally {
		db.close();
	}
}

describe("openai-codex workspace-scoped credential identity", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	const upsert = (args: Parameters<typeof codexCredential>[0]) =>
		store!.upsertAuthCredentialForProvider("openai-codex", codexCredential(args));

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-codex-ws-identity-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	it("stores a personal plan and an enterprise seat of one email side by side and updates same-workspace logins in place", () => {
		upsert({ suffix: "personal", accountId: PERSONAL_WS, orgId: PERSONAL_WS, orgName: "plus" });
		upsert({ suffix: "team", accountId: TEAM_WS, orgId: TEAM_WS, orgName: "enterprise" });
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${PERSONAL_WS}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}|org:${TEAM_WS}`, disabled_cause: null },
		]);

		const rows = upsert({ suffix: "team-renewed", accountId: TEAM_WS, orgId: TEAM_WS, orgName: "enterprise" });
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${PERSONAL_WS}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}|org:${TEAM_WS}`, disabled_cause: null },
		]);
		const teamRow = rows.find(row => row.credential.type === "oauth" && row.credential.orgId === TEAM_WS);
		expect(teamRow?.credential.type === "oauth" && teamRow.credential.access).toBe("access-team-renewed");
	});

	it("keeps two members of one workspace separate even though they share the workspace id", () => {
		upsert({ suffix: "alice", accountId: TEAM_WS, orgId: TEAM_WS, email: "alice@example.com" });
		upsert({ suffix: "bob", accountId: TEAM_WS, orgId: TEAM_WS, email: "bob@example.com" });
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:alice@example.com|org:${TEAM_WS}`, disabled_cause: null },
			{ identity_key: `email:bob@example.com|org:${TEAM_WS}`, disabled_cause: null },
		]);
	});

	it("upgrades a legacy email-keyed row on the first workspace-scoped login with the same email", () => {
		upsert({ suffix: "legacy", accountId: PERSONAL_WS });
		expect(readIdentityRows(dbPath)).toEqual([{ identity_key: `email:${EMAIL}`, disabled_cause: null }]);
		upsert({ suffix: "team", accountId: TEAM_WS, orgId: TEAM_WS, orgName: "team" });
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${TEAM_WS}`, disabled_cause: null },
		]);
	});

	it("never clobbers workspace-scoped rows with a workspace-less credential", () => {
		upsert({ suffix: "personal", accountId: PERSONAL_WS, orgId: PERSONAL_WS, orgName: "plus" });
		upsert({ suffix: "team", accountId: TEAM_WS, orgId: TEAM_WS, orgName: "enterprise" });
		upsert({ suffix: "orgless", accountId: PERSONAL_WS });
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${PERSONAL_WS}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}|org:${TEAM_WS}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}`, disabled_cause: null },
		]);
	});
});

function makeStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials: () => rows,
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider: () => rows,
		upsertAuthCredentialForProvider: () => rows,
		deleteAuthCredentialsForProvider() {},
		getCache: key => {
			const entry = cache.get(key);
			return entry && entry.expiresAtSec * 1000 > Date.now() ? entry.value : null;
		},
		setCache: (key, value, expiresAtSec) => cache.set(key, { value, expiresAtSec }),
		cleanExpiredCache() {},
	};
}

function codexRow(
	id: number,
	args?: { orgId?: string; orgName?: string; accountId?: string; email?: string },
): StoredAuthCredential {
	return {
		id,
		provider: "openai-codex",
		credential: {
			type: "oauth",
			access: `oat-${id}`,
			refresh: `refresh-${id}`,
			expires: Date.now() + 3_600_000,
			accountId: args?.accountId ?? args?.orgId ?? "ws-legacy",
			email: args?.email ?? EMAIL,
			orgId: args?.orgId,
			orgName: args?.orgName,
		},
		disabledCause: null,
	};
}

function emailOnlyReport(email: string): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 hours",
				scope: { provider: "openai-codex", windowId: "5h" },
				window: { id: "5h", label: "5 hours" },
				amount: { used: 42, limit: 100, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email },
	};
}

describe("openai-codex usage report dedupe partitions by workspace", () => {
	let storage: AuthStorage | null = null;
	afterEach(() => {
		storage?.close();
		storage = null;
		vi.restoreAllMocks();
	});

	it("keeps reports from two workspaces on one email separate and attributes each to its workspace", async () => {
		storage = new AuthStorage(
			makeStore([
				codexRow(1, { orgId: PERSONAL_WS, orgName: "plus" }),
				codexRow(2, { orgId: TEAM_WS, orgName: "enterprise" }),
			]),
			{ usageProviderResolver: p => (p === "openai-codex" ? codexUsage.openaiCodexUsageProvider : undefined) },
		);
		await storage.reload();
		vi.spyOn(codexUsage.openaiCodexUsageProvider, "fetchUsage").mockImplementation(async () =>
			emailOnlyReport(EMAIL),
		);

		const reports = ((await storage.fetchUsageReports()) ?? []).filter(r => r.provider === "openai-codex");
		expect(reports).toHaveLength(2);
		expect(reports.map(r => r.metadata?.orgId).sort()).toEqual([PERSONAL_WS, TEAM_WS].sort());
		expect(reports.map(r => r.metadata?.orgName).sort()).toEqual(["enterprise", "plus"].sort());
	});

	it("still merges workspace-less reports with the same email into one row", async () => {
		storage = new AuthStorage(makeStore([codexRow(1), codexRow(2)]), {
			usageProviderResolver: p => (p === "openai-codex" ? codexUsage.openaiCodexUsageProvider : undefined),
		});
		await storage.reload();
		vi.spyOn(codexUsage.openaiCodexUsageProvider, "fetchUsage").mockImplementation(async () =>
			emailOnlyReport(EMAIL),
		);

		const reports = ((await storage.fetchUsageReports()) ?? []).filter(r => r.provider === "openai-codex");
		expect(reports).toHaveLength(1);
	});
});
