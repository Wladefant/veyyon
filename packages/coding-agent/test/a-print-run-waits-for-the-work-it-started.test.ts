/**
 * WHY: a `-p` run returned as soon as its prompt's turn ended and disposed the session, so a
 * spawned agent or a backgrounded command that turn started was stopped, and its result, which
 * arrives by waking the loop for a follow-up turn, was never answered. The run printed the turn
 * that started the work and exited 0. The class this closes: a print run that ends while background
 * work it started is still due to report, for every kind of job the manager runs. Each kind is
 * pinned to whether a run waits for it by exact equality, so a new kind is a compile error here
 * until someone decides it. A launched process is the one kind not waited for: it runs until
 * something stops it, and waiting on it would hold the run open forever, which `RUN_BOUND_MS`
 * turns into a failure instead of a hang.
 *
 * It drives a session built by `createAgentSession` against a scripted provider, so a finished job
 * reaches the conversation through the production delivery path. Not caught: the `bash` and `task`
 * tools that register these jobs (the provider registers each job here, at the point in the turn
 * where a tool would, under the owner those tools use), and `--mode json`, which reads the same
 * settled session as text mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Context } from "@veyyon/ai";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { AsyncJobManager, type AsyncJobType, JOB_ENDS_ON_ITS_OWN } from "@veyyon/coding-agent/async/job-manager";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runPrintMode } from "@veyyon/coding-agent/modes/print-mode";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir, withTimeout } from "@veyyon/utils";

/** Whether a print run waits for a job of each kind before it exits. */
const A_PRINT_RUN_WAITS_FOR: Record<AsyncJobType, boolean> = { bash: true, task: true, launch: false };

/** How long a job that ends on its own runs: long enough to outlast the turn that started it. */
const JOB_MS = 60;
/** The bound on a run that must not wait: a regression that waits on a launch hangs until here. */
const RUN_BOUND_MS = 10_000;
/** Each test's own limit, past the run bound so a run that hangs fails on the bound and its message. */
const TEST_TIMEOUT_MS = RUN_BOUND_MS * 3;

const MOCK_API_SOURCE = "a-print-run-waits-for-the-work-it-started";

/** How a job ended: on its own, or stopped when the run disposed its session. */
type Outcome = "finished" | "stopped";

function resultOf(type: AsyncJobType): string {
	return `JOB-RESULT-${type}`;
}

function contextText(context: Context): string {
	return JSON.stringify(context.messages);
}

describe("a print run waits for the work it started", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let stdout: string;
	let exitCodes: number[];

	beforeEach(() => {
		expect(AsyncJobManager.instance(), "an earlier suite left an AsyncJobManager installed").toBeUndefined();
		stdout = "";
		exitCodes = [];
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null | undefined) => {
			exitCodes.push(Number(code ?? 0));
			return undefined as never;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation((chunk, callback) => {
			stdout += String(chunk);
			if (typeof callback === "function") callback();
			return true;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		unregisterCustomApis(MOCK_API_SOURCE);
		authStorage?.close();
		tempDir?.removeSync();
		AsyncJobManager.resetForTests();
	});

	/**
	 * Run `-p` on a top-level session whose first turn starts one job of each kind in `types` and
	 * answers `Started.`, and whose later turns answer with the job results the context holds by
	 * then. Resolves once the run has returned and every job has ended, with how each one ended.
	 */
	async function printRun(types: readonly AsyncJobType[]): Promise<Partial<Record<AsyncJobType, Outcome>>> {
		tempDir = TempDir.createSync("@veyyon-print-settle-");
		const cwd = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		for (const dir of [cwd, agentDir]) fs.mkdirSync(dir, { recursive: true });
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("mock", "mock-key");
		registerMockApi(MOCK_API_SOURCE);

		const outcomes: Partial<Record<AsyncJobType, Outcome>> = {};
		const ended: Promise<unknown>[] = [];
		const startJob = (owner: AgentSession, type: AsyncJobType): void => {
			const manager = owner.asyncJobManager;
			if (!manager) throw new Error("Expected a top-level session to own a job manager");
			manager.register(
				type,
				`${type} started by the turn`,
				({ signal }) => {
					const body = (async () => {
						try {
							// A launched process runs until it is stopped; the others end on their own.
							await sleep(type === "launch" ? RUN_BOUND_MS * 10 : JOB_MS, undefined, { signal });
						} catch (error) {
							outcomes[type] = "stopped";
							throw error;
						}
						outcomes[type] = "finished";
						return resultOf(type);
					})();
					ended.push(body.catch(() => undefined));
					return body;
				},
				// The owner a tool registers its job under (bash.ts, launch-exit-watch.ts).
				{ ownerId: owner.getAgentId() },
			);
		};

		let startedJobs = false;
		const model = createMockModel({
			handler: context => {
				if (!startedJobs && session) {
					startedJobs = true;
					for (const type of types) startJob(session, type);
					return { content: ["Started."] };
				}
				const text = contextText(context);
				const seen = types.filter(type => text.includes(resultOf(type)));
				return { content: [`Saw ${seen.join(",") || "nothing"}.`] };
			},
		});
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "async.enabled": true, "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		}));
		await withTimeout(
			runPrintMode(session, { mode: "text", initialMessage: "Start the work" }),
			RUN_BOUND_MS,
			"the print run did not return",
		);
		await Promise.all(ended);
		return outcomes;
	}

	it("pins a decision for every kind of job", () => {
		expect(Object.keys(JOB_ENDS_ON_ITS_OWN).sort()).toEqual(Object.keys(A_PRINT_RUN_WAITS_FOR).sort());
	});

	for (const type of Object.keys(JOB_ENDS_ON_ITS_OWN) as AsyncJobType[]) {
		if (A_PRINT_RUN_WAITS_FOR[type]) {
			it(`answers with a ${type} job's result before it exits`, async () => {
				expect(await printRun([type])).toEqual({ [type]: "finished" });
				expect(stdout).toBe(`Saw ${type}.\n`);
				expect(exitCodes).toEqual([]);
			}, TEST_TIMEOUT_MS);
		} else {
			it(`exits while a ${type} job still runs, and stops it`, async () => {
				expect(await printRun([type])).toEqual({ [type]: "stopped" });
				expect(stdout).toBe("Started.\n");
				expect(exitCodes).toEqual([]);
			}, TEST_TIMEOUT_MS);
		}
	}

	it("waits for the jobs that end and exits past the ones that do not", async () => {
		const types = Object.keys(JOB_ENDS_ON_ITS_OWN) as AsyncJobType[];
		const expected = Object.fromEntries(
			types.map(type => [type, A_PRINT_RUN_WAITS_FOR[type] ? "finished" : "stopped"]),
		);
		expect(await printRun(types)).toEqual(expected);
		expect(stdout).toBe(`Saw ${types.filter(type => A_PRINT_RUN_WAITS_FOR[type]).join(",")}.\n`);
	}, TEST_TIMEOUT_MS);
});
