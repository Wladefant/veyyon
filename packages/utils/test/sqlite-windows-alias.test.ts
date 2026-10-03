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
		fs.writeFileSync(dbPath, "damaged SQLite header");
		const unlink = fs.unlinkSync.bind(fs);
		const interruption = spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (target === dbPath) {
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
