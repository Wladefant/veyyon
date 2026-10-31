// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/standalone builds only need one JavaScript entry.
import { registerOwnedResourceDisposer } from "@veyyon/kernel/session/owned-resources";
import { errorMessage, logger, postmortem, Snowflake, workerHostEntry } from "@veyyon/utils";
import { raceWithTimeout } from "@veyyon/utils/scoped-timeout";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import { logWorkerMessage } from "../../subprocess/worker-log";
import type { ToolSession } from "../../tools";
import { ToolAbortError, ToolError } from "../../tools/core/tool-errors";
import { safeSend as safeSendIpc } from "../../utils/ipc";
import { JS_EVAL_PROCESS_ARG, JS_EVAL_WORKER_ARG } from "../../worker-args";
import { attachSessionOwner } from "../executor-base";
import { shouldDetachKernel } from "../py/spawn-options";
import { errorFromPayload, toErrorPayload } from "./error-payload";
import { callSessionTool, type JsStatusEvent } from "./tool-bridge";
import { WorkerCore } from "./worker-core";
import type {
	EvalWorkerInbound,
	EvalWorkerOutbound,
	EvalWorkerTransport,
	JsDisplayOutput,
	SessionSnapshot,
} from "./worker-protocol";

export { rewriteImports, wrapCode } from "./shared/rewrite-imports";
export type { JsDisplayOutput } from "./worker-protocol";

export interface VmRunState {
	signal?: AbortSignal;
	onText?: (chunk: string) => void;
	onDisplay?: (output: JsDisplayOutput) => void;
}

interface WorkerHandle {
	mode: "process" | "worker" | "inline";
	send(msg: EvalWorkerInbound): void;
	onMessage(handler: (msg: EvalWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	close(): Promise<boolean>;
	terminate(): Promise<void>;
}

interface PendingRun {
	runId: string;
	runState: VmRunState;
	toolSession: ToolSession;
	resolve(value: { value: unknown }): void;
	reject(error: Error): void;
	toolCalls: Map<string, AbortController>;
	settled: boolean;
}

interface JsSession {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	worker: WorkerHandle;
	state: "alive" | "dead";
	pending: Map<string, PendingRun>;
	/**
	 * Agent-session owners keeping this VM context alive. A context is disposed
	 * when its LAST owner detaches (see {@link disposeVmContextsByOwner}), mirroring
	 * the python/ruby/julia kernels. Without this, the JS eval subprocess was never
	 * reaped on session end (it has no by-owner or postmortem disposal), so
	 * `__veyyon_worker_js_eval_process` leaked across sessions (BACKLOG GRAN-11).
	 */
	ownerIds: Set<string>;
	/** True while the only owner is the fallback `sessionKey` (no real owner attached yet). */
	hasFallbackOwner: boolean;
}

const sessions = new Map<string, JsSession>();
const startingSessions = new Map<string, Promise<JsSession>>();
const resettingSessions = new Map<string, Promise<void>>();

/**
 * An `executeInVmContext` call that has named its owner but has not attached it to a session yet.
 * It is recorded before the first await, so disposal sees an owner that ends during a reset or a
 * startup. Once `ended`, the owner is never attached.
 */
interface OwnerLease {
	sessionKey: string;
	ownerId: string | undefined;
	ended: boolean;
}
const ownerLeases = new Set<OwnerLease>();
// Worker startup (module-graph import + WorkerCore construction) is infrastructure
// cost, not user compute. Floor it independently of Bun's 5s default per-test timeout
// so a slow cold-start under load isn't aborted mid-init — terminating a still-
// initializing eval runtime triggers the same kind of terminate-race that motivates
// avoiding `vm.runInContext` (see shared/indirect-eval.ts), here surfacing as a
// SIGILL/SIGSEGV. Callers that pass a larger per-cell budget still dominate.
const WORKER_INIT_TIMEOUT_MS = 15_000;
const WORKER_CLOSE_TIMEOUT_MS = 1_000;
// Active graceful-close grace period before a worker that ack'd `close` but never
// emitted its `close` event is force-terminated. Defaults to the production floor;
// tests override it (and restore it) to exercise the close-timeout -> terminate
// path without a real wall-clock wait.
let workerCloseTimeoutMs: number = WORKER_CLOSE_TIMEOUT_MS;
let useWorkerThreadForTests = false;

/**
 * Test-only seam: override the graceful-close grace period (ms). Returns the
 * previous value so callers can restore it. Production always uses
 * {@link WORKER_CLOSE_TIMEOUT_MS}; never call this outside tests.
 */
export function setWorkerCloseTimeoutMsForTests(ms: number): number {
	const previous = workerCloseTimeoutMs;
	workerCloseTimeoutMs = ms;
	return previous;
}

/** Test-only seam for the legacy Worker lifecycle mocks. */
export function setJsEvalWorkerThreadForTests(enabled: boolean): boolean {
	const previous = useWorkerThreadForTests;
	useWorkerThreadForTests = enabled;
	return previous;
}

interface VmExecuteOptions {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	session: ToolSession;
	localRoots?: Record<string, string>;
	artifactsDir?: string | null;
	reset?: boolean;
	code: string;
	filename: string;
	timeoutMs?: number;
	runState: VmRunState;
	/**
	 * Agent-session that owns this context. When set, the context is reaped when
	 * that owner's session ends (see {@link disposeVmContextsByOwner}); when unset,
	 * the context falls back to being owned by its own `sessionKey`.
	 */
	ownerId?: string;
}

export async function executeInVmContext(options: VmExecuteOptions): Promise<{ value: unknown }> {
	// Record the owner before the first await. Reset coalescing and startup both yield,
	// and an owner that ends in either window must still be visible to disposal.
	const lease: OwnerLease = { sessionKey: options.sessionKey, ownerId: options.ownerId, ended: false };
	ownerLeases.add(lease);
	const session = await acquireOwnedSession(options, lease).finally(() => ownerLeases.delete(lease));
	return await runOnce(session, options);
}

/**
 * Coalesce an in-flight reset, then start or join the context. The owner is attached in the same
 * synchronous step that checks the lease, so disposal never sees an owner that is neither leased
 * nor attached. A lease that ended while this call waited is not attached: the context is reaped
 * here unless another live owner still needs it.
 */
async function acquireOwnedSession(options: VmExecuteOptions, lease: OwnerLease): Promise<JsSession> {
	if (options.reset) {
		// Coalesce concurrent resets: an existing in-flight reset already
		// produces a fresh context, so a follow-up `reset: true` cell should
		// just wait for it rather than failing the user-visible call.
		const inFlight = resettingSessions.get(options.sessionKey);
		// Another caller owns this reset and is awaiting `resetPromise` itself, so its failure is reported
		// there. Here the only thing that matters is that the reset has SETTLED before running on the
		// context: if it failed, `acquireSession` below starts a fresh one and fails with its own reason.
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetVmContext(options.sessionKey);
			resettingSessions.set(
				options.sessionKey,
				resetPromise.then(() => undefined),
			);
			try {
				await resetPromise;
			} finally {
				resettingSessions.delete(options.sessionKey);
			}
		}
	} else {
		// Internal coordination: wait for any in-flight reset to settle and
		// then run on the freshly-rebuilt context.
		const inFlight = resettingSessions.get(options.sessionKey);
		// Another caller owns this reset and is awaiting `resetPromise` itself, so its failure is reported
		// there. Here the only thing that matters is that the reset has SETTLED before running on the
		// context: if it failed, `acquireSession` below starts a fresh one and fails with its own reason.
		if (inFlight) await inFlight.catch(() => undefined);
	}
	// The owner ended while it waited for a reset: do not start a worker for it.
	if (lease.ended) throw new ToolError("JS context disposed");
	const session = await acquireSession(
		options.sessionKey,
		{
			cwd: options.cwd,
			sessionId: options.sessionId,
			localRoots: options.localRoots,
			artifactsDir: options.artifactsDir,
		},
		options.timeoutMs,
	);
	if (lease.ended) {
		// The owner ended during startup. Reap the context unless another live owner still needs it.
		await releaseIfUnowned(session);
		throw new ToolError("JS context disposed");
	}
	// Synchronous with the lease check above: no disposal can run between the check and the attach.
	attachSessionOwner(session, options.sessionId, options.ownerId);
	return session;
}

/** Reap a context that no owner needs: no attached owner and no live lease for its key. */
async function releaseIfUnowned(session: JsSession): Promise<void> {
	if (session.ownerIds.size > 0 || hasLiveOwnerLease(session.sessionKey)) return;
	if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	await killSession(session, new ToolError("JS context disposed"), { force: false });
}

function hasLiveOwnerLease(sessionKey: string): boolean {
	for (const lease of ownerLeases) {
		if (lease.sessionKey === sessionKey && !lease.ended) return true;
	}
	return false;
}

export async function resetVmContext(sessionKey: string): Promise<void> {
	// A start that failed leaves nothing to reset, and its failure belongs to the caller awaiting the start.
	const session = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.catch(() => undefined));
	if (!session) return;
	sessions.delete(sessionKey);
	await killSession(session, new ToolError("JS context reset"), { force: false });
}

export async function disposeAllVmContexts(): Promise<void> {
	const pending = Array.from(startingSessions.values());
	startingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = Array.from(sessions.values());
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		if (!all.includes(result.value)) all.push(result.value);
	}
	sessions.clear();
	await Promise.all(all.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })));
}

/**
 * Dispose the JS VM contexts owned by `ownerId`, reaping the underlying eval
 * worker/subprocess. A context is killed only when `ownerId` is its LAST owner;
 * a context shared by another live owner just drops this owner. Mirrors
 * {@link disposeKernelSessionsByOwner} for python so a session's end reaps its JS
 * eval worker too, instead of leaking `__veyyon_worker_js_eval_process` for the
 * life of the parent process (BACKLOG GRAN-11).
 */
export async function disposeVmContextsByOwner(ownerId: string): Promise<void> {
	// Mark the owner's leases first, synchronously: a call still waiting on a reset or a startup must
	// not attach an owner that has gone. Disposal never awaits a startup, so a hung worker cannot stall
	// the caller; that startup reaps itself when it settles.
	for (const lease of ownerLeases) {
		if (lease.ownerId === ownerId) lease.ended = true;
	}
	const toKill: JsSession[] = [];
	for (const session of Array.from(sessions.values())) {
		if (!session.ownerIds.has(ownerId)) continue;
		// Kill only when ownerId is the last attached owner AND no live lease still names this context.
		// A call that leased this key before its attach yields at acquireSession; it must find the
		// context alive. Its own attach or release decides the context's fate.
		if (session.ownerIds.size === 1 && !hasLiveOwnerLease(session.sessionKey)) {
			toKill.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	for (const session of toKill) {
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	}
	await Promise.all(
		toKill.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })),
	);
}

/**
 * Smoke probe: spawn the JS evaluator through the worker-host entry and prove
 * it answers the `init` handshake in a real isolated subprocess (not the inline
 * fallback). Catches silent process-load and init-message regressions
 * that otherwise strand every cell on the init timeout in a distribution build —
 * the failure mode that motivated `installWorkerInbox`. Wired into
 * `veyyon --smoke-test` so binary / source / tarball installs all exercise it.
 */
export async function smokeTestJsEvalWorker(): Promise<void> {
	const worker = spawnJsWorker();
	const session: JsSession = {
		sessionKey: "smoke",
		sessionId: "smoke",
		cwd: process.cwd(),
		worker,
		state: "alive",
		pending: new Map(),
		ownerIds: new Set(),
		hasFallbackOwner: false,
	};
	try {
		await initWorker(session, { cwd: process.cwd(), sessionId: "smoke" }, WORKER_INIT_TIMEOUT_MS);
		if (worker.mode !== "process") {
			throw new Error("JS eval worker smoke fell back from the isolated subprocess");
		}
	} finally {
		await terminateJsWorker(worker, "smoke-test");
	}
}

/**
 * Terminate a JS eval worker, in one place.
 *
 * Every caller is tearing the session down: the startup smoke test in its `finally`, a forced kill, and the
 * graceful path's fallback after `close()` declined. None of them can throw, because each either raises its
 * own error (the smoke test's "fell back from the isolated subprocess") or is killing a session that is
 * already marked dead and whose pending calls have already been rejected.
 *
 * A terminate that fails is still worth a line: a subprocess-mode worker that will not stop keeps a
 * JavaScript runtime alive for the rest of the session, holding its cwd and any file handles it opened.
 */
async function terminateJsWorker(worker: Pick<WorkerHandle, "terminate">, context: string): Promise<void> {
	try {
		await worker.terminate();
	} catch (error) {
		logger.warn("JS eval worker did not terminate", { context, error: errorMessage(error) });
	}
}

async function runOnce(
	session: JsSession,
	options: {
		sessionId: string;
		cwd: string;
		session: ToolSession;
		localRoots?: Record<string, string>;
		artifactsDir?: string | null;
		code: string;
		filename: string;
		runState: VmRunState;
	},
): Promise<{ value: unknown }> {
	const runId = `r-${Snowflake.next()}`;
	const { promise, resolve, reject } = Promise.withResolvers<{ value: unknown }>();
	const pending: PendingRun = {
		runId,
		runState: options.runState,
		toolSession: options.session,
		resolve,
		reject,
		toolCalls: new Map(),
		settled: false,
	};
	session.pending.set(runId, pending);

	const onAbort = (): void => {
		const reason = options.runState.signal?.reason;
		const abortError = reasonToError(reason, "Execution aborted");
		// Cancel any in-flight tool calls first.
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(abortError);
		// Hard-kill the worker — only way to interrupt synchronous user code.
		void killSessionFor(session, abortError, { force: true });
	};

	if (options.runState.signal?.aborted) {
		queueMicrotask(onAbort);
	} else {
		options.runState.signal?.addEventListener("abort", onAbort, { once: true });
	}

	try {
		session.worker.send({
			type: "run",
			runId,
			code: options.code,
			filename: options.filename,
			snapshot: {
				cwd: options.cwd,
				sessionId: options.sessionId,
				localRoots: options.localRoots,
				artifactsDir: options.artifactsDir,
			},
		});
		return await promise;
	} finally {
		options.runState.signal?.removeEventListener("abort", onAbort);
		session.pending.delete(runId);
	}
}

async function acquireSession(sessionKey: string, snapshot: SessionSnapshot, timeoutMs?: number): Promise<JsSession> {
	const existing = sessions.get(sessionKey);
	if (existing && existing.state === "alive") {
		existing.sessionId = snapshot.sessionId;
		existing.cwd = snapshot.cwd;
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) return await starting;

	const startup = (async (): Promise<JsSession> => {
		// Attach the message listener before sending init. Both Bun Worker messages
		// and subprocess IPC can arrive immediately after the evaluator loads.
		const worker = spawnJsWorker();
		const session: JsSession = {
			sessionKey,
			sessionId: snapshot.sessionId,
			cwd: snapshot.cwd,
			worker,
			state: "alive",
			pending: new Map(),
			ownerIds: new Set(),
			hasFallbackOwner: false,
		};
		// Init headroom is the fixed infrastructure floor; the caller's per-cell timeout
		// dominates when larger so users can grant more by raising `timeout` on a cell.
		const readyTimeoutMs = Math.max(WORKER_INIT_TIMEOUT_MS, timeoutMs ?? 0);
		while (true) {
			try {
				await initWorker(session, snapshot, readyTimeoutMs);
				break;
			} catch (error) {
				// Runtime crash/load failures surface asynchronously via the runtime's
				// error callback, after the synchronous spawn try/catch has returned.
				// Preserve the full process -> Worker -> inline ladder for those failures.
				const failed = session.worker;
				await failed.terminate().catch(() => undefined);
				if (failed.mode === "inline") throw error;
				if (failed.mode === "process") {
					logger.warn("JS eval subprocess init failed; retrying with a Bun Worker", {
						error: errorMessage(error),
					});
					session.worker = spawnBunWorker();
				} else {
					logger.warn("JS eval worker init failed; retrying with inline worker (no sync-loop guard)", {
						error: errorMessage(error),
					});
					session.worker = spawnInlineWorker();
				}
				session.state = "alive";
			}
		}
		if (!hasLiveOwnerLease(sessionKey)) {
			// Every call that asked for this context ended while it started. Publish nothing and reap the worker.
			await killSession(session, new ToolError("JS context disposed"), { force: false });
			throw new ToolError("JS context disposed");
		}
		sessions.set(sessionKey, session);
		return session;
	})();
	startingSessions.set(sessionKey, startup);
	try {
		return await startup;
	} finally {
		if (startingSessions.get(sessionKey) === startup) startingSessions.delete(sessionKey);
	}
}

async function initWorker(session: JsSession, snapshot: SessionSnapshot, timeoutMs: number): Promise<void> {
	const worker = session.worker;
	const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	let resolved = false;
	const unsubscribeMessage = worker.onMessage(msg => {
		if (!resolved && msg.type === "ready") {
			resolved = true;
			resolveReady();
			return;
		}
		if (!resolved && msg.type === "init-failed") {
			resolved = true;
			rejectReady(errorFromPayload(msg.error));
			return;
		}
		handleSessionMessage(session, msg);
	});
	const unsubscribeError = worker.onError(error => {
		if (!resolved) {
			resolved = true;
			rejectReady(error);
			return;
		}
		// Worker died after a successful handshake: tear the session down so the
		// in-flight run (and the next acquire) fail fast instead of hanging on a
		// worker that will never reply.
		void killSessionFor(session, error, { force: true });
	});
	try {
		// Attach listeners and send init before awaiting ready. The worker now
		// emits ready only in response to init, so this ordering is race-free.
		worker.send({ type: "init", snapshot });
		await raceWithTimeout(readyPromise, timeoutMs, () => new ToolError("Timed out initializing JS eval worker"));
	} catch (error) {
		// Handshake failed (timeout, init-failed, or worker error): drop both listeners
		// so the abandoned worker can't keep routing messages into a session the caller
		// is about to discard or retry on the inline fallback.
		unsubscribeMessage();
		unsubscribeError();
		throw error;
	}
}

function handleSessionMessage(session: JsSession, msg: EvalWorkerOutbound): void {
	switch (msg.type) {
		case "text": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onText?.(msg.chunk);
			return;
		}
		case "display": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onDisplay?.(msg.output);
			return;
		}
		case "tool-call":
			void handleToolCall(session, msg);
			return;
		case "result":
			settlePending(session, msg);
			return;
		case "log":
			logWorkerMessage(msg);
			return;
		case "ready":
		case "init-failed":
		case "closed":
			return;
	}
}

async function handleToolCall(
	session: JsSession,
	msg: Extract<EvalWorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = session.pending.get(msg.runId);
	if (!pending) {
		safeSend(session, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: { message: "Run no longer active" } },
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.toolSession,
			entry: "cli.worker",
			signal: ctrl.signal,
			emitStatus: (event: JsStatusEvent) => pending.runState.onDisplay?.({ type: "status", event }),
		});
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
	}
}

function settlePending(session: JsSession, msg: Extract<EvalWorkerOutbound, { type: "result" }>): void {
	const pending = session.pending.get(msg.runId);
	if (!pending || pending.settled) return;
	pending.settled = true;
	if (msg.ok) {
		pending.resolve({ value: undefined });
		return;
	}
	pending.reject(errorFromPayload(msg.error));
}

async function killSessionFor(session: JsSession, error: Error, options: { force: boolean }): Promise<void> {
	if (sessions.get(session.sessionKey) === session) {
		sessions.delete(session.sessionKey);
	}
	await killSession(session, error, options);
}

async function killSession(session: JsSession, error: Error, options: { force: boolean }): Promise<void> {
	if (session.state === "dead") return;
	session.state = "dead";
	for (const pending of session.pending.values()) {
		if (pending.settled) continue;
		pending.settled = true;
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
		pending.reject(error);
	}
	session.pending.clear();
	if (options.force) {
		await terminateJsWorker(session.worker, "kill-forced");
		return;
	}
	// `close()` resolving false means the worker declined to shut down cleanly, which is an expected outcome
	// and not a failure; a THROW means the close could not be attempted, and both lead to the same terminate
	// below, so the distinction changes nothing here. The terminate reports for both.
	const closed = await session.worker.close().catch(() => false);
	if (closed) return;
	await terminateJsWorker(session.worker, "kill-graceful-fallback");
}

function safeSend(session: JsSession, msg: EvalWorkerInbound): void {
	if (session.state !== "alive") return;
	try {
		session.worker.send(msg);
	} catch (err) {
		logger.debug("js worker send failed", { error: errorMessage(err) });
	}
}

function reasonToError(reason: unknown, fallback: string): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new ToolAbortError(reason);
	return new ToolAbortError(fallback);
}

function spawnJsWorker(): WorkerHandle {
	if (!useWorkerThreadForTests) {
		try {
			return spawnJsProcess();
		} catch (err) {
			// Fall through to the Bun Worker rung: a worker thread still interrupts
			// synchronous infinite loops via terminate(), which the inline fallback
			// cannot.
			logger.warn("JS eval subprocess spawn failed; falling back to a Bun Worker", {
				error: errorMessage(err),
			});
		}
	}
	return spawnBunWorker();
}

function spawnBunWorker(): WorkerHandle {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: [JS_EVAL_WORKER_ARG] })
			: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline JS eval worker (no sync-loop guard)", {
			error: errorMessage(err),
		});
		return spawnInlineWorker();
	}
}

function spawnJsProcess(): WorkerHandle {
	const spawned = createWorkerSubprocess<EvalWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(JS_EVAL_PROCESS_ARG),
		env: workerEnvFromParent(),
		exitLabel: "JS eval worker",
		detached: shouldDetachKernel(process.platform),
		reportCleanExit: true,
		unref: false,
	});
	const base = createWorkerHandle<EvalWorkerInbound, EvalWorkerOutbound>(spawned, message =>
		safeSendIpc(spawned.proc, message, "js-eval"),
	);
	return {
		mode: "process",
		send: message => base.send(message),
		onMessage: handler => base.onMessage(handler),
		onError: handler => base.onError(handler),
		close: () =>
			awaitCloseAck(
				ack =>
					base.onMessage(message => {
						if (message.type !== "closed") return;
						void base.terminate().finally(ack);
					}),
				() => base.send({ type: "close" }),
			),
		terminate: () => base.terminate(),
	};
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg) {
			worker.postMessage(msg);
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as EvalWorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`JS eval worker message error: ${String(event.data)}`));
			const onClose = (): void => handler(new Error("JS eval worker exited"));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			worker.addEventListener("close", onClose);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
				worker.removeEventListener("close", onClose);
			};
		},
		close() {
			return awaitCloseAck(
				ack => {
					// Done only once the worker has acknowledged `close` AND its thread has exited.
					let sawClosedAck = false;
					let sawWorkerExit = false;
					const finishIfClosed = (): void => {
						if (sawClosedAck && sawWorkerExit) ack();
					};
					const onClose = (): void => {
						sawWorkerExit = true;
						finishIfClosed();
					};
					const unsubscribe = this.onMessage(msg => {
						if (msg.type !== "closed") return;
						sawClosedAck = true;
						finishIfClosed();
					});
					worker.addEventListener("close", onClose);
					return () => {
						unsubscribe();
						worker.removeEventListener("close", onClose);
					};
				},
				() => worker.postMessage({ type: "close" } satisfies EvalWorkerInbound),
			);
		},
		async terminate() {
			worker.terminate();
		},
	};
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown JS eval worker error");
}

/**
 * Inline fallback for environments where Bun cannot spawn the worker entry
 * (e.g. some test runners). Preserves behavior but cannot interrupt synchronous
 * infinite loops because user code runs on the main thread.
 */
function spawnInlineWorker(): WorkerHandle {
	const hostListeners = new Set<(message: EvalWorkerOutbound) => void>();
	const workerListeners = new Set<(message: EvalWorkerInbound) => void>();
	const workerTransport: EvalWorkerTransport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg);
			}),
		onMessage: handler => {
			workerListeners.add(handler);
			return () => workerListeners.delete(handler);
		},
		close: () => {},
	};
	const core = new WorkerCore(workerTransport, {
		mode: "inline",
		interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
	});
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		close() {
			return awaitCloseAck(
				ack => {
					const unsubscribe = this.onMessage(msg => {
						if (msg.type === "closed") ack();
					});
					return () => {
						unsubscribe();
						hostListeners.clear();
						workerListeners.clear();
					};
				},
				() => this.send({ type: "close" }),
			);
		},
		async terminate() {
			hostListeners.clear();
			workerListeners.clear();
			core.dispose();
		},
	};
}

/**
 * Wire this subsystem into the session's owner-scoped cleanup.
 *
 * Registered at module scope rather than called by name from `agent-session.dispose()`, which is
 * what used to happen. See `session/owned-resources.ts` for why load-time registration is safe
 * here: a kernel cannot exist unless this module was loaded to create it.
 */
registerOwnedResourceDisposer({
	name: "js-eval-contexts",
	scope: "eval-kernel-owner",
	dispose: disposeVmContextsByOwner,
});
postmortem.register("js-eval-cleanup", disposeAllVmContexts);
