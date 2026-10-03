// WHY: SQLite startup must release failed connections, retry real contention within a bound,
// install timeout policy before initialization, and publish WAL frames to the main file.
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { getDbBusyTimeoutMs } from "../src/env";
import { checkpointWal, isSqliteBusyError, isSqliteCorruptionError, openSqliteDatabase } from "../src/sqlite";
import { TempDir } from "../src/temp";

describe("openSqliteDatabase", () => {
	it("failed asynchronous initialization releases and rolls back its write transaction", async () => {
		await using dir = await TempDir.create("@veyyon-sqlite-init-");
		const dbPath = dir.join("store.db");
		let retainedHandle: Database | undefined;
		try {
			await expect(
				openSqliteDatabase(dbPath, async db => {
					retainedHandle = db;
					db.run("CREATE TABLE entries (value TEXT)");
					db.run("BEGIN IMMEDIATE");
					db.run("INSERT INTO entries VALUES ('uncommitted')");
					await Promise.resolve();
					db.run("INSERT INTO missing_table VALUES (1)");
				}),
			).rejects.toThrow(JSON.stringify(dbPath));

			const rows = await openSqliteDatabase(dbPath, db => {
				try {
					db.run("INSERT INTO entries VALUES ('reopened')");
					return db.query<{ value: string }, []>("SELECT value FROM entries").all();
				} finally {
					db.close();
				}
			});
			expect(rows).toEqual([{ value: "reopened" }]);
		} finally {
			try {
				retainedHandle?.close();
			} catch {}
		}
	}, 10000);

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

	it("checkpointWal publishes committed WAL content into the main database file", async () => {
		await using dir = await TempDir.create("@veyyon-sqlite-wal-");
		const dbPath = dir.join("wal.db");
		const sentinel = "veyyon-checkpoint-committed-marker";
		await openSqliteDatabase(dbPath, db => {
			try {
				db.run("PRAGMA journal_mode = WAL");
				db.run("PRAGMA wal_autocheckpoint = 0");
				db.run("CREATE TABLE events (value TEXT)");
				db.run("INSERT INTO events VALUES (?)", [sentinel]);
				expect(fs.readFileSync(dbPath).includes(Buffer.from(sentinel))).toBe(false);
				checkpointWal(db);
				expect(fs.readFileSync(dbPath).includes(Buffer.from(sentinel))).toBe(true);
			} finally {
				db.close();
			}
		});
	});

	it.each([true, false])(
		"real BUSY contention terminates within its attempt bound, transient=%s",
		async transient => {
			await using dir = await TempDir.create("@veyyon-sqlite-lock-");
			const dbPath = dir.join("busy.db");
			const blocker = new Database(dbPath);
			blocker.run("CREATE TABLE events (value TEXT)");
			blocker.run("BEGIN IMMEDIATE");
			let attempts = 0;
			let rows: unknown;
			let failure: unknown;
			try {
				try {
					rows = await openSqliteDatabase(dbPath, db => {
						attempts++;
						expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(
							getDbBusyTimeoutMs(),
						);
						db.run("PRAGMA busy_timeout = 1");
						try {
							db.run("INSERT INTO events VALUES ('opened')");
						} catch (error) {
							if (transient && attempts === 1) blocker.run("ROLLBACK");
							throw error;
						}
						const values = db.query("SELECT value FROM events").all();
						db.close();
						return values;
					});
				} catch (error) {
					failure = error;
				}
				if (transient) {
					expect(failure).toBeUndefined();
					expect(attempts).toBe(2);
					expect(rows).toEqual([{ value: "opened" }]);
				} else {
					expect(attempts).toBe(4);
					expect(failure).toMatchObject({ code: "SQLITE_BUSY" });
					expect((failure as Error).message).toContain(JSON.stringify(dbPath));
				}
			} finally {
				blocker.close();
			}
		},
		10000,
	);

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
