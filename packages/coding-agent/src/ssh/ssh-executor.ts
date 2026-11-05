import { randomBytes } from "node:crypto";
import { logger, ptree } from "@veyyon/utils";
import { Settings } from "../config/settings";
import { primarySessionCpuAdoption } from "../session/cpu-limit";
import { LIVE_OUTPUT_INTERVAL_MS, OutputSink, type OutputSummary } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/core/output-meta";
import {
	buildRemoteCommand,
	ensureConnection,
	ensureHostInfo,
	type SSHConnectionTarget,
	type SSHHostInfo,
} from "./connection-manager";
import { hasSshfs, mountRemote } from "./sshfs-mount";
import { wrapInPosixShell } from "./utils";

export interface SSHExecutorOptions {
	/** Timeout in milliseconds */
	timeout?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Remote path to mount when sshfs is available */
	remotePath?: string;
	/** Wrap commands in a POSIX shell for compat mode */
	compatEnabled?: boolean;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * How many bytes of output may stay inline, from the caller's session. See
	 * the same field on `BashExecutorOptions`: the executor has no session, so
	 * the caller prices it through the one owner and passes the number down.
	 */
	spillThreshold?: number;
}

export interface SSHResult extends OutputSummary {
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
}

type SSHExitEvent = { kind: "exit"; exitCode: number } | { kind: "error"; error: unknown };
type SSHEvent = SSHExitEvent | { kind: "detach"; exitCode: number };

function sshExitEvent(exitCode: number): SSHExitEvent {
	return { kind: "exit", exitCode };
}

function sshErrorEvent(error: unknown): SSHExitEvent {
	return { kind: "error", error };
}

/**
 * How long the session may stay open after the remote command has exited. The
 * channel closes in the same stream right behind the exit marker, so a session
 * still open after this is held by a background process.
 */
const EXIT_MARKER_GRACE_MS = 250;
/** Bytes after the marker prefix up to its newline: `:` is in the prefix, then at most three status digits. */
const EXIT_MARKER_STATUS_MAX_BYTES = 4;
/**
 * The marker's first byte, ASCII record separator. Text output almost never
 * ends a chunk with it, so stripping holds back nearly nothing; a newline
 * would hold back the end of every line and reorder it behind stderr.
 */
const MARKER_START = 0x1e;
const NEWLINE = 0x0a;

const DETACHED_NOTICE =
	"SSH: The command exited while a background process still held its output; the session closed without waiting for that process. It keeps running unless it writes to that output, which ends it with SIGPIPE. Redirect its output to a file to keep it running.";

/** The remote login shell parses a POSIX subshell and `printf`, so the command can report its own exit. */
function reportsExit(info: SSHHostInfo): boolean {
	return info.os !== "windows" && (info.shell === "bash" || info.shell === "zsh" || info.shell === "sh");
}

function parseStatus(data: Buffer, start: number, end: number): number | undefined {
	if (end <= start || end - start > 3) return undefined;
	let status = 0;
	for (let i = start; i < end; i++) {
		const digit = data[i] - 0x30;
		if (digit < 0 || digit > 9) return undefined;
		status = status * 10 + digit;
	}
	return status <= 255 ? status : undefined;
}

type MarkerScan =
	| { kind: "none" }
	| { kind: "partial"; start: number }
	| { kind: "marker"; start: number; end: number; status: number };

/**
 * Reports when the remote command exits, which the ssh client cannot: the
 * client returns when the channel closes, and the channel stays open while any
 * remote process still holds the command's stdout or stderr. A job started as
 * `cd dir && nohup job > log 2>&1 &` is such a process, because the `&`
 * backgrounds the whole `&&` list in a subshell that keeps both.
 *
 * The command runs in a subshell, and the login shell then prints
 * `\x1e__veyyon_exit_<token>:<status>\n` on its own stdout, so an
 * `exec >file` or an EXIT trap in the command neither moves nor suppresses it.
 * The token is random per call and the command text separates it from the
 * prefix, so an echo of the command line does not match.
 */
class ExitMarker {
	readonly #token = randomBytes(8).toString("hex");
	readonly #needle = Buffer.from(`\x1e__veyyon_exit_${this.#token}:`);
	readonly #exited = Promise.withResolvers<number>();
	#seen = false;

	/** Resolves with the remote command's exit status when its marker arrives. */
	get exited(): Promise<number> {
		return this.#exited.promise;
	}

	/**
	 * The command starts on the subshell's first line so remote error messages
	 * keep its line numbers; the space keeps a leading `(` from forming `((`.
	 */
	wrap(command: string): string {
		return `( ${command}\n)\n__veyyon_status=$?\nprintf '\\036%s%s:%s\\n' __veyyon_exit_ ${this.#token} "$__veyyon_status"\nexit "$__veyyon_status"`;
	}

	/** Removes the marker from stdout. Only bytes that may begin a marker wait for the next chunk. */
	strip(): TransformStream<Uint8Array, Uint8Array> {
		const needle = this.#needle;
		let held: Buffer | undefined;
		return new TransformStream<Uint8Array, Uint8Array>({
			transform: (chunk, controller) => {
				let data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
				if (held) {
					const probe = Buffer.concat([held, data.subarray(0, needle.length + EXIT_MARKER_STATUS_MAX_BYTES)]);
					const scan = this.#scan(probe, 0);
					if (scan.kind === "marker" && scan.start === 0) {
						this.#record(scan.status);
						data = data.subarray(scan.end - held.length);
						held = undefined;
					} else if (scan.kind === "partial" && scan.start === 0 && probe.length === held.length + data.length) {
						held = probe;
						return;
					} else {
						controller.enqueue(held);
						held = undefined;
					}
				}
				let from = 0;
				for (;;) {
					const scan = this.#scan(data, from);
					if (scan.kind === "none") {
						if (from < data.length) controller.enqueue(from === 0 ? data : data.subarray(from));
						return;
					}
					if (scan.start > from) controller.enqueue(data.subarray(from, scan.start));
					if (scan.kind === "partial") {
						held = Buffer.from(data.subarray(scan.start));
						return;
					}
					this.#record(scan.status);
					from = scan.end;
				}
			},
			flush: controller => {
				if (held) controller.enqueue(held);
			},
		});
	}

	/** The first marker at or after `from`, or the start of a marker cut off by the end of `data`. */
	#scan(data: Buffer, from: number): MarkerScan {
		const needle = this.#needle;
		for (let at = data.indexOf(needle, from); at >= 0; at = data.indexOf(needle, at + 1)) {
			const statusStart = at + needle.length;
			const end = data.indexOf(NEWLINE, statusStart);
			if (end < 0) {
				if (data.length - statusStart <= EXIT_MARKER_STATUS_MAX_BYTES) return { kind: "partial", start: at };
				continue;
			}
			const status = parseStatus(data, statusStart, end);
			if (status !== undefined) return { kind: "marker", start: at, end: end + 1, status };
		}
		// The needle holds MARKER_START once, as its first byte, so a cut-off marker starts there.
		for (let at = Math.max(from, data.length - needle.length + 1); at < data.length; at++) {
			if (data[at] === MARKER_START && needle.compare(data, at, data.length, 0, data.length - at) === 0) {
				return { kind: "partial", start: at };
			}
		}
		return { kind: "none" };
	}

	#record(status: number): void {
		if (this.#seen) return;
		this.#seen = true;
		this.#exited.resolve(status);
	}
}

function createAbortWaiter(
	signal: AbortSignal | undefined,
	streamAbort: AbortController,
): { promise: Promise<ptree.ProcessAbortError> | undefined; cleanup: () => void } {
	if (!signal) {
		return { promise: undefined, cleanup: () => {} };
	}

	const { promise, resolve } = Promise.withResolvers<ptree.ProcessAbortError>();
	const onAbort = () => {
		const error = new ptree.ProcessAbortError(signal.reason, "<cancelled>");
		if (!streamAbort.signal.aborted) {
			streamAbort.abort(error);
		}
		resolve(error);
	};

	if (signal.aborted) {
		onAbort();
		return { promise, cleanup: () => {} };
	}

	signal.addEventListener("abort", onAbort, { once: true });
	return { promise, cleanup: () => signal.removeEventListener("abort", onAbort) };
}

export async function executeSSH(
	host: SSHConnectionTarget,
	command: string,
	options?: SSHExecutorOptions,
): Promise<SSHResult> {
	await ensureConnection(host);
	if (hasSshfs()) {
		try {
			await mountRemote(host, options?.remotePath ?? "/");
		} catch (err) {
			logger.warn("SSHFS mount failed", { host: host.name, error: String(err) });
		}
	}

	const info = await ensureHostInfo(host);
	const marker = reportsExit(info) ? new ExitMarker() : undefined;
	let resolvedCommand = marker ? marker.wrap(command) : command;
	if (options?.compatEnabled) {
		if (info.compatShell) {
			resolvedCommand = wrapInPosixShell(info.compatShell, resolvedCommand);
		} else {
			logger.warn("SSH compat enabled without detected compat shell", { host: host.name });
		}
	}

	using child = ptree.spawn(["ssh", ...(await buildRemoteCommand(host, resolvedCommand))], {
		signal: options?.signal,
		timeout: options?.timeout,
		stdin: "pipe",
		stderr: "full",
		onSpawnPid: primarySessionCpuAdoption(),
	});

	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		...resolveOutputSinkWindow(settings, options?.spillThreshold ?? DEFAULT_MAX_BYTES),
		maxColumns: resolveOutputMaxColumns(settings),
		chunkThrottleMs: options?.onChunk ? LIVE_OUTPUT_INTERVAL_MS : 0,
	});

	const streamAbort = new AbortController();
	const abortWaiter = createAbortWaiter(options?.signal, streamAbort);
	const streamOptions = { signal: streamAbort.signal };
	const stdout = marker ? child.stdout.pipeThrough(marker.strip()) : child.stdout;
	const streams = [stdout.pipeTo(sink.createInput(), streamOptions)];
	if (child.stderr) {
		streams.push(child.stderr.pipeTo(sink.createInput(), streamOptions));
	}
	const streamsSettled = Promise.allSettled(streams).then(() => {});

	let graceTimer: NodeJS.Timeout | undefined;
	let finished = false;
	try {
		const exitEvent = child.exited.then(sshExitEvent, sshErrorEvent);
		const settledEvent = exitEvent.then<SSHExitEvent>(event =>
			event.kind === "exit" ? streamsSettled.then(() => event) : event,
		);
		const events: Promise<SSHEvent>[] = [settledEvent];
		const abortEvent = abortWaiter.promise?.then(sshErrorEvent);
		if (abortEvent) events.push(abortEvent);
		if (marker) {
			events.push(
				marker.exited.then(exitCode => {
					const { promise, resolve } = Promise.withResolvers<SSHEvent>();
					if (!finished) {
						graceTimer = setTimeout(() => resolve({ kind: "detach", exitCode }), EXIT_MARKER_GRACE_MS);
					}
					return promise;
				}),
			);
		}
		const event = await Promise.race(events);
		if (event.kind === "error") {
			throw event.error;
		}
		if (event.kind === "detach") {
			// The holder may keep the streams open for as long as it runs, so stop reading without
			// waiting for them; disposing `child` on return ends the ssh client, which closes the session.
			streamAbort.abort();
			void streamsSettled;
			return {
				exitCode: event.exitCode,
				cancelled: false,
				...(await sink.dump(DETACHED_NOTICE)),
			};
		}
		return {
			exitCode: event.exitCode,
			cancelled: false,
			...(await sink.dumpWithArtifactStatus()),
		};
	} catch (err) {
		if (!streamAbort.signal.aborted) {
			streamAbort.abort(err);
		}
		void streamsSettled;
		if (err instanceof ptree.Exception) {
			if (err instanceof ptree.TimeoutError) {
				return {
					exitCode: undefined,
					cancelled: true,
					...(await sink.dumpWithArtifactStatus(`SSH: ${err.message}`)),
				};
			}
			if (err.aborted) {
				return {
					exitCode: undefined,
					cancelled: true,
					...(await sink.dumpWithArtifactStatus(`Command aborted: ${err.message}`)),
				};
			}
			return {
				exitCode: err.exitCode,
				cancelled: false,
				...(await sink.dumpWithArtifactStatus(`Unexpected error: ${err.message}`)),
			};
		}
		throw err;
	} finally {
		finished = true;
		clearTimeout(graceTimer);
		abortWaiter.cleanup();
	}
}
