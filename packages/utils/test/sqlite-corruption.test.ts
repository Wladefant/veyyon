import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
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
	expect(err.message).toContain(dbPath);
	expect(await fs.readFile(dbPath)).toEqual(damaged);
	expect(await corruptBackups(dir.path())).toHaveLength(0);
});

test("synchronous recovery preserves damaged pages and creates usable database", async () => {
	await using dir = await TempDir.create("@omp-corrupt-sync-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchema(dbPath);

	openSqliteDatabaseSync(
		dbPath,
		db => {
			db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('recovered')");
			db.close();
		},
		{ recoverCorruption: true },
	);

	const backups = (await corruptBackups(dir.path())).filter(f => !/-wal$|-shm$|-journal$/.test(f));
	expect(backups).toHaveLength(1);
	expect(await fs.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);

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

	const backups = (await corruptBackups(dir.path())).filter(f => !/-wal$|-shm$|-journal$/.test(f));
	expect(backups).toHaveLength(1);
	const backupBase = path.join(dir.path(), backups[0]!);
	for (const [ext, data] of Object.entries(sidecars)) {
		expect(await fs.readFile(`${backupBase}${ext}`)).toEqual(data);
	}
});

test("negative control: opt-in recovery ignores non-corruption errors", async () => {
	await using dir = await TempDir.create("@omp-corrupt-negative-");
	const dbPath = dir.join("store.db");
	let err: unknown;
	try {
		openSqliteDatabaseSync(dbPath, db => db.run("INSERT INTO missing VALUES (1)"), { recoverCorruption: true });
	} catch (e) {
		err = e;
	}
	expect(isSqliteCorruptionError(err)).toBe(false);
	expect((err as Error).message).toContain(dbPath);
	expect(await corruptBackups(dir.path())).toHaveLength(0);
});
