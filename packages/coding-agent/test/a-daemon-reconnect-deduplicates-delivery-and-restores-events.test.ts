// WHY: When the Telegram daemon crashes or restarts while a Veyyon session is live,
// the daemon reconnects over IPC and may re-deliver in-flight messages or re-subscribe.
// The live session must deduplicate deliveries on messageId without re-running the turn,
// retain accepted delivery outcomes across reconnects, and restore delivery events on re-subscription.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { serveTerminalControl, TerminalNotReadyError, type TerminalOwner } from "../src/launch/terminal-control";
import { TerminalReceipts } from "../src/launch/terminal-receipts";

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
	identityRef?: { sessionId: string },
	subscribe?: (listener: (event: unknown) => void) => () => void,
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-reconnect-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const identity = identityRef ?? { sessionId };
	const close = await serveTerminalControl(
		{
			identity: () => ({ sessionId: identity.sessionId, cwd: root, sessionFile: path.join(root, `${identity.sessionId}.jsonl`) }),
			deliver,
			abort: async () => false,
			history: getHistory ?? (() => [{ entryId: "e-0", text: "initial entry" }]),
			subscribe: subscribe ?? (() => () => {}),
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

	// Client 3 cannot safely resume from a cursor that is no longer in history.
	const client3 = connect(owner);
	client3.send({ id: "sub-c3", op: "subscribe", cursor: "unknown-cursor" });
	const response3 = await client3.next(frame => frame.id === "sub-c3");
	expect(response3.ok).toBe(false);
	expect(response3.error).toContain("Unknown history cursor");
	client3.close();
});

test("cursor replay sends every missed entry in bounded history frames", async () => {
	const historyEntries = Array.from({ length: 1201 }, (_, index) => ({ entryId: `e-${index}`, text: `turn ${index}` }));
	const owner = await serve(async () => "ok", "sess-large-history", () => historyEntries);
	const client = connect(owner);
	client.send({ id: "sub-large", op: "subscribe", cursor: "e-0" });
	await client.next(frame => frame.id === "sub-large");
	const replayed: Array<{ entryId: string; text: string }> = [];
	for (let index = 0; index < 12; index++) {
		const frame = await client.next(frame => frame.event?.kind === "history");
		const entries = frame.event?.entries ?? [];
		expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(1024 * 1024);
		expect(entries.length).toBeLessThanOrEqual(100);
		replayed.push(...entries);
	}
	expect(replayed).toHaveLength(1200);
	expect(replayed[0]?.entryId).toBe("e-1");
	expect(replayed.at(-1)?.entryId).toBe("e-1200");
});
test("a busy rejection does not retain the message id after the delivery queue drains", async () => {
	const gate = Promise.withResolvers<void>();
	const { promise: callsReached, resolve: resolveCallsReached } = Promise.withResolvers<void>();
	let calls = 0;
	const owner = await serve(async () => {
		calls++;
		if (calls === 64) resolveCallsReached();
		await gate.promise;
		return "done";
	});
	const client = connect(owner);
	for (let index = 0; index < 64; index++) {
		client.send({ id: `fill-${index}`, op: "deliver", text: "queued", mode: "auto", ack: true, messageId: `fill-${index}` });
		await client.next(frame => frame.id === `fill-${index}`);
	}
	client.send({ id: "busy-first", op: "deliver", text: "retry me", mode: "auto", ack: true, messageId: "busy-retry" });
	const rejected = await client.next(frame => frame.id === "busy-first");
	expect(rejected.ok).toBe(false);
	expect(rejected.error).toContain("Terminal busy");
	gate.resolve();
	await callsReached;
	for (let index = 0; index < 64; index++) await client.next(frame => frame.event?.kind === "delivery");
	client.send({ id: "busy-retry-again", op: "deliver", text: "retry me", mode: "auto", ack: true, messageId: "busy-retry" });
	const accepted = await client.next(frame => frame.id === "busy-retry-again");
	expect(accepted.result).toMatchObject({ accepted: true, messageId: "busy-retry", state: "pending" });
});

test("a busy rejection of a plain delivery leaves its message id retryable", async () => {
	const gate = Promise.withResolvers<void>();
	const delivered: string[] = [];
	const owner = await serve(async text => {
		delivered.push(text);
		if (text === "queued") await gate.promise;
		return "done";
	});
	const client = connect(owner);
	for (let index = 0; index < 64; index++) {
		client.send({ id: `fill-${index}`, op: "deliver", text: "queued", mode: "auto", ack: true, messageId: `fill-${index}` });
		await client.next(frame => frame.id === `fill-${index}`);
	}
	client.send({ id: "plain-busy", op: "deliver", text: "plain retry", mode: "auto", messageId: "plain-retry" });
	const rejected = await client.next(frame => frame.id === "plain-busy");
	expect(rejected.ok).toBe(false);
	expect(rejected.error).toContain("Terminal busy");
	gate.resolve();
	for (let index = 0; index < 64; index++) await client.next(frame => frame.event?.kind === "delivery");
	client.send({ id: "plain-again", op: "deliver", text: "plain retry", mode: "auto", messageId: "plain-retry" });
	const retried = await client.next(frame => frame.id === "plain-again");
	expect(retried).toMatchObject({ ok: true, result: "done" });
	expect(delivered.filter(text => text === "plain retry")).toHaveLength(1);
});


test("message ids and delivery announcements stay within their accepting session", async () => {
	const identity = { sessionId: "sess-before-switch" };
	const gate = Promise.withResolvers<void>();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-reconnect-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const close = await serveTerminalControl({
		identity: () => ({ sessionId: identity.sessionId, cwd: root, sessionFile: path.join(root, `${identity.sessionId}.jsonl`) }),
		deliver: async text => { await gate.promise; return text; },
		abort: async () => false,
		history: () => [],
		subscribe: () => () => {},
	}, root);
	cleanup.push(close);
	const owner = await readOwner(root);
	const oldClient = connect(owner);
	oldClient.send({ id: "old-ack", op: "deliver", text: "old-session", mode: "auto", ack: true, messageId: "same-id" });
	await oldClient.next(frame => frame.id === "old-ack");
	const oldClosed = Promise.withResolvers<void>();
	oldClient.socket.once("close", oldClosed.resolve);
	identity.sessionId = "sess-after-switch";
	await oldClosed.promise;
	let updatedOwner: TerminalOwner;
	do {
		updatedOwner = await readOwner(root);
	} while (updatedOwner.sessionId !== "sess-after-switch");
	const newClient = connect(updatedOwner);
	newClient.send({ id: "new-sub", op: "subscribe" });
	const subscribed = await newClient.next(frame => frame.id === "new-sub");
	expect(subscribed.ok).toBe(true);
	newClient.send({ id: "new-ack", op: "deliver", text: "new-session", mode: "auto", ack: true, messageId: "same-id" });
	const accepted = await newClient.next(frame => frame.id === "new-ack");
	expect(accepted.result).toMatchObject({ accepted: true, messageId: "same-id", state: "pending" });
	gate.resolve();
	const newOutcome = await newClient.next(frame => frame.event?.kind === "delivery" && frame.event?.messageId === "same-id");
	expect(newOutcome.event).toMatchObject({ sessionId: "sess-after-switch", state: "delivered", outcome: "new-session" });
});

test("an exhausted terminal-not-ready delivery can retry with the same message id", async () => {
	let attempts = 0;
	const owner = await serve(async () => {
		if (++attempts <= 21) throw new TerminalNotReadyError("terminal is not ready");
		return "delivered";
	});
	const client = connect(owner);
	client.send({ id: "not-ready-first", op: "deliver", text: "retry me", mode: "auto", messageId: "not-ready-retry" });
	const rejected = await client.next(frame => frame.id === "not-ready-first");
	expect(rejected.error).toContain("terminal is not ready");
	client.send({ id: "not-ready-retry", op: "deliver", text: "retry me", mode: "auto", messageId: "not-ready-retry" });
	const retried = await client.next(frame => frame.id === "not-ready-retry");
	expect(retried.ok).toBe(true);
	expect(retried.result).toBe("delivered");
	expect(attempts).toBe(22);
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

test("a second subscriber connecting while streaming receives the active streaming state", async () => {
	const owner = await serve(
		async () => "delivered",
		"sess-streaming",
		undefined,
		undefined,
		listener => {
			listener({ kind: "streaming", sessionId: "sess-streaming", active: true });
			return () => {};
		},
	);

	// First subscriber connects and receives streaming state
	const client1 = connect(owner);
	client1.send({ id: "sub-1", op: "subscribe" });
	const streamEvent1 = await client1.next(frame => frame.event?.kind === "streaming");
	expect(streamEvent1.event).toMatchObject({
		kind: "streaming",
		sessionId: "sess-streaming",
		active: true,
	});

	// Second subscriber connects while subscriber 1 is still connected
	const client2 = connect(owner);
	client2.send({ id: "sub-2", op: "subscribe" });
	const streamEvent2 = await client2.next(frame => frame.event?.kind === "streaming");
	expect(streamEvent2.event).toMatchObject({
		kind: "streaming",
		sessionId: "sess-streaming",
		active: true,
	});
});

test("an acked delivery exhausted by not-ready announces failure to watchers before removing deduplication key", async () => {
	let attempts = 0;
	const owner = await serve(async () => {
		if (++attempts <= 21) throw new TerminalNotReadyError("terminal is not ready");
		return "delivered";
	});

	const client = connect(owner);
	client.send({
		id: "deliv-ack-1",
		op: "deliver",
		text: "exhaust me",
		mode: "auto",
		ack: true,
		messageId: "ack-not-ready",
	});
	const ack = await client.next(frame => frame.id === "deliv-ack-1");
	expect(ack.result).toMatchObject({ accepted: true, messageId: "ack-not-ready", state: "pending" });

	// Watcher socket receives the failure event when retries are exhausted
	const failedEvent = await client.next(
		frame => frame.event?.kind === "delivery" && frame.event?.messageId === "ack-not-ready",
	);
	expect(failedEvent.event).toMatchObject({
		kind: "delivery",
		messageId: "ack-not-ready",
		state: "failed",
	});
	expect(failedEvent.event?.error).toContain("terminal is not ready");

	// Deduplication key was deleted so a retry with the same messageId can succeed when terminal is ready
	client.send({
		id: "deliv-ack-2",
		op: "deliver",
		text: "exhaust me",
		mode: "auto",
		ack: true,
		messageId: "ack-not-ready",
	});
	const retryAck = await client.next(frame => frame.id === "deliv-ack-2");
	expect(retryAck.result).toMatchObject({ accepted: true, messageId: "ack-not-ready", state: "pending" });

	const deliveredEvent = await client.next(
		frame => frame.event?.kind === "delivery" && frame.event?.messageId === "ack-not-ready",
	);
	expect(deliveredEvent.event).toMatchObject({
		kind: "delivery",
		messageId: "ack-not-ready",
		state: "delivered",
		outcome: "delivered",
	});
	expect(attempts).toBe(22);
});

// WHY: a subscribe that fails must leave nothing behind. Before this, the socket joined the live feed
// before an oversize history entry made the request fail, so a client that saw `ok:false` still streamed.
// CLASS: any failure inside subscribe. GAP: it does not cover a socket that dies mid-replay.
test("a subscribe refused for an oversize history entry leaves the socket out of the live feed", async () => {
	let listener: ((event: unknown) => void) | undefined;
	const owner = await serve(
		async () => "ok",
		"sess-oversize",
		() => [{ entryId: "e-huge", text: "x".repeat(600 * 1024) }],
		undefined,
		next => {
			listener = next;
			return () => {};
		},
	);
	const client = connect(owner);
	client.send({ id: "sub-huge", op: "subscribe" });
	const refused = await client.next(frame => frame.id === "sub-huge");
	expect(refused.ok).toBe(false);
	listener?.({ kind: "streaming", sessionId: "sess-oversize", active: true });
	client.send({ id: "after-huge", op: "ping" });
	await client.next(frame => frame.id === "after-huge");
	expect(client.frames.filter(frame => frame.event)).toEqual([]);
});

// WHY: a second subscriber takes its own history snapshot while the shared journal timer still holds
// the entry as new, so the same entry reached it twice (snapshot, then `appended`).
// CLASS: one entry reaching one subscriber twice, whichever path delivers first. GAP: the timer itself
// lives in the mode and is not driven here; the test emits the event it would emit.
test("a subscriber that already holds a history entry never receives it again as an appended event", async () => {
	const history = [{ entryId: "e-0", text: "first" }];
	let listener: ((event: unknown) => void) | undefined;
	const owner = await serve(
		async () => "ok",
		"sess-dup",
		() => [...history],
		undefined,
		next => {
			listener = next;
			return () => {};
		},
	);
	const first = connect(owner);
	first.send({ id: "sub-a", op: "subscribe" });
	await first.next(frame => frame.id === "sub-a");
	history.push({ entryId: "e-1", text: "second" });
	const second = connect(owner);
	second.send({ id: "sub-b", op: "subscribe" });
	const snapshot = await second.next(frame => frame.event?.kind === "history");
	expect(snapshot.event?.entries?.map(entry => entry.entryId)).toEqual(["e-0", "e-1"]);
	await second.next(frame => frame.id === "sub-b");
	listener?.({ kind: "appended", sessionId: "sess-dup", entries: [{ entryId: "e-1", text: "second" }] });
	const appendedForFirst = await first.next(frame => frame.event?.kind === "appended");
	expect(appendedForFirst.event?.entries?.map(entry => entry.entryId)).toEqual(["e-1"]);
	second.send({ id: "ping-b", op: "ping" });
	await second.next(frame => frame.id === "ping-b");
	expect(second.frames.filter(frame => frame.event?.kind === "appended")).toEqual([]);
});

// WHY: a subscribed socket already receives a settled delivery by replay or announcement, so an ack
// retry on it sent the delivery frame a second time.
test("a retried acked delivery on a subscribed socket announces its settled outcome once", async () => {
	const owner = await serve(async () => "done", "sess-retry");
	const client = connect(owner);
	client.send({ id: "sub", op: "subscribe" });
	await client.next(frame => frame.id === "sub");
	client.send({ id: "ack-1", op: "deliver", text: "once", mode: "auto", ack: true, messageId: "m-once" });
	await client.next(frame => frame.id === "ack-1");
	await client.next(frame => frame.event?.kind === "delivery" && frame.event.messageId === "m-once");
	client.send({ id: "ack-2", op: "deliver", text: "once", mode: "auto", ack: true, messageId: "m-once" });
	const retried = await client.next(frame => frame.id === "ack-2");
	expect(retried.result).toMatchObject({ accepted: true, messageId: "m-once", state: "delivered", outcome: "done" });
	client.send({ id: "ping", op: "ping" });
	await client.next(frame => frame.id === "ping");
	expect(client.frames.filter(frame => frame.event?.kind === "delivery")).toEqual([]);
});

// WHY: A delivery can settle after a socket accepts an ack but while that same socket replays more than
// one MiB of history. The announcement and replay must share one receipt. GAP: this does not test a slow
// operating-system pipe; it holds replay open across many real-server history frames.
test("a delivery settling during large history replay reaches its acking subscriber once", async () => {
	const gate = Promise.withResolvers<void>();
	const history = Array.from({ length: 1201 }, (_, index) => ({
		entryId: `e-${index}`,
		text: `turn ${index} ${"x".repeat(1024)}`,
	}));
	const owner = await serve(async () => {
		await gate.promise;
		return "during-replay";
	}, "sess-replay-race", () => history);
	const client = connect(owner);
	client.send({ id: "ack-race", op: "deliver", text: "race", mode: "auto", ack: true, messageId: "m-race" });
	expect((await client.next(frame => frame.id === "ack-race")).result).toMatchObject({
		accepted: true,
		messageId: "m-race",
		state: "pending",
	});

	client.send({ id: "sub-race", op: "subscribe", cursor: "e-0" });
	let historyFrames = 0;
	for (let index = 0; index < 12; index++) {
		await client.next(frame => {
			if (frame.event?.kind !== "history") return false;
			historyFrames++;
			return true;
		});
		if (index === 0) gate.resolve();
	}
	await client.next(frame => frame.id === "sub-race");
	await client.next(frame => frame.event?.kind === "delivery" && frame.event.messageId === "m-race");
	client.send({ id: "ping-race", op: "ping" });
	await client.next(frame => frame.id === "ping-race");

	expect(historyFrames).toBe(12);
	expect(client.frames.filter(frame => frame.event?.kind === "delivery" && frame.event.messageId === "m-race")).toHaveLength(0);
});

// WHY: A settled ack is announced to its socket before that socket subscribes, then subscribe replay
// sends the same record again. A receipt ledger must suppress that duplicate across both send paths.
// GAP: the settling-during-replay case above covers a pending record's announcement/replay boundary.
test("a settled ack followed by subscribe on the same socket has one delivery frame", async () => {
	const owner = await serve(async () => "settled");
	const client = connect(owner);
	client.send({ id: "ack-before-sub", op: "deliver", text: "once", mode: "auto", ack: true, messageId: "m-settled" });
	await client.next(frame => frame.id === "ack-before-sub");
	await client.next(frame => frame.event?.kind === "delivery" && frame.event.messageId === "m-settled");

	client.send({ id: "subscribe-after-ack", op: "subscribe" });
	await client.next(frame => frame.id === "subscribe-after-ack");
	await client.next(frame => frame.event?.kind === "history");
	client.send({ id: "ping-after-sub", op: "ping" });
	await client.next(frame => frame.id === "ping-after-sub");

	expect(client.frames.filter(frame => frame.event?.kind === "delivery" && frame.event.messageId === "m-settled")).toHaveLength(0);
});

// WHY: A long-lived terminal session may stream thousands of history entries over time.
// The subscriber's receipt ledger must cap its history memory to 1000 entries and evict older entries.
// GAP: entries are pushed in batches over a real Unix/Windows socket, not synthesized in-process.
test("a long-lived subscriber bounds history receipt memory when more than 1000 entries are appended", async () => {
	let emitAppended: ((event: unknown) => void) | undefined;
	const history: Array<{ entryId: string; text: string }> = [
		{ entryId: "e-0", text: "initial entry" },
	];
	const owner = await serve(
		async () => "done",
		"sess-bounded-history",
		() => history,
		undefined,
		listener => {
			emitAppended = listener;
			return () => { emitAppended = undefined; };
		},
	);

	const historySizes: number[] = [];
	const originalHoldHistory = TerminalReceipts.prototype.holdHistory;
	const holdHistorySpy = spyOn(TerminalReceipts.prototype, "holdHistory").mockImplementation(function (
		this: TerminalReceipts,
		id: string,
	) {
		originalHoldHistory.call(this, id);
		historySizes.push(this.history.size);
	});
	cleanup.push(() => holdHistorySpy.mockRestore());

	const client = connect(owner);
	client.send({ id: "sub-bounded-history", op: "subscribe" });
	await client.next(frame => frame.id === "sub-bounded-history");

	const appendCount = 1500;
	for (let i = 1; i <= appendCount; i++) {
		const entry = { entryId: `e-${i}`, text: `entry ${i}` };
		history.push(entry);
		emitAppended?.({ kind: "appended", sessionId: "sess-bounded-history", entries: [entry] });
	}

	client.send({ id: "ping-bounded-history", op: "ping" });
	await client.next(frame => frame.id === "ping-bounded-history");

	const receivedHistoryEntries = client.frames.flatMap(frame => frame.event?.kind === "history" ? (frame.event.entries ?? []) : []);
	expect(receivedHistoryEntries).toHaveLength(appendCount);
	expect(receivedHistoryEntries.at(-1)?.entryId).toBe(`e-${appendCount}`);
	expect(historySizes.length).toBeGreaterThan(1000);
	expect(Math.max(...historySizes)).toBeLessThanOrEqual(1000);
	expect(historySizes[historySizes.length - 1]).toBe(1000);
});

// WHY: A long-lived terminal session may process many deliveries over its lifetime.
// The subscriber's receipt ledger must cap its delivery memory to 256 entries, evict older records,
// and update delivery state when retried with a distinct status reference while deduplicating identical references.
// GAP: does not test mid-flight network packet loss; exercises the production control server over a local pipe.
test("a long-lived subscriber bounds delivery receipt memory and updates on retries with distinct status reference", async () => {
	const owner = await serve(async text => `outcome-${text}`);

	const deliverySizes: number[] = [];
	const originalHoldDelivery = TerminalReceipts.prototype.holdDelivery;
	const holdDeliverySpy = spyOn(TerminalReceipts.prototype, "holdDelivery").mockImplementation(function (
		this: TerminalReceipts,
		id: string,
		status: object,
	) {
		const result = originalHoldDelivery.call(this, id, status);
		deliverySizes.push(this.deliveries.size);
		return result;
	});
	cleanup.push(() => holdDeliverySpy.mockRestore());

	const client = connect(owner);
	client.send({ id: "sub-bounded-deliveries", op: "subscribe" });
	await client.next(frame => frame.id === "sub-bounded-deliveries");

	const receivedDeliveries: ControlFrame[] = [];
	const totalDeliveries = 300;
	const batchSize = 20;
	for (let batchStart = 0; batchStart < totalDeliveries; batchStart += batchSize) {
		for (let i = 0; i < batchSize; i++) {
			const index = batchStart + i;
			client.send({
				id: `deliv-req-${index}`,
				op: "deliver",
				text: `payload-${index}`,
				mode: "auto",
				ack: true,
				messageId: `m-bounded-${index}`,
			});
		}
		for (let i = 0; i < batchSize; i++) {
			const index = batchStart + i;
			receivedDeliveries.push(await client.next(frame => frame.event?.kind === "delivery" && frame.event.messageId === `m-bounded-${index}`));
		}
	}
	expect(deliverySizes.length).toBeGreaterThan(256);
	expect(Math.max(...deliverySizes)).toBeLessThanOrEqual(256);
	expect(deliverySizes[deliverySizes.length - 1]).toBe(256);

	// Contract: retrying the same messageId with the identical status object reference emits no duplicate
	client.send({
		id: "deliv-retry-same",
		op: "deliver",
		text: "payload-299",
		mode: "auto",
		ack: true,
		messageId: "m-bounded-299",
	});
	const retryAck = await client.next(frame => frame.id === "deliv-retry-same");
	expect(retryAck.result).toMatchObject({ accepted: true, messageId: "m-bounded-299", state: "delivered" });

	client.send({ id: "ping-retry-same", op: "ping" });
	await client.next(frame => frame.id === "ping-retry-same");
	const duplicateDeliveries = client.frames.filter(
		frame => frame.event?.kind === "delivery" && frame.event.messageId === "m-bounded-299",
	);
	expect(duplicateDeliveries).toHaveLength(0);

	// Contract: direct receipt ledger accepts update when given distinct status reference for same messageId
	const receipt = new TerminalReceipts();
	const initialStatus = { state: "pending" as const };
	const distinctStatus = { state: "delivered" as const, outcome: "done" };

	expect(receipt.holdDelivery("m-ref-test", initialStatus)).toBe(true);
	expect(receipt.holdDelivery("m-ref-test", initialStatus)).toBe(false);
	expect(receipt.holdDelivery("m-ref-test", distinctStatus)).toBe(true);
	expect(receipt.holdDelivery("m-ref-test", distinctStatus)).toBe(false);
});

// WHY: Direct ledger contract guarantees strict FIFO eviction, exact bounds of 1000 history entries
// and 256 delivery entries, and window pruning via retainHistory.
// GAP: unit test verifying TerminalReceipts independently of transport.
test("TerminalReceipts directly enforces bounds, FIFO eviction, and reference-equality deduplication", () => {
	const receipts = new TerminalReceipts();

	for (let i = 0; i < 1200; i++) {
		receipts.holdHistory(`hist-${i}`);
	}
	expect(receipts.history.size).toBe(1000);
	expect(receipts.history.has("hist-0")).toBe(false);
	expect(receipts.history.has("hist-199")).toBe(false);
	expect(receipts.history.has("hist-200")).toBe(true);
	expect(receipts.history.has("hist-1199")).toBe(true);

	const window = Array.from({ length: 500 }, (_, i) => `hist-${700 + i}`);
	receipts.retainHistory(window);
	expect(receipts.history.size).toBe(500);
	expect(receipts.history.has("hist-699")).toBe(false);
	expect(receipts.history.has("hist-700")).toBe(true);
	expect(receipts.history.has("hist-1199")).toBe(true);

	for (let i = 0; i < 300; i++) {
		const status = { state: "delivered" as const, outcome: `out-${i}` };
		expect(receipts.holdDelivery(`deliv-${i}`, status)).toBe(true);
		expect(receipts.holdDelivery(`deliv-${i}`, status)).toBe(false);
	}
	expect(receipts.deliveries.size).toBe(256);
	expect(receipts.deliveries.has("deliv-0")).toBe(false);
	expect(receipts.deliveries.has("deliv-43")).toBe(false);
	expect(receipts.deliveries.has("deliv-44")).toBe(true);
	expect(receipts.deliveries.has("deliv-299")).toBe(true);
});
