/**
 * WHY: `/new`, `/resume` and a handoff release what the conversation being left holds
 * (`ConversationRelease.release`), and the IRC traffic of its agents is part of it. The bus is
 * process-global, so traffic the release leaves behind opens the next conversation's Comms pane on
 * the previous one's chatter, and traffic it takes from another conversation erases a record that
 * conversation still shows.
 *
 * The class this closes is a release that forgets the wrong lines at the call site: none, because
 * the forget was guarded on agents still being registered (an agent that finished and aged out is
 * gone by the time `/new` runs, yet its lines name this conversation's agent at the other end);
 * the ending agent's own legs left behind; or another conversation's lines taken because both ran
 * an agent under the same model-chosen name. `irc-bus-conversation-scope` pins the bus filter
 * itself; this suite pins that the release passes it the right agents and scope.
 *
 * What it does not catch: termination order and failure (`leaving-a-conversation-stops-the-agents-
 * it-spawned`), the eval kernel release (`a-conversation-the-session-leaves-shuts-down-its-eval-
 * kernels`) and the approval grants (`an-approval-answer-lasts-only-as-long-as-its-scope`), which
 * drive those through a real session.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { ConversationRelease } from "@veyyon/coding-agent/session/runtime/conversation-release";
import { IrcBus } from "@veyyon/coding-agent/task/irc-bus";

/** A session that accepts IRC hand-offs and the two calls the lifecycle makes to stop it. */
function stubSession(): AgentSession {
	return {
		deliverIrcMessage: async () => "delivered",
		emitIrcRelayObservation: () => {},
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

/** Register a conversation's driving agent under `scope`, and one agent it spawned. */
function conversation(scope: string, rootId: string, subId: string): void {
	const registry = AgentRegistry.global();
	registry.register({
		id: rootId,
		displayName: "main",
		kind: "main",
		session: stubSession(),
		status: "running",
		scope,
	});
	registry.register({
		id: subId,
		displayName: "reviewer",
		kind: "sub",
		parentId: rootId,
		session: stubSession(),
		status: "running",
	});
}

function releaseFor(agentId: string, nextScope: string): ConversationRelease {
	return new ConversationRelease(
		{ sessionId: () => nextScope, forgetToolDecisions: () => {} },
		agentId,
		`kernel-owner:${agentId}`,
	);
}

const bodies = (): string[] =>
	IrcBus.global()
		.log()
		.map(entry => entry.message.body);

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("a conversation that ends takes its own agents' traffic and no other", () => {
	it("forgets the ending conversation's lines and keeps another's under a recycled agent name", async () => {
		const bus = IrcBus.global();
		conversation("session-b", "acp:b", "Reviewer");
		await bus.send({ from: "Reviewer", to: "acp:b", body: "B's reviewer reported in" });
		AgentRegistry.global().unregister("Reviewer");

		conversation("session-a", "acp:a", "Reviewer");
		await bus.send({ from: "Reviewer", to: "acp:a", body: "A's reviewer reported in" });
		await bus.send({ from: "acp:a", to: "Reviewer", body: "A answered its reviewer" });

		await releaseFor("acp:a", "session-a2").release();

		expect(bodies()).toEqual(["B's reviewer reported in"]);
		expect(AgentRegistry.global().get("acp:a")?.scope).toBe("session-a2");
		expect(AgentRegistry.global().get("Reviewer")).toBeUndefined();
	});

	it("forgets the lines of an agent that already left the registry", async () => {
		const bus = IrcBus.global();
		conversation("session-b", "acp:b", "Reviewer-B");
		await bus.send({ from: "Reviewer-B", to: "acp:b", body: "B's line" });

		conversation("session-a", "acp:a", "Reviewer-A");
		await bus.send({ from: "Reviewer-A", to: "acp:a", body: "A's line" });
		AgentRegistry.global().unregister("Reviewer-A");

		await releaseFor("acp:a", "session-a2").release();

		expect(bodies()).toEqual(["B's line"]);
	});
});
