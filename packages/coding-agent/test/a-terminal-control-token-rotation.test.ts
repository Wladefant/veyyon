// WHY: Terminal control credentials must rotate dynamically without requiring process restarts,
// ensuring old credentials are unconditionally revoked, existing sockets and subscriptions are cut,
// active deliveries settle safely without duplicate work, and write failures preserve previous state.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	serveTerminalControl,
	type TerminalControlOptions,
	type TerminalControlTarget,
	type TerminalOwner,
} from "../src/launch/terminal-control";


const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) {
		try {
			await close();
		} catch {
			// Ignore cleanup errors on sockets or directories already destroyed.
		}
	}
});

async function getOwnerRecordPath(root: string): Promise<string> {
	const directory = path.join(root, "run", "terminals");
	const files = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
	if (files.length === 0) {
		throw new Error("No terminal owner discovery record found");
	}
	return path.join(directory, files[0]!);
}

async function readOwner(root: string): Promise<TerminalOwner> {
	const recordPath = await getOwnerRecordPath(root);
	const content = await fs.readFile(recordPath, "utf8");
	return JSON.parse(content);
}

async function createFixture(
	targetOverrides: Partial<TerminalControlTarget> = {},
	options?: TerminalControlOptions,
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-rot-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));

	let identity = "rot-session";
	const receivedDeliveries: Array<{ text: string; mode: string }> = [];

	const target: TerminalControlTarget = {
		identity: () => ({
			sessionId: identity,
			cwd: root,
			sessionFile: path.join(root, `${identity}.jsonl`),
		}),
		deliver: async (text, mode) => {
			receivedDeliveries.push({ text, mode });
			return "started";
		},
		abort: async () => false,
		history: () => [{ entryId: "init", text: "initial entry" }],
		subscribe: () => () => {},
		...targetOverrides,
	};

	const close = await serveTerminalControl(target, root, options);
	cleanup.push(close);

	return {
		root,
		target,
		receivedDeliveries,
		close,
	};
}

interface RpcResult {
	response: Record<string, any>;
	events: Record<string, any>[];
}

async function rpc(
	owner: { endpoint: string; token: string; sessionId: string },
	op: string,
	payload: Record<string, unknown> = {},
	bound = 5_000,
): Promise<RpcResult> {
	const done = Promise.withResolvers<RpcResult>();
	const socket = net.createConnection(owner.endpoint);
	// Bound real OS socket failure; named-pipe I/O cannot be driven by a fake clock.
	const timer = setTimeout(() => done.reject(new Error(`${op} exceeded bound ${bound}ms`)), bound);
	const events: Record<string, any>[] = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("connect", () => {
		socket.write(
			`${JSON.stringify({
				version: 1,
				id: `rpc-${Math.random().toString(36).slice(2)}`,
				token: owner.token,
				sessionId: owner.sessionId,
				op,
				...payload,
			})}\n`,
		);
	});
	socket.on("data", chunk => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			if (frame.event) {
				events.push(frame.event);
			} else {
				done.resolve({ response: frame, events });
			}
		}
	});
	socket.on("error", done.reject);
	socket.on("close", () => done.reject(new Error("socket closed")));
	try {
		return await done.promise;
	} finally {
		clearTimeout(timer);
		socket.destroy();
	}
}

function connect(owner: { endpoint: string; token: string; sessionId: string }) {
	const socket = net.createConnection(owner.endpoint);
	cleanup.push(() => {
		socket.destroy();
	});
	const frames: Record<string, any>[] = [];
	const waiters: Array<{ match: (frame: Record<string, any>) => boolean; done: (frame: Record<string, any>) => void }> = [];
	const closePromise = Promise.withResolvers<void>();
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("close", () => closePromise.resolve());
	socket.on("error", () => closePromise.resolve());
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
		socket,
		send(request: Record<string, unknown>) {
			socket.write(
				`${JSON.stringify({
					version: 1,
					id: `conn-${Math.random().toString(36).slice(2)}`,
					token: owner.token,
					sessionId: owner.sessionId,
					...request,
				})}\n`,
			);
		},
		next(match: (frame: Record<string, any>) => boolean, timeoutMs = 5_000): Promise<Record<string, any>> {
			const seen = frames.find(match);
			if (seen) return Promise.resolve(seen);
			const { promise, resolve, reject } = Promise.withResolvers<Record<string, any>>();
			// Bound real OS socket failure; named-pipe I/O cannot be driven by a fake clock.
			const timer = setTimeout(() => reject(new Error("no matching frame")), timeoutMs);
			waiters.push({
				match,
				done: frame => {
					clearTimeout(timer);
					resolve(frame);
				},
			});
			return promise;
		},
		waitForClose(timeoutMs = 5_000): Promise<boolean> {
			if (socket.destroyed || socket.closed) return Promise.resolve(true);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			// Bound real OS socket failure; named-pipe I/O cannot be driven by a fake clock.
			const timer = setTimeout(() => resolve(false), timeoutMs);
			closePromise.promise.then(() => {
				clearTimeout(timer);
				resolve(true);
			});
			return promise;
		},
		frames,
	};
}

test("authenticated rotate replaces private discovery atomically and invalidates old token for new and existing sockets", async () => {
	const fix = await createFixture();
	const oldOwner = await readOwner(fix.root);
	expect(typeof oldOwner.token === "string" && oldOwner.token.length > 0).toBe(true);

	// Connect an existing socket before rotation
	const existingSocket = connect(oldOwner);
	existingSocket.send({ op: "ping" });
	const initialPing = await existingSocket.next(frame => frame.ok === true);
	expect(initialPing.ok).toBe(true);

	// Issue rotate operation
	const rotateRes = await rpc(oldOwner, "rotate");
	expect(rotateRes.response.ok).toBe(true);
	expect(rotateRes.response.result?.rotated).toBe(true);

	// Read discovery record immediately after rotate returns
	const newOwner = await readOwner(fix.root);
	expect(newOwner.token === oldOwner.token).toBe(false);
	expect(typeof newOwner.token === "string" && newOwner.token.length > 0).toBe(true);
	expect(newOwner.endpoint === oldOwner.endpoint).toBe(true);
	expect(newOwner.sessionId === oldOwner.sessionId).toBe(true);

	if (process.platform !== "win32") {
		const recordPath = await getOwnerRecordPath(fix.root);
		const stat = await fs.stat(recordPath);
		expect((stat.mode & 0o777) === 0o600).toBe(true);
	}

	// New connection with old token must be rejected
	await expect(rpc(oldOwner, "ping")).rejects.toThrow();

	// Rotation must close the old socket within the bound, without accepting a stale request.
	const staleRequestId = "stale-after-rotation";
	existingSocket.send({ op: "ping", id: staleRequestId });
	expect(await existingSocket.waitForClose(1_000)).toBe(true);
	expect(existingSocket.frames.some(frame => frame.id === staleRequestId && frame.ok === true)).toBe(false);

	// Newly read discovery record ping and deliver works
	const newPing = await rpc(newOwner, "ping");
	expect(newPing.response.ok).toBe(true);
	const newDeliver = await rpc(newOwner, "deliver", { text: "hello-new", mode: "auto" });
	expect(newDeliver.response.ok).toBe(true);
	expect(newDeliver.response.result === "started").toBe(true);
	expect(fix.receivedDeliveries.some(d => d.text === "hello-new")).toBe(true);
});

test("old subscribers are disconnected upon token rotation while new subscribers receive subsequent events", async () => {
	let emitEvent: ((event: unknown) => void) | undefined;
	const fix = await createFixture({
		subscribe: listener => {
			emitEvent = listener;
			return () => {
				emitEvent = undefined;
			};
		},
	});
	const oldOwner = await readOwner(fix.root);

	const subscriber = connect(oldOwner);
	subscriber.send({ op: "subscribe" });
	const subAck = await subscriber.next(frame => frame.event?.kind === "history" || frame.ok === true);
	expect(Boolean(subAck)).toBe(true);

	// Rotate token
	const rotateRes = await rpc(oldOwner, "rotate");
	expect(rotateRes.response.ok).toBe(true);
	expect(rotateRes.response.result?.rotated).toBe(true);

	// Old subscriber must be disconnected
	const subscriberClosed = await subscriber.waitForClose(3_000);
	expect(subscriberClosed).toBe(true);

	// New subscriber with new token connects and receives live events
	const newOwner = await readOwner(fix.root);
	expect(newOwner.token === oldOwner.token).toBe(false);

	const newSubscriber = connect(newOwner);
	newSubscriber.send({ op: "subscribe" });
	const newSubAck = await newSubscriber.next(frame => frame.event?.kind === "history" || frame.ok === true);
	expect(Boolean(newSubAck)).toBe(true);

	emitEvent?.({ kind: "post-rotation-event", payload: "live-event-received" });
	const liveEvent = await newSubscriber.next(frame => frame.event?.kind === "post-rotation-event");
	expect(liveEvent.event?.payload === "live-event-received").toBe(true);
});

test("active acked delivery finishes cleanly during rotation without duplicate execution on retry", async () => {
	const deliveryGate = Promise.withResolvers<string>();
	const deliverCalls: Array<{ text: string; mode: string }> = [];

	const fix = await createFixture({
		deliver: async (text, mode) => {
			deliverCalls.push({ text, mode });
			return await deliveryGate.promise;
		},
	});
	const oldOwner = await readOwner(fix.root);

	// Send an acked delivery on old connection
	const conn = connect(oldOwner);
	const messageId = "msg-in-flight-rotation";
	conn.send({ op: "deliver", text: "payload-in-flight", mode: "auto", ack: true, messageId });
	const ack = await conn.next(frame => frame.result?.accepted === true);
	expect(ack.ok).toBe(true);
	expect(ack.result.accepted).toBe(true);
	expect(ack.result.messageId === messageId).toBe(true);
	expect(ack.result.state === "pending").toBe(true);

	// Delivery is in-flight (target.deliver is running and blocked on deliveryGate)
	expect(deliverCalls.length === 1).toBe(true);
	expect(deliverCalls[0]!.text === "payload-in-flight").toBe(true);

	// Rotate token while delivery is in-flight
	const rotateRes = await rpc(oldOwner, "rotate");
	expect(rotateRes.response.ok).toBe(true);
	expect(rotateRes.response.result?.rotated).toBe(true);

	const newOwner = await readOwner(fix.root);
	expect(newOwner.token === oldOwner.token).toBe(false);

	// Client reconnects with new token and retries the same messageId
	const retryRes = await rpc(newOwner, "deliver", {
		text: "payload-in-flight",
		mode: "auto",
		ack: true,
		messageId,
	});
	expect(retryRes.response.ok).toBe(true);
	expect(retryRes.response.result.accepted).toBe(true);
	expect(retryRes.response.result.messageId === messageId).toBe(true);

	// Target deliver must NOT have been called a second time
	expect(deliverCalls.length === 1).toBe(true);

	// Unblock in-flight delivery
	deliveryGate.resolve("completed-after-rotation");

	// Wait briefly for delivery promise to settle
	for (let i = 0; i < 50; i++) await Promise.resolve();

	// Target deliver still called exactly once
	expect(deliverCalls.length === 1).toBe(true);
	expect(deliverCalls[0]!.text === "payload-in-flight").toBe(true);

	// Query status on new connection confirms delivered outcome
	const statusRes = await rpc(newOwner, "deliveryStatus", { messageId });
	expect(statusRes.response.ok).toBe(true);
	expect(statusRes.response.result?.state === "delivered").toBe(true);
	expect(statusRes.response.result?.outcome === "completed-after-rotation").toBe(true);
});

test("concurrent rotations allow only the first old-auth request to succeed", async () => {
	const fix = await createFixture();
	const oldOwner = await readOwner(fix.root);

	// Send two rotate requests concurrently using the old credential
	const [firstAttempt, secondAttempt] = await Promise.allSettled([
		rpc(oldOwner, "rotate", {}, 5_000),
		rpc(oldOwner, "rotate", {}, 5_000),
	]);

	const successes = [firstAttempt, secondAttempt].filter(
		res => res.status === "fulfilled" && res.value.response?.ok === true && res.value.response?.result?.rotated === true,
	);
	expect(successes.length === 1).toBe(true);

	const failures = [firstAttempt, secondAttempt].filter(
		res => res.status === "rejected" || (res.status === "fulfilled" && res.value.response?.ok === false),
	);
	expect(failures.length === 1).toBe(true);

	// Discovery record on disk reflects the new token
	const newOwner = await readOwner(fix.root);
	expect(newOwner.token === oldOwner.token).toBe(false);

	// Newly read discovery record works
	const pingRes = await rpc(newOwner, "ping");
	expect(pingRes.response.ok).toBe(true);

	// Old credential no longer works
	await expect(rpc(oldOwner, "ping")).rejects.toThrow();
});

test("discovery write failure keeps old token valid, leaves file unchanged, and allows subsequent rotation", async () => {
	let failWrite = false;
	let writeAttempts = 0;
	const options: TerminalControlOptions = {
		writeOwner: async (recordPath, record) => {
			writeAttempts++;
			if (failWrite) {
				throw new Error("simulated atomic discovery write failure");
			}
			await fs.writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
		},
	};

	const fix = await createFixture({}, options);
	const oldOwner = await readOwner(fix.root);
	const recordPath = await getOwnerRecordPath(fix.root);
	const contentBefore = await fs.readFile(recordPath, "utf8");
	expect(writeAttempts >= 1).toBe(true);

	// Arm write failure
	failWrite = true;

	// Rotate attempt must fail because private discovery cannot be replaced
	let rotateFailed = false;
	try {
		const res = await rpc(oldOwner, "rotate");
		if (!res.response.ok) rotateFailed = true;
	} catch {
		rotateFailed = true;
	}
	expect(rotateFailed).toBe(true);

	// Discovery file on disk must remain unchanged
	const contentAfterFailure = await fs.readFile(recordPath, "utf8");
	expect(contentAfterFailure === contentBefore).toBe(true);

	const currentOwner = await readOwner(fix.root);
	expect(currentOwner.token === oldOwner.token).toBe(true);

	// Old token remains valid for operations
	const pingRes = await rpc(oldOwner, "ping");
	expect(pingRes.response.ok).toBe(true);

	const deliverRes = await rpc(oldOwner, "deliver", { text: "retained-after-write-fail", mode: "auto" });
	expect(deliverRes.response.ok).toBe(true);
	expect(fix.receivedDeliveries.some(d => d.text === "retained-after-write-fail")).toBe(true);

	// Disarm write failure and confirm rotation succeeds
	failWrite = false;
	const secondRotateRes = await rpc(oldOwner, "rotate");
	expect(secondRotateRes.response.ok).toBe(true);
	expect(secondRotateRes.response.result?.rotated).toBe(true);

	const rotatedOwner = await readOwner(fix.root);
	expect(rotatedOwner.token === oldOwner.token).toBe(false);

	const finalPing = await rpc(rotatedOwner, "ping");
	expect(finalPing.response.ok).toBe(true);
});
