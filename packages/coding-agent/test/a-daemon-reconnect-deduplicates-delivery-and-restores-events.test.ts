// WHY: When the Telegram daemon crashes or restarts while a Veyyon session is live,
// the daemon reconnects over IPC and may re-deliver in-flight messages or re-subscribe.
// The live session must deduplicate deliveries on messageId without re-running the turn,
// retain accepted delivery outcomes across reconnects, and restore delivery events on re-subscription.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { serveTerminalControl, type TerminalOwner } from "../src/launch/terminal-control";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function readOwner(root: string): Promise<TerminalOwner> {
	const directory = path.join(root, "run", "terminals");
	const file = (await fs.readdir(directory)).find(name => name.endsWith(".json"))!;
	return JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
}

interface ControlFrame {
	id?: string;
	ok?: boolean;
	result?: unknown;
	error?: string;
	event?: {
		kind?: string;
		sessionId?: string;
		messageId?: string;
		state?: string;
		outcome?: string;
		error?: string;
		entries?: Array<{ entryId: string; text: string }>;
	};
}

function connect(owner: TerminalOwner) {
	const socket = net.createConnection(owner.endpoint);
	cleanup.push(() => {
		socket.destroy();
	});
	const frames: ControlFrame[] = [];
	const waiters: Array<{ match: (frame: ControlFrame) => boolean; done: (frame: ControlFrame) => void }> = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const frame = JSON.parse(line);
			let matchedWaiter = false;
			for (const waiter of waiters.splice(0)) {
				if (!matchedWaiter && waiter.match(frame)) {
					matchedWaiter = true;
					waiter.done(frame);
				} else {
					waiters.push(waiter);
				}
			}
			if (!matchedWaiter) {
				frames.push(frame);
			}
		}
	});
	return {
		socket,
		send(request: Record<string, unknown>) {
			socket.write(`${JSON.stringify({ version: 1, token: owner.token, sessionId: owner.sessionId, ...request })}\n`);
		},
		next(match: (frame: ControlFrame) => boolean): Promise<ControlFrame> {
			const index = frames.findIndex(match);
			if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
			const { promise, resolve } = Promise.withResolvers<ControlFrame>();
			waiters.push({
				match,
				done: resolve,
			});
			return promise;
		},
		close() {
			socket.destroy();
		},
		frames,
	};
}

async function serve(
	deliver: (text: string, mode: "auto" | "steer" | "followUp") => Promise<string>,
	sessionId = "sess-live",
	getHistory?: () => { entryId: string; text: string }[],
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-reconnect-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const close = await serveTerminalControl(
		{
			identity: () => ({ sessionId, cwd: root, sessionFile: path.join(root, `${sessionId}.jsonl`) }),
			deliver,
			abort: async () => false,
			history: getHistory ?? (() => [{ entryId: "e-0", text: "initial entry" }]),
			subscribe: () => () => {},
		},
		root,
	);
	cleanup.push(close);
	return readOwner(root);
}

test("a reconnected daemon delivering the same messageId is deduplicated and receives settled outcome", async () => {
	const deliveredCalls: Array<{ text: string; mode: string }> = [];
	const owner = await serve(async (text, mode) => {
		deliveredCalls.push({ text, mode });
		return "steered";
	});

	// Socket 1: daemon connection before crash/restart
	const client1 = connect(owner);
	client1.send({ id: "sub-1", op: "subscribe" });
	const sub1Ack = await client1.next(frame => frame.id === "sub-1");
	expect(sub1Ack.ok).toBe(true);

	// Client 1 sends deliver with durable messageId
	client1.send({
		id: "deliv-1",
		op: "deliver",
		text: "turn payload",
		mode: "auto",
		ack: true,
		messageId: "durable-msg-1",
	});
	const ack1 = await client1.next(frame => frame.id === "deliv-1");
	expect(ack1.result).toMatchObject({ accepted: true, messageId: "durable-msg-1", state: "pending" });

	// Simulate daemon disconnect/crash while message settles
	client1.close();

	// Wait briefly for delivery on chain to settle
	for (let i = 0; i < 50; i++) await Promise.resolve();

	// Socket 2: daemon reconnects after restart
	const client2 = connect(owner);

	// Re-subscription must restore delivery events for settled deliveries and transcript history
	client2.send({ id: "sub-2", op: "subscribe" });
	const sub2Ack = await client2.next(frame => frame.id === "sub-2");
	expect(sub2Ack.ok).toBe(true);

	// Subscribed socket should receive the settled delivery event frame
	const restoredDeliveryEvent = await client2.next(
		frame => frame.event?.kind === "delivery" && frame.event?.messageId === "durable-msg-1",
	);
	expect(restoredDeliveryEvent.event).toMatchObject({
		kind: "delivery",
		messageId: "durable-msg-1",
		state: "delivered",
		outcome: "steered",
	});

	// Daemon retries the same durable messageId across recovery
	client2.send({
		id: "deliv-2",
		op: "deliver",
		text: "turn payload",
		mode: "auto",
		ack: true,
		messageId: "durable-msg-1",
	});
	const ack2 = await client2.next(frame => frame.id === "deliv-2");
	expect(ack2.result).toMatchObject({
		accepted: true,
		messageId: "durable-msg-1",
		state: "delivered",
		outcome: "steered",
	});

	// The turn was delivered to the terminal session exactly once
	expect(deliveredCalls).toEqual([{ text: "turn payload", mode: "auto" }]);
});

test("a delivery pending during disconnect announces to the reconnected subscriber when settled", async () => {
	const gate = Promise.withResolvers<void>();
	const deliveredCalls: Array<{ text: string; mode: string }> = [];
	const owner = await serve(async (text, mode) => {
		await gate.promise;
		deliveredCalls.push({ text, mode });
		return "started";
	});

	// Socket 1 sends deliver with gate pending
	const client1 = connect(owner);
	client1.send({
		id: "deliv-p",
		op: "deliver",
		text: "slow payload",
		mode: "auto",
		ack: true,
		messageId: "pending-msg-1",
	});
	const ack1 = await client1.next(frame => frame.id === "deliv-p");
	expect(ack1.result).toMatchObject({ accepted: true, messageId: "pending-msg-1", state: "pending" });

	// Daemon crashes/disconnects while delivery is still pending
	client1.close();

	// Socket 2: daemon reconnects and re-subscribes while still pending
	const client2 = connect(owner);
	client2.send({ id: "sub-p", op: "subscribe" });
	await client2.next(frame => frame.id === "sub-p");

	// Release the terminal delivery gate
	gate.resolve();

	// Reconnected subscriber must receive the delivery completion event
	const event = await client2.next(
		frame => frame.event?.kind === "delivery" && frame.event?.messageId === "pending-msg-1",
	);
	expect(event.event).toMatchObject({
		kind: "delivery",
		messageId: "pending-msg-1",
		state: "delivered",
		outcome: "started",
	});

	expect(deliveredCalls).toEqual([{ text: "slow payload", mode: "auto" }]);
});

test("a reconnected subscriber with a cursor receives only missed history entries", async () => {
	const historyEntries = [
		{ entryId: "e-0", text: "turn 0" },
		{ entryId: "e-1", text: "turn 1" },
		{ entryId: "e-2", text: "turn 2" },
	];
	const owner = await serve(async () => "steered", "sess-cursor", () => historyEntries);

	// Client 1 connects and subscribes with cursor "e-0": receives only entries after e-0
	const client1 = connect(owner);
	client1.send({ id: "sub-c1", op: "subscribe", cursor: "e-0" });
	const ack1 = await client1.next(frame => frame.id === "sub-c1");
	expect(ack1.ok).toBe(true);

	const hist1 = await client1.next(frame => frame.event?.kind === "history");
	expect(hist1.event?.entries?.map(e => e.entryId)).toEqual(["e-1", "e-2"]);
	client1.close();

	// Client 2 connects with cursor pointing to the latest entry: receives empty entries array
	const client2 = connect(owner);
	client2.send({ id: "sub-c2", op: "subscribe", cursor: "e-2" });
	await client2.next(frame => frame.id === "sub-c2");
	const hist2 = await client2.next(frame => frame.event?.kind === "history");
	expect(hist2.event?.entries).toEqual([]);
	client2.close();

	// Client 3 connects with unknown cursor: falls back to bounded history
	const client3 = connect(owner);
	client3.send({ id: "sub-c3", op: "subscribe", cursor: "unknown-cursor" });
	await client3.next(frame => frame.id === "sub-c3");
	const hist3 = await client3.next(frame => frame.event?.kind === "history");
	expect(hist3.event?.entries?.map(e => e.entryId)).toEqual(["e-0", "e-1", "e-2"]);
	client3.close();
});

test("concurrent or repeated deliveries with the same messageId share a single terminal turn", async () => {
	const deliveredCalls: Array<{ text: string; mode: string }> = [];
	const gate = Promise.withResolvers<void>();
	const owner = await serve(async (text, mode) => {
		await gate.promise;
		deliveredCalls.push({ text, mode });
		return "done";
	});

	const client1 = connect(owner);
	const client2 = connect(owner);

	// Client 1 sends deliver with messageId
	client1.send({
		id: "call-1",
		op: "deliver",
		text: "shared turn",
		mode: "auto",
		messageId: "shared-msg-1",
	});

	// Client 2 sends deliver with same messageId concurrently
	client2.send({
		id: "call-2",
		op: "deliver",
		text: "shared turn",
		mode: "auto",
		messageId: "shared-msg-1",
	});

	// Wait briefly for both to register and gate on delivery
	for (let i = 0; i < 50; i++) await Promise.resolve();

	// Release gate
	gate.resolve();

	const res1 = await client1.next(frame => frame.id === "call-1");
	const res2 = await client2.next(frame => frame.id === "call-2");

	expect(res1.ok).toBe(true);
	expect(res1.result).toBe("done");
	expect(res2.ok).toBe(true);
	expect(res2.result).toBe("done");

	// Delivered to terminal exactly once
	expect(deliveredCalls).toEqual([{ text: "shared turn", mode: "auto" }]);
});

test("a delivery failure is retained and replayed to retrying deliveries with the same messageId", async () => {
	let attempts = 0;
	const owner = await serve(async () => {
		attempts++;
		throw new Error("Terminal delivery crashed");
	});

	const client1 = connect(owner);
	client1.send({
		id: "fail-1",
		op: "deliver",
		text: "failing payload",
		mode: "auto",
		ack: true,
		messageId: "failing-msg-1",
	});
	const ack1 = await client1.next(frame => frame.id === "fail-1");
	expect(ack1.result).toMatchObject({ accepted: true, messageId: "failing-msg-1", state: "pending" });

	// Wait for delivery to fail and settle
	for (let i = 0; i < 50; i++) await Promise.resolve();

	// Client 2 reconnects and queries status or retries delivery
	const client2 = connect(owner);
	client2.send({
		id: "fail-2",
		op: "deliver",
		text: "failing payload",
		mode: "auto",
		ack: true,
		messageId: "failing-msg-1",
	});
	const ack2 = await client2.next(frame => frame.id === "fail-2");
	const result = ack2.result as { accepted: boolean; messageId: string; state: string; error?: string };
	expect(result).toMatchObject({
		accepted: true,
		messageId: "failing-msg-1",
		state: "failed",
	});
	expect(result.error).toContain("Terminal delivery crashed");

	// Delivery was attempted once
	expect(attempts).toBe(1);
});
