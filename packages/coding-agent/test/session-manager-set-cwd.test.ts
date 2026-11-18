import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { restorePlatform, setPlatform } from "../../utils/test/helpers/platform-override";
import { useTempDirs } from "./helpers/temp-dirs";

const makeTempDir = useTempDirs();

describe("SessionManager.setCwd", () => {
	it("re-roots a valid directory, updates header.cwd, and fires onCwdChanged", async () => {
		const start = makeTempDir("@pi-setcwd-start-");
		const next = makeTempDir("@pi-setcwd-next-");
		const manager = SessionManager.inMemory(start);

		const events: Array<{ previous: string; next: string }> = [];
		const unsubscribe = manager.onCwdChanged((previous, nextCwd) => {
			events.push({ previous, next: nextCwd });
		});

		const resolved = await manager.setCwd(next, { validate: true });
		expect(resolved).toBe(path.resolve(next));
		expect(manager.getCwd()).toBe(path.resolve(next));
		expect(manager.getHeader()?.cwd).toBe(path.resolve(next));
		expect(events).toEqual([{ previous: path.resolve(start), next: path.resolve(next) }]);

		unsubscribe();
	});

	it("keeps the journal readable while a Windows sharing denial delays a cwd change", async () => {
		const start = makeTempDir("@pi-setcwd-shared-start-");
		const next = makeTempDir("@pi-setcwd-shared-next-");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(start, start, storage);
		manager.appendCustomEntry("test-content", "Retain this journal entry.");
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile()!;
		const original = fs.readFileSync(sessionFile, "utf8");
		const rename = storage.renameSync.bind(storage);
		let blocked = true;
		let readWhileBlocked: string | undefined;
		const sharingDenial = Object.assign(new Error("EPERM: operation not permitted, rename journal.jsonl.tmp"), {
			code: "EPERM",
		});
		const renameSpy = spyOn(storage, "renameSync").mockImplementation((source, target) => {
			if (blocked && (source === sessionFile || target === sessionFile)) {
				if (readWhileBlocked === undefined) {
					readWhileBlocked = fs.readFileSync(sessionFile, "utf8");
					setPlatform("win32");
					setImmediate(() => {
						blocked = false;
						restorePlatform();
					});
				}
				throw sharingDenial;
			}
			rename(source, target);
		});
		try {
			expect(await manager.setCwd(next)).toBe(path.resolve(next));
			expect(readWhileBlocked).toBe(original);
			expect(manager.getSessionFile()).toBe(sessionFile);
			const persisted = fs.readFileSync(sessionFile, "utf8");
			expect(persisted).toContain("Retain this journal entry.");
			const header = persisted
				.split("\n")
				.map(line => (line ? JSON.parse(line) : null))
				.find(row => row?.type === "session");
			expect(header?.cwd).toBe(path.resolve(next));
		} finally {
			renameSpy.mockRestore();
			restorePlatform();
			await manager.close();
		}
	});

	it("rejects a path that is a file", async () => {
		const start = makeTempDir("@pi-setcwd-file-start-");
		const filePath = path.join(start, "not-a-dir.txt");
		fs.writeFileSync(filePath, "nope");
		const manager = SessionManager.inMemory(start);

		await expect(manager.setCwd(filePath, { validate: true })).rejects.toThrow(/Not a directory/);
		expect(manager.getCwd()).toBe(path.resolve(start));
	});

	it("rejects a nonexistent path", async () => {
		const start = makeTempDir("@pi-setcwd-missing-start-");
		const missing = path.join(start, "does-not-exist");
		const manager = SessionManager.inMemory(start);

		await expect(manager.setCwd(missing, { validate: true })).rejects.toThrow(/Directory does not exist/);
		expect(manager.getCwd()).toBe(path.resolve(start));
	});
});
