import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "../src/auth-storage-sqlite";

describe("SqliteAuthCredentialStore opener", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "veyyon-auth-store-opener-"),
		);
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("opens a new credential store and initializes required tables", async () => {
		const dbPath = path.join(tempDir, "auth.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const creds = store.listAuthCredentials();
			expect(creds).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("attributes the database path to startup initialization failures", async () => {
		const dbPath = path.join(tempDir, "corrupt-init.db");
		// Write a table with an incompatible schema that causes index creation or schema initialization to fail
		const rawDb = new Database(dbPath);
		rawDb.run(
			"CREATE TABLE auth_credentials (id TEXT PRIMARY KEY, not_the_right_columns INT)",
		);
		rawDb.run("CREATE TABLE auth_schema_version (version INT)");
		rawDb.run("INSERT INTO auth_schema_version VALUES (99999)"); // unsupported future schema version
		rawDb.close();

		let caught: Error | undefined;
		try {
			await SqliteAuthCredentialStore.open(dbPath);
		} catch (err) {
			caught = err instanceof Error ? err : new Error(String(err));
		}

		expect(caught).toBeDefined();
		expect(caught?.message).toContain(`Database ${JSON.stringify(dbPath)}:`);
	});

	it("negative control: raw SQLite initialization error lacks the Database path prefix", () => {
		const db = new Database(":memory:");
		let rawError: Error | undefined;
		try {
			db.run("SELECT * FROM non_existent_auth_table");
		} catch (err) {
			rawError = err instanceof Error ? err : new Error(String(err));
		} finally {
			db.close();
		}

		expect(rawError).toBeDefined();
		expect(rawError?.message).not.toContain('Database "/nonexistent/test.db":');
	});
});
