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

async function writeClaim(root: string, sessionFile: string, endpoint: string, pid: number): Promise<void> {
	const directory = path.join(root, "run", "terminals");
	await fsp.mkdir(directory, { recursive: true });
	await fsp.writeFile(
		path.join(directory, `${pid}-${crypto.randomUUID()}.json`),
		JSON.stringify({ version: 1, sessionId: "stale", pid, cwd: root, sessionFile, endpoint, token: "t" }),
	);
}

async function tempRoot(): Promise<string> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "terminal-ownership-"));
	cleanup.push(() => fsp.rm(root, { recursive: true, force: true }));
	return root;
}

/** A pid that was real and has exited, so `process.kill(pid, 0)` is a genuine ESRCH. */
function deadPid(): number {
	const { pid } = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
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
		await fsp.writeFile(
			path.join(directory, `${deadPid()}-${crypto.randomUUID()}.json`),
			JSON.stringify({ version: 1, sessionId: "x", pid: deadPid(), cwd: root, sessionFile: withoutEndpoint }),
		);
		await expect(assertNotTerminalOwned(withoutEndpoint, root)).resolves.toBeUndefined();
	});

	it("fails closed for a claim with no usable endpoint", async () => {
		const root = await tempRoot();
		const sessionFile = path.join(root, "no-endpoint.jsonl");
		const directory = path.join(root, "run", "terminals");
		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(
			path.join(directory, `${process.pid}-${crypto.randomUUID()}.json`),
			JSON.stringify({ version: 1, sessionId: "x", pid: process.pid, cwd: root, sessionFile }),
		);
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow("Session is owned by a live terminal");
	});
});
