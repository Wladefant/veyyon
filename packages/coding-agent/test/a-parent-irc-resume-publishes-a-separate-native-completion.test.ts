/** WHY: A retained child yielded B, but its parent saw only the child's immutable spawn result A.
 * The A artifact below is manually seeded; this suite does not test the initial executor fixture.
 * Exercise real Agent, native YieldTool, session persistence and IrcBus. Only the provider is scripted.
 * Gap: this proves transport, not a live model's interpretation of operational instructions. */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentProtocolHandler } from "../src/internal-urls/agent-protocol";
import { parseInternalUrl } from "../src/internal-urls/parse";
import { AgentRegistry } from "../src/registry/agent-registry";
import { IrcBus } from "../src/task/irc-bus";
import { renderAgentUserPrompt } from "../src/task/spawn-run";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { IrcContinuationOutbox } from "../src/session/runtime/irc-inbox";
import type { ToolSession } from "../src/tools";
import { YieldTool } from "../src/tools/agent/yield";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

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
function yielded(value: string): MockResponse {
	return { content: [{ type: "toolCall", id: `yield-${value}`, name: "yield", arguments: { result: { data: { value } } } }], stopReason: "toolUse" };
}
async function session(id: string, responses: MockResponse[], existing?: SessionManager) {
	const temp = TempDir.createSync("native-handoff-");
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	auth.setRuntimeApiKey("mock", "test-key");
	const mock = createMockModel({ responses });
	const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
	const tools: AgentTool[] = [new YieldTool({ outputSchema: undefined } as ToolSession)];
	const store = existing ?? SessionManager.create(temp.path(), temp.path());
	const agent = new Agent({ getApiKey: () => "fake-test-key", initialState: { model: mock, systemPrompt: ["Operator: production writes are forbidden."], tools, messages: store.buildSessionContext().messages }, convertToLlm, streamFn: mock.stream });
	const instance = new AgentSession({ agent, agentId: id, sessionManager: store, settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false, "todo.reminders": false }), modelRegistry: registry, toolRegistry: new Map(tools.map(tool => [tool.name, tool])) });
	resources.push({ session: instance, auth, temp });
	return { instance, mock, store };
}

describe("native retained child resume", () => {
	it("delivers B once through the parent inbox, keeps A, and coalesces duplicate resume IDs", async () => {
		AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Continuation received"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("A"), yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "NotMain", kind: "main", scope: "test", session: parent.instance });
		registry.register({ id: "worker", displayName: "Unrelated.Name", kind: "sub", parentId: "owner", session: child.instance });
		let completionEvents = 0;
		parent.instance.subscribe(event => {
			if (event.type === "irc_message" && event.message.customType === "task:continuation") completionEvents++;
		});
		await child.instance.prompt(renderAgentUserPrompt("Phase A: no new worktree and read-only until my next phase update.", "owner"), { attribution: "agent" });
		await child.instance.waitForIdle();
		const dir = child.store.getArtifactsDir()!;
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "worker.md"), JSON.stringify({ value: "A" }));
		const resume = { id: "resume-phase-two", from: "owner", to: "worker", body: "Phase two replaces my temporary read-only plan. Stay in the same tree. Production writes remain forbidden.", ts: Date.now() };
		await Promise.all([child.instance.deliverIrcMessage(resume), child.instance.deliverIrcMessage(resume)]);
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		await Promise.all([child.instance.replayIrcContinuations(), child.instance.replayIrcContinuations()]);
		const completions = parent.store.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completions).toHaveLength(1);
		expect(completionEvents).toBe(1);
		const completion = completions[0]!;
		if (completion.type !== "custom_message") throw new Error("Expected native completion");
		expect(completion.attribution).toBe("agent");
		expect(completion.details).toMatchObject({ from: "worker", source: "agent", phaseId: "resume-phase-two" });
		expect(completion.content).toContain('"value":"B"');
		const handle = Reflect.get(completion.details!, "handle") as string;
		expect(handle).toStartWith("agent://worker.phase-");
		expect(await fs.readFile(path.join(dir, `${handle.slice(8)}.md`), "utf8")).toBe('{"value":"B"}');
		const resolved = await new AgentProtocolHandler().resolve(parseInternalUrl(handle));
		expect(resolved.content).toBe('{"value":"B"}');
		expect(await fs.readFile(path.join(dir, "worker.md"), "utf8")).toBe('{"value":"A"}');
		expect(child.mock.calls).toHaveLength(2);
		expect(child.instance.agent.state.systemPrompt).toEqual(["Operator: production writes are forbidden."]);
		expect(child.mock.calls[0]?.context.messages.some(message => message.role === "user" && message.attribution === "agent")).toBe(true);
	});

	it("aggregates a nested child's B to the root as a separate native result", async () => {
		AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
		const root = await session("root", [{ content: ["Root received B"], stopReason: "stop" }]);
		const parent = await session("parent", [yielded("aggregate-B")]);
		const child = await session("child", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "root", displayName: "Root", kind: "main", scope: "tree", session: root.instance });
		registry.register({ id: "parent", displayName: "Parent", kind: "sub", parentId: "root", scope: "tree", session: parent.instance });
		registry.register({ id: "child", displayName: "Child", kind: "sub", parentId: "parent", scope: "tree", session: child.instance });
		await fs.mkdir(child.store.getArtifactsDir()!, { recursive: true });
		await fs.writeFile(path.join(child.store.getArtifactsDir()!, "child.md"), JSON.stringify({ value: "A" }));
		await child.instance.deliverIrcMessage({
			id: "resume-nested-child", from: "parent", to: "child", body: "Return B.", ts: Date.now(),
		});
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		await root.instance.waitForIdle();
		const parentResult = parent.store.getEntries().find(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		const rootResult = root.store.getEntries().find(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(parentResult?.type).toBe("custom_message");
		expect(rootResult?.type).toBe("custom_message");
		if (parentResult?.type !== "custom_message" || rootResult?.type !== "custom_message") throw new Error("Expected nested native completions");
		expect(parentResult.content).toContain('"value":"B"');
		expect(rootResult.content).toContain('"value":"aggregate-B"');
		expect(Reflect.get(parentResult.details!, "handle")).not.toBe(Reflect.get(rootResult.details!, "handle"));
		expect(await fs.readFile(path.join(child.store.getArtifactsDir()!, "child.md"), "utf8")).toBe('{"value":"A"}');
		expect(child.mock.calls).toHaveLength(1);
	});

	it("keeps a parent message received during native B as a separate C completion", async () => {
		AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Handled B and C"], stopReason: "stop" }]);
		const child = await session("worker", [{ ...yielded("B"), delayMs: 30 }, yielded("C")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({ id: "worker", displayName: "Worker", kind: "sub", parentId: "owner", scope: "test", session: child.instance });
		await child.store.ensureOnDisk();
		await fs.mkdir(child.store.getArtifactsDir()!, { recursive: true });
		await fs.writeFile(path.join(child.store.getArtifactsDir()!, "worker.md"), JSON.stringify({ value: "A" }));
		const bDelivery = child.instance.deliverIrcMessage({
			id: "resume-B", from: "owner", to: "worker", body: "Return B.", ts: Date.now(),
		});
		const cDelivery = child.instance.deliverIrcMessage({
			id: "resume-C", from: "owner", to: "worker", body: "Return C.", ts: Date.now(),
		});
		await Promise.all([bDelivery, cDelivery]);
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		const completions = parent.store.getEntries().flatMap(entry =>
			entry.type === "custom_message" && entry.customType === "task:continuation" ? [entry] : []);
		expect(completions).toHaveLength(2);
		expect(completions.map(entry => entry.content)).toEqual([
			expect.stringContaining('"value":"B"'), expect.stringContaining('"value":"C"'),
		]);
		expect(Reflect.get(completions[0]!.details ?? {}, "handle"))
			.not.toBe(Reflect.get(completions[1]!.details ?? {}, "handle"));
		expect(await fs.readFile(path.join(child.store.getArtifactsDir()!, "worker.md"), "utf8")).toBe('{"value":"A"}');
		expect(child.mock.calls).toHaveLength(2);
	});

	it("routes to the verified root ancestor when the direct parent is unavailable", async () => {
		AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
		const root = await session("root", [{ content: ["Received B"], stopReason: "stop" }]);
		const child = await session("child", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "root", displayName: "Root", kind: "main", scope: "tree", session: root.instance });
		registry.register({ id: "missing-parent", displayName: "Missing Parent", kind: "sub", parentId: "root", scope: "tree", session: null });
		registry.register({ id: "child", displayName: "Child", kind: "sub", parentId: "missing-parent", scope: "tree", session: child.instance });
		await child.instance.deliverIrcMessage({
			id: "resume-orphaned-child", from: "missing-parent", to: "child", body: "Return B.", ts: Date.now(),
		});
		await child.instance.waitForIdle();
		await root.instance.waitForIdle();
		const completion = root.store.getEntries().find(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completion?.type).toBe("custom_message");
		if (completion?.type !== "custom_message") throw new Error("Expected verified ancestor completion");
		expect(completion.content).toContain('"value":"B"');
		expect(child.mock.calls).toHaveLength(1);
	});

	it("does not route a completion to an unrelated root when verified lineage ends", async () => {
		AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
		const foreignRoot = await session("foreign-root", [{ content: ["Must not receive B"], stopReason: "stop" }]);
		const child = await session("child", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "foreign-root", displayName: "Foreign Root", kind: "main", scope: "foreign", session: foreignRoot.instance });
		registry.register({ id: "missing-parent", displayName: "Missing Parent", kind: "sub", scope: "isolated", session: null });
		registry.register({ id: "child", displayName: "Child", kind: "sub", parentId: "missing-parent", scope: "isolated", session: child.instance });
		await child.instance.deliverIrcMessage({
			id: "resume-unverified-lineage", from: "missing-parent", to: "child", body: "Return B.", ts: Date.now(),
		});
		await child.instance.waitForIdle();
		const completions = foreignRoot.store.getEntries().filter(entry =>
			entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completions).toHaveLength(0);
		const outbox = new IrcContinuationOutbox(child.store);
		expect(outbox.pending()).toHaveLength(1);
		const pending = outbox.pending()[0]!;
		expect(pending.output).toContain('"value":"B"');
		expect(pending.handle).toStartWith("agent://child.phase-");
		expect(await fs.readFile(path.join(child.store.getArtifactsDir()!, `${pending.handle.slice(8)}.md`), "utf8"))
			.toBe(pending.output);
		expect(child.mock.calls).toHaveLength(1);
	});

	it("replays an older unfinished parent phase before a newly arrived parent message", async () => {
		AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Received B then C"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("B"), yielded("C")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({ id: "worker", displayName: "Worker", kind: "sub", parentId: "owner", scope: "test", session: child.instance });
		const oldPhase = {
			role: "custom" as const, customType: "irc:incoming", content: "Resume older phase B",
			display: true, timestamp: Date.now(), attribution: "agent" as const,
			details: { id: "resume-B", from: "owner", source: "agent", relation: "parent" },
		};
		new IrcContinuationOutbox(child.store).begin("resume-B", oldPhase);
		await child.store.ensureOnDisk();
		await child.store.sync();
		await child.instance.dispose();
		const reopened = await SessionManager.open(child.store.getSessionFile()!);
		const recovered = await session("worker", [yielded("B"), yielded("C")], reopened);
		registry.attachSession("worker", recovered.instance, reopened.getSessionFile()!);
		await recovered.instance.deliverIrcMessage({
			id: "resume-C", from: "owner", to: "worker", body: "Resume newer phase C", ts: Date.now(),
		});
		await recovered.instance.waitForIdle();
		await parent.instance.waitForIdle();
		const completions = parent.store.getEntries().flatMap(entry =>
			entry.type === "custom_message" && entry.customType === "task:continuation" ? [entry] : []);
		expect(completions.map(entry => Reflect.get(entry.details ?? {}, "phaseId"))).toEqual(["resume-B", "resume-C"]);
		expect(completions.map(entry => entry.content)).toEqual([
			expect.stringContaining('"value":"B"'), expect.stringContaining('"value":"C"'),
		]);
		expect(recovered.mock.calls).toHaveLength(2);
	});

	it("replays a durable root continuation after reopen without duplicating its receipt", async () => {
		AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
		const root = await session("root", [{ content: ["Received B"], stopReason: "stop" }]);
		const child = await session("child", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "root", displayName: "Root", kind: "main", scope: "tree", session: root.instance });
		registry.register({ id: "child", displayName: "Child", kind: "sub", parentId: "root", scope: "tree", session: child.instance });
		const completionId = "durable-completion-before-wake";
		root.store.appendCustomMessageEntry("task:continuation", "B", true,
			{ id: "incoming-B", from: "child", completionId, source: "agent" }, "agent");
		await root.store.ensureOnDisk();
		await root.store.sync();
		await root.instance.dispose();
		const reopened = await SessionManager.open(root.store.getSessionFile()!);
		const recovered = await session("root", [{ content: ["Received B"], stopReason: "stop" }], reopened);
		registry.attachSession("root", recovered.instance, reopened.getSessionFile()!);
		await recovered.instance.replayIrcContinuations();
		await recovered.instance.waitForIdle();
		const consumed = reopened.getEntries().filter(entry => entry.type === "custom" &&
			entry.customType === "irc:completion-consumed" && entry.data === completionId);
		expect(consumed).toHaveLength(1);
		expect(recovered.mock.calls).toHaveLength(1);
		await recovered.instance.replayIrcContinuations();
		expect(reopened.getEntries().filter(entry => entry.type === "custom" &&
			entry.customType === "irc:completion-consumed" && entry.data === completionId)).toHaveLength(1);
		expect(recovered.mock.calls).toHaveLength(1);
	});

	it("recovers persisted native yields after restart without executing either phase again", async () => {
		AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Results received"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("B"), yielded("C")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({ id: "worker", displayName: "Worker", kind: "sub", parentId: "owner", scope: "test", session: child.instance });
		const outbox = new IrcContinuationOutbox(child.store);
		for (const phase of ["B", "C"]) {
			const record = {
				role: "custom" as const, customType: "irc:incoming", content: `Resume phase ${phase}`,
				display: true, timestamp: Date.now(), attribution: "agent" as const,
				details: { id: `resume-${phase}`, from: "owner", source: "agent", relation: "parent" },
			};
			outbox.begin(`resume-${phase}`, record);
			await child.instance.sendCustomMessage(record, { triggerTurn: true });
			await child.instance.waitForIdle();
		}
		await child.store.sync();
		await child.instance.dispose();
		const reopened = await SessionManager.open(child.store.getSessionFile()!);
		const recovered = await session("worker", [], reopened);
		registry.attachSession("worker", recovered.instance, reopened.getSessionFile()!);
		const waiting = IrcBus.global().wait("owner", { from: "worker" }, 2000);
		await recovered.instance.replayIrcContinuations();
		await recovered.instance.waitForIdle();
		await parent.instance.waitForIdle();
		const receipt = await waiting;
		const duplicateWait = IrcBus.global().wait("owner", { from: "worker" }, 50);
		await IrcBus.global().send({ from: "worker", to: "owner", body: receipt!.body }, { completion: receipt!.completion });
		expect(await duplicateWait).toBeNull();
		expect(receipt?.completion?.phaseId).toBe("resume-B");
		const completions = parent.store.getEntries().flatMap(entry =>
			entry.type === "custom_message" && entry.customType === "task:continuation" ? [entry] : []);
		expect(completions.map(entry => Reflect.get(entry.details ?? {}, "phaseId"))).toEqual(["resume-B", "resume-C"]);
		expect(completions.map(entry => entry.content)).toEqual([
			expect.stringContaining('"value":"B"'), expect.stringContaining('"value":"C"'),
		]);
		expect(recovered.mock.calls).toHaveLength(0);
		expect(new IrcContinuationOutbox(reopened).unfinished()).toEqual([]);
		await recovered.instance.replayIrcContinuations();
		expect(parent.store.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation")).toHaveLength(2);
	});

	it.each([
		{ name: "a phase without a native yield", response: { content: ["Stopped without yielding"], stopReason: "stop" } as MockResponse, source: "harness" },
		{ name: "an agent's explicit refusal", response: { content: [{ type: "toolCall", id: "declined", name: "yield", arguments: { result: { error: "Declined within the safety boundary" } } }], stopReason: "toolUse" } as MockResponse, source: "agent" },
	])("keeps the real source for $name, without inventing a human stop", async ({ response, source }) => {
		AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Result received"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("A"), response]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({ id: "worker", displayName: "Worker", kind: "sub", parentId: "owner", scope: "test", session: child.instance });
		await child.instance.prompt("Phase A", { attribution: "agent" });
		await child.instance.deliverIrcMessage({ id: "bounded-resume", from: "owner", to: "worker", body: "Complete the safe phase only.", ts: Date.now() });
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		const completion = parent.store.getEntries().find(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		if (completion?.type !== "custom_message") throw new Error("Expected native phase completion");
		expect(completion.details).toMatchObject({ resultSource: source });
		expect(completion.content).toContain(`"source":"${source}"`);
		expect(child.instance.agent.state.systemPrompt).toEqual(["Operator: production writes are forbidden."]);
	});
});
