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
		const pid = deadPid();
		await writeRecord(
			path.join(directory, `${pid}-${crypto.randomUUID()}.json`),
			{ version: 1, sessionId: "x", pid, cwd: root, sessionFile: withoutEndpoint },
		);
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
		await writeRecord(
			path.join(directory, `${process.pid}-${crypto.randomUUID()}.json`),
			{ version: 1, sessionId: "x", pid: process.pid, cwd: root, sessionFile },
		);
		await expect(assertNotTerminalOwned(sessionFile, root)).rejects.toThrow("Session is owned by a live terminal");
	});
});
