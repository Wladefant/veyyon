// WHY: Telegram messages reached a large busy session minutes late and the daemon reported them as
// failed (Wladefant/veyyon#505). The terminal must acknowledge a delivery at once, before the work
// that can block, and must never convert the whole journal again for a new leaf.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@veyyon/utils";
import { serveTerminalControl, type TerminalOwner } from "../src/launch/terminal-control";
import { startTerminalControl } from "../src/modes/terminal/terminal-control";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function readOwner(root: string): Promise<TerminalOwner> {
	const directory = path.join(root, "run", "terminals");
	const file = (await fs.readdir(directory)).find(name => name.endsWith(".json"))!;
	return JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
}

/** One request on a fresh connection. Resolves with the response frame and every event frame before it. */
async function rpc(owner: TerminalOwner, op: string, payload: Record<string, unknown> = {}, bound = 5_000) {
	const done = Promise.withResolvers<{ response: Record<string, any>; events: Record<string, any>[] }>();
	const socket = net.createConnection(owner.endpoint);
	const events: Record<string, any>[] = [];
	// Bound real OS socket failure; named-pipe I/O cannot be driven by a fake clock.
	const timer = setTimeout(() => done.reject(new Error(`${op} exceeded bound`)), bound);
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("connect", () =>
		socket.write(
			`${JSON.stringify({ version: 1, id: "r", token: owner.token, sessionId: owner.sessionId, op, ...payload })}\n`,
		),
	);
	socket.on("data", chunk => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			if (frame.event) events.push(frame.event);
			else done.resolve({ response: frame, events });
		}
	});
	socket.on("error", done.reject);
	try {
		return await done.promise;
	} finally {
		clearTimeout(timer);
		socket.destroy();
	}
}

async function serve(deliver: (text: string) => Promise<string>) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-ack-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const close = await serveTerminalControl(
		{
			identity: () => ({ sessionId: "busy", cwd: root, sessionFile: path.join(root, "busy.jsonl") }),
			deliver,
			abort: async () => false,
			history: () => [],
			subscribe: () => () => {},
		},
		root,
	);
	cleanup.push(close);
	return readOwner(root);
}

test("an acked delivery is answered within 1 s while the terminal is stuck, then runs once, in order", async () => {
	const gate = Promise.withResolvers<void>();
	const delivered: string[] = [];
	const owner = await serve(async text => {
		await gate.promise;
		delivered.push(text);
		return "queued";
	});

	const started = performance.now();
	const first = await rpc(owner, "deliver", { text: "one", mode: "auto", ack: true, messageId: "m-1" });
	expect(performance.now() - started).toBeLessThan(1_000);
	expect(first.response).toMatchObject({ ok: true, result: { accepted: true, messageId: "m-1", state: "pending" } });
	expect(delivered).toEqual([]);

	// The pipe answers other requests while the delivery is stuck.
	expect((await rpc(owner, "deliveryStatus", { messageId: "m-1" })).response.result).toEqual({ state: "pending" });
	expect((await rpc(owner, "ping")).response.result.capabilities).toContain("deliver-ack");

	// A retry with the same id is answered at once and never enqueues the message again.
	const retry = await rpc(owner, "deliver", { text: "one", mode: "auto", ack: true, messageId: "m-1" });
	expect(retry.response.result).toMatchObject({ accepted: true, messageId: "m-1", state: "pending" });
	await rpc(owner, "deliver", { text: "two", mode: "auto", ack: true, messageId: "m-2" });

	gate.resolve();
	// The chain settles on microtasks once the gate opens; a few round trips are enough.
	let state = "pending";
	for (let attempt = 0; attempt < 50 && state !== "delivered"; attempt++) {
		state = (await rpc(owner, "deliveryStatus", { messageId: "m-2" })).response.result.state;
	}
	expect(state).toBe("delivered");
	expect(delivered).toEqual(["one", "two"]);
	expect((await rpc(owner, "deliveryStatus", { messageId: "m-1" })).response.result).toEqual({
		state: "delivered",
		outcome: "queued",
	});
	expect((await rpc(owner, "deliveryStatus", { messageId: "never-sent" })).response.result).toEqual({
		state: "unknown",
	});
});

test("the requesting socket hears the final outcome of an acked delivery, including a failure", async () => {
	const owner = await serve(async () => {
		throw new Error("Terminal is shutting down");
	});
	const done = Promise.withResolvers<Record<string, any>>();
	const socket = net.createConnection(owner.endpoint);
	cleanup.push(() => {
		socket.destroy();
	});
	// Bound real OS socket failure; named-pipe I/O cannot be driven by a fake clock.
	const timer = setTimeout(() => done.reject(new Error("no delivery event")), 5_000);
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("connect", () =>
		socket.write(
			`${JSON.stringify({ version: 1, id: "r", token: owner.token, sessionId: owner.sessionId, op: "deliver", text: "x", mode: "auto", ack: true, messageId: "m-f" })}\n`,
		),
	);
	socket.on("data", chunk => {
		buffer += chunk;
		for (const line of buffer.split("\n")) {
			if (!line) continue;
			const frame = JSON.parse(line);
			if (frame.event?.kind === "delivery") done.resolve(frame.event);
		}
	});
	const event = await done.promise.finally(() => clearTimeout(timer));
	expect(event).toMatchObject({ messageId: "m-f", state: "failed" });
	expect(event.error).toContain("shutting down");
});

test("a request without ack keeps the original reply, and a bad message id is refused", async () => {
	const owner = await serve(async () => "started");
	expect((await rpc(owner, "deliver", { text: "legacy", mode: "auto" })).response).toMatchObject({
		ok: true,
		result: "started",
	});
	expect((await rpc(owner, "deliver", { text: "x", mode: "auto", ack: true })).response.ok).toBe(false);
	expect((await rpc(owner, "deliver", { text: "x", mode: "auto", ack: true, messageId: "" })).response.ok).toBe(
		false,
	);
});

test("history converts only new entries on a leaf change, and the frame stays bounded", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-history-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const BASE = 20_000;
	const journal: Array<{ id: string; type: string; message: { role: string; content: unknown[] } }> = [];
	let issued = 0;
	const add = (n: number) => {
		for (let i = 0; i < n; i++) {
			const id = `e${issued++}`;
			journal.push({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text: id }] } });
		}
	};
	add(BASE);
	let conversions = 0;
	const mockMode = {
		sessionManager: {
			getSessionId: () => "big",
			getLeafId: () => journal.at(-1)?.id ?? null,
			getCwd: () => root,
			getSessionFile: () => path.join(root, "big.jsonl"),
			getEntries: () => journal.slice(),
		},
		session: {
			isStreaming: false,
			displayAssistantContent: (content: unknown[]) => {
				conversions++;
				return content;
			},
		},
		isShuttingDown: false,
		isInitialized: true,
	};
	spyOn(utils, "getConfigRootDir").mockReturnValue(root);
	cleanup.push(await startTerminalControl(mockMode as never));
	const owner = await readOwner(root);

	const first = await rpc(owner, "subscribe");
	expect(conversions).toBe(BASE);
	const frame = first.events.find(event => event.kind === "history")!;
	expect(frame.entries).toHaveLength(1_000);
	expect(frame.entries.at(-1).entryId).toBe(`e${BASE - 1}`);

	for (let step = 0; step < 50; step++) {
		add(1);
		const next = await rpc(owner, "subscribe");
		expect(next.events.find(event => event.kind === "history")!.entries.at(-1).entryId).toBe(`e${BASE + step}`);
	}
	// Old code converted every assistant entry on each of the 51 leaf changes: 1,020,000 calls.
	expect(conversions).toBe(BASE + 50);

	// A journal rewritten under the cursor is converted again in full, once.
	journal.splice(0, 10);
	add(1);
	const rebuilt = await rpc(owner, "subscribe");
	expect(rebuilt.events.find(event => event.kind === "history")!.entries.at(-1).entryId).toBe(`e${BASE + 50}`);
	expect(conversions).toBe(BASE + 50 + journal.length);
});
