import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { scheduler } from "node:timers/promises";
import { exponentialBackoffDelay } from "./backoff";
import { getDbBusyTimeoutMs } from "./env";
import { withFileLockSync } from "./file-lock";
import { isEnoent } from "./fs-error";
import * as logger from "./logger";
/**
 * True when a queryable object named `table` exists in the database, whether it
 * is a regular table, a virtual table (FTS5/vec register in `sqlite_master`
 * with `type = 'table'`), or a view. Index and trigger names are not counted,
 * since they cannot be queried as a table.
 *
 * Query errors propagate on purpose: a failing `sqlite_master` read means a
 * broken or closed handle, and reporting that as "table missing" would silently
 * disable whole features (a scan path skipped, a rebuild never run).
 */
/**
 * SQLite expression for the current time as whole seconds since the Unix epoch, for use inside a SQL string.
 *
 * Not a bound parameter: it evaluates in the database, so an `INSERT ... DEFAULT` and an `UPDATE ... SET`
 * in the same statement agree on one timestamp and no clock is read in JavaScript.
 *
 * SECONDS, not milliseconds, and that is the whole reason this has one home. Three modules across two
 * packages each carried their own copy of this exact string and each writes a column another module reads:
 * `auth_credentials.updated_at`, `model_perf.updated_at`, the history tables. A copy edited to `'%s'` in
 * milliseconds, or to `strftime('%J')`, would put values a thousand times out of range into one table while
 * the readers kept interpreting them as seconds, and nothing would throw. Everything comparing those
 * columns, expiry checks and ranking windows included, would quietly be wrong.
 */
export const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

export function tableExists(db: Database, table: string): boolean {
	return (
		db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1",
			)
			.get(table) !== null
	);
}

/**
 * A comma-separated run of `count` bound-parameter placeholders (`?, ?, …`) for
 * a SQL `IN (…)` clause or multi-row insert, so an id list can be bound safely
 * instead of interpolated. Pair it with `.all(...ids)` / `.run(...ids)`.
 *
 * Returns `""` for a count of 0. `IN ()` is not valid SQL, so the caller must
 * guard an empty list before using the result; this helper does not, because a
 * zero-length batch is a normal early-return case at the call site, not an
 * error. A negative or non-integer count is a programming error and throws.
 */
export function sqlPlaceholders(count: number): string {
	if (!Number.isInteger(count) || count < 0) {
		throw new RangeError(
			`sqlPlaceholders: count must be a non-negative integer, got ${count}`,
		);
	}
	return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Escape the SQL `LIKE` wildcards in `value` so user input matches as literal
 * text instead of as a pattern. Backslash, `%` (any run) and `_` (any single
 * character) are each prefixed with a backslash.
 *
 * The result is only correct when the statement declares the same escape
 * character, so the `LIKE` clause must read `... LIKE ? ESCAPE '\'`. The caller
 * still wraps the escaped value in its own `%…%` for a substring match; those
 * surrounding wildcards are meant to stay active.
 */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

const BUSY_MAX_ATTEMPTS = 4;
const BUSY_BASE_DELAY_MS = 100;
const SQLITE_STORE_SUFFIXES = ["-wal", "-shm", "-journal", ""];

type SqliteFileIdentity = string | null | undefined;

class SqliteAttemptFailure extends Error {
	readonly canRecover: boolean;
	readonly db?: Database;
	constructor(
		readonly original: unknown,
		readonly identity: SqliteFileIdentity,
		options: { canRecover?: boolean; db?: Database } = {},
	) {
		super(original instanceof Error ? original.message : String(original));
		this.canRecover = options.canRecover ?? true;
		this.db = options.db;
	}
}

function sqliteFileIdentity(dbPath: string): SqliteFileIdentity {
	try {
		const s = fs.statSync(dbPath);
		return `${s.dev}:${s.ino}:${s.birthtimeMs}`;
	} catch (e) { return isEnoent(e) ? null : undefined; }
}

function closeFailedDatabase(db: Database | undefined, error: unknown, identity: SqliteFileIdentity): void {
	try { db?.close(); }
	catch (closeError) {
		const orig = error instanceof Error ? error : new Error(String(error));
		orig.message += `; failed to close the SQLite handle: ${closeError instanceof Error ? closeError.message : String(closeError)}`;
		throw new SqliteAttemptFailure(orig, identity, { canRecover: false });
	}
}

export interface SqliteOpenOptions {
	recoverCorruption?: boolean;
	onCorruptionPreserved?: (backupPath: string, error: unknown) => void;
}

function handleOpenError(db: Database | undefined, error: unknown, identity: SqliteFileIdentity, recover?: boolean): never {
	if (recover && isSqliteCorruptionError(error)) throw new SqliteAttemptFailure(error, identity, { db });
	closeFailedDatabase(db, error, identity);
	throw new SqliteAttemptFailure(error, identity);
}

async function openWithBusyRetries<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		let db: Database | undefined;
		const identity = sqliteFileIdentity(dbPath);
		try {
			db = new Database(dbPath);
			db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			return await initialize(db);
		} catch (error) {
			if (!isSqliteBusyError(error) || attempt + 1 >= BUSY_MAX_ATTEMPTS) {
				handleOpenError(db, error, identity, options.recoverCorruption);
			}
			closeFailedDatabase(db, error, identity);
			await scheduler.wait(exponentialBackoffDelay(attempt, { baseMs: BUSY_BASE_DELAY_MS, jitter: 0 }));
		}
	}
}

function openOnce<T>(dbPath: string, initialize: (db: Database) => T, options: SqliteOpenOptions): T {
	let db: Database | undefined;
	const identity = sqliteFileIdentity(dbPath);
	try {
		db = new Database(dbPath);
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		return initialize(db);
	} catch (error) {
		handleOpenError(db, error, identity, options.recoverCorruption);
	}
}

function quarantineCorruptSqliteStore(dbPath: string, db: Database | undefined): string {
	const backupPath = `${dbPath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
	const preserved: string[] = [];
	for (const suffix of SQLITE_STORE_SUFFIXES) {
		try {
			try { fs.chmodSync(`${dbPath}${suffix}`, 0o600); } catch {}
			fs.copyFileSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`, fs.constants.COPYFILE_EXCL);
			preserved.push(suffix);
		} catch (error) {
			if (isEnoent(error) && suffix !== "") continue;
			throw error;
		}
	}
	db?.close();
	const removed: string[] = [];
	try {
		for (const s of preserved) {
			try { fs.unlinkSync(`${dbPath}${s}`); removed.push(s); }
			catch (err) { if (!isEnoent(err)) throw err; }
		}
	} catch (error) {
		for (const s of removed) {
			try { fs.copyFileSync(`${backupPath}${s}`, `${dbPath}${s}`, fs.constants.COPYFILE_EXCL); } catch (rb) {
				logger.error("SQLite quarantine rollback failed; original preserved at backup path", { path: `${dbPath}${s}`, backupPath: `${backupPath}${s}`, error: String(rb) });
			}
		}
		throw error;
	}
	return backupPath;
}

function recoverCorruptDatabase(dbPath: string, error: unknown, options: SqliteOpenOptions): void {
	if (!(error instanceof SqliteAttemptFailure)) throw annotateSqliteError(error, dbPath);
	const failure = error;
	if (!options.recoverCorruption || !failure.canRecover || !isSqliteCorruptionError(failure.original)) {
		throw annotateSqliteError(failure.original, dbPath);
	}
	let backupPath: string | null;
	try {
		try {
			backupPath = withFileLockSync(`${dbPath}.recovery`, () => {
				const currentIdentity = sqliteFileIdentity(dbPath);
				if (failure.identity === undefined || currentIdentity === undefined) {
					throw new Error("could not verify the corrupt database file identity");
				}
				return currentIdentity === failure.identity ? quarantineCorruptSqliteStore(dbPath, failure.db) : null;
			});
		} finally { closeFailedDatabase(failure.db, failure.original, failure.identity); }
	} catch (preservationError) {
		const annotated = annotateSqliteError(failure.original, dbPath);
		annotated.message += `; failed to preserve the corrupt database: ${preservationError instanceof Error ? preservationError.message : String(preservationError)}`;
		throw annotated;
	}
	if (backupPath === null) return;
	logger.warn("SQLite database corrupt; preserved damaged store before recreating it", {
		path: dbPath, backupPath, warning: "Stored credentials from this database may require re-login.",
	});
	options.onCorruptionPreserved?.(backupPath, failure.original);
}

export async function openSqliteDatabase<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions = {},
): Promise<T> {
	try { return await openWithBusyRetries(dbPath, initialize, options); }
	catch (error) { recoverCorruptDatabase(dbPath, error, options); }
	try { return await openWithBusyRetries(dbPath, initialize, {}); }
	catch (error) { throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath); }
}

export function openSqliteDatabaseSync<T>(
	dbPath: string,
	initialize: (db: Database) => T,
	options: SqliteOpenOptions = {},
): T {
	try { return openOnce(dbPath, initialize, options); }
	catch (error) { recoverCorruptDatabase(dbPath, error, options); }
	try { return openOnce(dbPath, initialize, {}); }
	catch (error) { throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath); }
}

/** Adds the failing store's path to an error without losing SQLite result codes or its original stack. */
export function annotateSqliteError(error: unknown, dbPath: string): Error {
	const annotated = error instanceof Error ? error : new Error(String(error));
	annotated.message = `Database ${JSON.stringify(dbPath)}: ${annotated.message}`;
	return annotated;
}

/** Checkpoints committed WAL frames without waiting for concurrent readers. */
export function checkpointWal(db: Database): void {
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
}

/**
 * SQLite's busy result-code family — base `SQLITE_BUSY` plus the extended
 * variants `SQLITE_BUSY_RECOVERY` (concurrent WAL recovery), `SQLITE_BUSY_SNAPSHOT`,
 * and `SQLITE_BUSY_TIMEOUT`. All warrant the same backoff-and-retry treatment.
 */
export function isSqliteBusyError(err: unknown): boolean {
	if (!err || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * SQLite's unrecoverable-corruption result codes — the `SQLITE_CORRUPT` family
 * (base plus extended variants like `SQLITE_CORRUPT_VTAB` / `SQLITE_CORRUPT_INDEX`)
 * and `SQLITE_NOTADB` (the file header is not a database). Unlike
 * {@link isSqliteBusyError}, these never clear by retrying: the store must be
 * repaired or replaced, so callers latch, quarantine, or recreate the file.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
	if (!err || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return (
		typeof code === "string" &&
		(code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB")
	);
}
