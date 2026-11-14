import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_DUMP_FOLDER,
	disableLocalDumps,
	enableLocalDumps,
	LOCAL_DUMPS_BASE_KEY,
	SUPERVISOR_TARGET_APPS,
	statusLocalDumps,
} from "../src/cli/supervisor/dumps";
import { resolveSupervisorArgv, shouldSuperviseLaunch, superviseProcess } from "../src/cli/supervisor/process";

function createTestContext() {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
	const heartbeatDir = path.join(tempDir, "heartbeat");
	const sessionStderrDir = path.join(tempDir, "session-stderr");
	fs.mkdirSync(heartbeatDir, { recursive: true });
	fs.mkdirSync(sessionStderrDir, { recursive: true });
	const logs: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
	const logger = {
		errorSync(message: string, context?: Record<string, unknown>) {
			logs.push({ message, context });
		},
	};
	return {
		tempDir,
		heartbeatDir,
		sessionStderrDir,
		logs,
		logger,
		writeHeartbeat(pid: number, data?: Record<string, unknown>) {
			const file = path.join(heartbeatDir, `${pid}.json`);
			fs.writeFileSync(
				file,
				JSON.stringify({
					pid,
					sessionId: `sess-${pid}`,
					phase: "tool",
					startedAt: "2026-09-29T10:00:00.000Z",
					heartbeatAt: "2026-09-29T10:00:05.000Z",
					...data,
				}),
			);
			return file;
		},
		writeTombstone(pid: number) {
			const file = path.join(heartbeatDir, `${pid}.exited`);
			fs.writeFileSync(file, "");
			return file;
		},
		cleanup() {
			fs.rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

function fakeChild(pid: number, exitCode: number | null, signal: NodeJS.Signals | null = null): ChildProcess {
	const child = {
		pid,
		on(event: string, cb: (...args: unknown[]) => void) {
			if (event === "exit") queueMicrotask(() => cb(exitCode, signal));
			return child;
		},
	};
	return child as unknown as ChildProcess;
}

function fakeChildWithStderr(
	pid: number,
	exitCode: number | null,
	signal: NodeJS.Signals | null = null,
	stderrChunks: string[] = [],
): ChildProcess {
	const emitter = new EventEmitter();
	const stderrEmitter = new EventEmitter();
	const child = {
		pid,
		stderr: stderrEmitter,
		on(event: string, cb: (...args: unknown[]) => void) {
			emitter.on(event, cb);
			return child;
		},
	};
	queueMicrotask(() => {
		for (const chunk of stderrChunks) {
			stderrEmitter.emit("data", Buffer.from(chunk));
		}
		stderrEmitter.emit("end");
		stderrEmitter.emit("close");
		emitter.emit("exit", exitCode, signal);
	});
	return child as unknown as ChildProcess;
}

function createMockRegRunner(
	handler?: (args: string[]) => { exitCode: number; stdout: string; stderr: string } | undefined,
) {
	const calls: string[][] = [];
	const runner = (args: string[]) => {
		calls.push(args);
		return handler?.(args) ?? { exitCode: 0, stdout: "", stderr: "" };
	};
	return { runner, calls };
}

describe("process supervisor", () => {
	test("killed child + retained heartbeat => reports unexpected death and consumes heartbeat", async () => {
		const ctx = createTestContext();
		try {
			const pid = 4242;
			const hbFile = ctx.writeHeartbeat(pid, { sessionId: "session-xyz-123", activeLanes: 1, lanes: 2 });
			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: [],
				spawn: () => fakeChild(pid, null, "SIGKILL"),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
			});

			const expectedStatus = 128 + (os.constants.signals.SIGKILL ?? 9);
			expect(result.exitCode).toBe(expectedStatus);
			expect(result.reported).toBe(true);
			expect(result.report?.exitCode).toBe(expectedStatus);
			expect(result.report?.signal).toBe("SIGKILL");

			expect(ctx.logs.length).toBe(1);
			expect(ctx.logs[0].context?.pid).toBe(pid);
			expect(ctx.logs[0].context?.sessionId).toBe("session-xyz-123");
			expect(ctx.logs[0].context?.phase).toBe("tool");
			expect(ctx.logs[0].context?.exitCode).toBe(expectedStatus);
			expect(ctx.logs[0].context?.signal).toBe("SIGKILL");

			expect(fs.existsSync(hbFile)).toBe(false);
		} finally {
			ctx.cleanup();
		}
	});

	test("zero-code retained heartbeat (no tombstone) => reports unexpected death exactly once", async () => {
		const ctx = createTestContext();
		try {
			const pid = 4343;
			const hbFile = ctx.writeHeartbeat(pid, { sessionId: "session-zero-term", phase: "provider" });
			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: [],
				spawn: () => fakeChild(pid, 0),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.reported).toBe(true);
			expect(result.report?.exitCode).toBe(0);
			expect(result.report?.signal).toBeNull();
			expect(result.report?.sessionId).toBe("session-zero-term");
			expect(result.report?.phase).toBe("provider");

			expect(ctx.logs.length).toBe(1);
			expect(ctx.logs[0].context?.pid).toBe(pid);
			expect(ctx.logs[0].context?.sessionId).toBe("session-zero-term");
			expect(ctx.logs[0].context?.exitCode).toBe(0);

			expect(fs.existsSync(hbFile)).toBe(false);
		} finally {
			ctx.cleanup();
		}
	});
	test("Windows TerminateProcess-style exit code + retained heartbeat => reports immediately", async () => {
		const ctx = createTestContext();
		try {
			const pid = 4399;
			const windowsAccessViolation = 0xc0000005;
			ctx.writeHeartbeat(pid, { sessionId: "session-windows-crash", phase: "provider" });

			const result = await superviseProcess({
				spawn: () => fakeChild(pid, windowsAccessViolation),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
			});

			expect(result.exitCode).toBe(windowsAccessViolation);
			expect(result.reported).toBe(true);
			expect(result.report?.pid).toBe(pid);
			expect(result.report?.sessionId).toBe("session-windows-crash");
			expect(result.report?.phase).toBe("provider");
			expect(result.report?.signal).toBeNull();
			expect(ctx.logs[0]?.context?.exitCode).toBe(windowsAccessViolation);
		} finally {
			ctx.cleanup();
		}
	});

	test("persistence throws => error propagates and evidence is left intact", async () => {
		const ctx = createTestContext();
		try {
			const pid = 4444;
			const hbFile = ctx.writeHeartbeat(pid, { sessionId: "session-fail-persist" });
			ctx.logger.errorSync = () => {
				throw new Error("Disk full or log persistence failed");
			};

			await expect(
				superviseProcess({
					execPath: "veyyon.exe",
					argv: [],
					spawn: () => fakeChild(pid, 1),
					logger: ctx.logger,
					heartbeatDir: ctx.heartbeatDir,
				}),
			).rejects.toThrow("Disk full or log persistence failed");

			expect(fs.existsSync(hbFile)).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});
	test("mismatched heartbeat pid => does not emit false report and preserves evidence", async () => {
		const ctx = createTestContext();
		try {
			const childPid = 6161;
			const wrongPid = 9999;
			const hbFile = ctx.writeHeartbeat(childPid, {
				pid: wrongPid,
				sessionId: "sess-mismatch",
			});

			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: [],
				spawn: () => fakeChild(childPid, null, "SIGKILL"),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
			});

			const expectedStatus = 128 + (os.constants.signals.SIGKILL ?? 9);
			expect(result.exitCode).toBe(expectedStatus);
			expect(result.reported).toBe(false);
			expect(result.report).toBeUndefined();
			expect(ctx.logs.length).toBe(0);
			expect(fs.existsSync(hbFile)).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});

	test("corrupt heartbeat JSON => does not emit false report and preserves evidence", async () => {
		const ctx = createTestContext();
		try {
			const childPid = 6262;
			const hbFile = path.join(ctx.heartbeatDir, `${childPid}.json`);
			fs.writeFileSync(hbFile, "not-valid-json{");

			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: [],
				spawn: () => fakeChild(childPid, null, "SIGKILL"),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
			});

			const expectedStatus = 128 + (os.constants.signals.SIGKILL ?? 9);
			expect(result.exitCode).toBe(expectedStatus);
			expect(result.reported).toBe(false);
			expect(result.report).toBeUndefined();
			expect(ctx.logs.length).toBe(0);
			expect(fs.existsSync(hbFile)).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});

	test("normal child exit => clean removal and no report", async () => {
		const ctx = createTestContext();
		try {
			// Case A: no heartbeat at all, exit 0 -> reported: false, logs: 0
			const resA = await superviseProcess({
				spawn: () => fakeChild(5252, 0),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
			});
			expect(resA.exitCode).toBe(0);
			expect(resA.reported).toBe(false);
			expect(ctx.logs.length).toBe(0);

			// Case B: heartbeat + tombstone, exit 0 -> reported: false, both files removed
			const hbB = ctx.writeHeartbeat(5253);
			const tsB = ctx.writeTombstone(5253);
			const resB = await superviseProcess({
				spawn: () => fakeChild(5253, 0),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
			});
			expect(resB.exitCode).toBe(0);
			expect(resB.reported).toBe(false);
			expect(fs.existsSync(hbB)).toBe(false);
			expect(fs.existsSync(tsB)).toBe(false);

			// Case C: heartbeat + tombstone, exit 1 -> reported: false, both files removed
			const hbC = ctx.writeHeartbeat(5254);
			const tsC = ctx.writeTombstone(5254);
			const resC = await superviseProcess({
				spawn: () => fakeChild(5254, 1),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
			});
			expect(resC.exitCode).toBe(1);
			expect(resC.reported).toBe(false);
			expect(fs.existsSync(hbC)).toBe(false);
			expect(fs.existsSync(tsC)).toBe(false);
			expect(ctx.logs.length).toBe(0);
		} finally {
			ctx.cleanup();
		}
	});

	test("real-process execution: real spawn + self-kill below JS reports unexpected death and consumes heartbeat", async () => {
		const ctx = createTestContext();
		const evalScript = `
			const fs = require("node:fs");
			const path = require("node:path");
			const dir = process.env.TEST_HB_DIR;
			const pid = process.pid;
			fs.writeFileSync(path.join(dir, pid + ".json"), JSON.stringify({
				pid,
				sessionId: "real-proc-sess",
				phase: "tool",
				startedAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
			}));
			process.kill(pid, "SIGKILL");
		`;

		try {
			const result = await superviseProcess({
				execPath: process.execPath,
				argv: ["-e", evalScript],
				cwd: ctx.tempDir,
				env: { ...process.env, TEST_HB_DIR: ctx.heartbeatDir },
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
			});

			expect(result.reported).toBe(true);
			expect(typeof result.exitCode).toBe("number");
			expect(result.report).toBeDefined();
			expect(typeof result.report!.pid).toBe("number");
			expect(result.report!.pid).toBeGreaterThan(0);
			expect(result.report!.sessionId).toBe("real-proc-sess");
			expect(result.report!.phase).toBe("tool");
			expect(typeof result.report!.exitCode).toBe("number");

			expect(ctx.logs.length).toBe(1);
			expect(ctx.logs[0].context?.pid).toBe(result.report!.pid);
			expect(ctx.logs[0].context?.sessionId).toBe("real-proc-sess");
			expect(ctx.logs[0].context?.phase).toBe("tool");
			expect(typeof ctx.logs[0].context?.exitCode).toBe("number");

			const heartbeatFile = path.join(ctx.heartbeatDir, `${result.report!.pid}.json`);
			expect(fs.existsSync(heartbeatFile)).toBe(false);
		} finally {
			ctx.cleanup();
		}
	});

	test("default child argv omits the embedded entry path only for compiled binaries", () => {
		const processArgv = ["C:\\veyyon.exe", "B:/~BUN/root/cli.js", "hello"];
		expect(resolveSupervisorArgv(processArgv, true)).toEqual(["hello"]);
		expect(resolveSupervisorArgv(["C:\\bun.exe", "src/cli.ts", "hello"], false)).toEqual(["src/cli.ts", "hello"]);
	});

	test("spawn contract: executable, argv, cwd, inherited env/stdio, shell=false, and recursion marker", async () => {
		let capturedCmd = "";
		let capturedArgs: string[] = [];
		let capturedOpts: SpawnOptions | undefined;

		const fakeSpawn = (cmd: string, args: string[], opts: SpawnOptions) => {
			capturedCmd = cmd;
			capturedArgs = args;
			capturedOpts = opts;
			return fakeChild(9999, 0);
		};

		const parentEnv = { TEST_VAR: "inherited-val" };
		await superviseProcess({
			execPath: "test-binary.exe",
			argv: ["launch", "--arg1", "val1"],
			cwd: "/test/cwd",
			env: parentEnv,
			spawn: fakeSpawn,
		});

		expect(capturedCmd).toBe("test-binary.exe");
		expect(capturedArgs).toEqual(["launch", "--arg1", "val1"]);
		expect(capturedOpts?.cwd).toBe("/test/cwd");
		expect(capturedOpts?.stdio).toEqual(["inherit", "inherit", "pipe"]);
		expect(capturedOpts?.shell).toBe(false);
		expect(capturedOpts?.env?.TEST_VAR).toBe("inherited-val");
		expect(capturedOpts?.env?.VEYYON_SUPERVISED).toBe(String(process.pid));
	});

	test("marker bypass and selective supervisor activation", () => {
		const cases: Array<{
			name: string;
			argv: string[];
			env?: Record<string, string>;
			tty?: { stdin?: boolean; stdout?: boolean };
			ppid?: number;
			expected: boolean;
		}> = [
			{ name: "empty argv interactive launch", argv: [], tty: { stdin: true, stdout: true }, expected: true },
			{
				name: "prompt argv interactive launch",
				argv: ["hello world"],
				tty: { stdin: true, stdout: true },
				expected: true,
			},
			{
				name: "direct child marker bypass with matching ppid",
				argv: [],
				env: { VEYYON_SUPERVISED: "12345" },
				ppid: 12345,
				tty: { stdin: true, stdout: true },
				expected: false,
			},
			{
				name: "direct child marker bypass with prompt and matching ppid",
				argv: ["some prompt"],
				env: { VEYYON_SUPERVISED: "12345" },
				ppid: 12345,
				tty: { stdin: true, stdout: true },
				expected: false,
			},
			{
				name: "inherited marker with different ppid does not bypass",
				argv: [],
				env: { VEYYON_SUPERVISED: "12345" },
				ppid: 99999,
				tty: { stdin: true, stdout: true },
				expected: true,
			},
			{
				name: "inherited marker with different ppid and prompt does not bypass",
				argv: ["some prompt"],
				env: { VEYYON_SUPERVISED: "12345" },
				ppid: 99999,
				tty: { stdin: true, stdout: true },
				expected: true,
			},
			{
				name: "legacy boolean marker does not bypass when ppid differs",
				argv: [],
				env: { VEYYON_SUPERVISED: "1" },
				ppid: 12345,
				tty: { stdin: true, stdout: true },
				expected: true,
			},
			{
				name: "direct child marker bypass with default process.ppid",
				argv: [],
				env: { VEYYON_SUPERVISED: String(process.ppid) },
				tty: { stdin: true, stdout: true },
				expected: false,
			},
			{
				name: "mode flag short equals form",
				argv: ["-m=rpc"],
				tty: { stdin: true, stdout: true },
				expected: false,
			},
			{ name: "non-TTY stdin", argv: [], tty: { stdin: false, stdout: true }, expected: false },
			{ name: "non-TTY stdout", argv: [], tty: { stdin: true, stdout: false }, expected: false },
			{ name: "worker tab", argv: ["__veyyon_worker_tab"], tty: { stdin: true, stdout: true }, expected: false },
			{
				name: "worker js eval",
				argv: ["__veyyon_worker_js_eval"],
				tty: { stdin: true, stdout: true },
				expected: false,
			},
			{ name: "smoke test", argv: ["--smoke-test"], tty: { stdin: true, stdout: true }, expected: false },
			{
				name: "supervisor subcommand",
				argv: ["supervisor", "dumps", "status"],
				tty: { stdin: true, stdout: true },
				expected: false,
			},
			{ name: "config subcommand", argv: ["config", "list"], tty: { stdin: true, stdout: true }, expected: false },
			{ name: "commit subcommand", argv: ["commit"], tty: { stdin: true, stdout: true }, expected: false },
			{ name: "acp subcommand", argv: ["acp"], tty: { stdin: true, stdout: true }, expected: false },
			{ name: "print flag short", argv: ["-p", "hello"], tty: { stdin: true, stdout: true }, expected: false },
			{ name: "print flag long", argv: ["--print"], tty: { stdin: true, stdout: true }, expected: false },
			{ name: "mode flag", argv: ["--mode", "rpc"], tty: { stdin: true, stdout: true }, expected: false },
			{ name: "version flag", argv: ["--version"], tty: { stdin: true, stdout: true }, expected: false },
			{ name: "help flag", argv: ["--help"], tty: { stdin: true, stdout: true }, expected: false },
			{
				name: "export flag",
				argv: ["--export", "session.jsonl"],
				tty: { stdin: true, stdout: true },
				expected: false,
			},
		];

		for (const c of cases) {
			expect(shouldSuperviseLaunch(c.argv, c.env ?? {}, c.tty, c.ppid)).toBe(c.expected);
		}
	});

	test("exit attribution: supervisorPid, supervisorCommandLine, childCommand, explicit terminator reason", async () => {
		const ctx = createTestContext();
		try {
			const pid = 5555;
			ctx.writeHeartbeat(pid, { sessionId: "session-attribution-test", phase: "tool" });
			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: ["launch", "--debug-flag"],
				supervisorPid: 7777,
				supervisorCommandLine: "veyyon.exe supervisor",
				platform: "win32",
				spawn: () => fakeChild(pid, null, "SIGKILL"),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
				sessionStderrDir: ctx.sessionStderrDir,
			});

			expect(result.reported).toBe(true);
			expect(result.report).toBeDefined();
			expect(result.report?.supervisorPid).toBe(7777);
			expect(result.report?.supervisorCommandLine).toBe("veyyon.exe supervisor");
			expect(result.report?.childCommand).toBe("veyyon.exe launch --debug-flag");
			expect("terminatorAttributionReason" in (result.report ?? {})).toBe(false);
			expect(result.report?.terminatorAttribution?.available).toBe(false);
			expect(result.report?.terminatorAttribution?.reason).toBe("Child exit reports do not provide killer PID");
			expect(result.report?.terminatorAttribution?.killerPid).toBeNull();

			expect(ctx.logs.length).toBe(1);
			expect(ctx.logs[0].context?.supervisorPid).toBe(7777);
			expect(ctx.logs[0].context?.supervisorCommandLine).toBe("veyyon.exe supervisor");
			expect(ctx.logs[0].context?.childCommand).toBe("veyyon.exe launch --debug-flag");
			expect("terminatorAttributionReason" in (ctx.logs[0].context ?? {})).toBe(false);
			expect(ctx.logs[0].context?.terminatorAttribution).toEqual({
				available: false,
				reason: "Child exit reports do not provide killer PID",
				killerPid: null,
			});
		} finally {
			ctx.cleanup();
		}
	});

	test("heartbeat resource fields are preserved in report and logged context", async () => {
		const ctx = createTestContext();
		try {
			const pid = 5556;
			ctx.writeHeartbeat(pid, {
				sessionId: "session-resources-test",
				phase: "provider",
				rssBytes: 104857600,
				freeMemBytes: 524288000,
				heapTotal: 50000000,
				heapUsed: 30000000,
				external: 1000000,
				smol: true,
				forceRAMSize: "512MB",
				commitChargeBytes: 2000000000,
				commitLimitBytes: 4000000000,
				processCommitBytes: 150000000,
				cgroupMemoryBytes: 120000000,
				cgroupMemoryMaxBytes: 1000000000,
				handleCount: 150,
				consoleLogPath: "C:\\logs\\5556.console.log",
				consoleCtrlStatus: "installed",
				consoleCtrlInstalled: true,
				resourceHistory: [
					{
						at: "2026-11-11T12:00:00.000Z",
						rssBytes: 104857600,
						handleCount: 150,
					},
				],
			});

			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: ["launch"],
				spawn: () => fakeChild(pid, null, "SIGKILL"),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
				sessionStderrDir: ctx.sessionStderrDir,
			});

			expect(result.reported).toBe(true);
			expect(result.report).toBeDefined();
			expect(result.report?.phase).toBe("provider");
			expect(result.report?.rssBytes).toBe(104857600);
			expect(result.report?.freeMemBytes).toBe(524288000);
			expect(result.report?.heapTotal).toBe(50000000);
			expect(result.report?.heapUsed).toBe(30000000);
			expect(result.report?.external).toBe(1000000);
			expect(result.report?.smol).toBe(true);
			expect(result.report?.forceRAMSize).toBe("512MB");
			expect(result.report?.commitChargeBytes).toBe(2000000000);
			expect(result.report?.commitLimitBytes).toBe(4000000000);
			expect(result.report?.processCommitBytes).toBe(150000000);
			expect(result.report?.cgroupMemoryBytes).toBe(120000000);
			expect(result.report?.cgroupMemoryMaxBytes).toBe(1000000000);
			expect(result.report?.handleCount).toBe(150);
			expect(result.report?.consoleLogPath).toBe("C:\\logs\\5556.console.log");
			expect(result.report?.consoleCtrlStatus).toBe("installed");
			expect(result.report?.consoleCtrlInstalled).toBe(true);
			expect(result.report?.resourceHistory).toEqual([
				{
					at: "2026-11-11T12:00:00.000Z",
					rssBytes: 104857600,
					handleCount: 150,
				},
			]);

			expect(ctx.logs.length).toBe(1);
			expect(ctx.logs[0].context?.rssBytes).toBe(104857600);
			expect(ctx.logs[0].context?.freeMemBytes).toBe(524288000);
			expect(ctx.logs[0].context?.heapTotal).toBe(50000000);
			expect(ctx.logs[0].context?.heapUsed).toBe(30000000);
			expect(ctx.logs[0].context?.external).toBe(1000000);
			expect(ctx.logs[0].context?.smol).toBe(true);
			expect(ctx.logs[0].context?.forceRAMSize).toBe("512MB");
			expect(ctx.logs[0].context?.commitChargeBytes).toBe(2000000000);
			expect(ctx.logs[0].context?.commitLimitBytes).toBe(4000000000);
			expect(ctx.logs[0].context?.processCommitBytes).toBe(150000000);
			expect(ctx.logs[0].context?.cgroupMemoryBytes).toBe(120000000);
			expect(ctx.logs[0].context?.cgroupMemoryMaxBytes).toBe(1000000000);
			expect(ctx.logs[0].context?.handleCount).toBe(150);
			expect(ctx.logs[0].context?.consoleLogPath).toBe("C:\\logs\\5556.console.log");
			expect(ctx.logs[0].context?.consoleCtrlStatus).toBe("installed");
			expect(ctx.logs[0].context?.consoleCtrlInstalled).toBe(true);
			expect(ctx.logs[0].context?.resourceHistory).toEqual([
				{
					at: "2026-11-11T12:00:00.000Z",
					rssBytes: 104857600,
					handleCount: 150,
				},
			]);
		} finally {
			ctx.cleanup();
		}
	});

	test("stderr capture: pipes stderr to bounded rotating log file, drains before report", async () => {
		const ctx = createTestContext();
		try {
			const pid = 5557;
			ctx.writeHeartbeat(pid, { sessionId: "session-stderr-test", phase: "tool" });
			// Write 40 bytes chunk, then 30 bytes chunk with maxBytes 50 -> triggers rotation
			const chunk1 = "A".repeat(40);
			const chunk2 = "B".repeat(30);

			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: ["launch"],
				spawn: () => fakeChildWithStderr(pid, 1, null, [chunk1, chunk2]),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
				sessionStderrDir: ctx.sessionStderrDir,
				maxStderrLogBytes: 50,
				maxStderrLogFiles: 3,
				forwardStderr: false,
			});

			expect(result.reported).toBe(true);
			expect(result.report).toBeDefined();
			expect(result.report?.stderrLogPath).toBeDefined();
			expect(result.report?.stderrStatus).toBe("captured");
			expect(result.report?.stderrBytes).toBe(70);
			expect(result.report?.stderrFiles?.length).toBe(2);

			const activeContent = fs.readFileSync(result.report!.stderrLogPath!, "utf8");
			expect(activeContent).toBe(chunk2);

			const rotatedFile = path.join(ctx.sessionStderrDir, `${pid}.stderr.1.log`);
			expect(fs.existsSync(rotatedFile)).toBe(true);
			expect(fs.readFileSync(rotatedFile, "utf8")).toBe(chunk1);

			expect(ctx.logs.length).toBe(1);
			expect(ctx.logs[0].context?.stderrLogPath).toBe(result.report!.stderrLogPath);
			expect(ctx.logs[0].context?.stderrStatus).toBe("captured");
		} finally {
			ctx.cleanup();
		}
	});

	test("handles spawn errors gracefully without supervisor crash", async () => {
		const ctx = createTestContext();
		try {
			const result = await superviseProcess({
				execPath: "nonexistent-binary-12345.exe",
				argv: [],
				spawn: () => {
					throw new Error("spawn ENOENT");
				},
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
				sessionStderrDir: ctx.sessionStderrDir,
			});

			expect(result.reported).toBe(false);
			expect(result.exitCode).toBe(1);
		} finally {
			ctx.cleanup();
		}
	});

	test("handles rotation errors gracefully without supervisor crash", async () => {
		const ctx = createTestContext();
		try {
			const pid = 5558;
			ctx.writeHeartbeat(pid, { sessionId: "session-rot-err-test", phase: "tool" });
			const chunk1 = "A".repeat(40);
			const chunk2 = "B".repeat(30);

			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: ["launch"],
				spawn: () => fakeChildWithStderr(pid, 1, null, [chunk1, chunk2]),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
				sessionStderrDir: ctx.sessionStderrDir,
				maxStderrLogBytes: 50,
				maxStderrLogFiles: 3,
				forwardStderr: false,
				renameSync: () => {
					throw new Error("EPERM: operation not permitted");
				},
			});

			expect(result.reported).toBe(true);
			expect(result.report?.stderrStatus).toBe("rotation_error");
			const activeContent = fs.readFileSync(result.report!.stderrLogPath!, "utf8");
			expect(activeContent).toBe(chunk1);
			expect(activeContent.length).toBeLessThanOrEqual(50);
		} finally {
			ctx.cleanup();
		}
	});

	test("stderr rotation with maxFiles=1 truncates single log file at rotate", async () => {
		const ctx = createTestContext();
		try {
			const pid = 5559;
			ctx.writeHeartbeat(pid, { sessionId: "session-maxfiles-1-test", phase: "tool" });
			const chunk1 = "A".repeat(40);
			const chunk2 = "B".repeat(30);

			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: ["launch"],
				spawn: () => fakeChildWithStderr(pid, 1, null, [chunk1, chunk2]),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
				sessionStderrDir: ctx.sessionStderrDir,
				maxStderrLogBytes: 50,
				maxStderrLogFiles: 1,
				forwardStderr: false,
			});

			expect(result.reported).toBe(true);
			expect(result.report?.stderrStatus).toBe("captured");
			expect(result.report?.stderrFiles.length).toBe(1);
			expect(fs.existsSync(path.join(ctx.sessionStderrDir, `${pid}.stderr.1.log`))).toBe(false);
			const activeContent = fs.readFileSync(result.report!.stderrLogPath!, "utf8");
			expect(activeContent).toBe(chunk2);
			expect(activeContent.length).toBeLessThanOrEqual(50);
		} finally {
			ctx.cleanup();
		}
	});

	test("stderr rotation splits oversized chunks across rotated files respecting hard byte bound", async () => {
		const ctx = createTestContext();
		try {
			const pid = 5560;
			ctx.writeHeartbeat(pid, { sessionId: "session-oversized-chunk-test", phase: "tool" });
			const oversized = "A".repeat(50) + "B".repeat(50) + "C".repeat(20); // 120 bytes

			const result = await superviseProcess({
				execPath: "veyyon.exe",
				argv: ["launch"],
				spawn: () => fakeChildWithStderr(pid, 1, null, [oversized]),
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
				sessionStderrDir: ctx.sessionStderrDir,
				maxStderrLogBytes: 50,
				maxStderrLogFiles: 3,
				forwardStderr: false,
			});

			expect(result.reported).toBe(true);
			expect(result.report?.stderrStatus).toBe("captured");
			expect(result.report?.stderrBytes).toBe(120);
			expect(result.report?.stderrFiles.length).toBe(3);

			const active = fs.readFileSync(result.report!.stderrLogPath!, "utf8");
			const rot1 = fs.readFileSync(path.join(ctx.sessionStderrDir, `${pid}.stderr.1.log`), "utf8");
			const rot2 = fs.readFileSync(path.join(ctx.sessionStderrDir, `${pid}.stderr.2.log`), "utf8");

			expect(active).toBe("C".repeat(20));
			expect(rot1).toBe("B".repeat(50));
			expect(rot2).toBe("A".repeat(50));

			expect(active.length).toBeLessThanOrEqual(50);
			expect(rot1.length).toBeLessThanOrEqual(50);
			expect(rot2.length).toBeLessThanOrEqual(50);
		} finally {
			ctx.cleanup();
		}
	});

	test("real subprocess smoke fixture: writes beyond bound, leaves heartbeat, exits without tombstone", async () => {
		const ctx = createTestContext();
		const fixturePath = path.resolve(__dirname, "fixtures/supervisor-death-smoke.ts");
		try {
			const result = await superviseProcess({
				execPath: process.execPath,
				argv: [
					fixturePath,
					"--heartbeat-dir",
					ctx.heartbeatDir,
					"--bytes",
					"2500",
					"--chunk-size",
					"700",
					"--exit-code",
					"42",
				],
				logger: ctx.logger,
				heartbeatDir: ctx.heartbeatDir,
				sessionStderrDir: ctx.sessionStderrDir,
				maxStderrLogBytes: 500,
				maxStderrLogFiles: 3,
				forwardStderr: false,
			});

			expect(result.reported).toBe(true);
			expect(result.exitCode).toBe(42);
			expect(result.report).toBeDefined();

			const report = result.report!;
			expect(report.pid).toBeGreaterThan(0);
			expect(report.sessionId).toBe("smoke-fixture-session");
			expect(report.phase).toBe("tool");
			expect(report.handleCount).toBe(88);
			expect(report.consoleLogPath).toBe(path.join(ctx.heartbeatDir, `${report.pid}.console.log`));
			expect(report.consoleCtrlStatus).toBe("installed");
			expect(report.consoleCtrlInstalled).toBe(true);
			expect(report.resourceHistory).toBeDefined();
			expect(report.resourceHistory!.length).toBeGreaterThanOrEqual(1);
			expect(report.resourceHistory![0].handleCount).toBe(88);

			expect((report as any).terminatorAttributionReason).toBeUndefined();
			expect(report.terminatorAttribution).toEqual({
				available: false,
				reason: "Child exit reports do not provide killer PID",
				killerPid: null,
			});
			expect("terminatorAttributionReason" in (report ?? {})).toBe(false);
			expect(report.stderrStatus).toBe("captured");
			expect(report.stderrBytes).toBe(2500);
			expect(report.stderrFiles.length).toBe(3);
			for (const f of report.stderrFiles) {
				const stat = fs.statSync(f);
				expect(stat.size).toBeLessThanOrEqual(500);
			}

			expect(ctx.logs.length).toBe(1);
			const loggedCtx = ctx.logs[0].context;
			expect(loggedCtx?.handleCount).toBe(88);
			expect(loggedCtx?.consoleCtrlInstalled).toBe(true);
			expect(loggedCtx?.resourceHistory).toBeDefined();
			expect("terminatorAttributionReason" in (loggedCtx ?? {})).toBe(false);
			expect(loggedCtx?.terminatorAttribution).toEqual({
				available: false,
				reason: "Child exit reports do not provide killer PID",
				killerPid: null,
			});
		} finally {
			ctx.cleanup();
		}
	});
});

describe("supervisor dumps (Windows LocalDumps registry configuration)", () => {
	test("enable exact two-key HKCU configuration (default and custom directory)", async () => {
		const scenarios = [
			{ folder: DEFAULT_DUMP_FOLDER, count: 5 },
			{ folder: "C:\\CustomDumps", count: 10 },
		];

		for (const { folder, count } of scenarios) {
			const mock = createMockRegRunner();
			const mkdirCalls: string[] = [];
			const res = await enableLocalDumps({
				runner: mock.runner,
				folder,
				count,
				platform: "win32",
				mkdir: dir => mkdirCalls.push(dir),
			});

			expect(res.supported).toBe(true);
			expect(mkdirCalls).toEqual([folder]);
			expect(mock.calls.length).toBe(6);

			for (const app of SUPERVISOR_TARGET_APPS) {
				const key = `${LOCAL_DUMPS_BASE_KEY}\\${app}`;
				expect(mock.calls).toContainEqual([
					"add",
					key,
					"/v",
					"DumpFolder",
					"/t",
					"REG_EXPAND_SZ",
					"/d",
					folder,
					"/f",
				]);
				expect(mock.calls).toContainEqual([
					"add",
					key,
					"/v",
					"DumpCount",
					"/t",
					"REG_DWORD",
					"/d",
					String(count),
					"/f",
				]);
				expect(mock.calls).toContainEqual(["add", key, "/v", "DumpType", "/t", "REG_DWORD", "/d", "1", "/f"]);
			}
		}
	});

	test("enableLocalDumps count validation throws CliUsageError for out-of-bounds or non-integer counts", async () => {
		const invalidCounts = [0, -1, 101, 1.5, Number.NaN];
		for (const count of invalidCounts) {
			await expect(enableLocalDumps({ count, platform: "win32", mkdir: () => {} })).rejects.toThrow(
				"DumpCount must be an integer between 1 and 100",
			);
		}
	});

	test("enableLocalDumps throws on failed reg add mutation and never returns success", async () => {
		const mock = createMockRegRunner(args => {
			if (args[0] === "add") return { exitCode: 1, stdout: "", stderr: "ERROR: Access is denied." };
			return { exitCode: 0, stdout: "", stderr: "" };
		});

		await expect(enableLocalDumps({ runner: mock.runner, platform: "win32", mkdir: () => {} })).rejects.toThrow(
			"Registry mutation failed [action: add, app: veyyon.exe, value: DumpFolder]: ERROR: Access is denied.",
		);
	});

	test("disable only two keys", async () => {
		const mock = createMockRegRunner();
		const res = await disableLocalDumps({ runner: mock.runner, platform: "win32" });

		expect(res.supported).toBe(true);
		expect(mock.calls.length).toBe(2);

		for (const app of SUPERVISOR_TARGET_APPS) {
			const expectedKey = `${LOCAL_DUMPS_BASE_KEY}\\${app}`;
			expect(mock.calls).toContainEqual(["delete", expectedKey, "/f"]);
		}

		for (const call of mock.calls) {
			expect(call[1]).not.toBe(LOCAL_DUMPS_BASE_KEY);
		}
	});
	test("disable is idempotent when application keys are already absent", async () => {
		const mock = createMockRegRunner(() => ({
			exitCode: 1,
			stdout: "",
			stderr: "ERROR: The system was unable to find the specified registry key or value.",
		}));

		const res = await disableLocalDumps({ runner: mock.runner, platform: "win32" });
		expect(res.supported).toBe(true);
		expect(mock.calls).toHaveLength(2);
	});

	test("disableLocalDumps throws on failed reg delete mutation and never returns success", async () => {
		const mock = createMockRegRunner(args => {
			if (args[0] === "delete") return { exitCode: 1, stdout: "", stderr: "ERROR: Access is denied." };
			return { exitCode: 0, stdout: "", stderr: "" };
		});

		await expect(disableLocalDumps({ runner: mock.runner, platform: "win32" })).rejects.toThrow(
			"Registry mutation failed [action: delete, app: veyyon.exe, value: key]: ERROR: Access is denied.",
		);
	});

	test("statusLocalDumps reports configured / unconfigured with parsed details", async () => {
		// Valid veyyon.exe, missing bun.exe
		const mock1 = createMockRegRunner(args => {
			const key = args[1] ?? "";
			if (key.includes("veyyon.exe")) {
				return {
					exitCode: 0,
					stdout:
						"\nDumpFolder REG_EXPAND_SZ %LOCALAPPDATA%\\CrashDumps\nDumpCount REG_DWORD 0x5\nDumpType REG_DWORD 0x1\n",
					stderr: "",
				};
			}
			return { exitCode: 1, stdout: "", stderr: "not found" };
		});

		const res1 = await statusLocalDumps({ runner: mock1.runner, platform: "win32" });
		expect(res1.supported).toBe(true);
		expect(res1.apps?.["veyyon.exe"]?.configured).toBe(true);
		expect(res1.apps?.["veyyon.exe"]?.folder).toBe("%LOCALAPPDATA%\\CrashDumps");
		expect(res1.apps?.["veyyon.exe"]?.count).toBe(5);
		expect(res1.apps?.["veyyon.exe"]?.type).toBe(1);
		expect(res1.apps?.["bun.exe"]?.configured).toBe(false);

		// Malformed / partial: veyyon missing folder, bun count out of bounds (150)
		const mock2 = createMockRegRunner(args => {
			const key = args[1] ?? "";
			if (key.includes("veyyon.exe")) {
				return { exitCode: 0, stdout: "\nDumpCount REG_DWORD 0x5\nDumpType REG_DWORD 0x1\n", stderr: "" };
			}
			return {
				exitCode: 0,
				stdout: "\nDumpFolder REG_EXPAND_SZ C:\\Dumps\nDumpCount REG_DWORD 0x96\nDumpType REG_DWORD 0x1\n",
				stderr: "",
			};
		});

		const res2 = await statusLocalDumps({ runner: mock2.runner, platform: "win32" });
		expect(res2.apps?.["veyyon.exe"]?.configured).toBe(false);
		expect(res2.apps?.["veyyon.exe"]?.folder).toBeUndefined();
		expect(res2.apps?.["veyyon.exe"]?.count).toBe(5);
		expect(res2.apps?.["veyyon.exe"]?.type).toBe(1);

		expect(res2.apps?.["bun.exe"]?.configured).toBe(false);
		expect(res2.apps?.["bun.exe"]?.folder).toBe("C:\\Dumps");
		expect(res2.apps?.["bun.exe"]?.count).toBe(150);
		expect(res2.apps?.["bun.exe"]?.type).toBe(1);

		// DumpType is 2 (Full dump) instead of 1
		const mock3 = createMockRegRunner(() => ({
			exitCode: 0,
			stdout: "\nDumpFolder REG_EXPAND_SZ C:\\Dumps\nDumpCount REG_DWORD 0x5\nDumpType REG_DWORD 0x2\n",
			stderr: "",
		}));
		const res3 = await statusLocalDumps({ runner: mock3.runner, platform: "win32" });
		expect(res3.apps?.["veyyon.exe"]?.configured).toBe(false);
		expect(res3.apps?.["veyyon.exe"]?.type).toBe(2);
	});

	test("non-Windows fail-closed", async () => {
		for (const platform of ["linux", "darwin"]) {
			const mock = createMockRegRunner();
			const mkdirCalls: string[] = [];

			const enRes = await enableLocalDumps({ runner: mock.runner, platform, mkdir: d => mkdirCalls.push(d) });
			expect(enRes.supported).toBe(false);
			expect(mock.calls.length).toBe(0);
			expect(mkdirCalls.length).toBe(0);

			const disRes = await disableLocalDumps({ runner: mock.runner, platform });
			expect(disRes.supported).toBe(false);
			expect(mock.calls.length).toBe(0);

			const stRes = await statusLocalDumps({ runner: mock.runner, platform });
			expect(stRes.supported).toBe(false);
			expect(mock.calls.length).toBe(0);
		}
	});
});
