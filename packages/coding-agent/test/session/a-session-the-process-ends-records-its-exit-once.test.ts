/**
 * A session's `session_exit` entry is written once, by whichever of two paths reaches it first:
 * `dispose()`, or the callback the session registers with `postmortem` for a signal, a fatal error
 * or a process exit that never reaches a dispose.
 *
 * WHY THIS SUITE EXISTS. `a-crashed-session-is-logged-louder-than-a-closed-terminal` drives every
 * reason through `dispose({ reason })`. Nothing drove the registered callback itself, so a session
 * that stopped registering it, registered it with the wrong reason, or left it registered after a
 * dispose passed every suite.
 *
 * THE CLASS THIS CLOSES. An exit entry missing when the process ends without a dispose, an entry
 * whose reason is not the teardown that ran, a second entry when both paths run in either order,
 * and a callback left on the process list after a dispose, which keeps every closed session
 * reachable for the life of the process. The reason sweep enumerates `postmortem.Reason` at run
 * time and pins the kind of each by exact key equality, so a new reason fails here until someone
 * records what kind of exit it is.
 *
 * WHAT IT DOES NOT CATCH. A SIGKILL or an OOM kill runs no callback, and nothing in-process can
 * record either. The callback is invoked from the spy rather than by a real signal, because a real
 * teardown would run every callback the test process holds and leave `postmortem` spent for every
 * later file.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SESSION_EXIT_CUSTOM_TYPE, type SessionExitData } from "@veyyon/kernel/session/exit-diagnostics";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem, TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

/** The kind each process teardown records. Keyed by the persisted reason string. */
const EXPECTED_KIND: Record<string, SessionExitData["kind"]> = {
	[postmortem.Reason.PRE_EXIT]: "signal",
	[postmortem.Reason.EXIT]: "process_exit",
	[postmortem.Reason.SIGINT]: "signal",
	[postmortem.Reason.SIGTERM]: "signal",
	[postmortem.Reason.SIGHUP]: "signal",
	[postmortem.Reason.UNCAUGHT_EXCEPTION]: "fatal",
	[postmortem.Reason.UNHANDLED_REJECTION]: "fatal",
	[postmortem.Reason.MANUAL]: "normal",
};

const pendingAssistant = (): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "toolu_pending", name: "bash", arguments: { command: "sleep 30" } }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: emptyUsage(),
	stopReason: "toolUse",
	timestamp: Date.now(),
});

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	/** The callback the session handed `postmortem`, as the process would run it. */
	runProcessCallback(reason: postmortem.Reason): void;
	/** How many times the session withdrew that callback from the process list. */
	withdrawals(): number;
	exitEntries(): SessionExitData[];
}

describe("a session the process ends records its exit once", () => {
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];
	let sharedAuth: AuthStorage | undefined;
	let sharedRegistry: ModelRegistry | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		sharedAuth?.close();
		sharedAuth = undefined;
		sharedRegistry = undefined;
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	const registry = async (): Promise<ModelRegistry> => {
		if (sharedRegistry) return sharedRegistry;
		const dir = TempDir.createSync("@pi-exit-once-");
		tempDirs.push(dir);
		sharedAuth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		sharedAuth.setRuntimeApiKey("anthropic", "test-key");
		sharedRegistry = new ModelRegistry(sharedAuth, path.join(dir.path(), "models.json"));
		return sharedRegistry;
	};

	/**
	 * A real session over a real in-memory transcript holding a tool call with no result, so every
	 * path writes an entry. `postmortem.register` runs for real; the spy keeps the callback and
	 * counts the withdrawals of the registration this session made.
	 */
	const harness = async (): Promise<Harness> => {
		const callbacks: Array<(reason: postmortem.Reason) => void | Promise<void>> = [];
		let withdrawn = 0;
		const realRegister = postmortem.register;
		vi.spyOn(postmortem, "register").mockImplementation((id, callback) => {
			const cancel = realRegister(id, callback);
			if (!id.startsWith("agent-session:")) return cancel;
			callbacks.push(callback);
			return () => {
				withdrawn++;
				cancel();
			};
		});
		const modelRegistry = await registry();
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const dir = TempDir.createSync("@pi-exit-once-session-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(session);
		expect(callbacks, "the session registers exactly one process teardown callback").toHaveLength(1);

		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant() });
		let drained = 0;
		while (drained < 500 && !sessionManager.getEntries().some(entry => entry.type === "message")) {
			await Promise.resolve();
			drained++;
		}
		expect(sessionManager.getEntries().some(entry => entry.type === "message")).toBe(true);

		return {
			session,
			sessionManager,
			runProcessCallback: reason => {
				void callbacks[0](reason);
			},
			withdrawals: () => withdrawn,
			exitEntries: () =>
				sessionManager
					.getEntries()
					.flatMap(entry =>
						entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE
							? [entry.data as SessionExitData]
							: [],
					),
		};
	};

	it("names the kind of every teardown reason the process can hand the callback", () => {
		expect(Object.keys(EXPECTED_KIND).sort()).toEqual(Object.values(postmortem.Reason).sort());
	});

	it("writes the entry with the teardown's own reason when no dispose runs", async () => {
		for (const reason of Object.values(postmortem.Reason)) {
			const h = await harness();
			h.runProcessCallback(reason);
			const entries = h.exitEntries();
			expect(entries, reason).toHaveLength(1);
			expect(entries[0], reason).toMatchObject({
				reason,
				kind: EXPECTED_KIND[reason],
				pendingToolCalls: [{ toolCallId: "toolu_pending", toolName: "bash" }],
			});
			vi.restoreAllMocks();
		}
	});

	it("keeps the teardown's entry when a dispose follows it", async () => {
		const h = await harness();
		h.runProcessCallback(postmortem.Reason.SIGHUP);
		await h.session.dispose();
		expect(h.exitEntries()).toHaveLength(1);
		expect(h.exitEntries()[0]).toMatchObject({ reason: "sighup", kind: "signal" });
	});

	it("withdraws the callback on dispose, so a later teardown neither writes nor reaches the session", async () => {
		const h = await harness();
		await h.session.dispose();
		expect(h.withdrawals()).toBe(1);
		expect(h.exitEntries()).toHaveLength(1);
		expect(h.exitEntries()[0]).toMatchObject({ reason: "dispose", kind: "normal" });
		// A second dispose is the same settled call and withdraws nothing again.
		await h.session.dispose();
		expect(h.withdrawals()).toBe(1);
		expect(h.exitEntries()).toHaveLength(1);
	});
});
