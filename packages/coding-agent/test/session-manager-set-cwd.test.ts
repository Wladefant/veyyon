import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
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
