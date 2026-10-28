/**
 * A conversation the session leaves shuts down its eval kernels.
 *
 * WHY THIS SUITE EXISTS: a retained eval kernel is keyed by the transcript's eval session id, its
 * session file. `/new`, `/resume` of another conversation and a handoff move the same
 * `AgentSession` to another file, so no later cell reaches the kernel of the conversation it left,
 * yet that kernel stayed alive, at hundreds of megabytes, until the session ended. A window open for
 * days held one per conversation. The class is "a kernel that outlives the only transcript that can
 * reach it":
 *
 * - a conversation switch that leaves the previous kernel running;
 * - a release that depends on the session being registered as an agent, which a session built
 *   through the SDK without an agent id is not;
 * - a release that takes a kernel another owner still shares, such as a spawned agent's;
 * - a reload of the same conversation, which keeps its file, shutting the kernel its cells reach.
 *
 * Driven through a real `AgentSession` and the real Python kernel pool, with the kernel process
 * replaced by a fake that records its shutdown. The release goes through the owned-resource
 * registry `dispose` uses, so Ruby, Julia and the JS contexts go with it; only Python is observed.
 *
 * Not caught: a new conversation switch that skips `endConversation` (the switches are listed here,
 * not enumerated from source), and fork or `/move`, which change the file without ending the
 * conversation and start a fresh kernel as they did before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelShutdownResult,
	SessionKernel,
} from "@veyyon/coding-agent/eval/kernel-base";
import * as pythonExecutor from "@veyyon/coding-agent/eval/py/executor";
import * as pythonKernel from "@veyyon/coding-agent/eval/py/kernel";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { shellDomain } from "@veyyon/coding-agent/tools/shell/manifest";
import { registerAgentMessageKinds } from "@veyyon/kernel/session/message-kinds";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

// A handoff converts the transcript, which holds the cells `executePython` recorded.
registerAgentMessageKinds(shellDomain.messageKinds);

const OK: KernelExecuteResult = { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };

class FakeKernel implements SessionKernel {
	shutdowns = 0;
	#alive = true;

	isAlive(): boolean {
		return this.#alive;
	}

	async execute(_code: string, _options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		return OK;
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.shutdowns++;
		this.#alive = false;
		return { confirmed: true };
	}
}

describe("a conversation the session leaves", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let started: FakeKernel[];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("veyyon-conversation-kernels-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
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
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("veyyon-conversation-kernels-");
		started = [];
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true } as never);
		vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation((async () => {
			const kernel = new FakeKernel();
			started.push(kernel);
			return kernel;
		}) as never);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		await pythonExecutor.disposeAllKernelSessions();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		await tempDir.remove();
	});

	/** A persisted conversation, as `/resume` and a handoff need one. */
	async function seededManager(text: string): Promise<SessionManager> {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() - 2 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `${text} answered` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
		await manager.flush();
		return manager;
	}

	/** A session built the way the SDK builds one without an agent id: not in the agent registry. */
	function build(sessionManager: SessionManager, parentEvalSessionId?: string): AgentSession {
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "python.kernelMode": "session" }),
			modelRegistry,
			toolRegistry: new Map(),
			parentEvalSessionId,
		});
		sessions.push(session);
		return session;
	}

	const SWITCHES: Record<string, (session: AgentSession) => Promise<unknown>> = {
		"/new": session => session.newSession(),
		"/resume of another conversation": async session => {
			const file = (await seededManager("other")).getSessionFile();
			if (!file) throw new Error("expected the other conversation to have a file");
			return await session.switchSession(file);
		},
		handoff: session => {
			vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");
			return session.handoff();
		},
	};

	for (const [name, leave] of Object.entries(SWITCHES)) {
		it(`shuts its Python kernel down at ${name}, and the next cell starts a new one`, async () => {
			const session = build(await seededManager("current"));
			await session.executePython("x = 1", undefined, { excludeFromContext: true });
			expect(started).toHaveLength(1);

			await leave(session);

			expect(started[0]!.shutdowns).toBe(1);
			await session.executePython("y = 2", undefined, { excludeFromContext: true });
			expect(started).toHaveLength(2);
			expect(started[1]!.isAlive()).toBe(true);
		});
	}

	it("keeps its Python kernel through a reload of the same conversation", async () => {
		const session = build(await seededManager("current"));
		await session.executePython("x = 1", undefined, { excludeFromContext: true });

		await session.reload();
		await session.executePython("x", undefined, { excludeFromContext: true });

		expect(started).toHaveLength(1);
		expect(started[0]!.shutdowns).toBe(0);
	});

	it("leaves a kernel another session still shares running for that session", async () => {
		const parent = build(await seededManager("current"));
		await parent.executePython("x = 1", undefined, { excludeFromContext: true });
		const child = build(SessionManager.inMemory(tempDir.path()), parent.getEvalSessionId());
		await child.executePython("x", undefined, { excludeFromContext: true });
		expect(started).toHaveLength(1);

		await parent.newSession();
		await child.executePython("x", undefined, { excludeFromContext: true });

		expect(started[0]!.shutdowns).toBe(0);
		expect(started).toHaveLength(1);
	});
});
