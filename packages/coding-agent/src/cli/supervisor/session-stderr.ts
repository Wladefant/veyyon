import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir } from "@veyyon/utils/dirs";
import { withFileLockSync } from "@veyyon/utils/file-lock";
import { isEnoent } from "@veyyon/utils/fs-error";
import { errorMessage } from "@veyyon/utils/type-guards";

export const DEFAULT_MAX_STDERR_LOG_BYTES = 1024 * 1024; // 1 MiB
const MAX_RETAINED_SEGMENTS = 384;
const MAX_RETAINED_BYTES = 128 * 1024 * 1024;
const SEGMENT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * SEGMENT_LIFETIME_MS;
const SEGMENT_NAME = /^\d+-[0-9a-f-]{36}-\d+-(\d+)\.(active|sealed)\.log$/;
const LOCK_OPTIONS = { retries: 5, retryDelayMs: 10 };

export type StderrStatus = "captured" | "empty" | "truncated" | "error" | "rotation_error" | "spawn_error" | "disabled";

export interface StderrCaptureOptions {
	sessionStderrDir?: string;
	maxBytes?: number;
	maxFiles?: number;
	maxRetainedSegments?: number;
	maxRetainedBytes?: number;
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

function boundedLimit(value: number | undefined, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return max;
	return Math.max(1, Math.min(Math.floor(value), max));
}

function admitSegment(dir: string, file: string, capacity: number, maxSegments: number, maxBytes: number): void {
	// Sealing and admission use the same lock. A growing file is charged its
	// full reservation until sealed, so ordinary appends need no shared lock.
	withFileLockSync(
		path.join(dir, "retention"),
		() => {
			const now = Date.now();
			let bytes = 0;
			let count = 0;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				const match = SEGMENT_NAME.exec(entry.name);
				if (!match) continue;
				const candidate = path.join(dir, entry.name);
				const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
				if (!stat?.isFile()) continue;
				const active = match[2] === "active";
				if (!active && stat.nlink === 1 && now - stat.mtimeMs >= RETENTION_MS) {
					try {
						fs.unlinkSync(candidate);
						continue;
					} catch (error) {
						if (isEnoent(error)) continue;
						// A locked segment stays charged until it can be removed.
					}
				}
				count++;
				bytes += active ? Math.max(stat.size, Number(match[1])) : stat.size;
			}
			if (count >= maxSegments || bytes + capacity > maxBytes) {
				throw new Error("Session stderr retention budget exhausted; recent evidence kept for seven days");
			}
			fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
		},
		LOCK_OPTIONS,
	);
}

export function startStderrCapture(
	child: ChildProcess | undefined,
	pid: number | undefined,
	options: StderrCaptureOptions = {},
): StderrCaptureHandle {
	const root = options.sessionStderrDir ?? path.join(getLogsDir(), "session-stderr");
	const maxBytes = boundedLimit(options.maxBytes, DEFAULT_MAX_STDERR_LOG_BYTES);
	const maxRetainedSegments = boundedLimit(options.maxRetainedSegments, MAX_RETAINED_SEGMENTS);
	const maxRetainedBytes = boundedLimit(options.maxRetainedBytes, MAX_RETAINED_BYTES);
	const maxFiles = boundedLimit(options.maxFiles, maxRetainedSegments);
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
	let openedAt = 0;
	let activePath = "";
	let managedDir: string | undefined;
	let generation: string | undefined;
	const sealedFiles: string[] = [];
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

	const openSegment = () => {
		if (sealedFiles.length >= maxFiles) throw new Error("Session stderr segment limit reached");
		if (!managedDir) {
			const dir = path.join(root, "retained-v1");
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			if (!fs.lstatSync(dir).isDirectory()) throw new Error("Unsafe session stderr retention directory");
			managedDir = fs.realpathSync.native(dir);
		}
		generation ??= `${pid}-${crypto.randomUUID()}`;
		const file = path.join(managedDir, `${generation}-${sealedFiles.length}-${maxBytes}.active.log`);
		admitSegment(managedDir, file, maxBytes, maxRetainedSegments, maxRetainedBytes);
		activePath = file;
		openedAt = Date.now();
	};

	const sealSegment = (): boolean => {
		if (!activePath || !managedDir) return true;
		const sealed = activePath.replace(/\.active\.log$/, ".sealed.log");
		try {
			withFileLockSync(
				path.join(managedDir, "retention"),
				() => {
					const now = new Date();
					fs.utimesSync(activePath, now, now);
					rename(activePath, sealed);
				},
				LOCK_OPTIONS,
			);
			sealedFiles.push(sealed);
			activePath = "";
			currentBytes = 0;
			return true;
		} catch (err) {
			rotationError ??= errorMessage(err);
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
			if (
				activePath &&
				currentBytes > 0 &&
				(currentBytes + (buf.length - offset) > maxBytes || Date.now() - openedAt >= SEGMENT_LIFETIME_MS) &&
				!sealSegment()
			) {
				break;
			}

			const remainingCapacity = maxBytes - currentBytes;
			const remainingBytes = buf.length - offset;
			const sliceLength = Math.min(remainingBytes, remainingCapacity);
			const slice = buf.subarray(offset, offset + sliceLength);

			try {
				if (!activePath) openSegment();
				fs.appendFileSync(activePath, slice);
				currentBytes += slice.length;
				totalBytesWritten += slice.length;
				offset += sliceLength;
			} catch (err) {
				writeError = errorMessage(err);
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

			// No more appends after this point, even if the pipe outlived the drain deadline.
			child?.stderr?.off("data", onData);
			sealSegment();
			const files = sealedFiles.filter(file => fs.existsSync(file)).reverse();
			if (activePath) files.unshift(activePath);

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
				logPath: files[0] ?? "",
				files,
				bytesWritten: totalBytesWritten,
				status,
				error: spawnError ?? rotationError ?? writeError ?? truncationError,
			};
		},
	};
}
