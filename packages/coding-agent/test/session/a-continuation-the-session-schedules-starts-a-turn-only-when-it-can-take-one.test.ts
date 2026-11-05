/**
 * WHY THIS SUITE EXISTS. A session starts turns nobody typed: the `agent.continue()` a settle schedules
 * (a retry, a queued steer or follow-up, a finalize reminder) and the auto-continue prompt a compaction
 * resumes with. `TurnContinuations` runs each one later, on the post-prompt tasks, and by then the
 * session may be compacting, writing a handoff, disposed, past the prompt the work was scheduled for,
 * or already streaming a run another start began. A continuation that ran anyway would stream over a
 * transcript being rewritten or call `continue()` on a busy agent; one that skipped without reporting
 * why would strand a caller that counts on `onSkip`; one that left its turn counted would hold the
 * session busy for good.
 *
 * THE CLASS. Every reason a scheduled continuation skips, swept through a table keyed by
 * `AgentContinueSkipReason`, so a new reason fails the type check until it has a scenario here; the turn
 * count it holds from before the fallback restore until `continue()` settles or throws; the delay and
 * cancel it honours; the auto-continue prompt and the reminders it carries; and the TTSR resume a cancel
 * releases. The session's own predicate for "cannot take a turn" is driven through a real
 * `AgentSession` holding a compaction and a handoff open while a follow-up asks for a turn.
 *
 * WHAT IT DOES NOT CATCH. The `aborted` skip reason: a cancel during the delay reports nothing, and a
 * task with no delay starts before any cancel can reach it, so no schedule reaches that branch. Which
 * settles schedule a continuation, and with which options, belongs to the callers' suites.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { turnControlPrompts } from "@veyyon/coding-agent/prompts/turn-control/rows";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type {
	AgentContinueSkipReason,
	ScheduledAgentContinueOptions,
} from "@veyyon/coding-agent/session/agent-session-types";
import { PostPromptTasks } from "@veyyon/coding-agent/session/runtime/post-prompt-tasks";
import {
	type ContinuationAgent,
	TurnContinuations,
	type TurnContinuationsHost,
} from "@veyyon/coding-agent/session/runtime/turn-continuations";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";
import { createAssistantMessage } from "../helpers/agent-session-setup";

/** What the fake session's hooks do; a test replaces one to hold or fail it. */
interface Hooks {
	continue: () => Promise<void>;
	restore: () => Promise<void>;
}

/** A prompt the collaborator ran through the host. */
interface PromptRecord {
	readonly message: AgentMessage;
	readonly text: string;
	readonly prepend: AgentMessage[] | undefined;
}

interface FakeSession {
	readonly continuations: TurnContinuations;
	readonly tasks: PostPromptTasks;
	/** Every call the collaborator made on the host, in order. */
	readonly calls: string[];
	readonly prompts: PromptRecord[];
	readonly agentState: { isStreaming: boolean };
	readonly state: { generation: number; unavailable: boolean; disposed: boolean; nudges: AgentMessage[] };
	readonly hooks: Hooks;
}

/** A session reduced to what `TurnContinuations` reads, over the real post-prompt task queue. */
function fakeSession(): FakeSession {
	const calls: string[] = [];
	const prompts: PromptRecord[] = [];
	const agentState = { isStreaming: false };
	const state = { generation: 1, unavailable: false, disposed: false, nudges: [] as AgentMessage[] };
	const hooks: Hooks = { continue: async () => {}, restore: async () => {} };
	const agent: ContinuationAgent = {
		continue: async () => {
			calls.push("continue");
			await hooks.continue();
		},
		waitForIdle: async () => {},
		state: agentState,
	};
	const tasks = new PostPromptTasks({ promptGeneration: () => state.generation });
	const host: TurnContinuationsHost = {
		agent,
		promptGeneration: () => state.generation,
		unavailable: () => state.unavailable,
		disposed: () => state.disposed,
		beginTurn: () => {
			calls.push("beginTurn");
		},
		endTurn: () => {
			calls.push("endTurn");
		},
		restoreFallbackPrimary: async () => {
			calls.push("restore");
			await hooks.restore();
			calls.push("restored");
		},
		retryGate: () => undefined,
		ttsrResume: () => undefined,
		releaseTtsrResume: () => {
			calls.push("releaseTtsrResume");
		},
		postCompactionNudges: () => {
			calls.push("nudges");
			return state.nudges;
		},
		promptWith: async (message, text, prepend) => {
			calls.push("prompt");
			prompts.push({ message, text, prepend });
		},
	};
	return {
		continuations: new TurnContinuations(tasks, host),
		tasks,
		calls,
		prompts,
		agentState,
		state,
		hooks,
	};
}

/** Let every pending microtask and the I/O turn behind it run. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await setImmediate();
}

/** A continuation that ran to the end, in the order the host sees it. */
const RAN = ["beginTurn", "restore", "restored", "continue", "endTurn"];

interface SkipScenario {
	readonly options?: Omit<ScheduledAgentContinueOptions, "onSkip">;
	arrange(session: FakeSession): void;
}

const SKIPS: Record<Exclude<AgentContinueSkipReason, "aborted">, SkipScenario> = {
	"stale-generation": { options: { generation: 0 }, arrange: () => {} },
	"session-unavailable": {
		arrange: session => {
			session.state.unavailable = true;
		},
	},
	"should-continue-false": { options: { shouldContinue: () => false }, arrange: () => {} },
	"post-restore-unavailable": {
		arrange: session => {
			session.hooks.restore = async () => {
				session.state.disposed = true;
			};
		},
	},
	"agent-busy": {
		arrange: session => {
			session.hooks.restore = async () => {
				session.agentState.isStreaming = true;
			};
		},
	},
};

describe("a scheduled agent.continue()", () => {
	for (const [reason, scenario] of Object.entries(SKIPS)) {
		it(`skips with "${reason}", starts no continue and leaves no turn counted`, async () => {
			const session = fakeSession();
			scenario.arrange(session);
			const skips: AgentContinueSkipReason[] = [];
			session.continuations.scheduleContinue({ ...scenario.options, onSkip: skipped => skips.push(skipped) });
			await session.tasks.drained;

			expect(skips).toEqual([reason as AgentContinueSkipReason]);
			expect(session.calls).not.toContain("continue");
			const begun = session.calls.filter(call => call === "beginTurn").length;
			expect(session.calls.filter(call => call === "endTurn").length).toBe(begun);
		});
	}

	it("counts its turn from before the fallback restore until continue() settles", async () => {
		const session = fakeSession();
		const restore = Promise.withResolvers<void>();
		const run = Promise.withResolvers<void>();
		session.hooks.restore = () => restore.promise;
		session.hooks.continue = () => run.promise;

		session.continuations.scheduleContinue({ generation: 1 });
		await flush();
		expect(session.calls).toEqual(["beginTurn", "restore"]);

		restore.resolve();
		await flush();
		expect(session.calls).toEqual(["beginTurn", "restore", "restored", "continue"]);

		run.resolve();
		await session.tasks.drained;
		expect(session.calls).toEqual(RAN);
	});

	it("reports a continue() that throws to onError and still ends its turn", async () => {
		const session = fakeSession();
		session.hooks.continue = async () => {
			throw new Error("provider unreachable");
		};
		const reported: string[] = [];

		session.continuations.scheduleContinue({ onError: () => reported.push("onError") });
		await session.tasks.drained;

		expect(reported).toEqual(["onError"]);
		expect(session.calls).toEqual(RAN);
	});

	it("starts only once its delay has passed", async () => {
		const session = fakeSession();

		session.continuations.scheduleContinue({ delayMs: 25 });
		await flush();
		expect(session.calls).toEqual([]);

		await session.tasks.drained;
		expect(session.calls).toEqual(RAN);
	});

	it("is dropped without a skip when a cancel reaches it during its delay, and the cancel does not wait the delay out", async () => {
		const session = fakeSession();
		const skips: AgentContinueSkipReason[] = [];
		session.continuations.scheduleContinue({ delayMs: 5_000, onSkip: skipped => skips.push(skipped) });

		const started = performance.now();
		await session.continuations.cancel();

		expect(performance.now() - started).toBeLessThan(1_000);
		expect(session.calls).toEqual(["releaseTtsrResume"]);
		expect(skips).toEqual([]);
		expect(session.tasks.pending).toBe(false);
	});
});

describe("the auto-continue prompt a compaction resumes with", () => {
	const text = turnControlPrompts["turn-control/auto-continue"].text;

	it("runs as an agent-attributed developer turn carrying the reminders the compaction summarized away", async () => {
		const session = fakeSession();
		const reminder: AgentMessage = {
			role: "developer",
			content: [{ type: "text", text: "Step 2 of the plan is still open." }],
			attribution: "agent",
			timestamp: 1_756_080_000,
		};
		session.state.nudges = [reminder];

		session.continuations.scheduleAutoContinuePrompt(1);
		await session.tasks.drained;

		expect(session.prompts).toEqual([
			{
				message: {
					role: "developer",
					content: [{ type: "text", text }],
					attribution: "agent",
					timestamp: expect.any(Number),
				},
				text,
				prepend: [reminder],
			},
		]);
	});

	it("prepends nothing when the compaction left no reminder", async () => {
		const session = fakeSession();

		session.continuations.scheduleAutoContinuePrompt(1);
		await session.tasks.drained;

		expect(session.prompts.map(prompt => prompt.prepend)).toEqual([undefined]);
	});

	it("is dropped once the session moved past the prompt it was scheduled for", async () => {
		const session = fakeSession();
		session.state.generation = 2;

		session.continuations.scheduleAutoContinuePrompt(1);
		await session.tasks.drained;

		expect(session.calls).toEqual([]);
	});

	it("is dropped, with no reminder built, when a cancel reaches it before it starts", async () => {
		const session = fakeSession();

		session.continuations.scheduleAutoContinuePrompt(1);
		await session.continuations.cancel();

		expect(session.calls).toEqual(["releaseTtsrResume"]);
		expect(session.prompts).toEqual([]);
	});
});

/** What the session reported about itself when the agent was asked to continue. */
interface ContinueSeen {
	readonly compacting: boolean;
	readonly handoff: boolean;
}

/** Shared with the extension through `globalThis`, because the extension is a module loaded from disk. */
interface CompactionHold {
	entered: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
}

const HOLD_KEY = "__turnContinuationsCompactionHold";

/** Holds every compaction at `session_before_compact` until released, then supplies its summary. */
const HOLDER = `
export default function (pi) {
	pi.on("session_before_compact", async event => {
		const hold = globalThis[${JSON.stringify(HOLD_KEY)}];
		hold.entered.resolve();
		await hold.release.promise;
		return {
			compaction: {
				summary: "compacted",
				shortSummary: undefined,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {},
			},
		};
	});
}
`;

describe("a session compacting or writing a handoff", () => {
	let tempDir: TempDir;
	let projectDir: string;
	let extensionPath: string;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	const globals = globalThis as Record<string, unknown>;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@turn-continuations-");
		projectDir = tempDir.join("project");
		fs.mkdirSync(projectDir, { recursive: true });
		// Outside the project directory, so the loader treats it as the operator's own extension.
		extensionPath = tempDir.join("hold-compaction.ts");
		fs.writeFileSync(extensionPath, HOLDER);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		delete globals[HOLD_KEY];
	});

	afterAll(() => {
		authStorage?.close();
		tempDir?.removeSync();
	});

	/** A session whose history ends on an assistant turn, so a follow-up queued at rest asks for a turn. */
	async function openSession(): Promise<{ session: AgentSession; seen: ContinueSeen[] }> {
		const sessionManager = SessionManager.create(projectDir, tempDir.join("sessions"));
		const history: AgentMessage[] = [];
		for (let turn = 0; turn < 4; turn++) {
			const user: AgentMessage = { role: "user", content: `step ${turn} ${"x".repeat(20_000)}`, timestamp: turn };
			const assistant = createAssistantMessage(`done ${turn} ${"y".repeat(20_000)}`);
			sessionManager.appendMessage(user);
			sessionManager.appendMessage(assistant);
			history.push(user, assistant);
		}
		const modelRegistry = new ModelRegistry(authStorage);
		const loaded = await loadExtensions([extensionPath], projectDir);
		expect(loaded.errors).toEqual([]);
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: history } });
		const opened = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.autoContinue": false }),
			modelRegistry,
			extensionRunner: new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				projectDir,
				sessionManager,
				modelRegistry,
			),
		});
		session = opened;
		const seen: ContinueSeen[] = [];
		spyOn(agent, "continue").mockImplementation(async () => {
			seen.push({ compacting: opened.isCompacting, handoff: opened.isGeneratingHandoff });
			// The loop a real continue() runs takes the queued follow-up.
			agent.clearAllQueues();
		});
		return { session: opened, seen };
	}

	it("starts the turn a follow-up asks for when it is free", async () => {
		const { session, seen } = await openSession();

		await session.followUp("Check the build.", undefined, { synthetic: true });
		await flush();

		expect(seen).toEqual([{ compacting: false, handoff: false }]);
	});

	it("starts no turn for a follow-up queued while a compaction runs", async () => {
		const { session, seen } = await openSession();
		const hold: CompactionHold = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		globals[HOLD_KEY] = hold;

		const compaction = session.compact();
		await hold.entered.promise;
		expect(session.isCompacting).toBe(true);
		await session.followUp("Check the build.", undefined, { synthetic: true });
		await flush();
		const seenWhileCompacting = [...seen];
		hold.release.resolve();
		await compaction;

		expect(seenWhileCompacting).toEqual([]);
		expect(seen.filter(entry => entry.compacting)).toEqual([]);
	});

	it("starts no turn for a follow-up queued while a handoff is written", async () => {
		const { session, seen } = await openSession();
		const keyLookup = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		spyOn(ModelRegistry.prototype, "getApiKey").mockImplementation(async () => {
			keyLookup.resolve();
			await release.promise;
			return undefined;
		});

		const handoff = session.handoff().catch((error: unknown) => error);
		await keyLookup.promise;
		expect(session.isGeneratingHandoff).toBe(true);
		await session.followUp("Check the build.", undefined, { synthetic: true });
		await flush();
		const seenWhileWriting = [...seen];
		release.resolve();
		await handoff;

		expect(seenWhileWriting).toEqual([]);
		expect(seen.filter(entry => entry.handoff)).toEqual([]);
	});
});
