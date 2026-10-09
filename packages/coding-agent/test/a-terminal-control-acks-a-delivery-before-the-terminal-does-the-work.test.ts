// WHY: Telegram messages reached a large busy session minutes late and the daemon reported them as
// failed (Wladefant/veyyon#505). The terminal must acknowledge a delivery at once, before the work
// that can block, and must never convert the whole journal again for a new leaf.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@veyyon/utils";
import { serveTerminalControl, TerminalNotReadyError, type TerminalOwner } from "../src/launch/terminal-control";
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

/** A connection that keeps its frames, for tests that need several requests on one socket. */
function connect(owner: TerminalOwner) {
	const socket = net.createConnection(owner.endpoint);
	cleanup.push(() => {
		socket.destroy();
	});
	const frames: Record<string, any>[] = [];
	const waiters: Array<{ match: (frame: Record<string, any>) => boolean; done: (frame: Record<string, any>) => void }> = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			frames.push(frame);
			for (const waiter of waiters.splice(0)) {
				if (waiter.match(frame)) waiter.done(frame);
				else waiters.push(waiter);
			}
		}
	});
	return {
		send(request: Record<string, unknown>) {
			socket.write(`${JSON.stringify({ version: 1, token: owner.token, sessionId: owner.sessionId, ...request })}\n`);
		},
		/** Resolves with the first frame, seen or future, that matches. Bounded against a dead socket. */
		next(match: (frame: Record<string, any>) => boolean): Promise<Record<string, any>> {
			const seen = frames.find(match);
			if (seen) return Promise.resolve(seen);
			const { promise, resolve, reject } = Promise.withResolvers<Record<string, any>>();
			const timer = setTimeout(() => reject(new Error("no matching frame")), 5_000);
			waiters.push({
				match,
				done: frame => {
					clearTimeout(timer);
					resolve(frame);
				},
			});
			return promise;
		},
		frames,
	};
}

async function serve(deliver: (text: string) => Promise<string>, sessionId: () => string = () => "busy") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-ack-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const close = await serveTerminalControl(
		{
			identity: () => ({ sessionId: sessionId(), cwd: root, sessionFile: path.join(root, "busy.jsonl") }),
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

const settle = async () => {
	for (let i = 0; i < 50; i++) await Promise.resolve();
};

test("an acked message is never delivered to a session that replaced the one it was accepted for", async () => {
	const gate = Promise.withResolvers<void>();
	let current = "busy";
	const delivered: string[] = [];
	const owner = await serve(
		async text => {
			if (text === "one") await gate.promise;
			delivered.push(text);
			return "started";
		},
		() => current,
	);
	const client = connect(owner);
	client.send({ id: "a", op: "deliver", text: "one", mode: "auto", ack: true, messageId: "m-1" });
	client.send({ id: "b", op: "deliver", text: "two", mode: "auto", ack: true, messageId: "m-2" });
	await client.next(frame => frame.id === "b");
	// /new: the terminal now holds another session. "one" is already running; "two" must not follow it.
	current = "other";
	gate.resolve();
	await settle();
	expect(delivered).toEqual(["one"]);
});

test("a not-ready terminal is retried on the chain, so the second message still arrives", async () => {
	let attempts = 0;
	const owner = await serve(async () => {
		attempts++;
		if (attempts < 3) throw new TerminalNotReadyError("Terminal is not ready for input; delivery not accepted");
		return "started";
	});
	const client = connect(owner);
	client.send({ id: "a", op: "deliver", text: "x", mode: "auto", ack: true, messageId: "m-r" });
	expect(await client.next(frame => frame.event?.kind === "delivery")).toMatchObject({
		event: { messageId: "m-r", state: "delivered", outcome: "started" },
	});
	expect(attempts).toBe(3);
});

test("a plain deliver shares the ordered chain, and an acked one never waits behind it", async () => {
	const gate = Promise.withResolvers<void>();
	const delivered: string[] = [];
	const owner = await serve(async text => {
		if (text === "one") await gate.promise;
		delivered.push(text);
		return "started";
	});
	const client = connect(owner);
	client.send({ id: "a", op: "deliver", text: "one", mode: "auto", ack: true, messageId: "m-1" });
	await client.next(frame => frame.id === "a");
	client.send({ id: "plain", op: "deliver", text: "legacy", mode: "auto" });
	// The plain deliver is stuck behind "one". An acked deliver on the same socket is still answered at once.
	client.send({ id: "b", op: "deliver", text: "two", mode: "auto", ack: true, messageId: "m-2" });
	expect(await client.next(frame => frame.id === "b")).toMatchObject({ ok: true, result: { state: "pending" } });
	expect(client.frames.some(frame => frame.id === "plain")).toBe(false);
	gate.resolve();
	expect(await client.next(frame => frame.id === "plain")).toMatchObject({ ok: true, result: "started" });
	await client.next(frame => frame.event?.messageId === "m-2" && frame.event?.state === "delivered");
	// Both later messages ran on the same chain, after "one" and one at a time.
	expect(delivered[0]).toBe("one");
	expect([...delivered].sort()).toEqual(["legacy", "one", "two"]);
});

test("the terminal refuses a delivery with busy when too many are pending", async () => {
	const gate = Promise.withResolvers<void>();
	const owner = await serve(async () => {
		await gate.promise;
		return "queued";
	});
	const client = connect(owner);
	for (let i = 0; i < 64; i++) {
		client.send({ id: `a${i}`, op: "deliver", text: "x", mode: "auto", ack: true, messageId: `m-${i}` });
	}
	await client.next(frame => frame.id === "a63");
	expect(client.frames.every(frame => frame.ok === true)).toBe(true);
	client.send({ id: "over", op: "deliver", text: "x", mode: "auto", ack: true, messageId: "m-over" });
	const refused = await client.next(frame => frame.id === "over");
	expect(refused.ok).toBe(false);
	expect(refused.error).toContain("busy");
	// The refused id is not remembered as pending.
	client.send({ id: "st", op: "deliveryStatus", messageId: "m-over" });
	expect((await client.next(frame => frame.id === "st")).result).toEqual({ state: "unknown" });
	gate.resolve();
	await client.next(frame => frame.event?.messageId === "m-63" && frame.event?.state === "delivered");
});

test("the ack is written before a delivery that blocks the event loop starts", async () => {
	const owner = await serve(async () => {
		const until = performance.now() + 200;
		while (performance.now() < until) {
			// Synchronous block, like the session-file rewrite on a large session.
		}
		return "started";
	});
	const client = connect(owner);
	client.send({ id: "a", op: "deliver", text: "x", mode: "auto", ack: true, messageId: "m-s" });
	const ack = await client.next(frame => frame.id === "a");
	expect(ack.result).toMatchObject({ accepted: true, state: "pending" });
	// The ack frame precedes the delivery outcome on the wire.
	await client.next(frame => frame.event?.messageId === "m-s" && frame.event?.state === "delivered");
	expect(client.frames.findIndex(frame => frame.id === "a")).toBeLessThan(
		client.frames.findIndex(frame => frame.event?.kind === "delivery"),
	);
});
