// WHY: Telegram's GUI route opened a second writer instead of forwarding to the CLI.
// Exercise the production socket server's authentication, identity and detach boundaries.
// This does not prove model execution or Telegram delivery; those require the disposable CLI smoke.
import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import * as utils from "@veyyon/utils";
import { assertNotTerminalOwned } from "@veyyon/kernel/session/terminal-ownership";
import { serveTerminalControl, type TerminalOwner } from "../src/launch/terminal-control";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(sessionId: string, root: string) {
	const received: string[] = [];
	let identity = sessionId;
	const close = await serveTerminalControl({
		identity: () => ({ sessionId: identity, cwd: root, sessionFile: path.join(root, `${identity}.jsonl`) }),
		deliver: async text => { received.push(text); return "started"; },
		abort: async () => false,
		history: () => [{ entryId: "existing", text: "Earlier response" }],
		subscribe: () => () => {},
	}, root);
	cleanup.push(close);
	const directory = path.join(root, "run", "terminals");
	const owners: TerminalOwner[] = await Promise.all((await fs.readdir(directory)).filter(file => file.endsWith(".json")).map(async file => JSON.parse(await fs.readFile(path.join(directory, file), "utf8"))));
	const owner = owners.find(candidate => candidate.sessionId === sessionId)!;
	return { owner, received, change: (next: string) => { identity = next; }, close };
}

async function request(owner: TerminalOwner, overrides: Record<string, unknown> = {}) {
	const done = Promise.withResolvers<Record<string, unknown>>();
	const socket = net.createConnection(owner.endpoint);
	cleanup.push(() => { socket.destroy(); });
	// Bound real OS socket failure; no sleep or fake-clock scheduling can drive Windows named-pipe I/O.
	const timer = setTimeout(() => done.reject(new Error("request exceeded bound")), 1_000);
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("connect", () => socket.write(JSON.stringify({ version: 1, id: "probe", token: owner.token, sessionId: owner.sessionId, op: "deliver", text: "nonce", mode: "auto", ...overrides }) + "\n"));
	socket.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) done.resolve(JSON.parse(buffer.split("\n")[0]!)); });
	socket.on("error", done.reject);
	socket.on("close", () => done.reject(new Error("closed")));
	try { return await done.promise; } finally { clearTimeout(timer); socket.destroy(); }
}

test("authenticated delivery targets exact session, not another terminal in the same workspace", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-owner-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const first = await fixture("session-one", root);
	const second = await fixture("session-two", root);
	expect(await request(first.owner)).toMatchObject({ ok: true, result: "started" });
	expect(first.received).toEqual(["nonce"]);
	expect(second.received).toEqual([]);
	expect(await request(first.owner, { sessionId: second.owner.sessionId })).toMatchObject({ ok: false });
	await expect(request(first.owner, { token: "wrong" })).rejects.toThrow("closed");
	expect(first.received).toEqual(["nonce"]);
	await expect(assertNotTerminalOwned(first.owner.sessionFile, root)).rejects.toThrow("owned by a live terminal");
});

test("session switch and close reject stale routing without invoking the new owner", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-detach-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const first = await fixture("before", root);
	first.change("after");
	expect(await request(first.owner)).toMatchObject({ ok: false });
	expect(first.received).toEqual([]);
	first.close();
	await expect(request(first.owner)).rejects.toThrow();
});

test("implicit resume and GUI open refuse the live owner's transcript before reading or rewriting it", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-writer-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const first = await fixture("live-session", root);
	const original = "unreadable sentinel: ownership must be checked before parsing or migration";
	await fs.writeFile(first.owner.sessionFile, original);
	spyOn(utils, "getConfigRootDir").mockReturnValue(root);
	await expect(SessionManager.open(first.owner.sessionFile)).rejects.toThrow("owned by a live terminal");
	expect(await fs.readFile(first.owner.sessionFile, "utf8")).toBe(original);
});
