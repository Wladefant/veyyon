/**
 * Disposing an AgentSession ends the Python runner it alone owned, keeps a runner another live
 * session still uses running and usable, and never touches a runner of an unrelated session.
 *
 * WHY THIS SUITE EXISTS (issue 639: eval runners outlive their session). The pool and the
 * owner-scoped registry each have their own suite, but neither proves the end-to-end path a user
 * reaches: `AgentSession.dispose()` -> `disposeOwnedResources("eval-kernel-owner", ownerId)` ->
 * `KernelSessionPool.disposeByOwner`. This test drives that path through a real `createAgentSession`
 * and the real module-level Python pool.
 *
 * THE BOUNDARY. Only the runner process is controlled: `PythonKernel.start` and the Python
 * availability probe are stubbed to hand back in-memory runners that record every `execute` and
 * `shutdown`. The session, the pool, the owner ids and the registry are production code.
 *
 * WHAT CLASS THIS CLOSES. A dispose must (a) end every runner whose last owner it was, (b) leave a
 * runner that another live owner still holds alive and usable, and (c) leave runners of sessions it
 * does not own untouched. Each dispose is bounded by an explicit time limit so a regression that
 * waits on a runner fails here rather than hanging the suite.
 *
 * WHAT IT DOES NOT CATCH. A runner that refuses to shut down (the unconfirmed path is covered by
 * the pool suites), and the real interpreter process exit frame; `kernel-base` tests own that
 * boundary. The availability probe is also stubbed, so a regression in the host interpreter lookup
 * is outside this suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SessionKernel } from "@veyyon/coding-agent/eval/kernel-base";
import * as pythonExecutor from "@veyyon/coding-agent/eval/py/executor";
import type { PythonKernel as PythonKernelInstance } from "@veyyon/coding-agent/eval/py/kernel";
import * as pythonKernel from "@veyyon/coding-agent/eval/py/kernel";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { setAgentDir, Snowflake, TempDir } from "@veyyon/utils";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const OK_EXECUTION = { status: "ok", cancelled: false, timedOut: false, stdinRequested: false } as const;

/** Explicit upper bound for one session dispose. Nothing here runs long, so a hang fails fast. */
const DISPOSE_BOUND_MS = 2_000;

/** An in-memory runner: records what the session asked of it, answers every execution. */
class RecordingRunner implements SessionKernel {
	readonly executed: string[] = [];
	shutdownCalls = 0;
	alive = true;

	isAlive(): boolean {
		return this.alive;
	}

	async execute(code: string): Promise<typeof OK_EXECUTION> {
		this.executed.push(code);
		return OK_EXECUTION;
	}

	async shutdown(): Promise<{ confirmed: boolean }> {
		this.shutdownCalls += 1;
		this.alive = false;
		return { confirmed: true };
	}
}

const getModel = () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	return model;
};

describe("AgentSession dispose and the Python runners it owns", () => {
	const tempDirs: TempDir[] = [];
	let globals: SettingsTestState | undefined;
	let agentDir: TempDir;
	let originalNullPrompt: string | undefined;

	beforeEach(() => {
		globals = beginSettingsTest();
		agentDir = TempDir.createSync("@pi-dispose-runners-agentdir-");
		setAgentDir(agentDir.path());
		originalNullPrompt = Bun.env.NULL_PROMPT;
		Bun.env.NULL_PROMPT = "true";
	});

	afterEach(async () => {
		restoreSettingsTestState(globals);
		globals = undefined;
		if (originalNullPrompt === undefined) delete Bun.env.NULL_PROMPT;
		else Bun.env.NULL_PROMPT = originalNullPrompt;
		originalNullPrompt = undefined;
		vi.restoreAllMocks();
		AgentStorage.resetInstance();
		await pythonExecutor.disposeAllKernelSessions();
		for (const dir of [...tempDirs.splice(0), agentDir]) {
			await dir.remove().catch(() => {});
		}
	});

	/** A real AgentSession rooted at `cwd`. Each cwd names one Python runner key. */
	async function createSession(cwd: string) {
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: agentDir.path(),
			authStorage: await isolatedAuthStorage(agentDir.path()),
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "python.kernelMode": "session" }),
			model: getModel(),
			disableExtensionDiscovery: true,
			extensions: undefined,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			workspaceTree: { rootPath: cwd, rendered: ".", truncated: false, totalLines: 1, agentsMdFiles: [] },
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["eval"],
		});
		return session;
	}

	it("ends the runner only its last owner held, keeps a shared runner usable, and never touches an unrelated one", async () => {
		const root = TempDir.createSync(`@pi-dispose-runners-${Snowflake.next()}-`);
		tempDirs.push(root);

		// Runners are handed out in start order: the leaver's, the shared one, the unrelated one.
		const leaverRunner = new RecordingRunner();
		const sharedRunner = new RecordingRunner();
		const unrelatedRunner = new RecordingRunner();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(leaverRunner as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(sharedRunner as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(unrelatedRunner as unknown as PythonKernelInstance);

		// `leaver` is the only session that uses cwd A. `shared` and `survivor` both use cwd B.
		// `unrelated` uses cwd C. A session's Python runner key is its cwd, so this is the layout.
		const leaver = await createSession(root.join("cwd-a"));
		const shared = await createSession(root.join("cwd-b"));
		const survivor = await createSession(root.join("cwd-b"));
		const unrelated = await createSession(root.join("cwd-c"));

		try {
			await leaver.executePython("print('leaver')");
			await shared.executePython("print('shared')");
			await survivor.executePython("print('survivor-warmup')");
			await unrelated.executePython("print('unrelated')");
			expect(startSpy).toHaveBeenCalledTimes(3);

			// Step 1: a session that shares a runner leaves. The runner must survive for the other.
			const sharedStarted = performance.now();
			await shared.dispose();
			expect(performance.now() - sharedStarted).toBeLessThan(DISPOSE_BOUND_MS);
			expect(sharedRunner.shutdownCalls).toBe(0);
			expect(sharedRunner.alive).toBe(true);

			await survivor.executePython("print('after-shared-left')");
			expect(sharedRunner.executed).toContain("print('after-shared-left')");
			expect(startSpy).toHaveBeenCalledTimes(3);

			// Step 2: the only owner of its runner leaves. That runner must exit, and nothing else may.
			const leaverStarted = performance.now();
			await leaver.dispose();
			expect(performance.now() - leaverStarted).toBeLessThan(DISPOSE_BOUND_MS);
			expect(leaverRunner.shutdownCalls).toBe(1);
			expect(leaverRunner.alive).toBe(false);
			expect(sharedRunner.shutdownCalls).toBe(0);
			expect(unrelatedRunner.shutdownCalls).toBe(0);
			expect(unrelatedRunner.alive).toBe(true);

			// Step 3: the unrelated session is still live and its runner still answers.
			await unrelated.executePython("print('unrelated-after')");
			expect(unrelatedRunner.executed).toContain("print('unrelated-after')");
			expect(startSpy).toHaveBeenCalledTimes(3);
		} finally {
			await survivor.dispose();
			await unrelated.dispose();
		}

		// Last owners gone: each remaining runner exits exactly once.
		expect(sharedRunner.shutdownCalls).toBe(1);
		expect(unrelatedRunner.shutdownCalls).toBe(1);
		expect(leaverRunner.shutdownCalls).toBe(1);
	});
});
