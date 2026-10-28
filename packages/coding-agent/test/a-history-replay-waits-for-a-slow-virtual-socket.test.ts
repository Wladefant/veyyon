// WHY: the Windows pipe socket never reports a full buffer (`writableNeedDrain`), so a history or delivery replay
// that waited only on that flag wrote every chunk at once, passed the 1 MiB send limit and destroyed the
// subscriber. A concurrent history append must remain queued for replay rather than falling between snapshots.
// CLASS: replay snapshots plus live history arriving while a slow consumer drains its socket.
// GAP: the broker process itself is not run; the virtual socket deterministically blocks on its first write.
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
	writeHook: (() => void) | undefined;
	#drainTimer: NodeJS.Timeout | undefined;
	readonly frames: Array<{
		id?: string;
		ok?: boolean;
		result?: unknown;
		event?: {
			kind?: string;
			sessionId?: string;
			messageId?: string;
			state?: string;
			outcome?: string;
			entries?: Array<{ entryId: string; text: string }>;
		};
	}> = [];
	readonly replied = Promise.withResolvers<void>();

	setEncoding(): this {
		return this;
	}

	write(chunk: string): boolean {
		const previousLength = this.writableLength;
		this.writableLength += Buffer.byteLength(chunk);
		this.peakWritableLength = Math.max(this.peakWritableLength, this.writableLength);
		for (const line of chunk.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const frame = JSON.parse(trimmed);
			this.frames.push(frame);
			if (frame.id === "sub") this.replied.resolve();
			if (this.writeHook) {
				const hook = this.writeHook;
				this.writeHook = undefined;
				hook();
			}
		}
		if (!this.#drainTimer) this.#scheduleDrain();
		return this.writableLength < 256 * 1024;
	}

	#scheduleDrain(): void {
		// The real timer models a slow pipe drain while production polls writableLength.
		this.#drainTimer = setTimeout(() => {
			this.#drainTimer = undefined;
			const previousLength = this.writableLength;
			this.writableLength = Math.max(0, previousLength - 64 * 1024);
			if (previousLength > 256 * 1024 && this.writableLength <= 256 * 1024) this.emit("drain");
			if (this.writableLength > 0) this.#scheduleDrain();
		}, 15);
	}

	destroy(): this {
		if (this.destroyed) return this;
		if (this.#drainTimer) clearTimeout(this.#drainTimer);
		this.#drainTimer = undefined;
		this.writableLength = 0;
		this.destroyed = true;
		this.replied.resolve();
		this.emit("close");
		return this;
	}
}

class FastVirtualSocket extends EventEmitter {
	destroyed = false;
	writableLength = 0;
	readonly frames: Array<{
		id?: string;
		event?: { kind?: string; sessionId?: string; messageId?: string; state?: string; outcome?: string };
	}> = [];
	readonly #onFrame?: () => void;

	constructor(onFrame?: () => void) {
		super();
		this.#onFrame = onFrame;
	}

	setEncoding(): this {
		return this;
	}

	write(chunk: string): boolean {
		for (const line of chunk.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			this.frames.push(JSON.parse(trimmed));
		}
		this.#onFrame?.();
		return true;
	}

	destroy(): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		this.emit("close");
		return this;
	}
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

test("a history replay and late delivery replay larger than the send limit waits for a slow virtual socket instead of destroying it", async () => {
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
			deliver: async (text: string) => `outcome-${text}-${"z".repeat(30 * 1024)}`,
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

	const deliveryCount = 50;
	const allSettled = Promise.withResolvers<void>();
	const seeder = new FastVirtualSocket(() => {
		const settled = seeder.frames.filter(frame => frame.event?.kind === "delivery" && frame.event.state === "delivered").length;
		if (settled >= deliveryCount) allSettled.resolve();
	});
	cleanup.push(() => {
		seeder.destroy();
	});
	accept?.(seeder as unknown as transport.TerminalSocket);

	for (let index = 0; index < deliveryCount; index++) {
		seeder.emit("data", `${JSON.stringify({
			version: 1,
			token: owner.token,
			sessionId: owner.sessionId,
			id: `ack-${index}`,
			op: "deliver",
			text: `msg-${index}`,
			mode: "auto",
			ack: true,
			messageId: `m-${index}`,
		})}\n`);
	}
	await allSettled.promise;
	seeder.destroy();

	accept?.(socket as unknown as transport.TerminalSocket);
	socket.writeHook = () => {
		for (let index = 0; index < 1001; index++) {
			const entry = { entryId: `new-${String(index).padStart(4, "0")}`, text: `new entry ${index}` };
			history.push(entry);
		}
		socket.writableLength = 0;
	};
	socket.emit("data", `${JSON.stringify({ version: 1, token: owner.token, sessionId: owner.sessionId, id: "sub", op: "subscribe" })}\n`);
	await socket.replied.promise;

	const expectedIds = [...Array.from({ length: 400 }, (_, index) => `e-${index}`), ...Array.from({ length: 1001 }, (_, index) => `new-${String(index).padStart(4, "0")}`)];
	const receivedIds = socket.frames.flatMap(frame => frame.event?.kind === "history" ? (frame.event.entries ?? []).map(entry => entry.entryId) : []);
	expect(socket.destroyed).toBe(false);
	expect(socket.frames.find(frame => frame.id === "sub")?.ok).toBe(true);
	expect(receivedIds).toEqual(expectedIds);
	expect(new Set(receivedIds).size).toBe(expectedIds.length);

	const deliveryFrames = socket.frames.filter(frame => frame.event?.kind === "delivery");
	expect(deliveryFrames).toHaveLength(deliveryCount);
	for (let index = 0; index < deliveryCount; index++) {
		const delivery = deliveryFrames.find(frame => frame.event?.messageId === `m-${index}`);
		expect(delivery).toBeDefined();
		expect(delivery?.event?.state).toBe("delivered");
		expect(delivery?.event?.outcome).toBe(`outcome-msg-${index}-${"z".repeat(30 * 1024)}`);
	}
	expect(socket.peakWritableLength).toBeLessThanOrEqual(SEND_LIMIT_BYTES);
});
