import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { atomicWriteFileSync } from "./atomic-write";
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
		db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1").get(table) !== null
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
		throw new RangeError(`sqlPlaceholders: count must be a non-negative integer, got ${count}`);
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

function isTransientSqliteStore(dbPath: string): boolean {
	// Bun's default constructor does not enable SQLITE_OPEN_URI. URI-looking
	// strings are physical filenames (including NTFS streams), not memory stores.
	return dbPath === ":memory:" || dbPath === "";
}

function recoveryFileStem(dbPath: string): string {
	if (process.platform !== "win32") return dbPath;
	const resolved = path.resolve(dbPath);
	const basename = path.basename(resolved);
	const streamAt = basename.indexOf(":");
	const baseName = streamAt < 0 ? basename : basename.slice(0, streamAt);
	const stream = streamAt < 0 ? "" : basename.slice(streamAt).toLowerCase();
	const basePath = path.join(path.dirname(resolved), baseName);
	let canonicalBase: string;
	let baseExists = true;
	try {
		canonicalBase = fs.realpathSync.native(basePath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		baseExists = false;
		let link: string | undefined;
		try {
			link = fs.readlinkSync(basePath);
		} catch (linkError) {
			if (!isEnoent(linkError) && (linkError as NodeJS.ErrnoException).code !== "EINVAL") throw linkError;
		}
		if (link) {
			canonicalBase = recoveryFileStem(path.resolve(path.dirname(basePath), link));
		} else {
			const parent = fs.realpathSync.native(path.dirname(basePath));
			// Ordinary Win32 names ignore trailing dots/spaces; extended names do not.
			const name = resolved.startsWith("\\\\?\\") ? baseName : baseName.replace(/[. ]+$/, "");
			canonicalBase = path.join(parent, name);
		}
	}
	canonicalBase = canonicalBase
		.replace(/^\\\\[?.]\\UNC\\/i, "\\\\")
		.replace(/^\\\\[?.]\\/, "")
		.toLowerCase();
	// Native realpath retains UNC administrative-share spelling. Fold it into
	// a drive spelling only after proving both names identify the same object.
	const share = /^\\\\[^\\]+\\([a-z])\$(\\.*)$/i.exec(canonicalBase);
	if (share) {
		const driveBase = `${share[1]}:${share[2]}`;
		try {
			const unc = fs.statSync(baseExists ? canonicalBase : path.dirname(canonicalBase));
			const drive = fs.statSync(baseExists ? driveBase : path.dirname(driveBase));
			if (unc.dev === drive.dev && unc.ino === drive.ino) canonicalBase = driveBase;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	if (!stream) return canonicalBase;
	// Resolve the base file, not its ADS: aliases share a key even after the
	// stream is removed. NTFS streams cannot themselves name lock directories.
	return path.join(
		path.dirname(canonicalBase),
		`.sqlite-${crypto
			.createHash("sha256")
			.update(canonicalBase + stream)
			.digest("hex")}`,
	);
}

function sqliteFileIdentity(dbPath: string): SqliteFileIdentity {
	if (isTransientSqliteStore(dbPath)) return null;
	try {
		const s = fs.statSync(dbPath);
		return `${s.dev}:${s.ino}:${s.birthtimeMs}`;
	} catch (e) {
		return isEnoent(e) ? null : undefined;
	}
}

function closeFailedDatabase(db: Database | undefined, error: unknown, identity: SqliteFileIdentity): void {
	try {
		db?.close();
	} catch (closeError) {
		const orig = error instanceof Error ? error : new Error(String(error));
		orig.message += `; failed to close the SQLite handle: ${closeError instanceof Error ? closeError.message : String(closeError)}`;
		throw new SqliteAttemptFailure(orig, identity, { canRecover: false });
	}
}

export interface SqliteOpenOptions {
	recoverCorruption?: boolean;
	onCorruptionPreserved?: (backupPath: string, error: unknown) => void;
}

function handleOpenError(
	db: Database | undefined,
	error: unknown,
	identity: SqliteFileIdentity,
	recover?: boolean,
): never {
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
			db = openStoreUnderRecoveryLock(dbPath);
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
		db = openStoreUnderRecoveryLock(dbPath);
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		return initialize(db);
	} catch (error) {
		handleOpenError(db, error, identity, options.recoverCorruption);
	}
}

function openStoreUnderRecoveryLock(dbPath: string): Database {
	if (isTransientSqliteStore(dbPath)) return new Database(dbPath);
	const probe = path.join(path.dirname(dbPath), `.sqlite-write-probe-${crypto.randomUUID()}`);
	try {
		const fd = fs.openSync(probe, "wx", 0o600);
		fs.closeSync(fd);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
			// A read-only parent cannot publish a quarantine. Preserve SQLite's
			// ability to read it, but still refuse a previously interrupted one.
			assertNoPendingQuarantine(dbPath);
			return new Database(dbPath);
		}
		throw error;
	}
	fs.unlinkSync(probe);
	return withFileLockSync(`${recoveryFileStem(dbPath)}.recovery`, () => {
		assertNoPendingQuarantine(dbPath);
		return new Database(dbPath);
	});
}

function assertNoPendingQuarantine(dbPath: string): void {
	for (const marker of [`${dbPath}.quarantine-pending`, `${recoveryFileStem(dbPath)}.quarantine-pending`]) {
		if (fs.existsSync(marker)) {
			throw new Error(`Database ${JSON.stringify(dbPath)}: interrupted quarantine requires repair; see ${marker}`);
		}
	}
}

function quarantineCorruptSqliteStore(dbPath: string, db: Database | undefined): string {
	const stem = recoveryFileStem(dbPath);
	const backupDirectory = `${stem}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
	const temporaryDirectory = `${backupDirectory}.tmp`;
	const backupName = path.basename(stem);
	const backupPath = path.join(backupDirectory, backupName);
	fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
	const preserved: string[] = [];
	for (const suffix of SQLITE_STORE_SUFFIXES) {
		let data: Buffer;
		try {
			fs.chmodSync(`${dbPath}${suffix}`, 0o600);
			data = fs.readFileSync(`${dbPath}${suffix}`);
		} catch (error) {
			if (isEnoent(error) && suffix !== "") continue;
			throw error;
		}
		const target = path.join(temporaryDirectory, `${backupName}${suffix}`);
		atomicWriteFileSync(target, data);
		fs.chmodSync(target, 0o600);
		preserved.push(suffix);
	}
	// One rename publishes the complete, flushed store and its sidecars.
	fs.renameSync(temporaryDirectory, backupDirectory);
	// NTFS cannot atomically rename streams; use the same safe stem as the lock.
	// The opener also honors legacy/operator markers at the exact database path.
	const marker = path.resolve(`${stem}.quarantine-pending`);
	atomicWriteFileSync(marker, JSON.stringify({ backupPath, suffixes: preserved }));
	db?.close();
	// If interrupted, every opener refuses the partial store. The complete
	// backup and durable marker remain available for explicit repair.
	for (const suffix of preserved) {
		try {
			fs.unlinkSync(`${dbPath}${suffix}`);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	// Flush the parent directory after removing every member before clearing
	// the guard. A power loss may leave the guard, never an unguarded partial set.
	atomicWriteFileSync(marker, JSON.stringify({ backupPath, complete: true }));
	fs.unlinkSync(marker);
	return backupPath;
}

function mainStoreIsCorrupt(dbPath: string): boolean {
	// A fresh header read also handles NOTADB stores whose damaged WAL prevents
	// SQLite from acquiring a second connection. Empty files are valid new stores.
	const fd = fs.openSync(dbPath, "r");
	try {
		const header = Buffer.alloc(16);
		const length = fs.readSync(fd, header, 0, header.length, 0);
		if (length > 0 && (length < 16 || header.toString("ascii") !== "SQLite format 3\0")) return true;
	} finally {
		fs.closeSync(fd);
	}
	let probe: Database | undefined;
	try {
		probe = new Database(dbPath);
		probe.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		const rows = probe.query("PRAGMA main.integrity_check").all() as Record<string, unknown>[];
		return rows.some(row => Object.values(row).some(value => value !== "ok"));
	} catch (error) {
		if (isSqliteCorruptionError(error)) return true;
		throw error;
	} finally {
		probe?.close();
	}
}

function attachedCorruptionPath(db: Database | undefined): string | undefined {
	if (!db) return;
	let stores: { name: string; file: string }[];
	try {
		stores = db.query("PRAGMA database_list").all() as { name: string; file: string }[];
	} catch (error) {
		// Initializers may close their handle before reporting a stale failure.
		if (error instanceof Error && error.message === "Cannot use a closed database") return;
		throw error;
	}
	for (const store of stores) {
		if (store.name === "main" || store.name === "temp" || !store.file) continue;
		try {
			const schema = `"${store.name.replaceAll('"', '""')}"`;
			const rows = db.query(`PRAGMA ${schema}.integrity_check`).all() as Record<string, unknown>[];
			if (rows.some(row => Object.values(row).some(value => value !== "ok"))) return store.file;
		} catch (error) {
			if (isSqliteCorruptionError(error)) return store.file;
			throw error;
		}
	}
}

function recoverCorruptDatabase(dbPath: string, error: unknown, options: SqliteOpenOptions): void {
	if (!(error instanceof SqliteAttemptFailure)) throw annotateSqliteError(error, dbPath);
	const failure = error;
	if (isTransientSqliteStore(dbPath)) {
		closeFailedDatabase(failure.db, failure.original, failure.identity);
		throw annotateSqliteError(failure.original, dbPath);
	}
	if (!options.recoverCorruption || !failure.canRecover || !isSqliteCorruptionError(failure.original)) {
		throw annotateSqliteError(failure.original, dbPath);
	}
	let backupPath: string | null;
	try {
		try {
			backupPath = withFileLockSync(`${recoveryFileStem(dbPath)}.recovery`, () => {
				const currentIdentity = sqliteFileIdentity(dbPath);
				if (failure.identity === undefined || currentIdentity === undefined) {
					throw new Error("could not verify the corrupt database file identity");
				}
				if (currentIdentity !== failure.identity || currentIdentity === null) return null;
				if (!mainStoreIsCorrupt(dbPath)) {
					const attachedPath = attachedCorruptionPath(failure.db);
					if (attachedPath) throw annotateSqliteError(failure.original, attachedPath);
					return null;
				}
				return quarantineCorruptSqliteStore(dbPath, failure.db);
			});
		} finally {
			closeFailedDatabase(failure.db, failure.original, failure.identity);
		}
	} catch (preservationError) {
		const annotated = annotateSqliteError(failure.original, dbPath);
		annotated.message += `; failed to preserve the corrupt database: ${preservationError instanceof Error ? preservationError.message : String(preservationError)}`;
		throw annotated;
	}
	if (backupPath === null) return;
	logger.warn("SQLite database corrupt; preserved damaged store before recreating it", {
		path: dbPath,
		backupPath,
		warning: "Stored credentials from this database may require re-login.",
	});
	options.onCorruptionPreserved?.(backupPath, failure.original);
}

export async function openSqliteDatabase<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions = {},
): Promise<T> {
	try {
		return await openWithBusyRetries(dbPath, initialize, options);
	} catch (error) {
		recoverCorruptDatabase(dbPath, error, options);
	}
	try {
		return await openWithBusyRetries(dbPath, initialize, {});
	} catch (error) {
		throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath);
	}
}

export function openSqliteDatabaseSync<T>(
	dbPath: string,
	initialize: (db: Database) => T,
	options: SqliteOpenOptions = {},
): T {
	try {
		return openOnce(dbPath, initialize, options);
	} catch (error) {
		recoverCorruptDatabase(dbPath, error, options);
	}
	try {
		return openOnce(dbPath, initialize, {});
	} catch (error) {
		throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath);
	}
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
	return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}
