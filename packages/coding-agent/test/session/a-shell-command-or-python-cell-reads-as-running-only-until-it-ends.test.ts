// WHY: `isBashRunning` and `isEvalRunning` read the abort controllers of the `!` commands and `$`
// cells in flight. The terminal refuses a new `!` command while one reads as running ("A bash
// command is already running") and `/btw` refuses to branch, so a controller left behind after its
// run ended blocks every later command until the session is replaced. Mutation testing of
// `session/runtime/user-executions.ts` found the release after a finished command unpinned.
//
// Class closed: a command or cell reads as running from its start until it ends, however it ends
// (an answer, an abort, a thrown executor), and the abort reaches the run in flight. The suite drives
// the real `AgentSession` with the shell and kernel executors replaced at their module exports.
//
// Not caught: a run that never settles, which reads as running by design until it is aborted.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { PythonResult } from "@veyyon/coding-agent/eval/py/executor";
import * as pythonExecutor from "@veyyon/coding-agent/eval/py/executor";
import type { BashResult } from "@veyyon/coding-agent/exec/bash-executor";
import * as bashExecutor from "@veyyon/coding-agent/exec/bash-executor";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

function bashResult(output: string, cancelled = false): BashResult {
	return {
		output,
		exitCode: cancelled ? undefined : 0,
		cancelled,
		truncated: false,
		totalLines: 1,
		totalBytes: output.length,
		outputLines: 1,
		outputBytes: output.length,
	};
}

function pythonResult(output: string): PythonResult {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: output.length,
		outputLines: 1,
		outputBytes: output.length,
		displayOutputs: [],
		stdinRequested: false,
	};
}

describe("a shell command or Python cell reads as running only until it ends", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-user-run-state-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("reads a shell command as running until it answers, then runs the next", async () => {
		const first = Promise.withResolvers<BashResult>();
		vi.spyOn(bashExecutor, "executeBash").mockImplementationOnce(() => first.promise);

		const running = session.executeBash("first", undefined);
		await Promise.resolve();
		expect(session.isBashRunning).toBe(true);
		first.resolve(bashResult("first done"));
		expect((await running).output).toBe("first done");
		expect(session.isBashRunning).toBe(false);

		vi.spyOn(bashExecutor, "executeBash").mockResolvedValueOnce(bashResult("second done"));
		expect((await session.executeBash("second", undefined)).output).toBe("second done");
		expect(session.isBashRunning).toBe(false);
	});

	it("aborts the shell command in flight and stops reading it as running", async () => {
		vi.spyOn(bashExecutor, "executeBash").mockImplementationOnce((_command, options) => {
			const { promise, resolve } = Promise.withResolvers<BashResult>();
			options?.signal?.addEventListener("abort", () => resolve(bashResult("", true)), { once: true });
			return promise;
		});

		const running = session.executeBash("sleep 60", undefined);
		await Promise.resolve();
		session.abortBash();

		expect((await running).cancelled).toBe(true);
		expect(session.isBashRunning).toBe(false);
	});

	it("stops reading a shell command as running when its executor throws", async () => {
		vi.spyOn(bashExecutor, "executeBash").mockRejectedValueOnce(new Error("spawn failed"));

		await expect(session.executeBash("missing-binary", undefined)).rejects.toThrow("spawn failed");
		expect(session.isBashRunning).toBe(false);
	});

	it("reads a Python cell as running until it answers or throws", async () => {
		const cell = Promise.withResolvers<PythonResult>();
		vi.spyOn(pythonExecutor, "executePython").mockImplementationOnce(() => cell.promise);

		const running = session.executePython("1 + 1", undefined);
		await new Promise(resolve => setImmediate(resolve));
		expect(session.isEvalRunning).toBe(true);
		cell.resolve(pythonResult("2"));
		expect((await running).output).toBe("2");
		expect(session.isEvalRunning).toBe(false);

		vi.spyOn(pythonExecutor, "executePython").mockRejectedValueOnce(new Error("kernel died"));
		await expect(session.executePython("raise", undefined)).rejects.toThrow("kernel died");
		expect(session.isEvalRunning).toBe(false);
	});
});
