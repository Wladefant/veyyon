import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	readStorageStateFile,
	type StorageState,
	writeStorageStateFile,
} from "@veyyon/coding-agent/tools/web/browser/storage-state";

/**
 * WHY. A state file holds live session cookies and is rewritten in place by `save_state`. A write
 * that truncates first loses the previous state on a crash or a full disk, and a file that exists
 * with looser permissions must not be readable while the cookies are written into it. The write goes
 * to a 0600 sibling and is renamed over the target. No Chromium is involved.
 */

const roots: string[] = [];
function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-write-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const state = (value: string): StorageState => ({
	cookies: [{ name: "sid", value, domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true }],
	origins: [],
});

describe("writeStorageStateFile", () => {
	it("round-trips the state and leaves no staging file beside it", async () => {
		const dir = tempRoot();
		const file = path.join(dir, "nested", "state.json");
		await writeStorageStateFile(file, state("one"));
		expect((await readStorageStateFile(file)).cookies[0]?.value).toBe("one");
		expect(fs.readdirSync(path.dirname(file))).toEqual(["state.json"]);
	});

	it("replaces an existing file whole", async () => {
		const file = path.join(tempRoot(), "state.json");
		await writeStorageStateFile(file, state("a-much-longer-first-value-that-a-truncating-write-would-leave-behind"));
		await writeStorageStateFile(file, state("b"));
		expect((await readStorageStateFile(file)).cookies[0]?.value).toBe("b");
	});

	it.skipIf(process.platform === "win32")("narrows an existing 0644 file to 0600", async () => {
		const file = path.join(tempRoot(), "state.json");
		fs.writeFileSync(file, "{}", { mode: 0o644 });
		await writeStorageStateFile(file, state("x"));
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it("keeps the previous state and leaves no staging file when the write fails", async () => {
		const dir = tempRoot();
		const file = path.join(dir, "state.json");
		await writeStorageStateFile(file, state("kept"));
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await expect(writeStorageStateFile(file, circular as unknown as StorageState)).rejects.toThrow();
		expect((await readStorageStateFile(file)).cookies[0]?.value).toBe("kept");
		expect(fs.readdirSync(dir)).toEqual(["state.json"]);
	});
});
