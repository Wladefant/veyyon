import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { openSqliteDatabase, openSqliteDatabaseSync } from "../src/sqlite";
import { TempDir } from "../src/temp";

test.skipIf(process.platform !== "win32")(
	"Windows ordinary file aliases retain the pending guard after main removal",
	async () => {
		await using dir = await TempDir.create("@veyyon-missing-main-alias-");
		const dbPath = dir.join("store.db");
		const db = new Database(dbPath);
		try {
			db.run("CREATE TABLE sentinel(v); INSERT INTO sentinel VALUES ('same file')");
		} finally {
			db.close();
		}
		const junction = dir.join("junction");
		fs.symlinkSync(dir.path(), junction, "junction");
		const candidates = [
			{ kind: "case", file: dbPath.toUpperCase() },
			{ kind: "extended", file: path.toNamespacedPath(dbPath) },
			{ kind: "device", file: `\\\\.\\${dbPath}` },
			{ kind: "slashes", file: dbPath.replaceAll("\\", "/") },
			{ kind: "junction", file: path.join(junction, "store.db") },
			{ kind: "dotted parent", file: `${dir.path()}.\\store.db` },
			{ kind: "extended dotted parent", file: path.toNamespacedPath(`${dir.path()}.\\store.db`) },
			{ kind: "trailing dot", file: `${dbPath}.` },
			{ kind: "trailing space", file: `${dbPath} ` },
			{ kind: "UNC admin share", file: `\\\\localhost\\${dbPath[0]}$${dbPath.slice(2)}`, optional: true },
		];
		const link = dir.join("link.db");
		try {
			fs.symlinkSync(dbPath, link, "file");
			candidates.push({ kind: "symlink", file: link });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			console.log("ALIAS file symlink unavailable: EPERM");
		}
		const aliases: string[] = [];
		for (const candidate of candidates) {
			let probe: Database | undefined;
			try {
				probe = new Database(candidate.file);
				const row = probe.query<{ v: string }, []>("SELECT v FROM sentinel").get();
				if (row?.v !== "same file") throw new Error("not the sentinel file");
				aliases.push(candidate.file);
				console.log(`MAIN ALIAS ${candidate.kind}: same file`);
			} catch (error) {
				if (!candidate.optional) throw error;
				console.log(`MAIN ALIAS ${candidate.kind}: unavailable ${String(error)}`);
			} finally {
				probe?.close();
			}
		}
		for (const alias of aliases) {
			const initialize = (d: Database) => {
				try {
					return d.query<{ v: string }, []>("SELECT v FROM sentinel").get();
				} finally {
					d.close();
				}
			};
			expect(openSqliteDatabaseSync(alias, initialize)).toEqual({ v: "same file" });
			expect(await openSqliteDatabase(alias, initialize)).toEqual({ v: "same file" });
		}
		fs.writeFileSync(dbPath, "damaged SQLite header");
		const unlink = fs.unlinkSync.bind(fs);
		const interruption = spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (String(target).toLowerCase() === dbPath.toLowerCase()) {
				unlink(target);
				throw Object.assign(new Error("interrupted after main removal"), { code: "EPERM" });
			}
			return unlink(target);
		});
		try {
			expect(() =>
				openSqliteDatabaseSync(
					dbPath,
					d => {
						try {
							d.query("SELECT 1").all();
						} finally {
							d.close();
						}
					},
					{ recoverCorruption: true },
				),
			).toThrow();
		} finally {
			interruption.mockRestore();
		}
		expect(fs.existsSync(dbPath)).toBe(false);
		expect(fs.existsSync(`${dbPath}.quarantine-pending`)).toBe(true);
		for (const alias of aliases) {
			for (const recoverCorruption of [false, true]) {
				const initialize = (d: Database) => {
					d.close();
					throw new Error("guard allowed initialization");
				};
				expect(() => openSqliteDatabaseSync(alias, initialize, { recoverCorruption })).toThrow(
					/interrupted quarantine/,
				);
				await expect(openSqliteDatabase(alias, initialize, { recoverCorruption })).rejects.toThrow(
					/interrupted quarantine/,
				);
			}
		}
	},
	45000,
);

test.skipIf(process.platform !== "win32")(
	"Windows ADS stream suffix dots and spaces retain the generated pending guard",
	async () => {
		await using dir = await TempDir.create("@veyyon-stream-suffix-");
		const base = dir.join("base.db");
		fs.writeFileSync(base, "base");
		const file = `${base}:stream.db`;
		const db = new Database(file);
		try {
			db.run("CREATE TABLE sentinel(v); INSERT INTO sentinel VALUES ('same stream')");
		} finally {
			db.close();
		}
		const healthy = fs.readFileSync(file);
		fs.writeFileSync(file, "damaged SQLite header");
		const unlink = fs.unlinkSync.bind(fs);
		const interruption = spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (String(target).toLowerCase() === file.toLowerCase())
				throw Object.assign(new Error("interrupted stream removal"), { code: "EPERM" });
			return unlink(target);
		});
		try {
			expect(() =>
				openSqliteDatabaseSync(
					file,
					d => {
						try {
							d.query("SELECT 1").all();
						} finally {
							d.close();
						}
					},
					{ recoverCorruption: true },
				),
			).toThrow();
		} finally {
			interruption.mockRestore();
		}
		const markers = fs.readdirSync(dir.path()).filter(name => name.endsWith(".quarantine-pending"));
		expect(markers).toHaveLength(1);
		fs.writeFileSync(file, healthy);
		for (const prefix of [
			file,
			path.toNamespacedPath(file),
			`\\\\.\\${file}`,
			`\\\\localhost\\${file[0]}$${file.slice(2)}`,
		]) {
			for (const suffix of [".", " "]) {
				const alias = prefix + suffix;
				const probe = new Database(alias);
				try {
					expect(probe.query<{ v: string }, []>("SELECT v FROM sentinel").get()).toEqual({ v: "same stream" });
				} finally {
					probe.close();
				}
				for (const recoverCorruption of [false, true]) {
					const initialize = (d: Database) => {
						d.close();
						throw new Error("guard allowed initializer");
					};
					expect(() => openSqliteDatabaseSync(alias, initialize, { recoverCorruption })).toThrow(
						/interrupted quarantine/,
					);
					await expect(openSqliteDatabase(alias, initialize, { recoverCorruption })).rejects.toThrow(
						/interrupted quarantine/,
					);
				}
			}
		}
		fs.unlinkSync(dir.join(markers[0]!));
		for (const alias of [file + ".", path.toNamespacedPath(file) + " "]) {
			const damaged = Buffer.from("damaged suffix alias header");
			fs.writeFileSync(file, damaged);
			let backup: string | undefined;
			const initialize = (d: Database) => {
				try {
					d.run("CREATE TABLE recovered(v); INSERT INTO recovered VALUES ('restored')");
					return d.query<{ v: string }, []>("SELECT v FROM recovered").get();
				} finally {
					d.close();
				}
			};
			const options = {
				recoverCorruption: true,
				onCorruptionPreserved: (p: string) => {
					backup = p;
				},
			};
			const row = alias.endsWith(".")
				? openSqliteDatabaseSync(alias, initialize, options)
				: await openSqliteDatabase(alias, initialize, options);
			expect(row).toEqual({ v: "restored" });
			expect(backup).toBeDefined();
			expect(fs.readFileSync(backup!)).toEqual(damaged);
		}
	},
	45000,
);
