import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { startStderrCapture } from "../../src/cli/supervisor/session-stderr";

/**
 * The stderr capture of a supervised child: it writes `<pid>.stderr.log`, rotates it at `maxBytes`,
 * forwards every byte to the sink, and reports one status. A fake child stream stands in for the
 * process. The only IO is a temporary log directory.
 */
let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-session-stderr-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function fakeChild() {
	const stderr = new PassThrough();
	return { child: { stderr } as unknown as ChildProcess, stderr };
}

function recordingSink() {
	const chunks: Buffer[] = [];
	const stream = {
		write(chunk: Buffer | string) {
			chunks.push(Buffer.from(chunk));
			return true;
		},
	} as unknown as NodeJS.WritableStream;
	return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("startStderrCapture", () => {
	it("captures a child's stderr to its pid log and forwards every byte to the sink", async () => {
		const { child, stderr } = fakeChild();
		const sink = recordingSink();
		const capture = startStderrCapture(child, 4242, {
			sessionStderrDir: dir,
			stderrSink: sink.stream,
			drainTimeoutMs: 1000,
		});
		stderr.write("boom\n");
		stderr.end();

		const result = await capture.drain();
		expect(result.status).toBe("captured");
		expect(result.bytesWritten).toBe(5);
		expect(result.logPath).toBe(path.join(dir, "4242.stderr.log"));
		expect(result.files).toEqual([result.logPath]);
		expect(fs.readFileSync(result.logPath, "utf8")).toBe("boom\n");
		expect(sink.text()).toBe("boom\n");
		expect(result.error).toBeUndefined();
	});

	it("keeps the log and leaves the sink silent when forwarding is off", async () => {
		const { child, stderr } = fakeChild();
		const sink = recordingSink();
		const capture = startStderrCapture(child, 11, {
			sessionStderrDir: dir,
			forwardStderr: false,
			stderrSink: sink.stream,
			drainTimeoutMs: 1000,
		});
		stderr.write("quiet\n");
		stderr.end();

		const result = await capture.drain();
		expect(result.status).toBe("captured");
		expect(fs.readFileSync(result.logPath, "utf8")).toBe("quiet\n");
		expect(sink.text()).toBe("");
	});

	it("reports an empty status and creates no log when the child writes nothing", async () => {
		const { child, stderr } = fakeChild();
		const capture = startStderrCapture(child, 12, { sessionStderrDir: dir, drainTimeoutMs: 1000 });
		stderr.end();

		const result = await capture.drain();
		expect(result.status).toBe("empty");
		expect(result.bytesWritten).toBe(0);
		expect(result.files).toEqual([]);
		expect(fs.existsSync(path.join(dir, "12.stderr.log"))).toBe(false);
	});

	it("rotates the log at maxBytes, keeping the older bytes in the numbered file", async () => {
		const { child, stderr } = fakeChild();
		const capture = startStderrCapture(child, 7, {
			sessionStderrDir: dir,
			maxBytes: 4,
			maxFiles: 2,
			stderrSink: recordingSink().stream,
			drainTimeoutMs: 1000,
		});
		stderr.write("abcdefgh");
		stderr.end();

		const result = await capture.drain();
		const rotated = path.join(dir, "7.stderr.1.log");
		expect(result.status).toBe("captured");
		expect(result.bytesWritten).toBe(8);
		expect(fs.readFileSync(rotated, "utf8")).toBe("abcd");
		expect(fs.readFileSync(result.logPath, "utf8")).toBe("efgh");
		expect(result.files).toEqual([result.logPath, rotated]);
	});

	it("reports a rotation error with the rename message and keeps forwarding to the sink", async () => {
		const { child, stderr } = fakeChild();
		const sink = recordingSink();
		const capture = startStderrCapture(child, 9, {
			sessionStderrDir: dir,
			maxBytes: 4,
			maxFiles: 2,
			renameSync: () => {
				throw new Error("rename denied");
			},
			stderrSink: sink.stream,
			drainTimeoutMs: 1000,
		});
		stderr.write("abcdefgh");
		stderr.end();

		const result = await capture.drain();
		expect(result.status).toBe("rotation_error");
		expect(result.error).toBe("rename denied");
		expect(fs.readFileSync(result.logPath, "utf8")).toBe("abcd");
		expect(sink.text()).toBe("abcdefgh");
	});

	it("reports a spawn error and writes nothing when no pid was assigned", async () => {
		const capture = startStderrCapture(undefined, undefined, { sessionStderrDir: dir });
		capture.recordSpawnError(new Error("ENOENT: codex not found"));

		expect(await capture.drain()).toEqual({
			logPath: "",
			files: [],
			bytesWritten: 0,
			status: "spawn_error",
			error: "ENOENT: codex not found",
		});
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("reports disabled when there is no child and no spawn error", async () => {
		const result = await startStderrCapture(undefined, 0, { sessionStderrDir: dir }).drain();
		expect(result.status).toBe("disabled");
		expect(result.error).toBeUndefined();
	});
});
