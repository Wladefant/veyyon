/**
 * WHY: the relay client decides when a sealed frame goes to the socket and when it waits. A client that
 * sends into a socket whose own buffer is full grows that buffer without bound on a slow relay, and a client
 * that seals before its room key has imported drops or reorders the first frames of a session. The CLI and
 * the browser guest each had their own copy of this class, and only the CLI's held sends back, so these
 * cells drive the one class both now bind.
 *
 * Not covered here: the fatal close codes and the pending-send bound, which `relay-protocol.test.ts` pins,
 * and the end-to-end host/guest exchange, which the coding-agent collab suites drive over an in-memory relay.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { generateRoomKey, importRoomKey, openFrame, unpackEnvelope } from "../src/index";
import { RelayClient } from "../src/relay-client";

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;
const HIGH_WATER_MARK = 64 * 1024;
const DRAIN_RETRY_MS = 25;

type TestFrame = { t: string; reason?: string };

class BackpressuredWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static initialBufferedAmount = 0;
	static instances: BackpressuredWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	bufferedAmount: number;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = BackpressuredWebSocket.CONNECTING;
	sent: Uint8Array[] = [];

	constructor(url: string) {
		this.url = url;
		this.bufferedAmount = BackpressuredWebSocket.initialBufferedAmount;
		BackpressuredWebSocket.instances.push(this);
	}

	send(data: Uint8Array): void {
		this.sent.push(data);
		this.bufferedAmount += data.byteLength;
	}

	open(): void {
		this.readyState = BackpressuredWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	close(): void {
		if (this.readyState === BackpressuredWebSocket.CLOSED) return;
		this.readyState = BackpressuredWebSocket.CLOSED;
		this.onclose?.({ code: 1000, reason: "closed" } as CloseEvent);
	}
}

function installSocket(initialBufferedAmount: number): void {
	BackpressuredWebSocket.instances = [];
	BackpressuredWebSocket.initialBufferedAmount = initialBufferedAmount;
	globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
}

function client(key: CryptoKey | PromiseLike<CryptoKey>): RelayClient<TestFrame, TestFrame> {
	return new RelayClient<TestFrame, TestFrame>({
		wsUrl: "ws://localhost:8788/r/backpressure",
		role: "host",
		key,
		retryDelayMs: () => 1_000,
	});
}

function onlySocket(): BackpressuredWebSocket {
	const ws = BackpressuredWebSocket.instances[0];
	if (!ws) throw new Error("RelayClient did not construct a WebSocket");
	return ws;
}

async function flushMicrotasks(): Promise<void> {
	for (let flush = 0; flush < 5; flush++) await Promise.resolve();
}

describe("RelayClient send backpressure", () => {
	afterEach(() => {
		globalThis.WebSocket = ORIGINAL_WEBSOCKET;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("queues open-socket sends while bufferedAmount is above the high-water mark", async () => {
		vi.useFakeTimers();
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		installSocket(HIGH_WATER_MARK);
		const socket = client({} as CryptoKey);

		try {
			socket.connect();
			const ws = onlySocket();
			ws.open();
			socket.send({ t: "bye", reason: "slow relay" });
			await flushMicrotasks();
			expect(ws.sent).toHaveLength(0);

			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			await flushMicrotasks();
			expect(ws.sent).toHaveLength(0);

			ws.bufferedAmount = 0;
			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			await flushMicrotasks();
			expect(ws.sent).toHaveLength(1);
		} finally {
			socket.close();
		}
	});

	it("drains reconnect backlog through the same backpressure gate", async () => {
		vi.useFakeTimers();
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		installSocket(HIGH_WATER_MARK);
		const socket = client({} as CryptoKey);

		try {
			socket.connect();
			const ws = onlySocket();
			socket.send({ t: "bye", reason: "queued while disconnected" });
			await flushMicrotasks();
			expect(ws.sent).toHaveLength(0);

			ws.open();
			expect(ws.sent).toHaveLength(0);
			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			await flushMicrotasks();
			expect(ws.sent).toHaveLength(0);

			ws.bufferedAmount = 0;
			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			await flushMicrotasks();
			expect(ws.sent).toHaveLength(1);
		} finally {
			socket.close();
		}
	});
});

describe("RelayClient room key", () => {
	afterEach(() => {
		globalThis.WebSocket = ORIGINAL_WEBSOCKET;
	});

	/**
	 * The browser guest constructs its client with the key import still pending, so a frame sent before the
	 * import settles must wait for it, and every frame must still leave in send order under the real seal.
	 */
	it("seals frames sent before the key settles, in send order, once it does", async () => {
		installSocket(0);
		const pending = Promise.withResolvers<CryptoKey>();
		const socket = client(pending.promise);

		try {
			socket.connect();
			const ws = onlySocket();
			ws.open();
			socket.send({ t: "first" });
			socket.send({ t: "second" });
			await flushMicrotasks();
			expect(ws.sent).toHaveLength(0);

			const key = await importRoomKey(generateRoomKey());
			pending.resolve(key);
			const deadline = Date.now() + 5_000;
			while (ws.sent.length < 2 && Date.now() < deadline) await sleep(1);

			const frames = await Promise.all(
				ws.sent.map(bytes => {
					const envelope = unpackEnvelope(bytes);
					if (!envelope) throw new Error("sent bytes are not an envelope");
					return openFrame<TestFrame>(key, envelope.payload);
				}),
			);
			expect(frames.map(frame => frame.t)).toEqual(["first", "second"]);
		} finally {
			socket.close();
		}
	});
});
