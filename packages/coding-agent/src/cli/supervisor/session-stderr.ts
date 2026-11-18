import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir } from "@veyyon/utils/dirs";

export const DEFAULT_MAX_STDERR_LOG_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_MAX_STDERR_LOG_FILES = 3;

export type StderrStatus = "captured" | "empty" | "truncated" | "error" | "rotation_error" | "spawn_error" | "disabled";

export interface StderrCaptureOptions {
	sessionStderrDir?: string;
	maxBytes?: number;
	maxFiles?: number;
	forwardStderr?: boolean;
	stderrSink?: NodeJS.WritableStream;
	drainTimeoutMs?: number;
	flushTimeoutMs?: number;
	renameSync?: (oldPath: string, newPath: string) => void;
}

export interface StderrCaptureResult {
	logPath: string;
	files: string[];
	bytesWritten: number;
	status: StderrStatus;
	error?: string;
}

export interface StderrCaptureHandle {
	drain(): Promise<StderrCaptureResult>;
	recordSpawnError(err: unknown): void;
}

export function startStderrCapture(
	child: ChildProcess | undefined,
	pid: number | undefined,
	options: StderrCaptureOptions = {},
): StderrCaptureHandle {
	const dir = options.sessionStderrDir ?? path.join(getLogsDir(), "session-stderr");
	const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_STDERR_LOG_BYTES);
	const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_STDERR_LOG_FILES);
	const forwardStderr = options.forwardStderr ?? true;
	const rename = options.renameSync ?? fs.renameSync;
	const stderrSink = options.stderrSink ?? process.stderr;
	const drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? 2000);
	const flushTimeoutMs = Math.max(1, options.flushTimeoutMs ?? Math.min(drainTimeoutMs, 500));

	let spawnError: string | undefined;
	let writeError: string | undefined;
	let rotationError: string | undefined;
	let truncationError: string | undefined;
	let totalBytesWritten = 0;
	let currentBytes = 0;
	let pausedForDrain = false;
	let forwardingStopped = false;
	let truncated = false;
	let stderrEnded = Boolean(child?.stderr && (child.stderr.readableEnded || child.stderr.destroyed));
	const onSinkDrain = () => {
		pausedForDrain = false;
		if (!forwardingStopped && child?.stderr && !child.stderr.destroyed && typeof child.stderr.resume === "function") {
			child.stderr.resume();
		}
	};

	if (typeof pid !== "number" || pid <= 0) {
		return {
			async drain(): Promise<StderrCaptureResult> {
				return {
					logPath: "",
					files: [],
					bytesWritten: 0,
					status: spawnError ? "spawn_error" : "disabled",
					error: spawnError,
				};
			},
			recordSpawnError(err: unknown) {
				spawnError = err instanceof Error ? err.message : String(err);
			},
		};
	}

	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (err) {
		writeError = err instanceof Error ? err.message : String(err);
	}

	const logPath = path.join(dir, `${pid}.stderr.log`);

	// If file exists from prior execution with reused pid, initialize currentBytes
	try {
		if (fs.existsSync(logPath)) {
			currentBytes = fs.statSync(logPath).size;
		}
	} catch {}

	const rotateFiles = (): boolean => {
		try {
			if (maxFiles === 1) {
				if (fs.existsSync(logPath)) {
					fs.truncateSync(logPath, 0);
				}
				currentBytes = 0;
				return true;
			}
			for (let i = maxFiles - 1; i >= 1; i--) {
				const src = i === 1 ? logPath : path.join(dir, `${pid}.stderr.${i - 1}.log`);
				const dest = path.join(dir, `${pid}.stderr.${i}.log`);
				if (fs.existsSync(dest)) {
					try {
						fs.rmSync(dest, { force: true });
					} catch {}
				}
				if (fs.existsSync(src)) {
					rename(src, dest);
				}
			}
			currentBytes = 0;
			return true;
		} catch (err) {
			rotationError = err instanceof Error ? err.message : String(err);
			return false;
		}
	};

	const onData = (chunk: Buffer | string) => {
		const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		if (forwardStderr && !forwardingStopped) {
			let ok = true;
			try {
				ok = stderrSink.write(buf);
			} catch {}
			if (!ok && !pausedForDrain && typeof child?.stderr?.pause === "function") {
				pausedForDrain = true;
				child.stderr.pause();
				stderrSink.once("drain", onSinkDrain);
			}
		}

		if (rotationError || writeError) {
			return;
		}

		let offset = 0;
		while (offset < buf.length) {
			if (currentBytes >= maxBytes) {
				if (!rotateFiles()) {
					break;
				}
			} else if (currentBytes > 0 && currentBytes + (buf.length - offset) > maxBytes) {
				if (!rotateFiles()) {
					break;
				}
			}

			const remainingCapacity = maxBytes - currentBytes;
			const remainingBytes = buf.length - offset;
			const sliceLength = Math.min(remainingBytes, remainingCapacity);
			const slice = buf.subarray(offset, offset + sliceLength);

			try {
				fs.appendFileSync(logPath, slice);
				currentBytes += slice.length;
				totalBytesWritten += slice.length;
				offset += sliceLength;
			} catch (err) {
				writeError = err instanceof Error ? err.message : String(err);
				break;
			}
		}
	};

	if (child?.stderr) {
		child.stderr.on("data", onData);
		child.stderr.on("error", err => {
			writeError ??= err instanceof Error ? err.message : String(err);
		});
		child.stderr.once("end", () => {
			stderrEnded = true;
		});
		child.stderr.once("close", () => {
			stderrEnded = true;
		});
	}

	const waitForStderrEnd = (timeoutMs: number): Promise<boolean> => {
		if (!child?.stderr || stderrEnded || child.stderr.readableEnded || child.stderr.destroyed) {
			return Promise.resolve(true);
		}
		return new Promise<boolean>(resolve => {
			let timer: NodeJS.Timeout | undefined;
			const cleanup = () => {
				clearTimeout(timer);
				child.stderr?.off("end", onEnd);
				child.stderr?.off("close", onEnd);
				child.stderr?.off("error", onEnd);
			};
			const onEnd = () => {
				cleanup();
				resolve(true);
			};
			child.stderr?.once("end", onEnd);
			child.stderr?.once("close", onEnd);
			child.stderr?.once("error", onEnd);
			timer = setTimeout(() => {
				cleanup();
				resolve(false);
			}, timeoutMs);
			if (timer.unref) timer.unref();
		});
	};

	return {
		recordSpawnError(err: unknown) {
			spawnError = err instanceof Error ? err.message : String(err);
		},
		async drain(): Promise<StderrCaptureResult> {
			const completedBeforeTimeout = await waitForStderrEnd(drainTimeoutMs);
			pausedForDrain = false;
			if (typeof stderrSink.removeListener === "function") {
				stderrSink.removeListener("drain", onSinkDrain);
			}
			if (
				!completedBeforeTimeout &&
				child?.stderr &&
				!stderrEnded &&
				!child.stderr.readableEnded &&
				!child.stderr.destroyed
			) {
				forwardingStopped = true;
				if (typeof child.stderr.resume === "function") {
					child.stderr.resume();
				}
				const flushedAfterResume = await waitForStderrEnd(flushTimeoutMs);
				if (!flushedAfterResume && !stderrEnded && !child.stderr.readableEnded && !child.stderr.destroyed) {
					truncated = true;
					truncationError = "stderr drain timed out before stream ended";
				}
			}

			const files: string[] = [];
			if (fs.existsSync(logPath)) {
				files.push(logPath);
			}
			for (let i = 1; i < maxFiles; i++) {
				const rotated = path.join(dir, `${pid}.stderr.${i}.log`);
				if (fs.existsSync(rotated)) {
					files.push(rotated);
				}
			}

			let status: StderrStatus;
			if (spawnError) {
				status = "spawn_error";
			} else if (rotationError) {
				status = "rotation_error";
			} else if (writeError) {
				status = "error";
			} else if (!child?.stderr) {
				status = "disabled";
			} else if (truncated) {
				status = "truncated";
			} else if (totalBytesWritten > 0) {
				status = "captured";
			} else {
				status = "empty";
			}

			return {
				logPath,
				files,
				bytesWritten: totalBytesWritten,
				status,
				error: spawnError ?? rotationError ?? writeError ?? truncationError,
			};
		},
	};
}
