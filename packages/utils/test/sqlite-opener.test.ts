import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	annotateSqliteError,
	checkpointWal,
	isSqliteBusyError,
	isSqliteCorruptionError,
	openSqliteDatabase,
} from "../src/sqlite";
import { TempDir } from "../src/temp";

describe("openSqliteDatabase", () => {
	it("failed asynchronous initialization releases and rolls back its write transaction", async () => {
		await using dir = await TempDir.create("@veyyon-sqlite-init-");
		const dbPath = dir.join("store.db");
		await expect(
			openSqliteDatabase(dbPath, async db => {
				db.run("CREATE TABLE entries (value TEXT)");
				db.run("BEGIN IMMEDIATE");
				db.run("INSERT INTO entries VALUES ('uncommitted')");
				await Promise.resolve();
				db.run("INSERT INTO missing_table VALUES (1)");
			}),
		).rejects.toThrow(dbPath);

		const rows = await openSqliteDatabase(dbPath, db => {
			try {
				db.run("INSERT INTO entries VALUES ('reopened')");
				return db.query<{ value: string }, []>("SELECT value FROM entries").all();
			} finally {
				db.close();
			}
		});
		expect(rows).toEqual([{ value: "reopened" }]);
	});

	it("attributes the database path to initialization errors while preserving the cause and code", async () => {
		await using dir = await TempDir.create("@veyyon-sqlite-err-");
		const dbPath = dir.join("err.db");

		let caught: (Error & { code?: string }) | undefined;
		try {
			await openSqliteDatabase(dbPath, db => {
				db.run("SELECT * FROM non_existent_table");
			});
		} catch (err) {
			caught = err as Error & { code?: string };
		}

		expect(caught).toBeDefined();
		expect(caught?.message).toContain(`Database ${JSON.stringify(dbPath)}:`);
		expect(caught?.message).toContain("no such table: non_existent_table");
		expect(caught?.code).toBe("SQLITE_ERROR");
	});

	it("negative control: without path attribution the error message lacks the database path", () => {
		const db = new Database(":memory:");
		let rawError: Error | undefined;
		try {
			db.run("SELECT * FROM non_existent_table");
		} catch (err) {
			rawError = err instanceof Error ? err : new Error(String(err));
		} finally {
			db.close();
		}

		expect(rawError).toBeDefined();
		expect(rawError?.message).not.toContain('Database "/some/test/path":');
		const annotated = annotateSqliteError(rawError, "/some/test/path");
		expect(annotated.message).toContain('Database "/some/test/path":');
	});

	it("checkpointWal runs passive WAL checkpoint without error", async () => {
		await using dir = await TempDir.create("@veyyon-sqlite-wal-");
		const dbPath = dir.join("wal.db");
		await openSqliteDatabase(dbPath, db => {
			try {
				db.run("PRAGMA journal_mode = WAL");
				db.run("CREATE TABLE t (id INT)");
				checkpointWal(db);
			} finally {
				db.close();
			}
		});
	});

	it("classifies SQLite busy and corruption error codes accurately", () => {
		expect(isSqliteBusyError({ code: "SQLITE_BUSY" })).toBeTrue();
		expect(isSqliteBusyError({ code: "SQLITE_BUSY_RECOVERY" })).toBeTrue();
		expect(isSqliteBusyError({ code: "SQLITE_BUSY_TIMEOUT" })).toBeTrue();
		expect(isSqliteBusyError({ code: "SQLITE_CORRUPT" })).toBeFalse();
		expect(isSqliteBusyError(null)).toBeFalse();
		expect(isSqliteBusyError("error")).toBeFalse();

		expect(isSqliteCorruptionError({ code: "SQLITE_CORRUPT" })).toBeTrue();
		expect(isSqliteCorruptionError({ code: "SQLITE_CORRUPT_VTAB" })).toBeTrue();
		expect(isSqliteCorruptionError({ code: "SQLITE_NOTADB" })).toBeTrue();
		expect(isSqliteCorruptionError({ code: "SQLITE_BUSY" })).toBeFalse();
		expect(isSqliteCorruptionError(undefined)).toBeFalse();
	});
});
