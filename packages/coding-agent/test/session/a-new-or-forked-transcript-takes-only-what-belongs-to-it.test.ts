/**
 * `/new`, `/drop` and `/fork` hand the transcript they start what belongs to it, and leave behind
 * what belonged to the transcript they leave.
 *
 * WHY. `SessionSwitch.startNew` and `SessionSwitch.fork` each run a list of independent steps:
 * save or delete the outgoing file, empty the todo board, record the thinking level, drop next-turn
 * messages, cancel background jobs, move the provider session id and prompt cache key, rekey the
 * memory backend, copy the artifact directory, and notify extensions. Mutation testing of the two
 * lists found steps no suite pinned, each deletable with every suite green: `/drop` could keep the
 * file it was asked to delete, a fork could lose its artifacts, and a `/new` after a `/fork` could
 * keep sending the parent's prompt cache key.
 *
 * Class closed: every step whose effect reaches the session's public surface, the session file, the
 * artifact directory, the job manager, the memory backend's state or an extension. Each test drives
 * the real `AgentSession` over a persisted `SessionManager` in a temp directory.
 *
 * NOT CAUGHT. The order of `/drop`'s advisor recorder close against the file delete, which only
 * matters while an advisor turn is still streaming, and the advisor latch reset at `/new`; both need
 * an advisor-configured session. The flush before `/new` and `/fork`: the session manager's own
 * writer close persists an ordinary write without it, and the flush only adds the retry of an
 * earlier failed write. The MCP default selection recorded for the new file, which a return to it
 * reads only when `/new` selected nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentOptions, type AsideMessage, ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { hindsightBackend } from "@veyyon/coding-agent/memory/hindsight/backend";
import { HindsightApi } from "@veyyon/coding-agent/memory/hindsight/client";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionConfig } from "@veyyon/coding-agent/session/agent-session-types";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const OWNER = "Self";

let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model;
const tempDirs: TempDir[] = [];
const sessions: AgentSession[] = [];
const managers: AsyncJobManager[] = [];

beforeAll(async () => {
	sharedDir = TempDir.createSync("@new-or-forked-transcript-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	const bundled = requireBundledModel("anthropic", "claude-sonnet-4-5");
	model = bundled;
});

afterAll(async () => {
	authStorage.close();
	await sharedDir.remove();
});

beforeEach(() => {
	// The hindsight backend lists mental models on start. Nothing here reaches a network.
	vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
});

afterEach(async () => {
	while (sessions.length > 0) await sessions.pop()?.dispose();
	await Promise.all(managers.splice(0).map(manager => manager.dispose({ timeoutMs: 1_000 })));
	for (const dir of tempDirs.splice(0)) await dir.remove();
	vi.restoreAllMocks();
});

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
}

/** A session manager that persists to its own temp directory. */
function persistedManager(): SessionManager {
	const tempDir = TempDir.createSync("@new-or-forked-transcript-");
	tempDirs.push(tempDir);
	return SessionManager.create(tempDir.path(), tempDir.path());
}

function persistedSession(
	config: Partial<AgentSessionConfig> = {},
	agentOptions: AgentOptions = {},
	sessionManager = persistedManager(),
): Harness {
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		...agentOptions,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
		...config,
	});
	sessions.push(session);
	return { session, sessionManager };
}

/** One exchange on the branch, flushed, so the session file exists on disk. */
async function writeTurn(sessionManager: SessionManager, text = "go"): Promise<string> {
	sessionManager.appendMessage({ role: "user", content: text, timestamp: 1 });
	sessionManager.appendMessage(createAssistantMessage("ok"));
	await sessionManager.flush();
	const file = sessionManager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	expect(fs.existsSync(file)).toBe(true);
	return file;
}

/** The user prompts a transcript on disk holds, in order. */
async function userPromptsOnDisk(file: string): Promise<string[]> {
	const reopened = await SessionManager.open(file, path.dirname(file));
	return reopened
		.getEntries()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
				? [entry.message.content]
				: [],
		);
}

describe("/new", () => {
	it("keeps the transcript it leaves on disk and moves to a new file", async () => {
		const { session, sessionManager } = persistedSession();
		const previousFile = await writeTurn(sessionManager, "first conversation");

		expect(await session.newSession()).toBe(true);

		expect(session.sessionFile).toBeString();
		expect(session.sessionFile).not.toBe(previousFile);
		expect(await userPromptsOnDisk(previousFile)).toEqual(["first conversation"]);
		expect(session.agent.state.messages).toEqual([]);
	});

	it("with drop, deletes the transcript it leaves and that transcript's artifacts", async () => {
		const { session, sessionManager } = persistedSession();
		const previousFile = await writeTurn(sessionManager);
		const artifactId = await sessionManager.saveArtifact("spilled output", "bash");
		const artifactPath = await sessionManager.getArtifactPath(artifactId!);
		expect(artifactPath).toBeString();
		expect(fs.existsSync(artifactPath!)).toBe(true);
		const artifactDir = sessionManager.getArtifactsDir()!;

		expect(await session.newSession({ drop: true })).toBe(true);

		expect(fs.existsSync(previousFile)).toBe(false);
		expect(fs.existsSync(artifactDir)).toBe(false);
		expect(session.sessionFile).not.toBe(previousFile);
	});

	it("starts on an empty todo board", async () => {
		const { session } = persistedSession();
		session.setTodoPhases([{ name: "Old work", tasks: [{ content: "Finish it", status: "in_progress" }] }]);

		await session.newSession();

		expect(session.getTodoPhases()).toEqual([]);
	});

	it("records the live thinking level in the transcript it starts", async () => {
		const { session, sessionManager } = persistedSession();
		session.setThinkingLevel(ThinkingLevel.High);

		await session.newSession();

		// A resume of the new transcript reads its thinking level from this entry; without it the
		// resume falls back to `off`.
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("drops a next-turn message queued for the conversation it leaves", async () => {
		const held = Promise.withResolvers<void>();
		let calls = 0;
		const { session } = persistedSession(
			{},
			{
				getApiKey: () => "test-key",
				convertToLlm,
				streamFn: () => {
					calls += 1;
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						void held.promise.then(() =>
							stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Reply") }),
						);
					});
					return stream;
				},
			},
		);
		const run = session.prompt("First message");
		for (let waited = 0; calls === 0; waited++) {
			if (waited > 2_000) throw new Error("the prompt never reached the provider");
			await sleep(1);
		}
		await session.sendCustomMessage(
			{ customType: "build-reminder", content: "Check the build", display: false, attribution: "agent" },
			{ deliverAs: "nextTurn" },
		);
		held.resolve();
		await run;
		// Still waiting for the next prompt of the conversation it was queued in.
		expect(session.queuedMessageCount).toBe(1);

		await session.newSession();

		expect(session.queuedMessageCount).toBe(0);
	});

	it("cancels the background jobs this session started and no one else's", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const { session } = persistedSession({ asyncJobManager: manager, agentId: OWNER });
		const gate = Promise.withResolvers<string>();
		const own = manager.register("bash", "own job", () => gate.promise, { ownerId: OWNER });
		const other = manager.register("bash", "other job", () => gate.promise, { ownerId: "Elsewhere" });

		await session.newSession();

		expect(manager.getJob(own)?.status).toBe("cancelled");
		expect(manager.getJob(other)?.status).toBe("running");
		gate.resolve("done");
	});
});

describe("/fork", () => {
	it("copies the transcript's artifacts into the fork's own directory", async () => {
		const { session, sessionManager } = persistedSession();
		const previousFile = await writeTurn(sessionManager);
		const artifactId = await sessionManager.saveArtifact("spilled output", "bash");
		const parentArtifactPath = await sessionManager.getArtifactPath(artifactId!);

		expect(await session.fork()).toBe(true);

		expect(session.sessionFile).not.toBe(previousFile);
		const forkArtifactPath = await sessionManager.getArtifactPath(artifactId!);
		expect(forkArtifactPath).toBeString();
		expect(forkArtifactPath).not.toBe(parentArtifactPath);
		expect(fs.readFileSync(forkArtifactPath!, "utf8")).toBe("spilled output");
		expect(fs.existsSync(parentArtifactPath!)).toBe(true);
	});

	it("routes on the parent's prompt cache key, which a later /new drops", async () => {
		const { session, sessionManager } = persistedSession();
		await writeTurn(sessionManager);
		const parentSessionId = sessionManager.getSessionId();

		await session.fork();

		expect(sessionManager.getSessionId()).not.toBe(parentSessionId);
		expect(session.agent.promptCacheKey).toBe(parentSessionId);

		await session.newSession();

		expect(session.agent.promptCacheKey).toBeUndefined();
	});

	it("routes under the fork's own session id after /fresh", async () => {
		const { session, sessionManager } = persistedSession();
		await writeTurn(sessionManager);
		expect(session.freshSession()).toBeDefined();
		expect(session.agent.sessionId).not.toBe(sessionManager.getSessionId());

		await session.fork();

		expect(session.agent.sessionId).toBe(sessionManager.getSessionId());
	});
});

describe("an extension watching the switch", () => {
	interface Watched {
		harness: Harness;
		/** The reason of each `session_before_switch`, in order. */
		asked: string[];
		/** Each `session_switch`, in order. */
		switches: { reason: string; previousSessionFile: string | undefined }[];
	}

	async function withExtension(cancel: boolean): Promise<Watched> {
		const asked: string[] = [];
		const switches: Watched["switches"] = [];
		const sessionManager = persistedManager();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_switch", async event => {
					asked.push(event.reason);
					return cancel ? { cancel: true } : undefined;
				});
				pi.on("session_switch", async event => {
					switches.push({ reason: event.reason, previousSessionFile: event.previousSessionFile });
				});
			},
			sessionManager.getCwd(),
			new EventBus(),
			runtime,
			"switch-watcher",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			runtime,
			sessionManager.getCwd(),
			sessionManager,
			modelRegistry,
		);
		return { harness: persistedSession({ extensionRunner }, {}, sessionManager), asked, switches };
	}

	it("is told which transcript /new and /fork left", async () => {
		const { harness, asked, switches } = await withExtension(false);
		const first = await writeTurn(harness.sessionManager);

		await harness.session.fork();
		const forked = harness.session.sessionFile;
		await harness.session.newSession();

		expect(asked).toEqual(["fork", "new"]);
		expect(switches).toEqual([
			{ reason: "fork", previousSessionFile: first },
			{ reason: "new", previousSessionFile: forked },
		]);
	});

	it("keeps the session on its transcript when it cancels /new or /fork", async () => {
		const { harness, asked, switches } = await withExtension(true);
		const file = await writeTurn(harness.sessionManager);
		harness.session.setTodoPhases([{ name: "Kept", tasks: [{ content: "Stay", status: "pending" }] }]);

		expect(await harness.session.newSession()).toBe(false);
		expect(await harness.session.fork()).toBe(false);

		expect(harness.session.sessionFile).toBe(file);
		expect(harness.session.getTodoPhases()).toEqual([
			{ name: "Kept", tasks: [{ content: "Stay", status: "pending" }] },
		]);
		expect(asked).toEqual(["new", "fork"]);
		expect(switches).toEqual([]);
	});
});

describe("a memory backend", () => {
	async function hindsightSession(): Promise<{ harness: Harness; drainAsides: () => AgentMessage[] }> {
		const agent = new Agent({ initialState: { model, systemPrompt: ["base"], tools: [], messages: [] } });
		// The aside provider is private on the Agent; capture the one the session installs.
		let provider: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined;
		const install = agent.setAsideMessageProvider.bind(agent);
		agent.setAsideMessageProvider = fn => {
			provider = fn ?? undefined;
			install(fn);
		};
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const sessionManager = persistedManager();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["base"] }),
		});
		sessions.push(session);
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry,
			agentDir: sessionManager.getCwd(),
			taskDepth: 0,
		});
		return {
			harness: { session, sessionManager },
			drainAsides() {
				const thunks = provider?.();
				if (!thunks || thunks instanceof Promise) return [];
				return thunks
					.map(entry => (typeof entry === "function" ? entry() : entry))
					.filter((message): message is AgentMessage => message !== null);
			},
		};
	}

	it("files later memories under the transcript /new and /fork start", async () => {
		const { harness } = await hindsightSession();
		await writeTurn(harness.sessionManager);
		const state = harness.session.getHindsightSessionState();
		expect(state?.sessionId).toBe(harness.session.sessionId);

		await harness.session.fork();
		expect(state?.sessionId).toBe(harness.session.sessionId);

		const forkId = harness.session.sessionId;
		await harness.session.newSession();
		expect(harness.session.sessionId).not.toBe(forkId);
		expect(state?.sessionId).toBe(harness.session.sessionId);
	});

	it("drops a recall queued for the transcript a fork leaves", async () => {
		const { harness, drainAsides } = await hindsightSession();
		await writeTurn(harness.sessionManager);
		harness.session.getHindsightSessionState()!.lastRecallSnippet = "<memories>\nold turn\n</memories>";
		expect(await harness.session.publishVolatileMemoryContext("hindsight:recall")).toBe(true);

		await harness.session.fork();

		expect(drainAsides()).toEqual([]);
	});
});
