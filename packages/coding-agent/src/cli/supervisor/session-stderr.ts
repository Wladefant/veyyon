import { type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir } from "@veyyon/utils/dirs";

export const DEFAULT_MAX_STDERR_LOG_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_MAX_STDERR_LOG_FILES = 3;

export type StderrStatus =
	| "captured"
	| "empty"
	| "error"
	| "rotation_error"
	| "spawn_error"
	| "disabled";

export interface StderrCaptureOptions {
	sessionStderrDir?: string;
	maxBytes?: number;
	maxFiles?: number;
	forwardStderr?: boolean;
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

	let spawnError: string | undefined;
	let writeError: string | undefined;
	let rotationError: string | undefined;
	let totalBytesWritten = 0;
	let currentBytes = 0;

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
		if (forwardStderr) {
			try {
				process.stderr.write(buf);
			} catch {}
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
		child.stderr.on("error", (err) => {
			writeError ??= err instanceof Error ? err.message : String(err);
		});
	}

	return {
		recordSpawnError(err: unknown) {
			spawnError = err instanceof Error ? err.message : String(err);
		},
		async drain(): Promise<StderrCaptureResult> {
			if (child?.stderr && !child.stderr.readableEnded && !child.stderr.destroyed) {
				await new Promise<void>((resolve) => {
					let timer: NodeJS.Timeout | undefined;
					const onEnd = () => {
						if (timer) clearTimeout(timer);
						child.stderr?.off("end", onEnd);
						child.stderr?.off("close", onEnd);
						child.stderr?.off("error", onEnd);
						resolve();
					};
					child.stderr?.once("end", onEnd);
					child.stderr?.once("close", onEnd);
					child.stderr?.once("error", onEnd);
					timer = setTimeout(onEnd, 2000);
					if (timer.unref) timer.unref();
				});
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
				error: spawnError ?? rotationError ?? writeError,
			};
		},
	};
}
