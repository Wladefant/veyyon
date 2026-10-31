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
	it("ignores a claim whose recycled pid is alive but whose endpoint answers nothing", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "recycled.jsonl");
		// This process is definitely alive, and it does not serve the pipe: exactly the recycled-pid claim.
		await writeClaim(root, sessionFile, endpointFor(root, "gone"), process.pid);
		await expect(assertNotTerminalOwned(sessionFile, root)).resolves.toBeUndefined();
	});

	it("refuses a claim whose endpoint is really serving", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "served.jsonl");
		// Same shape serveTerminalControl uses: the socket lives beside the claim file it writes.
		await fsp.mkdir(path.join(root, "run", "terminals"), { recursive: true });
		const endpoint = endpointFor(root, crypto.randomUUID());
		await writeClaim(root, sessionFile, endpoint, process.pid);
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
	 * The same dead claim that is ignored when owner-only is refused when another user can read it: an
	 * unverifiable claim may be a live owner, so it blocks instead of being skipped.
	 */
	it("refuses a claim another user can read instead of skipping it", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "broad.jsonl");
		await writeClaim(root, sessionFile, endpointFor(root, "broad-gone"), deadPid(), true);
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow(
			"Cannot establish terminal writer ownership",
		);
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
	it("checks the parent once and does not batch ACLs for seven unrelated records", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "wanted.jsonl");
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		for (let index = 0; index < 7; index++) {
			await writeRecord(path.join(directory, `unrelated-${index}.json`), {
				version: 1,
				sessionId: `other-${index}`,
				pid: process.pid,
				cwd: root,
				sessionFile: path.join(root, `other-${index}.jsonl`),
			});
		}
		const calls: string[] = [];
		const options = {
			platform: "win32" as const,
			windowsAcl: {
				run: async (_script: string, filePath: string) => {
					calls.push(filePath);
					return { exitCode: 0, stdout: "OK", stderr: "" };
				},
			},
		};

		await assertNotTerminalOwned(sessionFile, root, options);

		expect(calls).toEqual([directory]);
	});

	it("refuses a matching loose ACL and reports the ACL cause", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "matching.jsonl");
		await writeClaim(root, sessionFile, endpointFor(root, "unavailable"), deadPid());
		const calls: string[] = [];
		await expect(
			assertNotTerminalOwned(sessionFile, root, {
				platform: "win32",
				windowsAcl: {
					run: async (_script, filePath) => {
						calls.push(filePath);
						return filePath.startsWith("[")
							? { exitCode: 1, stdout: "", stderr: "ACL grants access to another user" }
							: { exitCode: 0, stdout: "OK", stderr: "" };
					},
				},
			}),
		).rejects.toMatchObject({
			message: "Cannot establish terminal writer ownership",
			cause: expect.objectContaining({ message: expect.stringContaining("ACL grants access to another user") }),
		});
		expect(calls).toHaveLength(2);
		expect(JSON.parse(calls[1]!)).toEqual([expect.stringContaining(`${path.sep}run${path.sep}terminals${path.sep}`)]);
	});

	it("batches every matching candidate once and refuses a bad file", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "matching.jsonl");
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		for (let index = 0; index < 3; index++) {
			await writeRecord(path.join(directory, `candidate-${index}.json`), {
				version: 1,
				sessionId: `match-${index}`,
				pid: process.pid,
				cwd: root,
				sessionFile,
			});
		}
		const calls: string[] = [];
		await expect(
			assertNotTerminalOwned(sessionFile, root, {
				platform: "win32",
				windowsAcl: {
					run: async (_script, filePath) => {
						calls.push(filePath);
						return filePath.startsWith("[")
							? { exitCode: 1, stdout: "", stderr: "one candidate ACL is loose" }
							: { exitCode: 0, stdout: "OK", stderr: "" };
					},
				},
			}),
		).rejects.toThrow("Cannot establish terminal writer ownership");
		expect(calls).toHaveLength(2);
		expect(JSON.parse(calls[1]!)).toHaveLength(3);
		expect(JSON.parse(calls[1]!)).toEqual(
			expect.arrayContaining([0, 1, 2].map(index => path.join(directory, `candidate-${index}.json`))),
		);
	});

	it("keeps malformed and ambiguous records in the ACL candidate batch", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "matching.jsonl");
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(path.join(directory, "malformed.json"), "{");
		await writeRecord(path.join(directory, "ambiguous.json"), { version: 1, pid: process.pid });
		const calls: string[] = [];
		await expect(
			assertNotTerminalOwned(sessionFile, root, {
				platform: "win32",
				windowsAcl: {
					run: async (_script, filePath) => {
						calls.push(filePath);
						return { exitCode: 0, stdout: "OK", stderr: "" };
					},
				},
			}),
		).rejects.toThrow("Cannot establish terminal writer ownership");
		expect(calls).toHaveLength(2);
		expect(JSON.parse(calls[1]!)).toHaveLength(2);
	});

	it("refuses when the parent directory ACL is loose", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		await writeRecord(path.join(directory, "ambiguous.json"), { version: 1 });
		const calls: string[] = [];
		await expect(
			assertNotTerminalOwned(path.join(root, "matching.jsonl"), root, {
				platform: "win32",
				windowsAcl: {
					run: async (_script, filePath) => {
						calls.push(filePath);
						return filePath === directory
							? { exitCode: 1, stdout: "", stderr: "parent ACL is loose" }
							: { exitCode: 0, stdout: "OK", stderr: "" };
					},
				},
			}),
		).rejects.toThrow("Cannot establish terminal writer ownership");
		expect(calls).toEqual([directory]);
	});

	it("ignores an unrelated file ACL timeout but preserves the cause for a matching claim", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "run", "terminals");
		const sessionFile = path.join(root, "wanted.jsonl");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(
			path.join(directory, "claim.json"),
			JSON.stringify({ sessionFile: path.join(root, "other.jsonl") }),
		);
		const options = {
			platform: "win32" as const,
			windowsAcl: {
				run: async (_script: string, target: string) => {
					if (target !== directory) {
						throw new Error("The Windows ACL command timed out.");
					}
					return { exitCode: 0, stdout: "OK", stderr: "" };
				},
			},
		};
		await expect(assertNotTerminalOwned(sessionFile, root, options)).resolves.toBeUndefined();
		await fsp.writeFile(path.join(directory, "claim.json"), JSON.stringify({ sessionFile }));
		await expect(assertNotTerminalOwned(sessionFile, root, options)).rejects.toMatchObject({
			message: "Cannot establish terminal writer ownership",
			cause: expect.objectContaining({
				message: "The owner-only Windows ACL operation failed (The Windows ACL command timed out.).",
			}),
		});
	});
});

it("refuses a matching record replaced during the ACL batch", async () => {
	const root = await tempRoot();
	const directory = path.join(root, "run", "terminals");
	const sessionFile = path.join(root, "wanted.jsonl");
	const record = path.join(directory, "claim.json");
	await fsp.mkdir(directory, { recursive: true });
	await fsp.writeFile(record, JSON.stringify({ sessionFile }));
	await expect(
		assertNotTerminalOwned(sessionFile, root, {
			platform: "win32",
			windowsAcl: {
				run: async (_script, target) => {
					if (target.startsWith("[")) {
						await fsp.rename(record, `${record}.held`);
						await fsp.writeFile(record, JSON.stringify({ sessionFile }));
					}
					return { exitCode: 0, stdout: "OK", stderr: "" };
				},
			},
		}),
	).rejects.toMatchObject({
		message: "Cannot establish terminal writer ownership",
		cause: expect.objectContaining({ message: expect.stringContaining("replaced while it was checked") }),
	});
});
