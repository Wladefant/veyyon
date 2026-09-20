/**
 * An idle mnemopi embeddings subprocess is unloaded, and the next embed brings
 * it back with the same answers.
 *
 * WHY THIS SUITE EXISTS. The worker loads an ONNX model and then pins ~1.25 GB
 * of commit charge for the life of the session, whether or not anything embeds
 * again: a workstation audit found two sessions holding 1 263 MB and 1 265 MB
 * with a 39 MB working set, i.e. the model had been paged out entirely and the
 * process was pure commit charge (issue #54). `MnemopiEmbedClient` only ever
 * tore the child down at session shutdown or on a worker error, so N open
 * sessions cost N x 1.25 GB for a feature that runs for a few hundred
 * milliseconds per `retain` / `recall`.
 *
 * THE CLASS THIS CLOSES. Not "the timer exists" but the four ways an unload can
 * be wrong: it fires too early (a request in flight is killed under itself), it
 * never fires (the window is ignored or re-armed forever), it fires and nothing
 * comes back (a respawn that cannot self-init, or a second child racing the
 * dying one), and it is configured out of range without anybody noticing. Each
 * has a test below, driving the real `MnemopiEmbedClient` through its injected
 * `spawnWorker` seam on a fake clock.
 *
 * WHAT IT DOES NOT CATCH. That the real subprocess frees its memory when
 * SIGKILLed — that is the OS, and `mnemopi-embedding-worker-subprocess-isolation`
 * owns the real spawn/kill path. Nor does it observe the operator's config file:
 * it pins the validator that `loadMnemopiConfig` applies, not the YAML read.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { DEFAULT_EMBED_IDLE_UNLOAD_MS } from "@veyyon/coding-agent/config/settings-domains/shared";
import {
	MnemopiEmbedClient,
	type MnemopiEmbedWorkerHandle,
	parseEmbedIdleUnloadMs,
} from "@veyyon/coding-agent/memory/mnemopi/embed-client";
import type {
	MnemopiEmbedWorkerInbound,
	MnemopiEmbedWorkerOutbound,
} from "@veyyon/coding-agent/memory/mnemopi/embed-protocol";

const MODEL = "fast-bge-base-en-v1.5";
const CACHE_DIR = "/cache/fastembed";
const IDLE_MS = 5_000;

/** One spawned child, as the parent can observe it. */
interface FakeWorker {
	handle: MnemopiEmbedWorkerHandle;
	sent: MnemopiEmbedWorkerInbound[];
	terminated: boolean;
	/** When true, requests are recorded but left unanswered until {@link answerAll}. */
	hold: boolean;
	answerAll(): void;
}

/** Deterministic stand-in for fastembed: the vector encodes the text. */
function vectorsFor(texts: string[]): number[][] {
	return texts.map(text => [text.length, text.charCodeAt(0)]);
}

function replyTo(message: MnemopiEmbedWorkerInbound): MnemopiEmbedWorkerOutbound {
	if (message.type === "ping") return { type: "pong", id: message.id };
	if (message.type === "init") return { type: "ready", id: message.id };
	return { type: "vectors", id: message.id, vectors: vectorsFor(message.texts) };
}

/**
 * A fleet of fake workers behind one `spawnWorker`, so a test can count
 * respawns and watch each child's kill independently.
 */
function createFleet(): { workers: FakeWorker[]; spawn: () => MnemopiEmbedWorkerHandle } {
	const workers: FakeWorker[] = [];
	const spawn = (): MnemopiEmbedWorkerHandle => {
		let onMessage: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
		const unanswered: MnemopiEmbedWorkerInbound[] = [];
		const worker: FakeWorker = {
			sent: [],
			terminated: false,
			hold: false,
			answerAll(): void {
				const queued = unanswered.splice(0, unanswered.length);
				for (const message of queued) onMessage?.(replyTo(message));
			},
			handle: {
				send(message: MnemopiEmbedWorkerInbound): void {
					if (worker.terminated) throw new Error("send after terminate");
					worker.sent.push(message);
					if (worker.hold) {
						unanswered.push(message);
						return;
					}
					// Answer off the microtask queue, the way a real IPC reply
					// arrives: never synchronously inside `send`.
					queueMicrotask(() => onMessage?.(replyTo(message)));
				},
				onMessage(handler: (message: MnemopiEmbedWorkerOutbound) => void): () => void {
					onMessage = handler;
					return () => {
						if (onMessage === handler) onMessage = undefined;
					};
				},
				onError(): () => void {
					return () => {};
				},
				async terminate(): Promise<void> {
					worker.terminated = true;
					onMessage = undefined;
				},
			},
		};
		workers.push(worker);
		return worker.handle;
	};
	return { workers, spawn };
}

/** Let queued IPC replies and the client's own await chain settle. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

/** Advance the fake clock and let the unload's async terminate run to completion. */
async function advance(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await settle();
}

async function drain(vectors: AsyncIterable<number[][]>): Promise<number[][]> {
	const batches: number[][][] = [];
	for await (const batch of vectors) batches.push(batch);
	return batches.flat();
}

describe("an idle embed worker is unloaded and relaunched on demand", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("kills the worker once the idle window elapses, and not one tick before", async () => {
		vi.useFakeTimers();
		const { workers, spawn } = createFleet();
		const client = new MnemopiEmbedClient(spawn, IDLE_MS);
		const model = await client.initialize(MODEL, CACHE_DIR);
		expect(model).not.toBeNull();

		// THE BOUND. One millisecond short of the window the child is still
		// there; a test that only advanced "a lot" would pass against an unload
		// that fires immediately, which is the defect in the other direction.
		await advance(IDLE_MS - 1);
		expect(workers[0].terminated).toBe(false);

		// TERMINATION. The window is not merely long, it ENDS: the kill lands on
		// the bound, from a timer nobody re-armed.
		await advance(1);
		expect(workers[0].terminated).toBe(true);
		expect(workers.length).toBe(1);
	});

	it("respawns exactly one worker on the next embed and answers identically", async () => {
		vi.useFakeTimers();
		const { workers, spawn } = createFleet();
		const client = new MnemopiEmbedClient(spawn, IDLE_MS);
		const model = await client.initialize(MODEL, CACHE_DIR);
		const before = await drain(model!.embed(["hello"]));

		await advance(IDLE_MS);
		expect(workers[0].terminated).toBe(true);

		// The caller still holds the wrapper mnemopi cached before the unload.
		const after = await drain(model!.embed(["hello"]));
		expect(after).toEqual(before);
		expect(workers.length).toBe(2);
		expect(workers[1].terminated).toBe(false);

		// The respawned child never saw `init`, so the embed must carry its own
		// (model, cacheDir) or it would trip the worker's "embed before init".
		const embeds = workers[1].sent.filter(
			(message): message is Extract<MnemopiEmbedWorkerInbound, { type: "embed" }> => message.type === "embed",
		);
		expect(embeds.map(embed => [embed.model, embed.cacheDir])).toEqual([[MODEL, CACHE_DIR]]);

		await client.terminate();
	});

	it("never unloads under an in-flight request, and re-arms once it lands", async () => {
		vi.useFakeTimers();
		const { workers, spawn } = createFleet();
		const client = new MnemopiEmbedClient(spawn, IDLE_MS);
		const model = await client.initialize(MODEL, CACHE_DIR);

		workers[0].hold = true;
		const inFlight = drain(model!.embed(["slow"]));
		await settle();

		// Four windows pass while the child is still computing. A timer armed
		// before the request, or one that ignores the pending map, kills the
		// worker here and rejects the promise.
		await advance(IDLE_MS * 4);
		expect(workers[0].terminated).toBe(false);

		workers[0].hold = false;
		workers[0].answerAll();
		expect(await inFlight).toEqual(vectorsFor(["slow"]));
		expect(workers.length).toBe(1);

		// And the window is measured from the reply, not from the request: the
		// worker survives one tick short of it and dies on it.
		await advance(IDLE_MS - 1);
		expect(workers[0].terminated).toBe(false);
		await advance(1);
		expect(workers[0].terminated).toBe(true);
	});

	it("serves an embed that arrives while the unloaded worker is still dying", async () => {
		vi.useFakeTimers();
		const { workers, spawn } = createFleet();
		let releaseKill: (() => void) | undefined;
		const client = new MnemopiEmbedClient(() => {
			const handle = spawn();
			const worker = workers[workers.length - 1];
			// A kill that does not complete until the test says so, which is the
			// window a second child could be spawned into.
			const slowKill = async (): Promise<void> => {
				if (workers.length === 1 && !releaseKill) {
					const { promise, resolve } = Promise.withResolvers<void>();
					releaseKill = resolve;
					await promise;
				}
				worker.terminated = true;
			};
			return { ...handle, terminate: slowKill };
		}, IDLE_MS);
		const model = await client.initialize(MODEL, CACHE_DIR);

		await advance(IDLE_MS);
		expect(workers[0].terminated).toBe(false);
		expect(releaseKill).toBeDefined();

		const pending = drain(model!.embed(["during-teardown"]));
		await settle();
		// Nothing was spawned yet: the request is waiting out the kill instead of
		// racing a second 1.25 GB child alongside the dying one.
		expect(workers.length).toBe(1);

		releaseKill?.();
		expect(await pending).toEqual(vectorsFor(["during-teardown"]));
		expect(workers.length).toBe(2);

		await client.terminate();
	});

	it("keeps the worker for the whole session when the window is 0", async () => {
		vi.useFakeTimers();
		const { workers, spawn } = createFleet();
		const client = new MnemopiEmbedClient(spawn, 0);
		await client.initialize(MODEL, CACHE_DIR);

		await advance(DEFAULT_EMBED_IDLE_UNLOAD_MS * 10);
		expect(workers[0].terminated).toBe(false);
		expect(workers.length).toBe(1);

		// And turning the window back on re-arms against the live worker rather
		// than waiting for the next request to notice.
		client.setIdleUnloadMs(IDLE_MS);
		expect(client.idleUnloadMs).toBe(IDLE_MS);
		await advance(IDLE_MS);
		expect(workers[0].terminated).toBe(true);
	});

	it("refuses an idle window that is not a whole number of milliseconds", () => {
		expect(parseEmbedIdleUnloadMs(0)).toBe(0);
		expect(parseEmbedIdleUnloadMs(DEFAULT_EMBED_IDLE_UNLOAD_MS)).toBe(DEFAULT_EMBED_IDLE_UNLOAD_MS);

		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "120000", null, undefined]) {
			expect(() => parseEmbedIdleUnloadMs(bad), `${String(bad)} must be rejected`).toThrow(
				/mnemopi\.embedIdleUnloadMs must be 0/,
			);
		}

		const { spawn } = createFleet();
		const client = new MnemopiEmbedClient(spawn, IDLE_MS);
		expect(() => client.setIdleUnloadMs(-1)).toThrow(/mnemopi\.embedIdleUnloadMs must be 0/);
		// A rejected value leaves the previous window in force rather than
		// silently disabling the unload.
		expect(client.idleUnloadMs).toBe(IDLE_MS);
	});

	it("ships a default window that unloads", () => {
		expect(Number.isInteger(DEFAULT_EMBED_IDLE_UNLOAD_MS)).toBe(true);
		expect(DEFAULT_EMBED_IDLE_UNLOAD_MS).toBeGreaterThan(0);
		const { spawn } = createFleet();
		expect(new MnemopiEmbedClient(spawn).idleUnloadMs).toBe(DEFAULT_EMBED_IDLE_UNLOAD_MS);
	});
});
