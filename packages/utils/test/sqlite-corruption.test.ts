import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
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
		expect(await fs.realpath(preservedBackupPath)).toBe(await fs.realpath(path.join(backupDir, "store.db")));
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
		if (
			[dbPath, `${dbPath}-wal`, `${dbPath}-shm`].some(
				file => String(targetPath).toLowerCase() === file.toLowerCase(),
			)
		) {
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
		const list = db.query<{ seq: number; name: string; file: string }, []>("PRAGMA database_list").all();
		expect(list[0]?.file).toBe("");
		db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k1', 101);");
		return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k1'").get();
	});
	expect(asyncDefault).toEqual({ val: 101 });

	await openSqliteDatabase(":memory:", async db => {
		const list = db.query<{ seq: number; name: string; file: string }, []>("PRAGMA database_list").all();
		expect(list[0]?.file).toBe("");
		expect(
			db.query<{ count: number }, []>("SELECT count(*) as count FROM sqlite_master WHERE name = 'entries'").get(),
		).toEqual({ count: 0 });
	});

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
		const list = db.query<{ seq: number; name: string; file: string }, []>("PRAGMA database_list").all();
		expect(list[0]?.file).toBe("");
		db.run("CREATE TABLE entries (key TEXT, val INTEGER); INSERT INTO entries VALUES ('k3', 103);");
		return db.query<{ val: number }, []>("SELECT val FROM entries WHERE key = 'k3'").get();
	});
	expect(syncDefault).toEqual({ val: 103 });

	openSqliteDatabaseSync(":memory:", db => {
		const list = db.query<{ seq: number; name: string; file: string }, []>("PRAGMA database_list").all();
		expect(list[0]?.file).toBe("");
		expect(
			db.query<{ count: number }, []>("SELECT count(*) as count FROM sqlite_master WHERE name = 'entries'").get(),
		).toEqual({ count: 0 });
	});

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

test("compatibility: deterministic injected parent openSync wx EACCES allows healthy reads while pending marker blocks", async () => {
	await using dir = await TempDir.create("@omp-corrupt-readonly-parent-");
	const dbPath = dir.join("store.db");
	const initDb = new Database(dbPath);
	initDb.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('healthy-parent-ro');");
	initDb.close();

	const originalOpenSync = nodeFs.openSync.bind(nodeFs);
	let probeDenialChecked = 0;
	const openSpy = spyOn(nodeFs, "openSync").mockImplementation(
		(targetPath: nodeFs.PathLike, flags?: nodeFs.OpenMode, mode?: nodeFs.Mode) => {
			if (
				typeof targetPath === "string" &&
				path.basename(targetPath).startsWith(".sqlite-write-probe-") &&
				(flags === "wx" || flags === "xw")
			) {
				probeDenialChecked++;
				const error = new Error("EACCES: permission denied, open");
				(error as NodeJS.ErrnoException).code = "EACCES";
				throw error;
			}
			return originalOpenSync(targetPath, flags, mode);
		},
	);

	try {
		const asyncRow = await openSqliteDatabase(dbPath, async db => {
			try {
				return db.query<{ v: string }, []>("SELECT v FROM t").get();
			} finally {
				db.close();
			}
		});
		expect(asyncRow).toEqual({ v: "healthy-parent-ro" });

		const syncRow = openSqliteDatabaseSync(dbPath, db => {
			try {
				return db.query<{ v: string }, []>("SELECT v FROM t").get();
			} finally {
				db.close();
			}
		});
		expect(syncRow).toEqual({ v: "healthy-parent-ro" });
		expect(probeDenialChecked).toBeGreaterThan(0);

		await fs.writeFile(`${dbPath}.quarantine-pending`, JSON.stringify({ reason: "interrupted" }));

		await expect(
			openSqliteDatabase(dbPath, async db => {
				try {
					return db.query("SELECT 1").all();
				} finally {
					db.close();
				}
			}),
		).rejects.toThrow(/quarantine.*pending|pending.*quarantine/i);
		expect(() =>
			openSqliteDatabaseSync(dbPath, db => {
				try {
					return db.query("SELECT 1").all();
				} finally {
					db.close();
				}
			}),
		).toThrow(/quarantine.*pending|pending.*quarantine/i);
	} finally {
		openSpy.mockRestore();
	}
});

test.skipIf(process.platform !== "win32")(
	"regression: real NTFS ACL denied-create-directory allows healthy reads while marker blocks both",
	async () => {
		await using dir = await TempDir.create("@omp-corrupt-ntfs-acl-");
		const parentDir = dir.path();
		const dbPath = dir.join("store.db");

		const initDb = new Database(dbPath);
		initDb.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('healthy-ntfs-acl');");
		initDb.close();

		let sid: string;
		try {
			const whoamiOut = childProcess.execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 5000,
			});
			const match = whoamiOut.match(/"(S-1-[^"]+)"/);
			if (!match) throw new Error(`Could not parse SID from whoami output: ${whoamiOut}`);
			sid = match[1];
		} catch (error) {
			throw new Error(
				`Failed to determine current user SID for NTFS ACL fixture: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		try {
			childProcess.execFileSync("icacls", [parentDir, "/deny", `*${sid}:(WD,AD)`], {
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 5000,
			});
		} catch (error) {
			throw new Error(
				`Failed to configure NTFS ACL deny (WD,AD) on ${parentDir}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		try {
			let accessWOkSucceeded = false;
			try {
				nodeFs.accessSync(parentDir, nodeFs.constants.W_OK);
				accessWOkSucceeded = true;
			} catch {
				accessWOkSucceeded = false;
			}
			expect(accessWOkSucceeded).toBe(true);

			let createFailed = false;
			const probePath = path.join(parentDir, `.probe-test-${Date.now()}.tmp`);
			try {
				const fd = nodeFs.openSync(probePath, "wx");
				nodeFs.closeSync(fd);
			} catch (e) {
				createFailed = true;
				expect(["EACCES", "EPERM"]).toContain((e as NodeJS.ErrnoException).code ?? "");
			}
			expect(createFailed).toBe(true);

			const directDb = new Database(dbPath);
			try {
				const directRow = directDb.query<{ v: string }, []>("SELECT v FROM t").get();
				expect(directRow).toEqual({ v: "healthy-ntfs-acl" });
			} finally {
				directDb.close();
			}

			const asyncRow = await openSqliteDatabase(dbPath, async db => {
				try {
					return db.query<{ v: string }, []>("SELECT v FROM t").get();
				} finally {
					db.close();
				}
			});
			expect(asyncRow).toEqual({ v: "healthy-ntfs-acl" });

			const syncRow = openSqliteDatabaseSync(dbPath, db => {
				try {
					return db.query<{ v: string }, []>("SELECT v FROM t").get();
				} finally {
					db.close();
				}
			});
			expect(syncRow).toEqual({ v: "healthy-ntfs-acl" });
		} finally {
			childProcess.execFileSync("icacls", [parentDir, "/remove:d", `*${sid}`], {
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 5000,
			});
		}

		const markerPath = `${dbPath}.quarantine-pending`;
		await fs.writeFile(markerPath, JSON.stringify({ reason: "interrupted" }));

		childProcess.execFileSync("icacls", [parentDir, "/deny", `*${sid}:(WD,AD)`], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});

		try {
			await expect(
				openSqliteDatabase(dbPath, async db => {
					try {
						return db.query("SELECT 1").all();
					} finally {
						db.close();
					}
				}),
			).rejects.toThrow(/quarantine.*pending|pending.*quarantine/i);
			expect(() =>
				openSqliteDatabaseSync(dbPath, db => {
					try {
						return db.query("SELECT 1").all();
					} finally {
						db.close();
					}
				}),
			).toThrow(/quarantine.*pending|pending.*quarantine/i);
		} finally {
			childProcess.execFileSync("icacls", [parentDir, "/remove:d", `*${sid}`], {
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 5000,
			});
		}
	},
);

test("regression: physical URI-looking filenames exact starts-file subprocess runner asserts backing, persistence, and quarantine block", async () => {
	await using dir = await TempDir.create("@omp-corrupt-uri-runner-");
	const repoRoot = path.resolve(__dirname, "../../..");
	const sqliteModulePath = path.join(repoRoot, "packages/utils/src/sqlite.ts").replaceAll("\\", "/");
	const script = `
		import { Database } from "bun:sqlite";
		import { openSqliteDatabase, openSqliteDatabaseSync } from "${sqliteModulePath}";
		import * as fs from "node:fs";

		const uris = [
			"file:store-plain.db?mode=memory&cache=shared",
			"file:store-dup.db?mode=memory&cache=shared&mode=memory",
			"file:store-encval.db?mode=%6d%65%6d%6f%72%79&cache=shared",
			"file:store-mem-rwc.db?mode=memory&cache=shared&mode=rwc",
			"file:store-rwc-mem.db?mode=rwc&cache=shared&mode=memory",
			"file:store-encname.db?%6d%6f%64%65=memory&cache=shared",
			"file:store-encboth.db?%6d%6f%64%65=%6d%65%6d%6f%72%79&cache=shared",
		];

		for (const uri of uris) {
			openSqliteDatabaseSync(uri, db => {
				try {
					const list = db.query("PRAGMA database_list").all();
					const mainFile = list[0]?.file;
					if (!mainFile || mainFile.length === 0) throw new Error("main.file was empty for " + uri);
					db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('sentinel');");
				} finally {
					db.close();
				}
			});

			const reopenedSync = openSqliteDatabaseSync(uri, db => {
				try {
					return db.query("SELECT v FROM t").all();
				} finally {
					db.close();
				}
			});
			if (reopenedSync.length !== 1 || reopenedSync[0].v !== "sentinel") {
				throw new Error("sentinel did not persist sync reopen for " + uri);
			}

			const reopenedAsync = await openSqliteDatabase(uri, async db => {
				try {
					return db.query("SELECT v FROM t").all();
				} finally {
					db.close();
				}
			});
			if (reopenedAsync.length !== 1 || reopenedAsync[0].v !== "sentinel") {
				throw new Error("sentinel did not persist async reopen for " + uri);
			}

			const marker = \`\${uri}.quarantine-pending\`;
			fs.writeFileSync(marker, JSON.stringify({ reason: "interrupted" }));

			let syncDefBlocked = false;
			try {
				openSqliteDatabaseSync(uri, db => {
					try {
						return db.query("SELECT 1").all();
					} finally {
						db.close();
					}
				});
			} catch (e) {
				if (/quarantine.*pending|pending.*quarantine/i.test(e.message)) syncDefBlocked = true;
			}
			if (!syncDefBlocked) throw new Error("sync default not blocked by marker for " + uri);

			let syncOptBlocked = false;
			try {
				openSqliteDatabaseSync(
					uri,
					db => {
						try {
							return db.query("SELECT 1").all();
						} finally {
							db.close();
						}
					},
					{ recoverCorruption: true },
				);
			} catch (e) {
				if (/quarantine.*pending|pending.*quarantine/i.test(e.message)) syncOptBlocked = true;
			}
			if (!syncOptBlocked) throw new Error("sync opt-in not blocked by marker for " + uri);

			let asyncDefBlocked = false;
			try {
				await openSqliteDatabase(uri, async db => {
					try {
						return db.query("SELECT 1").all();
					} finally {
						db.close();
					}
				});
			} catch (e) {
				if (/quarantine.*pending|pending.*quarantine/i.test(e.message)) asyncDefBlocked = true;
			}
			if (!asyncDefBlocked) throw new Error("async default not blocked by marker for " + uri);

			let asyncOptBlocked = false;
			try {
				await openSqliteDatabase(
					uri,
					async db => {
						try {
							return db.query("SELECT 1").all();
						} finally {
							db.close();
						}
					},
					{ recoverCorruption: true },
				);
			} catch (e) {
				if (/quarantine.*pending|pending.*quarantine/i.test(e.message)) asyncOptBlocked = true;
			}
			if (!asyncOptBlocked) throw new Error("async opt-in not blocked by marker for " + uri);

			fs.unlinkSync(marker);
		}
	`;

	const child = childProcess.spawnSync(process.execPath, ["-e", script], {
		cwd: dir.path(),
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15000,
		encoding: "utf8",
	});

	if (child.error) throw child.error;
	if (child.status !== 0) {
		throw new Error(`Isolated URI runner failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
	}
}, 45000);

test.skipIf(process.platform !== "win32")(
	"regression: windows NTFS ADS corrupt-header recovery and interrupted unlink guard",
	async () => {
		await using dir = await TempDir.create("@omp-corrupt-ads-");
		const baseDb = dir.join("base.db");
		nodeFs.writeFileSync(baseDb, "base-content");
		const adsPath = `${baseDb}:stream.db`;
		const damagedAds = Buffer.from("damaged ads sqlite header bytes 1234567890");
		nodeFs.writeFileSync(adsPath, damagedAds);

		const expectedHash = crypto.createHash("sha256").update(path.resolve(adsPath).toLowerCase()).digest("hex");
		const expectedStem = path.join(path.dirname(adsPath), `.sqlite-${expectedHash}`);
		const hashedMarker = path.resolve(`${expectedStem}.quarantine-pending`);

		// 1. Interrupted unlink injection leaves hashed marker
		const originalUnlinkSync = nodeFs.unlinkSync.bind(nodeFs);
		const unlinkSpy = spyOn(nodeFs, "unlinkSync").mockImplementation((targetPath: nodeFs.PathLike) => {
			if (typeof targetPath === "string" && targetPath.toLowerCase().includes(adsPath.toLowerCase())) {
				const err = new Error("EPERM: operation not permitted, unlink");
				(err as NodeJS.ErrnoException).code = "EPERM";
				throw err;
			}
			return originalUnlinkSync(targetPath);
		});

		try {
			await expect(
				openSqliteDatabase(
					adsPath,
					async db => {
						try {
							return db.query("SELECT 1").all();
						} finally {
							db.close();
						}
					},
					{ recoverCorruption: true },
				),
			).rejects.toThrow();
		} finally {
			unlinkSpy.mockRestore();
		}

		expect(nodeFs.existsSync(hashedMarker)).toBe(true);

		// Both sync and async openers fail closed due to hashed pending marker
		expect(() =>
			openSqliteDatabaseSync(adsPath, db => {
				try {
					return db.query("SELECT 1").all();
				} finally {
					db.close();
				}
			}),
		).toThrow(/quarantine.*pending|pending.*quarantine/i);

		await expect(
			openSqliteDatabase(adsPath, async db => {
				try {
					return db.query("SELECT 1").all();
				} finally {
					db.close();
				}
			}),
		).rejects.toThrow(/quarantine.*pending|pending.*quarantine/i);

		nodeFs.unlinkSync(hashedMarker);

		// Exact original path marker also fails closed
		const exactMarker = `${adsPath}.quarantine-pending`;
		nodeFs.writeFileSync(exactMarker, JSON.stringify({ reason: "interrupted" }));
		expect(() =>
			openSqliteDatabaseSync(adsPath, db => {
				try {
					return db.query("SELECT 1").all();
				} finally {
					db.close();
				}
			}),
		).toThrow(/quarantine.*pending|pending.*quarantine/i);
		await expect(
			openSqliteDatabase(adsPath, async db => {
				try {
					return db.query("SELECT 1").all();
				} finally {
					db.close();
				}
			}),
		).rejects.toThrow(/quarantine.*pending|pending.*quarantine/i);
		nodeFs.unlinkSync(exactMarker);

		// 2. Corrupt-header recovery sync: proves hashed backup path, bytes, and fresh usable store
		nodeFs.writeFileSync(adsPath, damagedAds);
		let syncBackupPath: string | undefined;
		const syncRows = openSqliteDatabaseSync(
			adsPath,
			db => {
				try {
					db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('ads-sync-recovered');");
					return db.query<{ v: string }, []>("SELECT v FROM t").all();
				} finally {
					db.close();
				}
			},
			{
				recoverCorruption: true,
				onCorruptionPreserved: p => {
					syncBackupPath = p;
				},
			},
		);
		expect(syncRows).toEqual([{ v: "ads-sync-recovered" }]);
		expect(syncBackupPath).toBeDefined();
		expect(syncBackupPath).toContain(expectedHash);
		expect(nodeFs.readFileSync(syncBackupPath!)).toEqual(damagedAds);

		const syncReopened = openSqliteDatabaseSync(adsPath, db => {
			try {
				return db.query<{ v: string }, []>("SELECT v FROM t").all();
			} finally {
				db.close();
			}
		});
		expect(syncReopened).toEqual([{ v: "ads-sync-recovered" }]);

		// 3. Corrupt-header recovery async: proves hashed backup path, bytes, and fresh usable store
		nodeFs.writeFileSync(adsPath, damagedAds);
		let asyncBackupPath: string | undefined;
		const asyncRows = await openSqliteDatabase(
			adsPath,
			async db => {
				try {
					db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('ads-async-recovered');");
					return db.query<{ v: string }, []>("SELECT v FROM t").all();
				} finally {
					db.close();
				}
			},
			{
				recoverCorruption: true,
				onCorruptionPreserved: p => {
					asyncBackupPath = p;
				},
			},
		);
		expect(asyncRows).toEqual([{ v: "ads-async-recovered" }]);
		expect(asyncBackupPath).toBeDefined();
		expect(asyncBackupPath).toContain(expectedHash);
		expect(nodeFs.readFileSync(asyncBackupPath!)).toEqual(damagedAds);

		const asyncReopened = await openSqliteDatabase(adsPath, async db => {
			try {
				return db.query<{ v: string }, []>("SELECT v FROM t").all();
			} finally {
				db.close();
			}
		});
		expect(asyncReopened).toEqual([{ v: "ads-async-recovered" }]);
	},
	45000,
);

test.skipIf(process.platform !== "win32")(
	"regression: Windows file and stream aliases share canonical recovery identity and pending guard",
	async () => {
		await using dir = await TempDir.create("@omp-corrupt-ads-aliases-");
		const baseDb = dir.join("base.db");
		nodeFs.writeFileSync(baseDb, "base-content");
		const adsPath = `${baseDb}:stream.db`;

		// 1. Create sentinel store with Bun directly
		const initDb = new Database(adsPath);
		try {
			initDb.run("CREATE TABLE sentinel (v TEXT); INSERT INTO sentinel VALUES ('initial-value');");
		} finally {
			initDb.close();
		}

		const resolved = path.resolve(adsPath);
		const baseDir = path.dirname(adsPath);
		const junction = dir.join("junction");
		nodeFs.symlinkSync(baseDir, junction, "junction");
		const shortDir = childProcess
			.execFileSync("cmd.exe", ["/d", "/c", "for %I in (%SQLITE_ALIAS_DIR%) do @echo %~sI"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 5000,
				env: { ...process.env, SQLITE_ALIAS_DIR: `"${baseDir}"` },
			})
			.trim();
		const candidates = [
			{ kind: "extended prefix", file: path.toNamespacedPath(resolved) },
			{ kind: "device prefix", file: `\\\\.\\${resolved}`, optional: true },
			{ kind: "drive case", file: resolved[0]!.toLowerCase() + resolved.slice(1) },
			{ kind: "basename case", file: path.join(baseDir, "BASE.DB:stream.db") },
			{ kind: "stream case", file: path.join(baseDir, "base.db:STREAM.DB") },
			{ kind: "directory case", file: path.join(baseDir.toUpperCase(), "base.db:stream.db") },
			{ kind: "forward slashes", file: resolved.replaceAll("\\", "/") },
			{ kind: "8.3 parent", file: path.join(shortDir, "base.db:stream.db") },
			{ kind: "junction", file: path.join(junction, "base.db:stream.db") },
			{ kind: "dotted parent", file: `${baseDir}.\\base.db:stream.db` },
			{ kind: "extended dotted parent", file: path.toNamespacedPath(`${baseDir}.\\base.db:stream.db`) },
			{ kind: "trailing dot", file: path.join(baseDir, "base.db.:stream.db"), optional: true },
			{ kind: "trailing space", file: path.join(baseDir, "base.db :stream.db"), optional: true },
			{ kind: "UNC admin share", file: `\\\\localhost\\${resolved[0]}$${resolved.slice(2)}`, optional: true },
		];
		for (const candidate of [...candidates]) {
			if (candidate.kind === "trailing dot" || candidate.kind === "trailing space") continue;
			for (const suffix of [".", " "]) {
				candidates.push({
					...candidate,
					kind: `${candidate.kind} stream suffix ${JSON.stringify(suffix)}`,
					file: candidate.file + suffix,
				});
			}
		}
		const aliases: string[] = [];

		// 2. Verify all aliases read the SAME store directly with Bun
		for (const candidate of candidates) {
			let db: Database | undefined;
			try {
				db = new Database(candidate.file);
				const row = db.query<{ v: string }, []>("SELECT v FROM sentinel").get();
				if (row?.v !== "initial-value") throw new Error("filename does not resolve to the sentinel store");
				expect(row).toEqual({ v: "initial-value" });
				aliases.push(candidate.file);
				console.log(`ALIAS ${candidate.kind}: same physical store`);
			} catch (error) {
				if (!candidate.optional) throw error;
				console.log(`ALIAS ${candidate.kind}: not a supported same-store alias: ${String(error)}`);
			} finally {
				db?.close();
			}
		}
		for (const alias of aliases) {
			const initialize = (db: Database) => {
				try {
					return db.query<{ v: string }, []>("SELECT v FROM sentinel").get();
				} finally {
					db.close();
				}
			};
			expect(openSqliteDatabaseSync(alias, initialize)).toEqual({ v: "initial-value" });
			expect(await openSqliteDatabase(alias, initialize)).toEqual({ v: "initial-value" });
		}

		// Mutate store via an alias directly with Bun
		const mutDb = new Database(aliases[1]);
		try {
			mutDb.run("UPDATE sentinel SET v = 'mutated-via-alias';");
		} finally {
			mutDb.close();
		}

		// Verify canonical sees mutation directly with Bun
		const checkDb = new Database(adsPath);
		try {
			const row = checkDb.query<{ v: string }, []>("SELECT v FROM sentinel").get();
			expect(row).toEqual({ v: "mutated-via-alias" });
		} finally {
			checkDb.close();
		}

		// 4. Trigger production corrupt quarantine interrupted unlink
		const healthyBytes = nodeFs.readFileSync(adsPath);
		const damagedAds = Buffer.from("damaged ads sqlite header bytes 1234567890");
		nodeFs.writeFileSync(adsPath, damagedAds);

		const originalUnlinkSync = nodeFs.unlinkSync.bind(nodeFs);
		const unlinkSpy = spyOn(nodeFs, "unlinkSync").mockImplementation((targetPath: nodeFs.PathLike) => {
			if (typeof targetPath === "string" && targetPath.toLowerCase().includes("base.db")) {
				const err = new Error("EPERM: operation not permitted, unlink");
				(err as NodeJS.ErrnoException).code = "EPERM";
				throw err;
			}
			return originalUnlinkSync(targetPath);
		});

		try {
			await expect(
				openSqliteDatabase(
					adsPath,
					async db => {
						try {
							return db.query("SELECT 1").all();
						} finally {
							db.close();
						}
					},
					{ recoverCorruption: true },
				),
			).rejects.toThrow();
		} finally {
			unlinkSpy.mockRestore();
		}

		const markers = nodeFs.readdirSync(dir.path()).filter(name => name.endsWith(".quarantine-pending"));
		expect(markers).toHaveLength(1);
		const hashedMarker = dir.join(markers[0]!);
		nodeFs.writeFileSync(adsPath, healthyBytes);
		expect(nodeFs.existsSync(`${adsPath}.quarantine-pending`)).toBe(false);

		// 5. Assert BOTH sync and async default/opt-in helpers refuse aliases while hashed marker exists
		try {
			for (const alias of aliases) {
				expect(nodeFs.existsSync(`${alias}.quarantine-pending`)).toBe(false);

				let syncDefRan = false;
				expect(() =>
					openSqliteDatabaseSync(alias, db => {
						syncDefRan = true;
						try {
							return db.query("SELECT 1").all();
						} finally {
							db.close();
						}
					}),
				).toThrow(/quarantine.*pending|pending.*quarantine/i);
				expect(syncDefRan).toBe(false);

				let syncOptRan = false;
				expect(() =>
					openSqliteDatabaseSync(
						alias,
						db => {
							syncOptRan = true;
							try {
								return db.query("SELECT 1").all();
							} finally {
								db.close();
							}
						},
						{ recoverCorruption: true },
					),
				).toThrow(/quarantine.*pending|pending.*quarantine/i);
				expect(syncOptRan).toBe(false);

				let asyncDefRan = false;
				await expect(
					openSqliteDatabase(alias, async db => {
						asyncDefRan = true;
						try {
							return db.query("SELECT 1").all();
						} finally {
							db.close();
						}
					}),
				).rejects.toThrow(/quarantine.*pending|pending.*quarantine/i);
				expect(asyncDefRan).toBe(false);

				let asyncOptRan = false;
				await expect(
					openSqliteDatabase(
						alias,
						async db => {
							asyncOptRan = true;
							try {
								return db.query("SELECT 1").all();
							} finally {
								db.close();
							}
						},
						{ recoverCorruption: true },
					),
				).rejects.toThrow(/quarantine.*pending|pending.*quarantine/i);
				expect(asyncOptRan).toBe(false);
			}
			nodeFs.unlinkSync(adsPath);
			for (const alias of aliases) {
				for (const recoverCorruption of [false, true]) {
					const initialize = (db: Database) => {
						db.close();
						throw new Error("pending guard allowed initialization after stream removal");
					};
					expect(() => openSqliteDatabaseSync(alias, initialize, { recoverCorruption })).toThrow(
						/interrupted quarantine/,
					);
					await expect(openSqliteDatabase(alias, initialize, { recoverCorruption })).rejects.toThrow(
						/interrupted quarantine/,
					);
				}
			}
		} finally {
			nodeFs.unlinkSync(hashedMarker);
		}
	},
	45000,
);

test("regression: physical URI corrupt-header recovery preserves backup bytes and recreates fresh usable store", async () => {
	await using dir = await TempDir.create("@omp-corrupt-uri-recovery-");
	const uri = dir.join("file:corrupt-uri.db?mode=memory&cache=shared");
	const damagedUri = Buffer.from("damaged physical uri header bytes 1234567890");
	nodeFs.writeFileSync(uri, damagedUri);

	let syncBackupPath: string | undefined;
	const syncRows = openSqliteDatabaseSync(
		uri,
		db => {
			try {
				db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('uri-sync-recovered');");
				return db.query<{ v: string }, []>("SELECT v FROM t").all();
			} finally {
				db.close();
			}
		},
		{
			recoverCorruption: true,
			onCorruptionPreserved: p => {
				syncBackupPath = p;
			},
		},
	);
	expect(syncRows).toEqual([{ v: "uri-sync-recovered" }]);
	expect(syncBackupPath).toBeDefined();
	if (process.platform === "win32") {
		const expectedHash = crypto.createHash("sha256").update(path.resolve(uri).toLowerCase()).digest("hex");
		expect(syncBackupPath).toContain(expectedHash);
	}
	expect(nodeFs.readFileSync(syncBackupPath!)).toEqual(damagedUri);

	const syncReopened = openSqliteDatabaseSync(uri, db => {
		try {
			return db.query<{ v: string }, []>("SELECT v FROM t").all();
		} finally {
			db.close();
		}
	});
	expect(syncReopened).toEqual([{ v: "uri-sync-recovered" }]);

	// Async recovery
	nodeFs.writeFileSync(uri, damagedUri);
	let asyncBackupPath: string | undefined;
	const asyncRows = await openSqliteDatabase(
		uri,
		async db => {
			try {
				db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('uri-async-recovered');");
				return db.query<{ v: string }, []>("SELECT v FROM t").all();
			} finally {
				db.close();
			}
		},
		{
			recoverCorruption: true,
			onCorruptionPreserved: p => {
				asyncBackupPath = p;
			},
		},
	);
	expect(asyncRows).toEqual([{ v: "uri-async-recovered" }]);
	expect(asyncBackupPath).toBeDefined();
	if (process.platform === "win32") {
		const expectedHash = crypto.createHash("sha256").update(path.resolve(uri).toLowerCase()).digest("hex");
		expect(asyncBackupPath).toContain(expectedHash);
	}
	expect(nodeFs.readFileSync(asyncBackupPath!)).toEqual(damagedUri);

	const asyncReopened = await openSqliteDatabase(uri, async db => {
		try {
			return db.query<{ v: string }, []>("SELECT v FROM t").all();
		} finally {
			db.close();
		}
	});
	expect(asyncReopened).toEqual([{ v: "uri-async-recovered" }]);
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
});
