import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { SqliteAuthCredentialStore } from "../src/auth-storage-sqlite";

async function backupNames(dirPath: string, dbName = "auth.db"): Promise<string[]> {
	const files = await fs.promises.readdir(dirPath);
	return files.filter(name => name.startsWith(`${dbName}.corrupt-`));
}

test("SqliteAuthCredentialStore.open automatically quarantines a corrupt database and recreates a fresh store", async () => {
	await using dir = await TempDir.create("@omp-auth-store-corrupt-");
	const dbPath = dir.join("auth.db");
	const damaged = Buffer.from("not a valid sqlite database header".repeat(32));
	await fs.promises.writeFile(dbPath, damaged);

	const store = await SqliteAuthCredentialStore.open(dbPath);
	try {
		const credentials = store.listAuthCredentials();
		expect(credentials).toEqual([]);

		// Verify write and read operations work normally in the recreated database
		store.saveApiKey("test-provider", "secret-token");
		const found = store.getApiKey("test-provider");
		expect(found).toBe("secret-token");
	} finally {
		store.close();
	}

	const backups = (await backupNames(dir.path())).filter(
		name => !name.endsWith(".tmp") && !/-wal$|-shm$|-journal$/.test(name),
	);
	expect(backups).toHaveLength(1);
	const backupPath = path.join(dir.path(), backups[0]!);
	const stat = await fs.promises.stat(backupPath);
	const preservedFile = stat.isDirectory() ? path.join(backupPath, "auth.db") : backupPath;
	expect(await fs.promises.readFile(preservedFile)).toEqual(damaged);
});

test("negative control: without corruption recovery an unrecoverable database throws without quarantine", async () => {
	await using dir = await TempDir.create("@omp-auth-store-neg-control-");
	const dbPath = dir.join("auth.db");
	const damaged = Buffer.from("damaged content without recovery");
	await fs.promises.writeFile(dbPath, damaged);

	// Directly opening Database without corruption recovery fails and leaves file untouched
	expect(() => {
		const rawDb = new Database(dbPath);
		try {
			rawDb.query("SELECT 1 FROM sqlite_master").all();
		} finally {
			rawDb.close();
		}
	}).toThrow();

	expect(await fs.promises.readFile(dbPath)).toEqual(damaged);
	const backups = await backupNames(dir.path());
	expect(backups).toEqual([]);
});
