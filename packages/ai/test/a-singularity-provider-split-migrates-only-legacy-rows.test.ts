// WHY: A schema migration can orphan split-provider credentials or rewrite unrelated rows. This fixture exercises the real SQLite open path and a second open; it does not test operator database files.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "../../utils/src/temp";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";
import { SqliteAuthCredentialStore } from "../src/auth/sqlite-credential-store";

type SqlRow = Record<string, string | number | null>;

function readRows(db: Database, sql: string): SqlRow[] {
	return db.query(sql).all() as SqlRow[];
}

function seedVersionSixDatabase(file: string): void {
	const db = new Database(file);
	try {
		db.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version (id, version) VALUES (1, 6);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE auth_credential_blocks (
				credential_id INTEGER NOT NULL,
				provider_key TEXT NOT NULL,
				block_scope TEXT NOT NULL DEFAULT '',
				blocked_until_ms INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (credential_id, provider_key, block_scope)
			);
			CREATE TABLE auth_credential_refresh_leases (
				credential_id INTEGER PRIMARY KEY,
				owner TEXT NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE auth_account_names (
				identity TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE auth_provider_selection (
				provider TEXT PRIMARY KEY,
				identity TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE usage_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				provider TEXT NOT NULL,
				account_key TEXT NOT NULL,
				email TEXT,
				account_id TEXT,
				limit_id TEXT NOT NULL,
				label TEXT NOT NULL,
				window_label TEXT,
				used_fraction REAL,
				status TEXT,
				resets_at INTEGER
			);
		`);
		const insertCredential = db.prepare(
			"INSERT INTO auth_credentials (id, provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, ?, 'api_key', ?, ?, ?, ?)",
		);
		insertCredential.run(1, "singularityapi", JSON.stringify({ key: "sk-sapi-fixture" }), "gateway", 101, 201);
		insertCredential.run(2, "singularityapi", JSON.stringify({ key: "sk-fixture" }), "lanes", 102, 202);
		insertCredential.run(3, "singularityapi", "not-json", "malformed", 103, 203);
		insertCredential.run(4, "singularityapi-dev", JSON.stringify({ key: "sk-sapi-existing" }), "existing-dev", 104, 204);
		insertCredential.run(5, "singularityapi-tech", JSON.stringify({ key: "sk-existing" }), "existing-tech", 105, 205);
		insertCredential.run(6, "anthropic", JSON.stringify({ key: "sk-other" }), "other-provider", 106, 206);
		insertCredential.finalize();

		const insertBlock = db.prepare(
			"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
		);
		insertBlock.run(1, "singularityapi:api_key", "requests", 301, 201);
		insertBlock.run(2, "singularityapi:api_key", "requests", 302, 202);
		insertBlock.run(3, "singularityapi:api_key", "requests", 303, 203);
		insertBlock.run(4, "singularityapi-dev:api_key", "requests", 304, 204);
		insertBlock.run(5, "singularityapi-tech:api_key", "requests", 305, 205);
		insertBlock.run(6, "anthropic:api_key", "requests", 306, 206);
		insertBlock.run(6, "openai-codex:oauth", "shared", 406, 306);
		insertBlock.finalize();

		db.run(`
			INSERT INTO auth_credential_refresh_leases (credential_id, owner, expires_at_ms, updated_at)
			VALUES (1, 'fixture-owner', 500, 200);
			INSERT INTO auth_account_names (identity, name, updated_at)
			VALUES ('anthropic:account', 'Work', 200);
			INSERT INTO auth_provider_selection (provider, identity, updated_at)
			VALUES ('anthropic', 'anthropic:account', 200);
			INSERT INTO usage_history (recorded_at, provider, account_key, limit_id, label, used_fraction)
			VALUES (200, 'anthropic', 'other-provider', 'requests', 'Requests', 0.25);
		`);
	} finally {
		db.close();
	}
}

function snapshot(file: string) {
	const db = new Database(file, { readonly: true });
	try {
		return {
			schemaObjects: readRows(
				db,
				"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name",
			),
			schemaVersion: readRows(db, "SELECT id, version FROM auth_schema_version ORDER BY id"),
			credentials: readRows(db, "SELECT * FROM auth_credentials ORDER BY id"),
			blocks: readRows(db, "SELECT * FROM auth_credential_blocks ORDER BY credential_id, provider_key, block_scope"),
			refreshLeases: readRows(db, "SELECT * FROM auth_credential_refresh_leases ORDER BY credential_id"),
			accountNames: readRows(db, "SELECT * FROM auth_account_names ORDER BY identity"),
			providerSelection: readRows(db, "SELECT * FROM auth_provider_selection ORDER BY provider"),
			usageHistory: readRows(db, "SELECT * FROM usage_history ORDER BY id"),
			changeRevision: readRows(db, "SELECT * FROM auth_change_revision ORDER BY id"),
			usageCostTable: readRows(
				db,
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_cost_history'",
			),
		};
	} finally {
		db.close();
	}
}

describe("a legacy SingularityAPI split migrates only old provider rows", () => {
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-singularity-schema-"));
	});

	afterEach(async () => {
		if (tempRoot) {
			await removeWithRetries(guardDestructivePath(tempRoot, "singularity-schema-migration"));
			tempRoot = "";
		}
	});

	test("routes legacy keys, preserves fork history, and makes the second open a no-op", async () => {
		const file = path.join(tempRoot, "agent.db");
		seedVersionSixDatabase(file);

		const firstStore = await SqliteAuthCredentialStore.open(file);
		firstStore.close();

		const firstSnapshot = snapshot(file);
		expect(firstSnapshot.schemaVersion).toEqual([{ id: 1, version: 7 }]);
		expect(firstSnapshot.credentials).toEqual([
			{
				id: 1,
				provider: "singularityapi-dev",
				credential_type: "api_key",
				data: JSON.stringify({ key: "sk-sapi-fixture" }),
				disabled_cause: null,
				identity_key: "gateway",
				created_at: 101,
				updated_at: 201,
			},
			{
				id: 2,
				provider: "singularityapi-tech",
				credential_type: "api_key",
				data: JSON.stringify({ key: "sk-fixture" }),
				disabled_cause: null,
				identity_key: "lanes",
				created_at: 102,
				updated_at: 202,
			},
			{
				id: 3,
				provider: "singularityapi-tech",
				credential_type: "api_key",
				data: "not-json",
				disabled_cause: null,
				identity_key: "malformed",
				created_at: 103,
				updated_at: 203,
			},
			{
				id: 4,
				provider: "singularityapi-dev",
				credential_type: "api_key",
				data: JSON.stringify({ key: "sk-sapi-existing" }),
				disabled_cause: null,
				identity_key: "existing-dev",
				created_at: 104,
				updated_at: 204,
			},
			{
				id: 5,
				provider: "singularityapi-tech",
				credential_type: "api_key",
				data: JSON.stringify({ key: "sk-existing" }),
				disabled_cause: null,
				identity_key: "existing-tech",
				created_at: 105,
				updated_at: 205,
			},
			{
				id: 6,
				provider: "anthropic",
				credential_type: "api_key",
				data: JSON.stringify({ key: "sk-other" }),
				disabled_cause: null,
				identity_key: "other-provider",
				created_at: 106,
				updated_at: 206,
			},
		]);
		expect(firstSnapshot.blocks).toEqual([
			{ credential_id: 1, provider_key: "singularityapi-dev:api_key", block_scope: "requests", blocked_until_ms: 301, updated_at: 201 },
			{ credential_id: 2, provider_key: "singularityapi-tech:api_key", block_scope: "requests", blocked_until_ms: 302, updated_at: 202 },
			{ credential_id: 3, provider_key: "singularityapi-tech:api_key", block_scope: "requests", blocked_until_ms: 303, updated_at: 203 },
			{ credential_id: 4, provider_key: "singularityapi-dev:api_key", block_scope: "requests", blocked_until_ms: 304, updated_at: 204 },
			{ credential_id: 5, provider_key: "singularityapi-tech:api_key", block_scope: "requests", blocked_until_ms: 305, updated_at: 205 },
			{ credential_id: 6, provider_key: "anthropic:api_key", block_scope: "requests", blocked_until_ms: 306, updated_at: 206 },
			{ credential_id: 6, provider_key: "openai-codex:oauth", block_scope: "chat", blocked_until_ms: 406, updated_at: 306 },
			{ credential_id: 6, provider_key: "openai-codex:oauth", block_scope: "shared", blocked_until_ms: 406, updated_at: 306 },
			{ credential_id: 6, provider_key: "openai-codex:oauth", block_scope: "spark", blocked_until_ms: 406, updated_at: 306 },
		]);
		expect(firstSnapshot.refreshLeases).toEqual([
			{ credential_id: 1, owner: "fixture-owner", expires_at_ms: 500, updated_at: 200 },
		]);
		expect(firstSnapshot.accountNames).toEqual([{ identity: "anthropic:account", name: "Work", updated_at: 200 }]);
		expect(firstSnapshot.providerSelection).toEqual([
			{ provider: "anthropic", identity: "anthropic:account", updated_at: 200 },
		]);
		expect(firstSnapshot.usageHistory).toEqual([
			{
				id: 1,
				recorded_at: 200,
				provider: "anthropic",
				account_key: "other-provider",
				email: null,
				account_id: null,
				limit_id: "requests",
				label: "Requests",
				window_label: null,
				used_fraction: 0.25,
				status: null,
				resets_at: null,
			},
		]);
		expect(firstSnapshot.usageCostTable).toEqual([]);

		const secondStore = await SqliteAuthCredentialStore.open(file);
		secondStore.close();
		expect(snapshot(file)).toEqual(firstSnapshot);
	});
	test("creates provider selection storage on a fresh database", async () => {
		const file = path.join(tempRoot, "fresh.db");
		const store = await SqliteAuthCredentialStore.open(file);
		try {
			expect(store.getProviderSelection("openai")).toBeUndefined();
			store.setProviderSelection("openai", "openai:personal");
			expect(store.getProviderSelection("openai")).toBe("openai:personal");
			store.clearProviderSelection("openai");
			expect(store.getProviderSelection("openai")).toBeUndefined();
		} finally {
			store.close();
		}

		const db = new Database(file, { readonly: true });
		try {
			expect(
				readRows(
					db,
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_provider_selection'",
				),
			).toEqual([{ name: "auth_provider_selection" }]);
			expect(readRows(db, "SELECT provider, identity, updated_at FROM auth_provider_selection")).toEqual([]);
		} finally {
			db.close();
		}
	});
});
