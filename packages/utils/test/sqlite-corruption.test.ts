import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSqliteCorruptionError, openSqliteDatabase, openSqliteDatabaseSync } from "../src/sqlite";
import { TempDir } from "../src/temp";

async function corruptSchema(dbPath: string): Promise<Buffer<ArrayBuffer>> {
	const db = new Database(dbPath);
	db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('ok'); PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();
	const damaged = await fs.readFile(dbPath);
	damaged.fill(0xff, 100);
	await fs.writeFile(dbPath, damaged);
	return damaged;
}

const corruptBackups = async (dir: string) => (await fs.readdir(dir)).filter(f => f.startsWith("store.db.corrupt-"));

test("corruption recovery is opt-in and default preserves active evidence", async () => {
	await using dir = await TempDir.create("@omp-corrupt-optin-");
	const dbPath = dir.join("store.db");
	const damaged = Buffer.from("corrupt header".repeat(32));
	await fs.writeFile(dbPath, damaged);

	const err = await openSqliteDatabase(dbPath, db => db.query("SELECT 1").all()).catch(e => e);
	expect(isSqliteCorruptionError(err)).toBe(true);
	expect(err.message.replaceAll("\\\\", "\\")).toContain(dbPath);
	expect(await fs.readFile(dbPath)).toEqual(damaged);
	expect(await corruptBackups(dir.path())).toHaveLength(0);
});

test("synchronous recovery preserves damaged pages and creates usable database", async () => {
	await using dir = await TempDir.create("@omp-corrupt-sync-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchema(dbPath);

	let preservedBackupPath: string | undefined;
	openSqliteDatabaseSync(
		dbPath,
		db => {
			db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('recovered')");
			db.close();
		},
		{
			recoverCorruption: true,
			onCorruptionPreserved: backupPath => {
				preservedBackupPath = backupPath;
			},
		},
	);

	const backups = (await corruptBackups(dir.path())).filter(f => !f.endsWith(".tmp"));
	expect(backups).toHaveLength(1);
	const backupDir = path.join(dir.path(), backups[0]!);
	const dirStat = await fs.stat(backupDir);
	expect(dirStat.isDirectory()).toBe(true);
	expect(await fs.readFile(path.join(backupDir, "store.db"))).toEqual(damaged);
	if (preservedBackupPath) {
		expect(preservedBackupPath).toBe(path.join(backupDir, "store.db"));
	}

	const rows = openSqliteDatabaseSync(dbPath, db => {
		try {
			return db.query<{ v: string }, []>("SELECT v FROM t").all();
		} finally {
			db.close();
		}
	});
	expect(rows).toEqual([{ v: "recovered" }]);
});

test("recovery preserves all sidecars under one private backup prefix", async () => {
	await using dir = await TempDir.create("@omp-corrupt-sidecars-");
	const dbPath = dir.join("store.db");
	const sidecars: Record<string, Buffer> = {
		"": Buffer.from("bad db"),
		"-wal": Buffer.from("bad wal"),
		"-shm": Buffer.from("bad shm"),
		"-journal": Buffer.from("bad jrnl"),
	};
	for (const [ext, data] of Object.entries(sidecars)) await fs.writeFile(`${dbPath}${ext}`, data);

	await openSqliteDatabase(
		dbPath,
		async db => {
			try {
				db.run("CREATE TABLE t (v TEXT)");
			} catch (error) {
				sidecars["-shm"] = await fs.readFile(`${dbPath}-shm`);
				await fs.writeFile(`${dbPath}-journal`, sidecars["-journal"]);
				throw error;
			}
			db.close();
		},
		{ recoverCorruption: true },
	);

	const backups = (await corruptBackups(dir.path())).filter(f => !f.endsWith(".tmp"));
	expect(backups).toHaveLength(1);
	const backupDir = path.join(dir.path(), backups[0]!);
	const dirStat = await fs.stat(backupDir);
	expect(dirStat.isDirectory()).toBe(true);
	for (const [ext, data] of Object.entries(sidecars)) {
		expect(await fs.readFile(path.join(backupDir, `store.db${ext}`))).toEqual(data);
	}
});

test("negative control: opt-in recovery ignores non-corruption errors", async () => {
	await using dir = await TempDir.create("@omp-corrupt-negative-");
	const dbPath = dir.join("store.db");
	let err: unknown;
	try {
		openSqliteDatabaseSync(dbPath, db => db.query("SELECT * FROM missing").all(), { recoverCorruption: true });
	} catch (e) {
		err = e;
	}
	expect(isSqliteCorruptionError(err)).toBe(false);
	expect((err as Error).message.replaceAll("\\\\", "\\")).toContain(dbPath);
	expect(await corruptBackups(dir.path())).toHaveLength(0);
});

test("regression: same-inode healthy repair after stale corruption preserves repaired data without quarantine", async () => {
	await using dir = await TempDir.create("@omp-corrupt-stale-repair-");
	const dbPath = dir.join("store.db");

	const initDb = new Database(dbPath);
	initDb.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('initial'); PRAGMA wal_checkpoint(TRUNCATE)");
	initDb.close();

	await using corruptDir = await TempDir.create("@omp-corrupt-source-");
	const corruptDbPath = corruptDir.join("bad.db");
	await corruptSchema(corruptDbPath);
	let capturedCorruption: unknown;
	try {
		const badDb = new Database(corruptDbPath);
		badDb.query("SELECT * FROM t").all();
	} catch (error) {
		capturedCorruption = error;
	}
	expect(isSqliteCorruptionError(capturedCorruption)).toBe(true);

	let attempts = 0;
	const result = await openSqliteDatabase(
		dbPath,
		async db => {
			attempts++;
			if (attempts === 1) {
				db.close();
				const repairDb = new Database(dbPath);
				repairDb.run("DELETE FROM t; INSERT INTO t VALUES ('kept_data'); PRAGMA wal_checkpoint(TRUNCATE)");
				repairDb.close();
				throw capturedCorruption;
			}
			return db.query<{ v: string }, []>("SELECT v FROM t").all();
		},
		{ recoverCorruption: true },
	);

	expect(attempts).toBe(2);
	expect(result).toEqual([{ v: "kept_data" }]);
	expect(await corruptBackups(dir.path())).toHaveLength(0);
});

test("regression: attached corrupt DB preserves valuable main store rows and surfaces secondary path error", async () => {
	await using dir = await TempDir.create("@omp-corrupt-attached-");
	const mainPath = dir.join("store.db");
	const secondaryPath = dir.join("secondary.db");

	const mainDb = new Database(mainPath);
	mainDb.run(
		"CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER); INSERT INTO accounts VALUES (1, 5000); PRAGMA wal_checkpoint(TRUNCATE)",
	);
	mainDb.close();

	await corruptSchema(secondaryPath);

	let err: unknown;
	try {
		await openSqliteDatabase(
			mainPath,
			async db => {
				db.run("ATTACH DATABASE ? AS secondary", [secondaryPath]);
				return db.query("SELECT * FROM secondary.t").all();
			},
			{ recoverCorruption: true },
		);
	} catch (e) {
		err = e;
	}

	expect(isSqliteCorruptionError(err)).toBe(true);
	expect((err as Error).message.replaceAll("\\\\", "/")).toContain(secondaryPath.replaceAll("\\\\", "/"));

	const verifyMain = new Database(mainPath);
	try {
		const rows = verifyMain.query<{ id: number; balance: number }, []>("SELECT id, balance FROM accounts").all();
		expect(rows).toEqual([{ id: 1, balance: 5000 }]);
	} finally {
		verifyMain.close();
	}

	expect(await corruptBackups(dir.path())).toHaveLength(0);
});

test("regression: injected chmod failure leaves active store intact and surfaces error", async () => {
	await using dir = await TempDir.create("@omp-corrupt-chmod-fail-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchema(dbPath);

	const originalChmodSync = nodeFs.chmodSync.bind(nodeFs);
	const chmodSpy = spyOn(nodeFs, "chmodSync").mockImplementation((targetPath, mode) => {
		if (typeof targetPath === "string" && targetPath.includes("store.db")) {
			const error = new Error("EPERM: operation not permitted, chmod");
			(error as NodeJS.ErrnoException).code = "EPERM";
			throw error;
		}
		return originalChmodSync(targetPath, mode);
	});

	try {
		let thrownError: unknown;
		try {
			openSqliteDatabaseSync(dbPath, db => db.query("SELECT 1").all(), { recoverCorruption: true });
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeDefined();
		expect((thrownError as Error).message).toMatch(/EPERM|chmod|failed to preserve/i);
		expect(await fs.readFile(dbPath)).toEqual(damaged);
		const published = (await corruptBackups(dir.path())).filter(f => !f.endsWith(".tmp"));
		expect(published).toHaveLength(0);
	} finally {
		chmodSpy.mockRestore();
	}
});

test("regression: incomplete backup publication leaves active store intact and publishes no corrupt directory", async () => {
	await using dir = await TempDir.create("@omp-corrupt-incomplete-pub-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchema(dbPath);

	const originalRenameSync = nodeFs.renameSync.bind(nodeFs);
	const renameSpy = spyOn(nodeFs, "renameSync").mockImplementation((oldPath, newPath) => {
		if (typeof newPath === "string" && newPath.includes(".corrupt-")) {
			const error = new Error("ENOSPC: no space left on device, rename");
			(error as NodeJS.ErrnoException).code = "ENOSPC";
			throw error;
		}
		return originalRenameSync(oldPath, newPath);
	});

	try {
		let thrownError: unknown;
		try {
			openSqliteDatabaseSync(dbPath, db => db.query("SELECT 1").all(), { recoverCorruption: true });
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeDefined();
		expect((thrownError as Error).message).toMatch(/ENOSPC|rename|failed to preserve/i);
		const published = (await corruptBackups(dir.path())).filter(f => !f.endsWith(".tmp"));
		expect(published).toHaveLength(0);
		expect(await fs.readFile(dbPath)).toEqual(damaged);
	} finally {
		renameSpy.mockRestore();
	}
});

test("regression: interrupted sidecar removal writes quarantine-pending marker and subsequent opener fails closed", async () => {
	await using dir = await TempDir.create("@omp-corrupt-interrupted-removal-");
	const dbPath = dir.join("store.db");
	await corruptSchema(dbPath);
	await fs.writeFile(`${dbPath}-wal`, Buffer.from("damaged wal data"));

	const originalUnlinkSync = nodeFs.unlinkSync.bind(nodeFs);
	let unlinks = 0;
	const unlinkSpy = spyOn(nodeFs, "unlinkSync").mockImplementation(targetPath => {
		if (targetPath === dbPath || targetPath === `${dbPath}-wal` || targetPath === `${dbPath}-shm`) {
			unlinks++;
			if (unlinks > 1) {
				const error = new Error("EPERM: operation not permitted, unlink");
				(error as NodeJS.ErrnoException).code = "EPERM";
				throw error;
			}
		}
		return originalUnlinkSync(targetPath);
	});

	try {
		let thrownError: unknown;
		try {
			await openSqliteDatabase(dbPath, db => db.query("SELECT 1").all(), { recoverCorruption: true });
		} catch (error) {
			thrownError = error;
		}
		expect(thrownError).toBeDefined();

		const markerExists = await fs.stat(`${dbPath}.quarantine-pending`).then(
			() => true,
			() => false,
		);
		expect(markerExists).toBe(true);

		const openerError = await openSqliteDatabase(dbPath, db => db.query("SELECT 1").all()).catch(e => e);
		expect(openerError).toBeDefined();
		expect((openerError as Error).message).toMatch(/quarantine.*pending|pending.*quarantine/i);

		expect(() => openSqliteDatabaseSync(dbPath, db => db.query("SELECT 1").all())).toThrow(
			/quarantine.*pending|pending.*quarantine/i,
		);
	} finally {
		unlinkSpy.mockRestore();
	}
});
