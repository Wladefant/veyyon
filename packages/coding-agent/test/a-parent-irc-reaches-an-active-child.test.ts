/** WHY: A parent-to-child IRC send during the child's live model turn must reach the child once.
 * This drives real AgentSession instances, lineage registration and IrcBus; only the provider is scripted.
 * Gap: it proves the mock-provider turn path, not delivery through an external provider or host process.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { isRecord, TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { IrcBus } from "../src/task/irc-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

const resources: { session: AgentSession; auth: AuthStorage; temp: TempDir }[] = [];
afterEach(async () => {
	const completed = resources.splice(0);
	for (const resource of completed) {
		await resource.session.dispose();
		resource.auth.close();
	}
	for (const resource of completed) resource.temp.removeSync();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function makeSession(id: string, response: MockResponse) {
	const temp = TempDir.createSync("active-child-irc-");
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	auth.setRuntimeApiKey("mock", "test-key");
	const mock = createMockModel({ responses: [response] });
	const modelRegistry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
	const sessionManager = SessionManager.create(temp.path(), temp.path());
	const agent = new Agent({
		getApiKey: () => "fake-test-key",
		initialState: { model: mock, systemPrompt: ["Read-only test session."], tools: [], messages: sessionManager.buildSessionContext().messages },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		agentId: id,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false, "todo.reminders": false }),
		modelRegistry,
		toolRegistry: new Map(),
	});
	resources.push({ session, auth, temp });
	return { session, mock };
}

describe("parent IRC delivery to an active child", () => {
	it("injects parent steering into the streaming child exactly once", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await makeSession("parent", { content: ["parent response"], stopReason: "stop" });
		const child = await makeSession("child", { content: ["child response"], stopReason: "stop", delayMs: 2_000 });
		const registry = AgentRegistry.global();
		registry.register({ id: "parent", displayName: "Parent", kind: "main", scope: "test", session: parent.session });
		registry.register({ id: "child", displayName: "Child", kind: "sub", parentId: "parent", scope: "test", session: child.session });
		const received: string[] = [];
		child.session.subscribe(event => {
			if (event.type === "irc_message" && isRecord(event.message.details)) {
				received.push(String(event.message.details.message ?? ""));
			}
		});
		const turn = child.session.prompt("Continue the task.", { attribution: "agent" });
		try {
			for (let attempt = 0; child.mock.calls.length === 0 && attempt < 100; attempt++) await delay(10);
			expect(child.mock.calls).toHaveLength(1);
			const receipt = await IrcBus.global().send({ from: "parent", to: "child", body: "Pause edits and report current status." });
			expect(receipt).toMatchObject({ to: "child", outcome: "injected" });
			expect(child.session.isStreaming).toBe(true);
			expect(child.session.agent.peekSteeringQueue()).toEqual(expect.arrayContaining([expect.objectContaining({
				role: "user",
				steering: true,
				content: expect.stringContaining("Pause edits and report current status."),
			})]));
			expect(received).toEqual(["Pause edits and report current status."]);
			await child.session.waitForIdle();
			await turn;
			expect(received).toEqual(["Pause edits and report current status."]);
		} finally {
			await child.session.waitForIdle();
		}
	});
});
