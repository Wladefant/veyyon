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

	it("bounds retained stderr across short child runs without evicting recent evidence", async () => {
		const legacy = path.join(dir, "200.stderr.log");
		fs.writeFileSync(legacy, "legacy incident");
		const options = { sessionStderrDir: dir, maxBytes: 4, maxRetainedSegments: 2, forwardStderr: false };
		const run = async (pid: number, text: string) => {
			const { child, stderr } = fakeChild();
			const capture = startStderrCapture(child, pid, options);
			stderr.end(text);
			return capture.drain();
		};
		const first = await run(200, "aaaa");
		const second = await run(201, "bbbb");
		for (let pid = 202; pid < 210; pid++) {
			const full = await run(pid, "cccc");
			expect(full.status).toBe("error");
			expect(full.error).toContain("retention budget");
			expect(full.bytesWritten).toBe(0);
			expect(full.files).toEqual([]);
		}
		expect(fs.readFileSync(first.logPath, "utf8")).toBe("aaaa");
		expect(fs.readFileSync(second.logPath, "utf8")).toBe("bbbb");
		expect(fs.readFileSync(legacy, "utf8")).toBe("legacy incident");

		const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(first.logPath, expired, expired);
		const next = await run(210, "dddd");
		expect(next.status).toBe("captured");
		expect(fs.existsSync(first.logPath)).toBe(false);
		expect(fs.readFileSync(next.logPath, "utf8")).toBe("dddd");
		expect(fs.readFileSync(second.logPath, "utf8")).toBe("bbbb");
	});

	it("keeps concurrent generations with the same PID separate", async () => {
		const first = fakeChild();
		const second = fakeChild();
		const options = { sessionStderrDir: dir, maxBytes: 16, forwardStderr: false };
		const firstCapture = startStderrCapture(first.child, 42, options);
		first.stderr.write("first ");
		const secondCapture = startStderrCapture(second.child, 42, options);
		second.stderr.end("second");
		const secondResult = await secondCapture.drain();
		first.stderr.end("late");
		const firstResult = await firstCapture.drain();
		expect(firstResult.logPath).not.toBe(secondResult.logPath);
		expect(fs.readFileSync(firstResult.logPath, "utf8")).toBe("first late");
		expect(fs.readFileSync(secondResult.logPath, "utf8")).toBe("second");
	});

	it("keeps a live writer's segment even when its mtime is outside the incident window", async () => {
		const first = fakeChild();
		const options = { sessionStderrDir: dir, maxBytes: 16, maxRetainedSegments: 1, forwardStderr: false };
		const capture = startStderrCapture(first.child, 50, options);
		first.stderr.write("first ");
		const [relative] = fs.readdirSync(dir, { recursive: true }).filter(name => name.endsWith(".log"));
		const active = path.join(dir, relative);
		const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(active, expired, expired);
		const contender = fakeChild();
		const refused = startStderrCapture(contender.child, 51, options);
		contender.stderr.end("contending write");
		expect((await refused.drain()).status).toBe("error");
		first.stderr.end("late");
		const result = await capture.drain();
		expect(result.status).toBe("captured");
		expect(fs.readFileSync(result.logPath, "utf8")).toBe("first late");
	});

	it("preserves earlier segments when a later rollover fails and forwards all stderr", async () => {
		const { child, stderr } = fakeChild();
		const sink = recordingSink();
		let attempts = 0;
		const capture = startStderrCapture(child, 52, {
			sessionStderrDir: dir,
			maxBytes: 4,
			maxFiles: 2,
			stderrSink: sink.stream,
			renameSync: (source, dest) => {
				if (++attempts > 1) throw new Error("segment locked");
				fs.renameSync(source, dest);
			},
		});
		stderr.end("aaaabbbbcccc");
		const result = await capture.drain();
		expect(result.status).toBe("rotation_error");
		expect(result.error).toBe("segment locked");
		expect(result.files.map(file => fs.readFileSync(file, "utf8"))).toEqual(["bbbb", "aaaa"]);
		expect(sink.text()).toBe("aaaabbbbcccc");
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
