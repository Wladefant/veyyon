/**
 * Cleanup and postmortem handler utilities.
 *
 * This module provides a system for registering and running cleanup callbacks
 * in response to process exit, signals, or fatal exceptions. It is intended to
 * allow reliably releasing resources or shutting down subprocesses, files, sockets, etc.
 */
// `node:inspector` is NOT imported here. It is reached only by the SIGUSR1 handler below, and
// importing it cost 4.3ms of module evaluation on every launch, because this module is on the
// first-frame path (`@veyyon/tui/terminal` registers its terminal restore through it). `require`
// is the deferred form that stays synchronous inside a signal handler, and the specifier is
// literal, so the bundler still resolves it into the compiled binary.
import type * as inspectorModule from "node:inspector";
import { isMainThread } from "node:worker_threads";
// Import submodules directly, not the "." barrel: the barrel re-exports env.ts,
// whose import-time dotenv load must stay behind the profile bootstrap for
// consumers that import postmortem early (e.g. the JS eval process entry).
import * as logger from "./logger";
import { restoreTerminalStderr } from "./stderr-guard";

// Cleanup reasons, in order of priority/meaning.
export enum Reason {
	PRE_EXIT = "pre_exit", // Pre-exit phase (not used by default)
	EXIT = "exit", // Normal process exit
	SIGINT = "sigint", // Ctrl-C or SIGINT
	SIGTERM = "sigterm", // SIGTERM
	SIGHUP = "sighup", // SIGHUP; on Windows also a closed console window (CTRL_CLOSE_EVENT)
	SIGBREAK = "sigbreak", // Windows Ctrl+Break (CTRL_BREAK_EVENT)
	UNCAUGHT_EXCEPTION = "uncaught_exception", // Fatal exception
	UNHANDLED_REJECTION = "unhandled_rejection", // Unhandled promise rejection
	MANUAL = "manual", // Manual cleanup (not triggered by process)
}

// Internal list of active cleanup callbacks (in registration order)
const callbackList: ((reason: Reason) => Promise<void> | void)[] = [];
// Tracks cleanup run state (to prevent recursion/reentry issues)
let cleanupStage: "idle" | "running" | "complete" = "idle";
const CLEANUP_DEADLINE_MS = 10_000;

/**
 * Internal: runs all registered cleanup callbacks for the given reason.
 * Ensures each callback is invoked at most once. Handles errors and prevents reentrancy.
 *
 * Returns a Promise that settles after all cleanups complete or error out.
 */
function runCleanup(reason: Reason): Promise<void> {
	switch (cleanupStage) {
		case "idle":
			cleanupStage = "running";
			break;
		case "running":
			return Promise.resolve();
		case "complete":
			return Promise.resolve();
	}

	// Call .cleanup() for each callback that is still "armed".
	// Use Promise.try to handle sync/async, but only those armed.
	const promises = callbackList.toReversed().map(callback => {
		return Promise.try(() => callback(reason));
	});

	const cleanupSettled = Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "rejected") {
				const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
				logger.error("Cleanup callback failed", { err, stack: err.stack });
			}
		}
		cleanupStage = "complete";
	});
	const deadline = Promise.withResolvers<void>();
	const deadlineTimer = setTimeout(() => {
		logger.error("Cleanup deadline exceeded; proceeding with exit", { reason });
		cleanupStage = "complete";
		deadline.resolve();
	}, CLEANUP_DEADLINE_MS);
	deadlineTimer.unref();
	return Promise.race([cleanupSettled, deadline.promise]).finally(() => {
		clearTimeout(deadlineTimer);
	});
}

// Register signal and error event handlers to trigger cleanup before exit.
// Main thread: full signal handling (SIGINT, SIGTERM, SIGHUP) + exceptions + exit
// Worker thread: exit only (workers use self.addEventListener for exceptions)
let inspectorOpened = false;

/**
 * Detect an EPIPE rejection that originated from an IPC `send()` to a worker
 * subprocess (`syscall: "send"`), as opposed to a stdin/stdout pipe write
 * (`syscall: "write"`). The owning worker handles recovery. See issue #2997.
 */
export function isIpcSendEpipe(err: Error): boolean {
	const code = (err as { code?: unknown }).code;
	const syscall = (err as { syscall?: unknown }).syscall;
	return code === "EPIPE" && syscall === "send";
}

const stdioErrors = new WeakSet<object>();

function isWriteEpipe(err: unknown): boolean {
	if (err === null || typeof err !== "object") return false;
	const { code, syscall } = err as { code?: unknown; syscall?: unknown };
	return code === "EPIPE" && syscall === "write";
}

/** Only errors observed on our output streams prove a consumer closed them. */
export function isStdioWriteEpipe(err: Error): boolean {
	return isWriteEpipe(err) && stdioErrors.has(err);
}

/**
 * Whether `err` is an ENOSPC ("no space left on device") filesystem error.
 * Disk-full writes from logs, sessions, or artifacts must never be fatal —
 * killing Main discards every running lane. The session can continue even
 * when individual writes fail; disk pressure is transient. See issue #73.
 */
export function isEnospc(err: unknown): boolean {
	if (err === null || typeof err !== "object") return false;
	if (!("code" in err)) return false;
	return err.code === "ENOSPC";
}

/**
 * Detect Bun's advanced-serialization (structured-clone) IPC decode failure.
 *
 * When a worker subprocess spawned with `serialization: "advanced"` sends a
 * malformed or truncated frame, Bun raises the decode failure as a
 * process-level `uncaughtException` in the *parent* rather than routing it to
 * the channel's `ipc()` callback (oven-sh/bun#37287). The error is a bare
 * `TypeError: Unable to deserialize data.` whose only own property is `message`
 * — it carries no `code`, no `syscall`, and no `stack`. Matching all four traits
 * keeps unrelated application `TypeError`s (which always carry a populated
 * multi-frame stack) on the fatal path, so a genuine bug is never silently
 * swallowed.
 *
 * Every advanced-serialization channel in this process is an optional worker
 * subsystem (TTS, STT, tiny-title, mnemopi embeddings, JS eval), so one
 * worker's bad frame must fault only that worker — via its own `onExit`/error
 * path — never tear down the whole session. Callers log-and-continue instead of
 * taking the fatal path. Mirrors {@link isIpcSendEpipe} for the send side
 * (#2997, #9158).
 */
export function isWorkerIpcDeserializeError(err: unknown): boolean {
	return (
		err instanceof TypeError &&
		err.message === "Unable to deserialize data." &&
		!err.stack &&
		!("code" in err) &&
		!("syscall" in err)
	);
}

// Well-known key marking an error as an *expected* teardown artifact (e.g. a
// browser run-scope abort at normal run end). `Symbol.for` so the marker
// survives duplicate module instances across bundles/realms.
const EXPECTED_CLEANUP = Symbol.for("veyyon.expectedCleanupError");

/**
 * Mark an error as expected cleanup fallout so the global fatal handlers
 * downgrade it to a log line instead of tearing down the process. Use for
 * abort reasons fired by routine resource teardown (browser run end, tab
 * close) whose rejections may surface on fire-and-forget promises with no
 * consumer. Returns the same error for inline use at the `abort()` callsite.
 */
export function markExpectedCleanupError<T extends object>(reason: T): T {
	(reason as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] = true;
	return reason;
}

/**
 * Whether `reason` (or any error in its `cause` chain) was marked via
 * {@link markExpectedCleanupError}. Walks the chain because the unhandled
 * reason is often a wrapper (`AbortError`) with the marked abort reason as
 * its `cause`.
 */
export function isExpectedCleanupError(reason: unknown): boolean {
	let current: unknown = reason;
	for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
		if ((current as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] === true) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Interceptors consulted by the global `unhandledRejection` handler before the
 * fatal path. See {@link interceptUnhandledRejections}.
 */
const rejectionInterceptors = new Set<(reason: unknown) => boolean>();

/**
 * Register an interceptor consulted before an unhandled rejection tears the
 * process down. Return `true` to consume the rejection — the interceptor owns
 * reporting and the process continues. Used by embedded script runtimes (JS
 * eval cells) whose user code can float rejections the host must not die for.
 * Returns an unregister function.
 */
export function interceptUnhandledRejections(interceptor: (reason: unknown) => boolean): () => void {
	rejectionInterceptors.add(interceptor);
	return () => rejectionInterceptors.delete(interceptor);
}

function formatFatalError(label: string, err: Error): string {
	const name = err.name || "Error";
	const message = err.message || "(no message)";
	const stack = err.stack || "";
	const stackLines = stack.split("\n").slice(1);
	const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
	return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
}

if (isMainThread) {
	// A syscall alone cannot distinguish child stdin from our own output pipes.
	for (const stream of [process.stdout, process.stderr]) {
		stream.on("error", err => {
			stdioErrors.add(err);
			// The first failure owns shutdown. Teardown can itself emit output
			// errors; re-entering would exit before asynchronous persistence settles.
			if (cleanupStage !== "idle") return;
			process.emit("uncaughtException", err);
		});
	}
	process
		.on("SIGINT", async () => {
			await runCleanup(Reason.SIGINT);
			process.exit(130); // 128 + SIGINT (2)
		})
		.on("SIGUSR1", () => {
			if (inspectorOpened) return;
			inspectorOpened = true;
			const inspector = require("node:inspector") as typeof inspectorModule;
			inspector.open(undefined, undefined, false);
			const url = inspector.url();
			process.stderr.write(`Inspector opened: ${url}\n`);
		})
		.on("uncaughtException", async err => {
			if (isExpectedCleanupError(err)) {
				logger.warn("Ignoring expected cleanup exception", { err });
				return;
			}
			if (isStdioWriteEpipe(err)) {
				if (cleanupStage !== "idle") return;
				logger.info("stdout/stderr pipe closed by consumer; exiting quietly", { err });
				await runCleanup(Reason.EXIT);
				process.exit(0);
			}
			if (isWriteEpipe(err)) {
				logger.warn("Ignoring EPIPE from non-stdio write; owning operation handles failure", { err });
				return;
			}
			// ENOSPC from a log, session, or artifact write must not be fatal —
			// killing Main discards every running lane. Disk pressure is
			// transient; the write's caller handles the local failure. #73.
			if (isEnospc(err)) {
				logger.warn("Disk full (ENOSPC) — degrading gracefully instead of crashing", { err });
				return;
			}
			// A malformed advanced-serialization frame from a worker subprocess
			// surfaces here as a process-level uncaughtException (oven-sh/bun#37287)
			// rather than in the channel's ipc() callback. It is a worker-local
			// fault on the subprocess-isolation boundary, so contain it to that
			// worker: log and continue, letting the owning client detect the dead
			// worker via its own onExit/error path instead of exiting the whole
			// session. Mirrors the ipc-send EPIPE containment below (#9158, #2997).
			if (isWorkerIpcDeserializeError(err)) {
				logger.warn("Ignoring malformed worker IPC frame; optional subsystem will self-recover", { err });
				return;
			}
			// fd 2 may be redirected to the log while a TUI owns the terminal
			// (stderr-guard); re-point it at the real terminal so the fatal
			// report is visible. Terminal modes are restored moments later by
			// the terminal-restore cleanup callback inside runCleanup().
			restoreTerminalStderr();
			process.stderr.write(formatFatalError("Uncaught Exception", err));
			logger.error("Uncaught exception", { err });
			await runCleanup(Reason.UNCAUGHT_EXCEPTION);
			process.exit(1);
		})
		.on("unhandledRejection", async reason => {
			const err = reason instanceof Error ? reason : new Error(String(reason));
			// EPIPE from an IPC `send()` (`syscall: "send"`) originates from a
			// worker subprocess whose pipe broke between the exit being observed
			// and the next `proc.send()` — a race window that Bun surfaces as an
			// async rejection rather than the synchronous "cannot be used after
			// the process has exited" guard. Every `send()` target is an optional
			// worker subsystem (TTS, STT, tiny-title, MCP servers), so a broken
			// send pipe must never take down the whole session. Log and continue
			// instead of exiting; the owning client detects the dead worker via
			// its own `onExit`/error path and respawns or disables it. See #2997.
			if (isIpcSendEpipe(err)) {
				logger.warn("Ignoring EPIPE from worker IPC send; optional subsystem will self-recover", { err });
				return;
			}
			if (isExpectedCleanupError(reason)) {
				logger.warn("Ignoring expected cleanup rejection", { err });
				return;
			}
			// Async stdout/stderr writes surface consumer-closed pipes here.
			if (isStdioWriteEpipe(err)) {
				if (cleanupStage !== "idle") return;
				logger.info("stdout/stderr pipe closed by consumer; exiting quietly", { err });
				await runCleanup(Reason.EXIT);
				process.exit(0);
			}
			if (isWriteEpipe(reason)) {
				logger.warn("Ignoring EPIPE from non-stdio write; owning operation handles failure", { err: reason });
				return;
			}
			// ENOSPC: same rationale as the uncaughtException guard above. #73.
			if (isEnospc(reason)) {
				logger.warn("Disk full (ENOSPC) — degrading gracefully instead of crashing", { err });
				return;
			}
			for (const interceptor of rejectionInterceptors) {
				try {
					if (interceptor(reason)) return;
				} catch (interceptorErr) {
					logger.warn("Unhandled-rejection interceptor threw; continuing with fatal path", {
						err: interceptorErr,
					});
				}
			}
			// See uncaughtException above: surface the report on the real stderr.
			restoreTerminalStderr();
			process.stderr.write(formatFatalError("Unhandled Rejection", err));
			logger.error("Unhandled rejection", { err });
			await runCleanup(Reason.UNHANDLED_REJECTION);
			process.exit(1);
		})
		.on("exit", async () => {
			void runCleanup(Reason.EXIT); // fire and forget (exit imminent)
		})
		.on("SIGTERM", async () => {
			await runCleanup(Reason.SIGTERM);
			process.exit(143); // 128 + SIGTERM (15)
		})
		.on("SIGHUP", async () => {
			// On Windows libuv raises this for CTRL_CLOSE_EVENT and then holds the
			// console's control thread, so the few seconds Windows allows before it
			// terminates the process are ours to record the exit in.
			await runCleanup(Reason.SIGHUP);
			process.exit(129); // 128 + SIGHUP (1)
		});
	if (process.platform === "win32") {
		// Ctrl+Break is delivered even while the terminal reads Ctrl+C as input.
		// With no listener libuv declines it and Windows ends the process from the
		// control thread: no JavaScript, no exit record (veyyon#73).
		process.on("SIGBREAK", async () => {
			await runCleanup(Reason.SIGBREAK);
			process.exit(149); // 128 + SIGBREAK (21)
		});
	}
} else {
	// Worker thread: only register exit handler for cleanup.
	// DO NOT register uncaughtException/unhandledRejection handlers here -
	// they would swallow errors before the worker's own handlers (self.addEventListener)
	// can report failures back to the parent thread.
	process.on("exit", () => {
		void runCleanup(Reason.EXIT);
	});
}

/**
 * Register a process cleanup callback, to be run on shutdown, signal, or fatal error.
 *
 * Returns a Callback instance that can be used to cancel (unregister) or manually clean up.
 * If register is called after cleanup already began, invokes callback on a microtask.
 */
export function register(id: string, callback: (reason: Reason) => void | Promise<void>): () => void {
	let done = false;
	const exec = (reason: Reason) => {
		if (done) return;
		done = true;
		try {
			return callback(reason);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
	};

	const cancel = () => {
		const index = callbackList.indexOf(exec);
		if (index >= 0) {
			callbackList.splice(index, 1);
		}
		done = true;
	};

	if (cleanupStage !== "idle") {
		// Cleanup is already in progress or complete; run late registrations once
		// without re-entering the global cleanup pass.
		logger.debug("Cleanup already started; running late callback once", { id });
		try {
			callback(Reason.MANUAL);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
		return () => {};
	}

	// Register callback as "armed" (active).
	callbackList.push(exec);
	return cancel;
}

/**
 * Runs all cleanup callbacks without exiting.
 * Use this in workers or when you need to clean up but continue execution.
 */
export function cleanup(): Promise<void> {
	return runCleanup(Reason.MANUAL);
}

/** Controls how manual process shutdown handles terminal output. */
export interface QuitOptions {
	/** Wait for buffered stdout before exiting; disable after the terminal has disconnected. */
	drainStdout?: boolean;
}

/**
 * Runs all cleanup callbacks and exits.
 *
 * In main thread: waits for stdout drain unless disabled, then calls process.exit().
 * In workers: runs cleanup only (process.exit would kill entire process).
 */
export async function quit(code: number = 0, options: QuitOptions = {}): Promise<void> {
	await runCleanup(Reason.MANUAL);

	if (!isMainThread) {
		return; // Workers: cleanup done, let worker exit naturally
	}

	if (options.drainStdout !== false && process.stdout.writableLength > 0) {
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stdout.once("drain", resolve);
		await Promise.race([promise, Bun.sleep(5000)]);
	}
	process.exit(code);
}
