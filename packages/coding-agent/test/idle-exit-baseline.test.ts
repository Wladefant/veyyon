import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { serveTerminalControl } from "../src/launch/terminal-control";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("terminal control accepts an idleExit request", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "idle-exit-before-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const close = await serveTerminalControl(
		{
			identity: () => ({ sessionId: "baseline", cwd: root, sessionFile: path.join(root, "session.jsonl") }),
			deliver: async () => "started",
			abort: async () => false,
			history: () => [],
			subscribe: () => () => {},
		},
		root,
	);
	cleanup.push(close);
	const records = await fs.readdir(path.join(root, "run", "terminals"));
	const ownerValue: unknown = JSON.parse(
		await fs.readFile(path.join(root, "run", "terminals", records[0]), "utf8"),
	);
	if (!isRecord(ownerValue)) throw new Error("terminal owner record is invalid");
	const { endpoint, token, sessionId } = ownerValue;
	if (typeof endpoint !== "string" || typeof token !== "string" || typeof sessionId !== "string")
		throw new Error("terminal owner credentials are invalid");
	const response = Promise.withResolvers<Record<string, unknown>>();
	const socket = net.createConnection(endpoint);
	cleanup.push(() => socket.destroy());
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("connect", () =>
		socket.write(`${JSON.stringify({ version: 1, id: "idle-exit", token, sessionId, op: "idleExit" })}\n`),
	);
	socket.on("data", chunk => {
		buffer += chunk;
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const frame: unknown = JSON.parse(buffer.slice(0, newline));
		if (isRecord(frame)) response.resolve(frame);
	});
	// Bound real socket failure; a fake clock cannot drive the operating-system transport.
	const timer = setTimeout(() => response.reject(new Error("idleExit response timed out")), 5_000);
	const frame = await response.promise.finally(() => clearTimeout(timer));
	expect(frame.ok).toBe(true);
	if (!isRecord(frame.result)) throw new Error("idleExit result is invalid");
	expect(frame.result.accepted).toBe(true);
});
