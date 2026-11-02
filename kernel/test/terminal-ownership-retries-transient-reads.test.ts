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

describe("terminal ownership read retries", () => {
	for (const code of ["EPERM", "EBUSY", "EACCES"]) {
		it(`rechecks ownership after transient ${code} instead of opening a live owner's session`, async () => {
			const { root, sessionFile } = await claim();
			const read = vi.spyOn(utils, "readOwnerOnlyFile")
				.mockRejectedValueOnce(Object.assign(new Error("temporarily busy"), { code }))
				.mockRejectedValueOnce(Object.assign(new Error("temporarily busy"), { code }))
				.mockResolvedValue(JSON.stringify({ version: 1, sessionFile, pid: process.pid }));
			await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow("Session is owned by a live terminal");
			expect(read).toHaveBeenCalledTimes(3);
		});
	}

	it("retries invalid JSON and still refuses the recovered live owner", async () => {
		const { root, sessionFile } = await claim();
		const read = vi.spyOn(utils, "readOwnerOnlyFile").mockResolvedValueOnce("{")
			.mockResolvedValue(JSON.stringify({ version: 1, sessionFile, pid: process.pid }));
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow("Session is owned by a live terminal");
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("fails closed with the record and code after persistent read errors", async () => {
		const { root, sessionFile, record } = await claim();
		const error = Object.assign(new Error("access denied"), { code: "EPERM" });
		const read = vi.spyOn(utils, "readOwnerOnlyFile").mockRejectedValue(error);
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow(`Cannot establish terminal writer ownership: ${record}`);
		expect(read).toHaveBeenCalledTimes(10);
	});

	it("does not retry a security refusal", async () => {
		const { root, sessionFile } = await claim();
		const read = vi.spyOn(utils, "readOwnerOnlyFile").mockRejectedValue(new Error("Refusing discovery record: readable by other users"));
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow("readable by other users");
		expect(read).toHaveBeenCalledTimes(1);
	});
});
