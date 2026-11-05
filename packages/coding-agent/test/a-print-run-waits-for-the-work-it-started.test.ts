/**
 * WHY: a `-p` run returned as soon as its prompt's turn ended and disposed the session, so a
 * spawned agent or a backgrounded command that turn started was stopped, and its result, which
 * arrives by waking the loop for a follow-up turn, was never answered. The run printed the turn
 * that started the work and exited 0. The class this closes: a print run that ends while background
 * work it started is still due to report, for every kind of job the manager runs, and for the
 * backgrounded command with and without a deadline. Each kind is pinned to whether a run waits for
 * it by exact equality, so a new kind is a compile error here until someone decides it. A job that
 * runs until stopped is not waited for: a launched process, or a command given `timeout: 0`.
 * Waiting on one would hold the run open forever, which `RUN_BOUND_MS` turns into a failure
 * instead of a hang.
 *
 * It drives a session built by `createAgentSession` against a scripted provider, so a finished job
 * reaches the conversation through the production delivery path. The backgrounded commands run
 * through the real `bash` tool. Not caught: the `task` and `launch` tools themselves (their kinds
 * are registered here at the point in the turn where the tool would, under the owner those tools
 * use), and `--mode json`, which reads the same settled session as text mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockResponse, registerMockApi } from "@veyyon/ai/providers/mock";
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
/** The bound on a run that must not wait: a regression that waits on such a job hangs until here. */
const RUN_BOUND_MS = 10_000;
/** Each test's own limit, past the run bound so a run that hangs fails on the bound and its message. */
const TEST_TIMEOUT_MS = RUN_BOUND_MS * 3;

const MOCK_API_SOURCE = "a-print-run-waits-for-the-work-it-started";

/** What the backgrounded command prints. The shell computes it, so the command line does not hold it. */
const COMMAND_OUTPUT = "BG-42-DONE";
const COMMAND = "echo BG-$((40+2))-DONE";

/** What the first turn does, and the text each piece of work leaves in the context once answered. */
interface Work {
	start(session: AgentSession): MockResponse;
	results: Readonly<Record<string, string>>;
}

/** A job the session ran, as it stood when the provider was last called. */
interface JobSeen {
	type: AsyncJobType;
	endsOnItsOwn: boolean;
}

/** How a job ended: on its own, or stopped when the run disposed its session. */
type Outcome = "finished" | "stopped";

function resultOf(type: AsyncJobType): string {
	return `JOB-RESULT-${type}`;
}

/** One job of each kind in `types`, registered the way the tool that owns the kind registers it. */
function jobsOfKinds(types: readonly AsyncJobType[]): {
	work: Work;
	outcomes: () => Promise<Partial<Record<AsyncJobType, Outcome>>>;
} {
	const outcomes: Partial<Record<AsyncJobType, Outcome>> = {};
	const ended: Promise<unknown>[] = [];
	const work: Work = {
		start: session => {
			const manager = session.asyncJobManager;
			if (!manager) throw new Error("Expected a top-level session to own a job manager");
			for (const type of types) {
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
					{ ownerId: session.getAgentId() },
				);
			}
			return { content: ["Started."] };
		},
		results: Object.fromEntries(types.map(type => [type, resultOf(type)])),
	};
	return {
		work,
		outcomes: async () => {
			await Promise.all(ended);
			return outcomes;
		},
	};
}

/** A command the real `bash` tool runs in the background, after `delaySec`, under `timeout`. */
function backgroundCommand(delaySec: number, timeout: number): Work {
	return {
		start: () => ({
			content: [
				{
					type: "toolCall",
					name: "bash",
					arguments: { command: `sleep ${delaySec}; ${COMMAND}`, async: true, timeout },
				},
			],
		}),
		results: { bash: COMMAND_OUTPUT },
	};
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
	 * Run `-p` on a top-level session whose first turn does `work.start`, and whose later turns
	 * answer `Saw <names>.` with the work whose results the context holds by then. Resolves once the
	 * run has returned, with every job the session ran.
	 */
	async function printRun(work: Work): Promise<JobSeen[]> {
		tempDir = TempDir.createSync("@veyyon-print-settle-");
		const cwd = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		for (const dir of [cwd, agentDir]) fs.mkdirSync(dir, { recursive: true });
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("mock", "mock-key");
		registerMockApi(MOCK_API_SOURCE);

		const jobs = new Map<string, JobSeen>();
		const noteJobs = (): void => {
			for (const job of session?.asyncJobManager?.getAllJobs() ?? []) {
				jobs.set(job.id, { type: job.type, endsOnItsOwn: job.endsOnItsOwn });
			}
		};
		let started = false;
		const model = createMockModel({
			handler: context => {
				noteJobs();
				if (!started && session) {
					started = true;
					const reply = work.start(session);
					noteJobs();
					return reply;
				}
				const text = JSON.stringify(context.messages);
				const seen = Object.keys(work.results).filter(name => text.includes(work.results[name]));
				return { content: [`Saw ${seen.join(",") || "nothing"}.`] };
			},
		});
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({
				"async.enabled": true,
				"compaction.enabled": false,
				"tools.approvalMode": "yolo",
			}),
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
		return [...jobs.values()];
	}

	it("pins a decision for every kind of job", () => {
		expect(Object.keys(JOB_ENDS_ON_ITS_OWN).sort()).toEqual(Object.keys(A_PRINT_RUN_WAITS_FOR).sort());
	});

	for (const type of Object.keys(JOB_ENDS_ON_ITS_OWN) as AsyncJobType[]) {
		if (A_PRINT_RUN_WAITS_FOR[type]) {
			it(
				`answers with a ${type} job's result before it exits`,
				async () => {
					const run = jobsOfKinds([type]);
					await printRun(run.work);
					expect(await run.outcomes()).toEqual({ [type]: "finished" });
					expect(stdout).toBe(`Saw ${type}.\n`);
					expect(exitCodes).toEqual([]);
				},
				TEST_TIMEOUT_MS,
			);
		} else {
			it(
				`exits while a ${type} job still runs, and stops it`,
				async () => {
					const run = jobsOfKinds([type]);
					await printRun(run.work);
					expect(await run.outcomes()).toEqual({ [type]: "stopped" });
					expect(stdout).toBe("Started.\n");
					expect(exitCodes).toEqual([]);
				},
				TEST_TIMEOUT_MS,
			);
		}
	}

	it(
		"waits for the jobs that end and exits past the ones that do not",
		async () => {
			const types = Object.keys(JOB_ENDS_ON_ITS_OWN) as AsyncJobType[];
			const run = jobsOfKinds(types);
			await printRun(run.work);
			expect(await run.outcomes()).toEqual(
				Object.fromEntries(types.map(type => [type, A_PRINT_RUN_WAITS_FOR[type] ? "finished" : "stopped"])),
			);
			expect(stdout).toBe(`Saw ${types.filter(type => A_PRINT_RUN_WAITS_FOR[type]).join(",")}.\n`);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"answers with a command the bash tool ran in the background under a timeout",
		async () => {
			expect(await printRun(backgroundCommand(0.1, 5))).toEqual([{ type: "bash", endsOnItsOwn: true }]);
			expect(stdout).toBe("Saw bash.\n");
			expect(exitCodes).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"exits past a command the bash tool ran in the background with no timeout",
		async () => {
			// The command would print only after the run's bound, so an answer naming it cannot exist.
			const delaySec = (RUN_BOUND_MS / 1000) * 6;
			expect(await printRun(backgroundCommand(delaySec, 0))).toEqual([{ type: "bash", endsOnItsOwn: false }]);
			expect(stdout).toBe("Saw nothing.\n");
			expect(exitCodes).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);
});
