import { describe, expect, test } from "bun:test";
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
} from "../src/supervisor/dumps";
import { resolveSupervisorArgv, shouldSuperviseLaunch, superviseProcess } from "../src/supervisor/process";

function createTestContext() {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
	const heartbeatDir = path.join(tempDir, "heartbeat");
	fs.mkdirSync(heartbeatDir, { recursive: true });
	const logs: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
	const logger = {
		errorSync(message: string, context?: Record<string, unknown>) {
			logs.push({ message, context });
		},
	};
	return {
		tempDir,
		heartbeatDir,
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
		expect(capturedOpts?.stdio).toBe("inherit");
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
