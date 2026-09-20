// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { DEFAULT_EMBED_IDLE_UNLOAD_MS, MAX_EMBED_IDLE_UNLOAD_MS } from "../../config/settings-domains/shared";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	logWorkerMessage,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	type WorkerHandle,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import { MNEMOPI_EMBED_WORKER_ARG } from "../../worker-args";
import type { MnemopiEmbedModelId, MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

/**
 * Parent-side handle for the mnemopi embeddings subprocess. The runtime
 * implementation is a Bun child process so `onnxruntime-node`'s NAPI
 * constructor + finalizer never run inside the main agent address space —
 * those destructors segfault Bun on Windows when mnemopi's local embedding
 * provider loads fastembed in the main process (issue #3031; the mnemopi
 * sibling of the tiny-model fix from #1606 / #1607).
 */
export type MnemopiEmbedWorkerHandle = WorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>;

type PendingRequest =
	| { kind: "init"; model: MnemopiEmbedModelId; resolve: (ok: boolean) => void }
	| { kind: "embed"; model: MnemopiEmbedModelId; resolve: (vectors: number[][] | Error) => void };

/**
 * Validate and normalize an idle-unload window, in milliseconds. `0` disables
 * unloading and keeps the worker for the whole session.
 *
 * Clamped to match the sibling numeric settings in `loadMnemopiConfig`:
 * non-finite, negative, or invalid values clamp to 0 (disabling idle unload),
 * and fractional values are rounded down with `Math.floor`.
 *
 * The upper clamp is {@link MAX_EMBED_IDLE_UNLOAD_MS}, because `setTimeout`
 * rewrites a delay it cannot hold in a signed 32-bit integer to `1` ms: an
 * unclamped `2147483648` would unload the worker after every single request
 * and reload the ONNX model on the next one.
 */
export function parseEmbedIdleUnloadMs(value: unknown): number {
	const num = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(num)) return 0;
	return Math.min(MAX_EMBED_IDLE_UNLOAD_MS, Math.max(0, Math.floor(num)));
}

/**
 * Hidden subcommand on the main CLI that boots the mnemopi embeddings worker
 * in the spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */

/**
 * Spawn the mnemopi embeddings worker as a subprocess. Exported for tests and
 * the smoke probe; production callers go through {@link spawnMnemopiEmbedWorker}.
 * The child inherits the parent env verbatim — fastembed honours `HF_HUB_*`,
 * `HTTPS_PROXY`, etc., and our `loadFastembed()` reads the same `OMP_*`
 * runtime-install knobs the parent uses.
 */
export function createMnemopiEmbedSubprocess(): SpawnedSubprocess<MnemopiEmbedWorkerOutbound> {
	return createWorkerSubprocess<MnemopiEmbedWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(MNEMOPI_EMBED_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "mnemopi embed subprocess",
	});
}

function wrapSubprocess(spawned: SpawnedSubprocess<MnemopiEmbedWorkerOutbound>): MnemopiEmbedWorkerHandle {
	const { proc } = spawned;
	// `proc.send` throws synchronously when the child's IPC pipe is already
	// closed. That throw MUST propagate: the caller registers a pending
	// resolver before sending, and a swallowed send failure leaves that
	// request awaiting a reply that can never arrive (a silent hang).
	return createWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(spawned, message => {
		proc.send(message);
	});
}

function spawnMnemopiEmbedWorker(): MnemopiEmbedWorkerHandle {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createMnemopiEmbedSubprocess()),
		createUnavailableWorker<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>,
		"mnemopi embed worker spawn failed; local embeddings disabled",
	);
}

/**
 * Per-model wrapper produced by {@link MnemopiEmbedClient.initialize}.
 * `embed()` round-trips one batch of texts through the worker subprocess and
 * yields the resulting vectors in a single asynchronous batch — fastembed's
 * own iterator was emitting batches that we collect on the child side anyway,
 * and serializing per-batch over IPC would not improve throughput.
 */
export interface MnemopiSubprocessEmbeddingModel {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}

export class MnemopiEmbedClient {
	#worker: MnemopiEmbedWorkerHandle | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;
	#spawnWorker: () => MnemopiEmbedWorkerHandle;
	#idleUnloadMs: number;
	#idleTimer: NodeJS.Timeout | undefined;
	/** The kill a request arriving mid-unload waits out before it spawns a replacement. */
	#teardown: Promise<void> | null = null;
	/**
	 * How many public {@link terminate} calls are in flight.
	 *
	 * A counter rather than a flag because two disposes overlap: the first to
	 * finish must not clear the guard while the second is still awaiting the
	 * same kill. Deliberately NOT set by the idle-unload or crash paths, which
	 * reap through `#reap()` instead — a request parked on those
	 * kills is supposed to get a replacement worker, and a request parked on a
	 * shutdown is not.
	 */
	#shutdowns = 0;

	constructor(
		spawnWorker: () => MnemopiEmbedWorkerHandle = spawnMnemopiEmbedWorker,
		idleUnloadMs: number = DEFAULT_EMBED_IDLE_UNLOAD_MS,
	) {
		this.#spawnWorker = spawnWorker;
		this.#idleUnloadMs = parseEmbedIdleUnloadMs(idleUnloadMs);
	}

	/**
	 * Re-point the idle window at a configured value. Non-finite or negative
	 * values clamp to 0 (disabling idle unload), matching sibling numeric
	 * settings in `loadMnemopiConfig`. Takes effect immediately: a worker
	 * already sitting idle is re-armed against the new window, and `0` disarms
	 * the timer so the worker lives for the rest of the session.
	 */
	setIdleUnloadMs(value: unknown): void {
		this.#idleUnloadMs = parseEmbedIdleUnloadMs(value);
		this.#cancelIdleTimer();
		this.#armIdleTimer();
	}

	/** The idle window currently in force, in milliseconds. `0` means never unload. */
	get idleUnloadMs(): number {
		return this.#idleUnloadMs;
	}

	/**
	 * Load the named fastembed model inside the subprocess. Resolves to a
	 * thin wrapper whose `embed()` round-trips through the same worker, or
	 * `null` when the worker cannot init the model (missing peer, native
	 * load failure, etc.). Multiple calls with the same model reuse the
	 * single in-flight worker; calling with a different model loads it on
	 * the child without restarting the process.
	 */
	async initialize(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
	): Promise<MnemopiSubprocessEmbeddingModel | null> {
		try {
			const worker = await this.#acquireWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#pending.set(id, { kind: "init", model, resolve });
			try {
				worker.send({ type: "init", id, model, cacheDir });
				const ok = await promise;
				if (!ok) return null;
			} finally {
				this.#pending.delete(id);
				this.#armIdleTimer();
			}
		} catch (error) {
			logger.warn("mnemopi-embed: init failed; local embeddings unavailable for this model", {
				model,
				error: errorMessage(error),
			});
			return null;
		}
		return { embed: (texts, batchSize) => this.#streamEmbed(model, cacheDir, texts, batchSize) };
	}

	/**
	 * Shut the client down: kill the worker and leave the slot empty.
	 *
	 * The guarantee callers depend on — session dispose, `shutdownMnemopiEmbedClient`
	 * — is that nothing survives this call. A request that parked on the kill
	 * inside `#acquireWorker` resumes *before* the await below settles (it
	 * registered on the same promise first) and would otherwise spawn its
	 * ~1.25 GB replacement into the slot we just emptied. `#shutdowns` holds the
	 * door shut for the whole call, so that request rejects instead.
	 */
	async terminate(): Promise<void> {
		this.#shutdowns++;
		try {
			await this.#reap();
		} finally {
			this.#shutdowns--;
		}
	}

	/**
	 * Kill the live worker and settle everything waiting on it, leaving the
	 * client reusable.
	 *
	 * The idle timer and the crash handler reap here rather than through
	 * {@link terminate}: an embed arriving mid-unload must get a fresh worker,
	 * which is the whole point of unloading an idle one.
	 */
	async #reap(): Promise<void> {
		this.#cancelIdleTimer();
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(new Error("mnemopi embed worker terminated"));
		}
		this.#pending.clear();
		if (!worker) {
			await this.#teardown;
			return;
		}
		// Publish the kill BEFORE awaiting it: `#acquireWorker` waits on this
		// promise, so an embed that lands while the subprocess is dying joins the
		// respawn instead of racing a second child into existence.
		const teardown = (async () => {
			try {
				await worker.terminate();
			} catch {
				// Already gone.
			}
		})();
		this.#teardown = teardown;
		try {
			await teardown;
		} finally {
			if (this.#teardown === teardown) this.#teardown = null;
		}
	}

	async #embed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): Promise<number[][]> {
		const worker = await this.#acquireWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<number[][] | Error>();
		this.#pending.set(id, { kind: "embed", model, resolve });
		try {
			// Carry the (model, cacheDir) the wrapper was bound to in every
			// embed message: dispose + respawn between two embeds on the same
			// `LocalEmbeddingModel` handle would otherwise hit a fresh
			// worker's "embed before init" guard. Worker `ensureLoaded` is
			// idempotent so steady-state embeds pay no extra cost.
			worker.send({ type: "embed", id, model, cacheDir, texts, batchSize });
			const result = await promise;
			if (result instanceof Error) throw result;
			return result;
		} finally {
			this.#pending.delete(id);
			this.#armIdleTimer();
		}
	}

	async *#streamEmbed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): AsyncIterable<number[][]> {
		const vectors = await this.#embed(model, cacheDir, texts, batchSize);
		// Mnemopi's `collectMatrix` re-batches via async iteration anyway; yield
		// a single batch carrying the full result so the caller's drain loop
		// behaves identically to the in-process fastembed iterator (one yield
		// per `embed()` call) without paying extra IPC round-trips.
		yield vectors;
	}

	/**
	 * The live worker, spawning one when there is none.
	 *
	 * Async because of the unload race: a reap nulls `#worker` synchronously
	 * and then awaits the kill, so a request landing in that window would
	 * otherwise spawn a second subprocess beside a dying one. It waits out the
	 * teardown in flight and comes back to a clean slot instead.
	 *
	 * The wait is finite: worker-client termination semantics (`createWorkerHandle`
	 * in `subprocess/worker-client.ts`) issue a synchronous SIGKILL without
	 * awaiting process exit, settling on the next microtask. Teardown never
	 * awaits child cooperation or external I/O, so the wait cannot hang. That
	 * invariant is load-bearing and pinned by "never blocks a request longer
	 * than the worker handle's own kill" in the idle-unload suite.
	 */
	async #acquireWorker(): Promise<MnemopiEmbedWorkerHandle> {
		// Disarm first: a request in flight must never be killed under itself,
		// and the `finally` of every request re-arms once the map drains.
		this.#cancelIdleTimer();
		const teardown = this.#teardown;
		if (teardown) await teardown;
		// Re-checked here, AFTER the await, and not only on entry: a request
		// parked on a shutdown's kill resumes inside `terminate()`'s own await,
		// and spawning a replacement there is what left a live ~1.25 GB child
		// behind a completed shutdown. Rejecting settles the request loudly
		// instead; an idle-unload teardown sets no such flag and still respawns.
		if (this.#shutdowns > 0) throw new Error("mnemopi embed client is shutting down");
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	/**
	 * Start the unload countdown once nothing is in flight.
	 *
	 * Armed from the `finally` of every request rather than from a periodic
	 * sweep, so the window is measured from the last completed round-trip. A
	 * non-empty pending map means a request is still awaiting its reply, and
	 * killing the worker there would reject it — the timer waits for the map to
	 * drain instead.
	 */
	#armIdleTimer(): void {
		this.#cancelIdleTimer();
		if (this.#idleUnloadMs === 0) return;
		if (!this.#worker || this.#pending.size > 0) return;
		const timer = setTimeout(() => {
			this.#idleTimer = undefined;
			if (!this.#worker || this.#pending.size > 0) return;
			logger.debug("mnemopi-embed: unloading idle worker", { idleUnloadMs: this.#idleUnloadMs });
			// `#reap`, not `terminate()`: this is an unload, not a shutdown, so a
			// request that lands on the kill still gets its replacement worker.
			void this.#reap();
		}, this.#idleUnloadMs);
		// The unload is an optimisation; it must never be the reason the agent
		// process stays alive at exit.
		timer.unref?.();
		this.#idleTimer = timer;
	}

	#cancelIdleTimer(): void {
		if (!this.#idleTimer) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
	}

	#handleMessage(message: MnemopiEmbedWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.type === "ready") {
			if (pending.kind === "init") pending.resolve(true);
			return;
		}
		if (message.type === "vectors") {
			if (pending.kind === "embed") pending.resolve(message.vectors);
			return;
		}
		logger.debug("mnemopi-embed: worker returned error", { error: message.error });
		if (pending.kind === "init") pending.resolve(false);
		else pending.resolve(new Error(message.error));
	}

	#handleWorkerError(error: Error): void {
		logger.warn("mnemopi-embed: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(error);
		}
		this.#pending.clear();
		// A crashed child is reaped, not shut down: the next request respawns.
		void this.#reap();
	}
}

export const mnemopiEmbedClient = new MnemopiEmbedClient();

export async function shutdownMnemopiEmbedClient(): Promise<void> {
	await mnemopiEmbedClient.terminate();
}

export async function smokeTestMnemopiEmbedWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createMnemopiEmbedSubprocess()), "mnemopi embed worker", timeoutMs);
}
