/**
 * WHY:
 * `assertNotTerminalOwned` read `process.kill(pid, 0)` as proof a terminal still owns the session.
 * Windows recycles PIDs within minutes, so a claim file left behind by a dead CLI kept matching an
 * unrelated process and blocked every launch in the project with
 * "Session is owned by a live terminal" until the file was deleted by hand.
 * The owner's control endpoint is the only proof that outlives the pid, so the check now connects to
 * it: no pipe or socket means a stale claim to ignore; anything else (answered, timed out, unknown
 * error) stays an owner, because a second writer is the worse failure.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { assertNotTerminalOwned } from "@veyyon/kernel/session/terminal-ownership";
import { applyOwnerOnlyWindowsAcl } from "@veyyon/utils";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const undo of cleanup.splice(0).reverse()) await undo();
});

/** The same endpoint shape `serveTerminalControl` publishes: a named pipe on win32, a socket elsewhere. */
function endpointFor(root: string, nonce: string): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\veyyon-terminal-${nonce}`
		: path.join(root, "run", "terminals", `${nonce}.sock`);
}

/**
 * Writes a claim the way serveTerminalControl does: owner-only. `broad` leaves it readable by other
 * users (on win32, the inherited ACL that the owner-only check refuses).
 */
async function writeRecord(file: string, body: object, broad = false): Promise<void> {
	const dir = path.dirname(file);
	await fsp.mkdir(dir, { recursive: true });
	if (process.platform === "win32") {
		if (!broad) await applyOwnerOnlyWindowsAcl(dir);
	} else {
		await fsp.chmod(dir, broad ? 0o755 : 0o700);
	}
	await fsp.writeFile(file, JSON.stringify(body));
	if (process.platform === "win32") {
		if (!broad) await applyOwnerOnlyWindowsAcl(file);
	} else {
		await fsp.chmod(file, broad ? 0o644 : 0o600);
	}
}

async function writeClaim(
	root: string,
	sessionFile: string,
	endpoint: string,
	pid: number,
	broad = false,
): Promise<void> {
	const directory = path.join(root, "run", "terminals");
	await fsp.mkdir(directory, { recursive: true });
	await writeRecord(
		path.join(directory, `${pid}-${crypto.randomUUID()}.json`),
		{ version: 1, sessionId: "stale", pid, cwd: root, sessionFile, endpoint, token: "t" },
		broad,
	);
}

async function tempRoot(): Promise<string> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "terminal-ownership-"));
	cleanup.push(() => fsp.rm(root, { recursive: true, force: true }));
	return root;
}

/** A pid that was real and has exited, so `process.kill(pid, 0)` is a genuine ESRCH. */
function deadPid(): number {
	const { pid, error, status, signal } = spawnSync(process.execPath, ["-e", "0"], {
		stdio: "ignore",
		timeout: 5_000,
		windowsHide: true,
	});
	if (error) throw error;
	if (status !== 0 || signal !== null) throw new Error("could not retire a child process");
	if (pid === undefined) throw new Error("no pid to retire");
	return pid;
}

async function listen(endpoint: string): Promise<void> {
	const server = net.createServer();
	cleanup.push(
		() =>
			new Promise<void>(resolve => {
				server.close(() => resolve());
			}),
	);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, resolve);
	});
}

describe("terminal ownership claims", () => {
	it("ignores a live pid in a malformed record when its derived endpoint is absent", async () => {
		const root = await tempRoot();
		const unrelatedSession = path.join(root, "malformed-live.jsonl");
		const nonce = crypto.randomUUID();
		const malformed = path.join(root, "run", "terminals", `${process.pid}-${nonce}.json`);
		await fsp.mkdir(path.dirname(malformed), { recursive: true });
		await fsp.writeFile(malformed, "{ malformed");
		await expect(assertNotTerminalOwned(unrelatedSession, root)).resolves.toBeUndefined();
	});

	it("rejects a malformed live-pid publisher when its derived endpoint is serving", async () => {
		const root = await tempRoot();
		const unrelatedSession = path.join(root, "malformed-serving.jsonl");
		const nonce = crypto.randomUUID();
		const malformed = path.join(root, "run", "terminals", `${process.pid}-${nonce}.json`);
		await fsp.mkdir(path.dirname(malformed), { recursive: true });
		await fsp.writeFile(malformed, "{ malformed");
		await listen(endpointFor(root, nonce));
		await expect(assertNotTerminalOwned(unrelatedSession, root)).rejects.toThrow(
			"Cannot establish terminal writer ownership",
		);
	});

	it("rejects malformed JSON with an unknown publisher name", async () => {
		const root = await tempRoot();
		const unrelatedSession = path.join(root, "unknown-malformed.jsonl");
		const malformed = path.join(root, "run", "terminals", `unknown-${crypto.randomUUID()}.json`);
		await fsp.mkdir(path.dirname(malformed), { recursive: true });
		await fsp.writeFile(malformed, "{ malformed");
		await expect(assertNotTerminalOwned(unrelatedSession, root)).rejects.toThrow(
			"Cannot establish terminal writer ownership",
		);
	});

	it("refuses a claim whose endpoint is really serving", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "served.jsonl");
		await fsp.mkdir(path.join(root, "run", "terminals"), { recursive: true });
		const nonce = crypto.randomUUID();
		const endpoint = endpointFor(root, nonce);
		await writeRecord(path.join(root, "run", "terminals", `${process.pid}-${nonce}.json`), {
			version: 1,
			sessionId: "stale",
			pid: process.pid,
			cwd: root,
			sessionFile,
			endpoint,
			token: "t",
		});
		await listen(endpoint);
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow("Session is owned by a live terminal");
	});

	it("ignores a claim whose pid is dead, endpoint or not", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "dead.jsonl");
		await writeClaim(root, sessionFile, endpointFor(root, "also-gone"), deadPid());
		await expect(assertNotTerminalOwned(sessionFile, root)).resolves.toBeUndefined();
		const withoutEndpoint = path.join(root, "dead-no-endpoint.jsonl");
		const directory = path.join(root, "run", "terminals");
		const pid = deadPid();
		await writeRecord(path.join(directory, `${pid}-${crypto.randomUUID()}.json`), {
			version: 1,
			sessionId: "x",
			pid,
			cwd: root,
			sessionFile: withoutEndpoint,
		});
		await expect(assertNotTerminalOwned(withoutEndpoint, root)).resolves.toBeUndefined();
	});

	/**
	 * An unverifiable record may still belong to a live owner, so it blocks instead of being skipped.
	 */
	it("fails closed for a live filename pid when its record ACL cannot be verified", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		const sessionFile = path.join(root, "broad.jsonl");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(path.join(directory, `${process.pid}-claim.json`), JSON.stringify({ sessionFile }));
		await expect(
			assertNotTerminalOwned(sessionFile, root, {
				platform: "win32",
				windowsAcl: {
					run: async (_script: string, target: string) => {
						if (target === directory) return { exitCode: 0, stdout: "OK", stderr: "" };
						throw new Error("The Windows ACL command timed out.");
					},
				},
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("Cannot establish terminal writer ownership"),
			cause: expect.objectContaining({ message: expect.stringContaining("The Windows ACL command timed out.") }),
		});
	});

	it("skips an unverifiable record whose filename pid is dead", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		const sessionFile = path.join(root, "wanted.jsonl");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(path.join(directory, `${deadPid()}-${crypto.randomUUID()}.json`), JSON.stringify({ sessionFile }));
		await expect(assertNotTerminalOwned(sessionFile, root, {
			platform: "win32",
			windowsAcl: {
				run: async (_script: string, target: string) => {
					if (target === directory) return { exitCode: 0, stdout: "OK", stderr: "" };
					throw new Error("The Windows ACL command timed out.");
				},
			},
		})).resolves.toBeUndefined();
	});


	it("ignores malformed publisher-shaped records for dead pids without matching unrelated sessions", async () => {
		const root = await tempRoot();
		const unrelatedSession = path.join(root, "other.jsonl");
		const pid = deadPid();
		const malformed = path.join(root, "run", "terminals", `${pid}-${crypto.randomUUID()}.json`);
		await fsp.mkdir(path.dirname(malformed), { recursive: true });
		await fsp.writeFile(malformed, "{ malformed");
		await expect(assertNotTerminalOwned(unrelatedSession, root)).resolves.toBeUndefined();
	});

	it("refuses a broadly readable claim for a live pid with record diagnostics", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "broad-live.jsonl");
		const nonce = crypto.randomUUID();
		const endpoint = endpointFor(root, nonce);
		await writeRecord(
			path.join(root, "run", "terminals", `${process.pid}-${nonce}.json`),
			{ version: 1, sessionId: "stale", pid: process.pid, cwd: root, sessionFile, endpoint, token: "t" },
			true,
		);
		await listen(endpoint);
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow(
			"Cannot establish terminal writer ownership",
		);
	});

	it("ignores a broadly readable dead-pid claim", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "broad-dead.jsonl");
		await writeClaim(root, sessionFile, endpointFor(root, "broad-dead"), deadPid(), true);
		await expect(assertNotTerminalOwned(sessionFile, root)).resolves.toBeUndefined();
	});

	it("fails closed for a claim with no usable endpoint", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "no-endpoint.jsonl");
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		await writeRecord(path.join(directory, `${process.pid}-${crypto.randomUUID()}.json`), {
			version: 1,
			sessionId: "x",
			pid: process.pid,
			cwd: root,
			sessionFile,
		});
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow("Session is owned by a live terminal");
	});
});

describe("terminal ownership Windows ACL scan", () => {
	it("checks every parent and all seven unrelated records before using their bytes", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		const records = Array.from({ length: 7 }, (_, index) => path.join(directory, `unrelated-${index}.json`));
		for (const record of records) {
			await fsp.writeFile(record, JSON.stringify({ version: 1, pid: process.pid, sessionFile: `${record}l` }));
		}
		const calls: string[] = [];
		await assertNotTerminalOwned(path.join(root, "wanted.jsonl"), root, {
			platform: "win32",
			windowsAcl: { run: async (_script, target) => {
				calls.push(target);
				return { exitCode: 0, stdout: "OK", stderr: "" };
			} },
		});
		expect(calls).toHaveLength(14);
		expect(calls.filter(target => target !== directory).sort()).toEqual(records);
		expect(calls.filter((_target, index) => index % 2 === 0)).toEqual(Array(7).fill(directory));
	});

	it("refuses a matching loose ACL and reports the original ACL cause", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		const sessionFile = path.join(root, "wanted.jsonl");
		const record = path.join(directory, "claim.json");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(record, JSON.stringify({ version: 1, pid: process.pid, sessionFile }));
		const calls: string[] = [];
		await expect(assertNotTerminalOwned(sessionFile, root, {
			platform: "win32",
			windowsAcl: { run: async (_script, target) => {
				calls.push(target);
				return target === record
					? { exitCode: 1, stdout: "", stderr: "ACL grants access to another user" }
					: { exitCode: 0, stdout: "OK", stderr: "" };
			} },
		})).rejects.toMatchObject({
			message: expect.stringContaining("Cannot establish terminal writer ownership"),
			cause: expect.objectContaining({ message: expect.stringContaining("ACL grants access to another user") }),
		});
		expect(calls).toEqual([directory, record]);
	});

	it("does not retry an uncertain ACL failure", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(path.join(directory, "claim.json"), "{}");
		let attempts = 0;
		await expect(assertNotTerminalOwned(path.join(root, "wanted.jsonl"), root, {
			platform: "win32",
			windowsAcl: { run: async (_script, target) => {
				if (target !== directory) {
					attempts++;
					throw new Error("transient ACL runner failure");
				}
				return { exitCode: 0, stdout: "OK", stderr: "" };
			} },
		})).rejects.toThrow("transient ACL runner failure");
		expect(attempts).toBe(1);
	});

	it("fails closed when a record disappears during an uncertain ACL failure", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		const record = path.join(directory, "claim.json");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(record, "{}");
		await expect(assertNotTerminalOwned(path.join(root, "wanted.jsonl"), root, {
			platform: "win32",
			windowsAcl: { run: async (_script, target) => {
				if (target === record) {
					await fsp.rm(record);
					throw new Error("ACL provider could not find its target");
				}
				return { exitCode: 0, stdout: "OK", stderr: "" };
			} },
		})).rejects.toThrow("Cannot establish terminal writer ownership");
	});

	for (const matching of [false, true]) {
		it(`refuses a replaced record before trusting its session (matching=${matching})`, async () => {
			const root = await tempRoot();
			const directory = path.join(root, "run", "terminals");
			const sessionFile = path.join(root, "wanted.jsonl");
			const record = path.join(directory, "claim.json");
			await fsp.mkdir(directory, { recursive: true });
			const content = JSON.stringify({ sessionFile: matching ? sessionFile : path.join(root, "other.jsonl") });
			await fsp.writeFile(record, content);
			await expect(assertNotTerminalOwned(sessionFile, root, {
				platform: "win32",
				windowsAcl: { run: async (_script, target) => {
					if (target === record) {
						await fsp.rename(record, `${record}.held`);
						await fsp.writeFile(record, content);
					}
					return { exitCode: 0, stdout: "OK", stderr: "" };
				} },
			})).rejects.toThrow("replaced while it was checked");
		});
	}

	it("checks all records beyond the former 32-record batch boundary", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		for (let index = 0; index < 33; index++) {
			await fsp.writeFile(path.join(directory, `${index}.json`), "{}");
		}
		const calls: string[] = [];
		await assertNotTerminalOwned(path.join(root, "wanted.jsonl"), root, {
			platform: "win32",
			windowsAcl: { run: async (_script, target) => {
				calls.push(target);
				return { exitCode: 0, stdout: "OK", stderr: "" };
			} },
		});
		expect(calls).toHaveLength(66);
		expect(new Set(calls.filter(target => target !== directory)).size).toBe(33);
	});

	it("verifies a malformed record before reporting the parse failure", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		const record = path.join(directory, "malformed.json");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(record, "{");
		const calls: string[] = [];
		await expect(assertNotTerminalOwned(path.join(root, "wanted.jsonl"), root, {
			platform: "win32",
			windowsAcl: { run: async (_script, target) => {
				calls.push(target);
				return { exitCode: 0, stdout: "OK", stderr: "" };
			} },
		})).rejects.toThrow("step=parse");
		expect(calls).toEqual([directory, record]);
	});

	it("refuses a loose parent without opening or checking a record", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(path.join(directory, "claim.json"), "{}");
		const calls: string[] = [];
		await expect(assertNotTerminalOwned(path.join(root, "wanted.jsonl"), root, {
			platform: "win32",
			windowsAcl: { run: async (_script, target) => {
				calls.push(target);
				return { exitCode: 1, stdout: "", stderr: "parent ACL is loose" };
			} },
		})).rejects.toThrow("parent ACL is loose");
		expect(calls).toEqual([directory]);
	});

	it("fails closed when an unrelated record ACL times out and preserves the nested cause", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(path.join(directory, "claim.json"), JSON.stringify({ sessionFile: path.join(root, "other.jsonl") }));
		await expect(assertNotTerminalOwned(path.join(root, "wanted.jsonl"), root, {
			platform: "win32",
			windowsAcl: { run: async (_script, target) => {
				if (target !== directory) throw new Error("The Windows ACL command timed out.");
				return { exitCode: 0, stdout: "OK", stderr: "" };
			} },
		})).rejects.toMatchObject({
			message: expect.stringContaining("Cannot establish terminal writer ownership"),
			cause: expect.objectContaining({ message: expect.stringContaining("The Windows ACL command timed out.") }),
		});
	});
});
