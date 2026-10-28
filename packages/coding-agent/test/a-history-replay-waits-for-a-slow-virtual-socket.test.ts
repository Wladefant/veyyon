// WHY: the Windows pipe socket never reports a full buffer (`writableNeedDrain`), so a history replay
// that waited only on that flag wrote every chunk at once, passed the 1 MiB send limit and destroyed the
// subscriber. The replay now waits on the bytes the socket still holds.
// CLASS: any replay larger than the send limit on a socket whose consumer is slower than the producer.
// GAP: the broker process itself is not run; the fake socket reproduces its contract, a write that
// completes later and a `writableLength` that falls as it does.
import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { serveTerminalControl, type TerminalOwner } from "../src/launch/terminal-control";
import * as transport from "../src/launch/terminal-control-transport";

const SEND_LIMIT_BYTES = 1024 * 1024;

class SlowVirtualSocket extends EventEmitter {
	destroyed = false;
	writableLength = 0;
	peakWritableLength = 0;
	readonly frames: Array<{ id?: string; ok?: boolean; event?: { kind?: string; entries?: unknown[] } }> = [];
	readonly replied = Promise.withResolvers<void>();
	readonly #drain: ReturnType<typeof setInterval>;

	constructor() {
		super();
		// A real interval on purpose: the contract under test is the replay waiting on bytes that leave over time.
		this.#drain = setInterval(() => {
			this.writableLength = Math.max(0, this.writableLength - 512 * 1024);
		}, 5);
	}

	setEncoding(): this {
		return this;
	}

	write(chunk: string): boolean {
		this.writableLength += Buffer.byteLength(chunk);
		this.peakWritableLength = Math.max(this.peakWritableLength, this.writableLength);
		const frame = JSON.parse(chunk);
		this.frames.push(frame);
		if (frame.id === "sub") this.replied.resolve();
		return true;
	}

	destroy(): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		clearInterval(this.#drain);
		this.replied.resolve();
		this.emit("close");
		return this;
	}
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

test("a history replay larger than the send limit waits for a slow virtual socket instead of destroying it", async () => {
	const socket = new SlowVirtualSocket();
	cleanup.push(() => {
		socket.destroy();
	});
	let accept: ((peer: transport.TerminalSocket) => void) | undefined;
	const spy = spyOn(transport, "createTerminalControlTransport").mockImplementation(async (endpoint, onConnection) => {
		accept = onConnection;
		return { endpoint, close() {} };
	});
	cleanup.push(() => spy.mockRestore());
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-slow-pipe-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const history = Array.from({ length: 400 }, (_, index) => ({ entryId: `e-${index}`, text: "y".repeat(10 * 1024) }));
	const close = await serveTerminalControl(
		{
			identity: () => ({ sessionId: "sess-slow", cwd: root, sessionFile: path.join(root, "sess-slow.jsonl") }),
			deliver: async () => "ok",
			abort: async () => false,
			history: () => history,
			subscribe: () => () => {},
		},
		root,
	);
	cleanup.push(close);
	const directory = path.join(root, "run", "terminals");
	const recordName = (await fs.readdir(directory)).find(name => name.endsWith(".json"))!;
	const owner: TerminalOwner = JSON.parse(await fs.readFile(path.join(directory, recordName), "utf8"));

	accept?.(socket as unknown as transport.TerminalSocket);
	socket.emit("data", `${JSON.stringify({ version: 1, token: owner.token, sessionId: owner.sessionId, id: "sub", op: "subscribe" })}\n`);
	await socket.replied.promise;

	expect(socket.destroyed).toBe(false);
	expect(socket.frames.find(frame => frame.id === "sub")?.ok).toBe(true);
	const replayed = socket.frames
		.filter(frame => frame.event?.kind === "history")
		.reduce((count, frame) => count + (frame.event?.entries?.length ?? 0), 0);
	expect(replayed).toBe(400);
	expect(socket.peakWritableLength).toBeLessThanOrEqual(SEND_LIMIT_BYTES);
});
