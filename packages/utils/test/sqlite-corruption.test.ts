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

test("compatibility: in-memory sqlite store opens async and sync with default and opt-in recovery", async () => {
	const asyncDefault = await openSqliteDatabase(":memory:", async db => {
		db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k1', 101);");
		return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k1'").get();
	});
	expect(asyncDefault).toEqual({ val: 101 });

	const asyncRecover = await openSqliteDatabase(
		":memory:",
		async db => {
			db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k2', 102);");
			return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k2'").get();
		},
		{ recoverCorruption: true },
	);
	expect(asyncRecover).toEqual({ val: 102 });

	const syncDefault = openSqliteDatabaseSync(":memory:", db => {
		db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k3', 103);");
		return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k3'").get();
	});
	expect(syncDefault).toEqual({ val: 103 });

	const syncRecover = openSqliteDatabaseSync(
		":memory:",
		db => {
			db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k4', 104);");
			return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k4'").get();
		},
		{ recoverCorruption: true },
	);
	expect(syncRecover).toEqual({ val: 104 });
});

test("compatibility: temporary empty path sqlite store opens async and sync with default and opt-in recovery", async () => {
	const asyncDefault = await openSqliteDatabase("", async db => {
		db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k5', 201);");
		return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k5'").get();
	});
	expect(asyncDefault).toEqual({ val: 201 });

	const asyncRecover = await openSqliteDatabase(
		"",
		async db => {
			db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k6', 202);");
			return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k6'").get();
		},
		{ recoverCorruption: true },
	);
	expect(asyncRecover).toEqual({ val: 202 });

	const syncDefault = openSqliteDatabaseSync("", db => {
		db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k7', 203);");
		return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k7'").get();
	});
	expect(syncDefault).toEqual({ val: 203 });

	const syncRecover = openSqliteDatabaseSync(
		"",
		db => {
			db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k8', 204);");
			return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k8'").get();
		},
		{ recoverCorruption: true },
	);
	expect(syncRecover).toEqual({ val: 204 });
});

test("compatibility: deterministic injected parent accessSync EACCES allows healthy reads while pending marker blocks", async () => {
	await using dir = await TempDir.create("@omp-corrupt-readonly-parent-");
	const dbPath = dir.join("store.db");
	const initDb = new Database(dbPath);
	initDb.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('healthy-parent-ro');");
	initDb.close();

	const originalAccessSync = nodeFs.accessSync.bind(nodeFs);
	const parentDir = path.dirname(dbPath);
	let parentAccessChecked = 0;
	const accessSpy = spyOn(nodeFs, "accessSync").mockImplementation((checkPath: nodeFs.PathLike, mode?: number) => {
		if (
			checkPath === parentDir &&
			(mode === nodeFs.constants.W_OK || (typeof mode === "number" && (mode & nodeFs.constants.W_OK) !== 0))
		) {
			parentAccessChecked++;
			const error = new Error("EACCES: permission denied, access");
			(error as NodeJS.ErrnoException).code = "EACCES";
			throw error;
		}
		return originalAccessSync(checkPath, mode);
	});

	try {
		const asyncRow = await openSqliteDatabase(dbPath, async db => {
			return db.query<{ v: string }, []>("SELECT v FROM t").get();
		});
		expect(asyncRow).toEqual({ v: "healthy-parent-ro" });

		const syncRow = openSqliteDatabaseSync(dbPath, db => {
			return db.query<{ v: string }, []>("SELECT v FROM t").get();
		});
		expect(syncRow).toEqual({ v: "healthy-parent-ro" });
		expect(parentAccessChecked).toBeGreaterThan(0);

		await fs.writeFile(`${dbPath}.quarantine-pending`, JSON.stringify({ reason: "interrupted" }));

		await expect(openSqliteDatabase(dbPath, db => db.query("SELECT 1").all())).rejects.toThrow(
			/quarantine.*pending|pending.*quarantine/i,
		);
		expect(() => openSqliteDatabaseSync(dbPath, db => db.query("SELECT 1").all())).toThrow(
			/quarantine.*pending|pending.*quarantine/i,
		);
	} finally {
		accessSpy.mockRestore();
	}
});

test("regression: real URI memory store opens async and sync with default and opt-in recovery without filesystem operations", async () => {
	const interceptedOps: string[] = [];
	const fsOps = [
		"statSync",
		"lstatSync",
		"mkdirSync",
		"accessSync",
		"existsSync",
		"openSync",
		"readFileSync",
		"writeFileSync",
		"chmodSync",
		"unlinkSync",
		"renameSync",
		"rmdirSync",
		"rmSync",
		"readdirSync",
	] as const;

	const originals = {
		statSync: nodeFs.statSync,
		lstatSync: nodeFs.lstatSync,
		mkdirSync: nodeFs.mkdirSync,
		accessSync: nodeFs.accessSync,
		existsSync: nodeFs.existsSync,
		openSync: nodeFs.openSync,
		readFileSync: nodeFs.readFileSync,
		writeFileSync: nodeFs.writeFileSync,
		chmodSync: nodeFs.chmodSync,
		unlinkSync: nodeFs.unlinkSync,
		renameSync: nodeFs.renameSync,
		rmdirSync: nodeFs.rmdirSync,
		rmSync: nodeFs.rmSync,
		readdirSync: nodeFs.readdirSync,
	};
	const spies = fsOps.map(op => {
		const orig = (originals[op] as (...args: unknown[]) => unknown).bind(nodeFs);
		return spyOn(nodeFs, op).mockImplementation((...args: unknown[]) => {
			const targetPath = args[0];
			if (typeof targetPath === "string" && targetPath.startsWith("file:")) {
				interceptedOps.push(`${op}:${targetPath}`);
				throw new Error(`Unexpected filesystem call ${op} for URI path: ${targetPath}`);
			}
			return orig(...args);
		});
	});

	const uriAsyncDef = "file:transient-uri-async-def?mode=memory&cache=shared";
	const uriAsyncRec = "file:transient-uri-async-rec?mode=memory&cache=shared";
	const uriSyncDef = "file:transient-uri-sync-def?mode=memory&cache=shared";
	const uriSyncRec = "file:transient-uri-sync-rec?mode=memory&cache=shared";

	try {
		const asyncDefRows = await openSqliteDatabase(uriAsyncDef, async db => {
			try {
				db.run(
					"CREATE TABLE IF NOT EXISTS t_async_def (id INTEGER, val TEXT); INSERT INTO t_async_def VALUES (1, 'async-def');",
				);
				return db.query<{ id: number; val: string }, []>("SELECT id, val FROM t_async_def WHERE id = 1").all();
			} finally {
				db.close();
			}
		});
		expect(asyncDefRows).toEqual([{ id: 1, val: "async-def" }]);

		const asyncRecRows = await openSqliteDatabase(
			uriAsyncRec,
			async db => {
				try {
					db.run(
						"CREATE TABLE IF NOT EXISTS t_async_rec (id INTEGER, val TEXT); INSERT INTO t_async_rec VALUES (2, 'async-rec');",
					);
					return db.query<{ id: number; val: string }, []>("SELECT id, val FROM t_async_rec WHERE id = 2").all();
				} finally {
					db.close();
				}
			},
			{ recoverCorruption: true },
		);
		expect(asyncRecRows).toEqual([{ id: 2, val: "async-rec" }]);
		const syncDefRows = openSqliteDatabaseSync(uriSyncDef, db => {
			try {
				db.run(
					"CREATE TABLE IF NOT EXISTS t_sync_def (id INTEGER, val TEXT); INSERT INTO t_sync_def VALUES (3, 'sync-def');",
				);
				return db.query<{ id: number; val: string }, []>("SELECT id, val FROM t_sync_def WHERE id = 3").all();
			} finally {
				db.close();
			}
		});
		expect(syncDefRows).toEqual([{ id: 3, val: "sync-def" }]);

		const syncRecRows = openSqliteDatabaseSync(
			uriSyncRec,
			db => {
				try {
					db.run(
						"CREATE TABLE IF NOT EXISTS t_sync_rec (id INTEGER, val TEXT); INSERT INTO t_sync_rec VALUES (4, 'sync-rec');",
					);
					return db.query<{ id: number; val: string }, []>("SELECT id, val FROM t_sync_rec WHERE id = 4").all();
				} finally {
					db.close();
				}
			},
			{ recoverCorruption: true },
		);
		expect(syncRecRows).toEqual([{ id: 4, val: "sync-rec" }]);

		expect(interceptedOps).toEqual([]);
	} finally {
		for (const spy of spies) {
			spy.mockRestore();
		}
		for (const uri of [uriAsyncDef, uriAsyncRec, uriSyncDef, uriSyncRec]) {
			try {
				nodeFs.unlinkSync(uri);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
	}
});

test.skipIf(process.platform !== "win32")(
	"regression: windows :memory: store opens async and sync without EINVAL pathname lock",
	async () => {
		const asyncDefRows = await openSqliteDatabase(":memory:", async db => {
			try {
				db.run("CREATE TABLE t (k TEXT, v INTEGER); INSERT INTO t VALUES ('win-async-def', 10);");
				return db.query<{ k: string; v: number }, []>("SELECT k, v FROM t").all();
			} finally {
				db.close();
			}
		});
		expect(asyncDefRows).toEqual([{ k: "win-async-def", v: 10 }]);

		const asyncRecRows = await openSqliteDatabase(
			":memory:",
			async db => {
				try {
					db.run("CREATE TABLE t (k TEXT, v INTEGER); INSERT INTO t VALUES ('win-async-rec', 20);");
					return db.query<{ k: string; v: number }, []>("SELECT k, v FROM t").all();
				} finally {
					db.close();
				}
			},
			{ recoverCorruption: true },
		);
		expect(asyncRecRows).toEqual([{ k: "win-async-rec", v: 20 }]);

		const syncDefRows = openSqliteDatabaseSync(":memory:", db => {
			try {
				db.run("CREATE TABLE t (k TEXT, v INTEGER); INSERT INTO t VALUES ('win-sync-def', 30);");
				return db.query<{ k: string; v: number }, []>("SELECT k, v FROM t").all();
			} finally {
				db.close();
			}
		});
		expect(syncDefRows).toEqual([{ k: "win-sync-def", v: 30 }]);

		const syncRecRows = openSqliteDatabaseSync(
			":memory:",
			db => {
				try {
					db.run("CREATE TABLE t (k TEXT, v INTEGER); INSERT INTO t VALUES ('win-sync-rec', 40);");
					return db.query<{ k: string; v: number }, []>("SELECT k, v FROM t").all();
				} finally {
					db.close();
				}
			},
			{ recoverCorruption: true },
		);
		expect(syncRecRows).toEqual([{ k: "win-sync-rec", v: 40 }]);
	},
);

test("regression: transient corruption surfaces error without quarantine and closes handle", async () => {
	const createCorruptionError = () => {
		const error = new Error("database disk image is malformed");
		(error as NodeJS.ErrnoException).code = "SQLITE_CORRUPT";
		return error;
	};

	// 1. Asynchronous :memory: store with recoverCorruption: true
	let asyncMemoryDb: Database | undefined;
	let asyncMemoryPreserved = 0;
	await expect(
		openSqliteDatabase(
			":memory:",
			async db => {
				asyncMemoryDb = db;
				throw createCorruptionError();
			},
			{
				recoverCorruption: true,
				onCorruptionPreserved: () => {
					asyncMemoryPreserved++;
				},
			},
		),
	).rejects.toThrow(/database disk image is malformed/);
	expect(asyncMemoryPreserved).toBe(0);
	expect(() => asyncMemoryDb?.query("SELECT 1").all()).toThrow(/closed database/i);

	// 2. Synchronous :memory: store with recoverCorruption: true
	let syncMemoryDb: Database | undefined;
	let syncMemoryPreserved = 0;
	expect(() =>
		openSqliteDatabaseSync(
			":memory:",
			db => {
				syncMemoryDb = db;
				throw createCorruptionError();
			},
			{
				recoverCorruption: true,
				onCorruptionPreserved: () => {
					syncMemoryPreserved++;
				},
			},
		),
	).toThrow(/database disk image is malformed/);
	expect(syncMemoryPreserved).toBe(0);
	expect(() => syncMemoryDb?.query("SELECT 1").all()).toThrow(/closed database/i);

	// 3. Asynchronous URI memory store with recoverCorruption: true
	let asyncUriDb: Database | undefined;
	let asyncUriPreserved = 0;
	const uriAsync = "file:transient-corrupt-async?mode=memory&cache=shared";
	const uriSync = "file:transient-corrupt-sync?mode=memory&cache=shared";
	try {
		await expect(
			openSqliteDatabase(
				uriAsync,
				async db => {
					asyncUriDb = db;
					throw createCorruptionError();
				},
				{
					recoverCorruption: true,
					onCorruptionPreserved: () => {
						asyncUriPreserved++;
					},
				},
			),
		).rejects.toThrow(/database disk image is malformed/);
		expect(asyncUriPreserved).toBe(0);
		expect(() => asyncUriDb?.query("SELECT 1").all()).toThrow(/closed database/i);

		// 4. Synchronous URI memory store with recoverCorruption: true
		let syncUriDb: Database | undefined;
		let syncUriPreserved = 0;
		expect(() =>
			openSqliteDatabaseSync(
				uriSync,
				db => {
					syncUriDb = db;
					throw createCorruptionError();
				},
				{
					recoverCorruption: true,
					onCorruptionPreserved: () => {
						syncUriPreserved++;
					},
				},
			),
		).toThrow(/database disk image is malformed/);
		expect(syncUriPreserved).toBe(0);
		expect(() => syncUriDb?.query("SELECT 1").all()).toThrow(/closed database/i);
	} finally {
		for (const uri of [uriAsync, uriSync]) {
			try {
				nodeFs.unlinkSync(uri);
			} catch {}
		}
	}
});
