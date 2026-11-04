/**
 * An eval kernel follows its session across a cwd change.
 *
 * WHY THIS SUITE EXISTS. A retained eval kernel was keyed by the cwd twice: the eval session id a
 * session derives (`defaultEvalSessionId`) contained its cwd, and the pool key (`buildEvalSessionKey`)
 * added it again. A session that moved between directories started a kernel in each one and kept
 * every earlier kernel alive until the session ended, at several hundred megabytes each, and the
 * variables of the first directory were gone in the second. Every runner applies the cwd sent with
 * each cell, so a directory change needs no new kernel.
 *
 * The class is every kernel-backed eval language plus the session-level id each of them is keyed by.
 * The languages are swept from the eval barrel, so a new backend fails here until it records how its
 * kernels are scoped. The session id is driven through a real `AgentSession` and its own `setCwd`.
 *
 * Not caught here: whether a runner's import path moves with the cwd needs a live interpreter. The
 * opt-in `python-runner-integration` and `ruby-runner.integration` suites cover that.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExecutorBackend, ExecutorBackendExecOptions } from "@veyyon/coding-agent/eval";
import * as evalBarrel from "@veyyon/coding-agent/eval";
import * as juliaExecutor from "@veyyon/coding-agent/eval/jl/executor";
import * as juliaKernel from "@veyyon/coding-agent/eval/jl/kernel";
import type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelShutdownResult,
	SessionKernel,
} from "@veyyon/coding-agent/eval/kernel-base";
import * as pythonExecutor from "@veyyon/coding-agent/eval/py/executor";
import * as pythonKernel from "@veyyon/coding-agent/eval/py/kernel";
import * as rubyExecutor from "@veyyon/coding-agent/eval/rb/executor";
import * as rubyKernel from "@veyyon/coding-agent/eval/rb/kernel";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedAgentDir();

const OK: KernelExecuteResult = { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };

/** Records the cwd each cell was sent with, which is what a runner applies before the cell runs. */
class FakeKernel implements SessionKernel {
	readonly cwds: Array<string | undefined> = [];
	#alive = true;

	isAlive(): boolean {
		return this.#alive;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.cwds.push(options?.cwd);
		return OK;
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.#alive = false;
		return { confirmed: true };
	}
}

interface KernelSeams {
	kernelClass: { start: (...args: never[]) => Promise<unknown> };
	availabilityModule: Record<string, unknown>;
	availabilityExport: string;
	disposeAll: () => Promise<void>;
}

const SEAMS: Readonly<Record<string, KernelSeams>> = {
	python: {
		kernelClass: pythonKernel.PythonKernel,
		availabilityModule: pythonKernel as unknown as Record<string, unknown>,
		availabilityExport: "checkPythonKernelAvailability",
		disposeAll: pythonExecutor.disposeAllKernelSessions,
	},
	ruby: {
		kernelClass: rubyKernel.RubyKernel,
		availabilityModule: rubyKernel as unknown as Record<string, unknown>,
		availabilityExport: "checkRubyKernelAvailability",
		disposeAll: rubyExecutor.disposeAllRubyKernelSessions,
	},
	julia: {
		kernelClass: juliaKernel.JuliaKernel,
		availabilityModule: juliaKernel as unknown as Record<string, unknown>,
		availabilityExport: "checkJuliaKernelAvailability",
		disposeAll: juliaExecutor.disposeAllJuliaKernelSessions,
	},
};

/**
 * `js` runs its context in a worker keyed by the eval session id alone and applies the cwd per run,
 * so it has no kernel key of its own to get wrong. The session id it shares is asserted below.
 */
const KEYED_BY_SESSION_ID_ALONE = ["js"];

function isBackend(value: unknown): value is ExecutorBackend {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ExecutorBackend>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.isAvailable === "function" &&
		typeof candidate.execute === "function"
	);
}

const BACKENDS: ExecutorBackend[] = Object.values(evalBarrel).filter(isBackend);

/** Answer availability for `seams`, hand out a fresh fake per kernel start, and keep them in start order. */
function recordStarts(seams: KernelSeams): FakeKernel[] {
	const started: FakeKernel[] = [];
	vi.spyOn(seams.availabilityModule, seams.availabilityExport).mockResolvedValue({ ok: true } as never);
	vi.spyOn(seams.kernelClass, "start").mockImplementation((async () => {
		const kernel = new FakeKernel();
		started.push(kernel);
		return kernel;
	}) as never);
	return started;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(Object.values(SEAMS).map(seams => seams.disposeAll()));
});

describe("the backend list this suite sweeps", () => {
	it("accounts for every eval backend the barrel exports", () => {
		const ids = BACKENDS.map(backend => backend.id).sort();
		expect(ids).toEqual(["js", "julia", "python", "ruby"]);
		expect(ids.filter(id => SEAMS[id] === undefined && !KEYED_BY_SESSION_ID_ALONE.includes(id))).toEqual([]);
		expect(KEYED_BY_SESSION_ID_ALONE).toEqual(["js"]);
	});
});

describe.each(Object.keys(SEAMS))("the %s kernel", id => {
	const seams = SEAMS[id]!;
	const backend = (): ExecutorBackend => {
		const found = BACKENDS.find(candidate => candidate.id === id);
		if (found === undefined) throw new Error(`no backend exported for ${id}`);
		return found;
	};

	function run(code: string, cwd: string): Promise<unknown> {
		const options: ExecutorBackendExecOptions = {
			cwd,
			sessionId: `follows-cwd:${id}`,
			sessionFile: undefined,
			kernelOwnerId: `follows-cwd-owner:${id}`,
			session: makeToolSession({ cwd }),
			reset: false,
			onChunk: () => {},
		};
		return backend().execute(code, options);
	}

	it("runs a cell in a second directory on the kernel the first directory started", async () => {
		using first = TempDir.createSync(`@veyyon-${id}-follows-cwd-a-`);
		using second = TempDir.createSync(`@veyyon-${id}-follows-cwd-b-`);
		const started = recordStarts(seams);

		await run("1", first.path());
		await run("2", second.path());
		await run("3", first.path());

		expect(started).toHaveLength(1);
		expect(started[0]!.cwds).toEqual([first.path(), second.path(), first.path()]);
	});
});

describe("a Python project venv", () => {
	/**
	 * The one cwd that does select a different kernel: a project `.venv` picks the interpreter, and a
	 * running kernel cannot switch interpreters. An active `VIRTUAL_ENV` or `CONDA_PREFIX` wins over a
	 * project venv for every directory, so the case only exists without one.
	 */
	it.skipIf(Boolean(process.env.VIRTUAL_ENV || process.env.CONDA_PREFIX))(
		"starts a second kernel for a directory with its own venv, and only for it",
		async () => {
			using plain = TempDir.createSync("@veyyon-python-plain-");
			using project = TempDir.createSync("@veyyon-python-venv-");
			fs.mkdirSync(path.join(project.path(), ".venv"));
			const started = recordStarts(SEAMS.python!);
			const run = (cwd: string) =>
				pythonExecutor.executePython("1", { cwd, sessionId: "python:venv-scope", kernelMode: "session" });

			await run(plain.path());
			await run(project.path());
			await run(plain.path());

			expect(started).toHaveLength(2);
			expect(started[0]!.cwds).toEqual([plain.path(), plain.path()]);
			expect(started[1]!.cwds).toEqual([project.path()]);
		},
	);
});

describe("the eval session id of an agent session", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");

	async function sessionIn(cwd: string, sessionManager: SessionManager, agentDir: string) {
		fs.mkdirSync(agentDir, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage: await isolatedAuthStorage(agentDir),
			sessionManager,
			settings: Settings.isolated({ "python.kernelMode": "session" }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["eval"],
			workspaceTree: { rootPath: cwd, rendered: ".", truncated: false, totalLines: 1, agentsMdFiles: [] },
		});
		return session;
	}

	/**
	 * Driven through `executePython`, the `$` path, because it derives its id the way the eval tool
	 * does and sends the session's current cwd: one kernel start across `setCwd` is the whole contract.
	 * A session without a file is keyed by its cwd on purpose, since every fileless session in one
	 * directory shares a kernel, and is not covered here.
	 */
	it("keeps one Python kernel across setCwd for a session with a file", async () => {
		using root = TempDir.createSync("@veyyon-follows-cwd-session-");
		const first = path.join(root.path(), "first");
		const second = path.join(root.path(), "second");
		fs.mkdirSync(first);
		fs.mkdirSync(second);
		const started = recordStarts(SEAMS.python!);
		const session = await sessionIn(
			first,
			SessionManager.create(first, path.join(root.path(), "sessions")),
			path.join(root.path(), "agent"),
		);
		try {
			const idBefore = session.getEvalSessionId();
			await session.executePython("x = 1", undefined, { excludeFromContext: true });
			await session.setCwd(second);
			await session.executePython("x", undefined, { excludeFromContext: true });

			expect(session.getEvalSessionId()).toBe(idBefore);
			expect(started).toHaveLength(1);
			expect(started[0]!.cwds).toEqual([first, second]);
		} finally {
			await session.dispose();
		}
	});
});
