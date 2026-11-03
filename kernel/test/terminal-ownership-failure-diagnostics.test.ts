import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@veyyon/utils";
import { assertNotTerminalOwned } from "../src/session/terminal-ownership";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function claim(): Promise<{ root: string; sessionFile: string; record: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ownership-retry-"));
	roots.push(root);
	const directory = path.join(root, "run", "terminals");
	await fs.mkdir(directory, { recursive: true });
	const record = path.join(directory, "owner.json");
	await fs.writeFile(record, "{}");
	return { root, sessionFile: path.join(root, "owned.jsonl"), record };
}

describe("terminal ownership failure diagnostics", () => {
	for (const step of ["open", "ACL #1 (parent)", "ACL #2 (record)", "identity"]) {
		it(`names the record, ${step}, code, elapsed time and deadline without losing the cause`, async () => {
			const { root, sessionFile, record } = await claim();
			const cause = Object.assign(new Error("access denied"), { code: "EPERM" });
			const read = vi.spyOn(utils, "readOwnerOnlyFile").mockImplementation(async (_file, options) => {
				options?.onStep?.(step);
				throw cause;
			});
			const error = await assertNotTerminalOwned(sessionFile, root).then(() => undefined, error => error);
			expect(error).toBeInstanceOf(Error);
			expect(error.cause).toBe(cause);
			expect(error.message).toContain(`Cannot establish terminal writer ownership: ${record}; step=${step}; code=EPERM;`);
			expect(error.message).toMatch(/elapsed=\d+ms; ACL deadline=15000ms per command; access denied$/);
			expect(read).toHaveBeenCalledTimes(1);
		});
	}

	it("names parse failures and keeps their original SyntaxError", async () => {
		const { root, sessionFile, record } = await claim();
		vi.spyOn(utils, "readOwnerOnlyFile").mockResolvedValue("{");
		const error = await assertNotTerminalOwned(sessionFile, root).then(() => undefined, error => error);
		expect(error.cause).toBeInstanceOf(SyntaxError);
		expect(error.message).toContain(`${record}; step=parse; code=SyntaxError;`);
	});

	it("still treats a vanished record as absent", async () => {
		const { root, sessionFile } = await claim();
		vi.spyOn(utils, "readOwnerOnlyFile").mockRejectedValue(Object.assign(new Error("gone"), { code: "ENOENT" }));
		await expect(assertNotTerminalOwned(sessionFile, root)).resolves.toBeUndefined();
	});

	it("still refuses a recovered live owner without retries", async () => {
		const { root, sessionFile } = await claim();
		const read = vi.spyOn(utils, "readOwnerOnlyFile").mockResolvedValue(
			JSON.stringify({ version: 1, sessionFile, pid: process.pid }),
		);
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow("Session is owned by a live terminal");
		expect(read).toHaveBeenCalledTimes(1);
	});
});
