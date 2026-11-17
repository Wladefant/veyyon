/** WHY: A retained child yielded B, but its parent saw only the child's immutable spawn result A.
 * The A artifact below is manually seeded; this suite does not test the initial executor fixture.
 * Exercise real Agent, native YieldTool, session persistence and IrcBus. Only the provider is scripted.
 * Gap: this proves transport, not a live model's interpretation of operational instructions. */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { withJournalLock } from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentProtocolHandler } from "../src/internal-urls/agent-protocol";
import { parseInternalUrl } from "../src/internal-urls/parse";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { IrcContinuationOutbox } from "../src/session/runtime/irc-inbox";
import { IrcBus } from "../src/task/irc-bus";
import { renderAgentUserPrompt } from "../src/task/spawn-run";
import type { ToolSession } from "../src/tools";
import { YieldTool } from "../src/tools/agent/yield";

const resources: { session?: AgentSession; auth?: AuthStorage; temp: TempDir }[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	const completed = resources.splice(0);
	for (const resource of completed) {
		if (resource.session) await resource.session.dispose();
		if (resource.auth) resource.auth.close();
	}
	for (const resource of completed) resource.temp.removeSync();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});
function yielded(value: string): MockResponse {
	return {
		content: [{ type: "toolCall", id: `yield-${value}`, name: "yield", arguments: { result: { data: { value } } } }],
		stopReason: "toolUse",
	};
}
async function session(id: string, responses: MockResponse[], existing?: SessionManager) {
	const temp = TempDir.createSync("native-handoff-");
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	auth.setRuntimeApiKey("mock", "test-key");
	const mock = createMockModel({ responses });
	const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
	const tools: AgentTool[] = [new YieldTool({ outputSchema: undefined } as ToolSession)];
	const store = existing ?? SessionManager.create(temp.path(), temp.path());
	const agent = new Agent({
		getApiKey: () => "fake-test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Operator: production writes are forbidden."],
			tools,
			messages: store.buildSessionContext().messages,
		},
		convertToLlm,
		streamFn: mock.stream,
	});
	const instance = new AgentSession({
		agent,
		agentId: id,
		sessionManager: store,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		}),
		modelRegistry: registry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	resources.push({ session: instance, auth, temp });
	return { instance, mock, store };
}

describe("native retained child resume", () => {
	it("claims a parent phase in memory while the real journal lock is held, then persists it once", async () => {
		const child = await session("worker", []);
		await child.store.ensureOnDisk();
		await child.store.sync();
		const sessionFile = child.store.getSessionFile()!;
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const held = new Promise<void>(resolve => {
			entered = resolve;
		});
		const lock = withJournalLock(sessionFile, async () => {
			entered();
			await gate;
		});
		await held;
		const pendingRewrite = child.store.rewriteEntries();
		await setImmediate();
		try {
			const outbox = new IrcContinuationOutbox(child.store);
			expect(outbox.begin("locked-parent-message")).toBe(true);
			expect(outbox.begin("locked-parent-message")).toBe(false);
		} finally {
			release();
			await lock;
		}
		await pendingRewrite;
		await child.store.ensureOnDisk();
		await child.store.sync();
		await child.instance.dispose();
		const reopened = await SessionManager.open(sessionFile);
		const phaseCount = reopened
			.getEntries()
			.filter(
				entry =>
					entry.type === "custom" &&
					entry.customType === "irc:continuation-phase" &&
					Reflect.get(entry.data ?? {}, "phaseId") === "locked-parent-message",
			).length;
		expect(phaseCount).toBe(1);
		await reopened.close();
	});
	it("delivers B once through the parent inbox, keeps A, and coalesces duplicate resume IDs", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Continuation received"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("A"), yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "NotMain", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Unrelated.Name",
			kind: "sub",
			parentId: "owner",
			session: child.instance,
		});
		let completionEvents = 0;
		parent.instance.subscribe(event => {
			if (event.type === "irc_message" && event.message.customType === "task:continuation") completionEvents++;
		});
		await child.instance.prompt(
			renderAgentUserPrompt("Phase A: no new worktree and read-only until my next phase update.", "owner"),
			{ attribution: "agent" },
		);
		await child.instance.waitForIdle();
		const dir = child.store.getArtifactsDir()!;
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "worker.md"), JSON.stringify({ value: "A" }));
		const resume = {
			id: "resume-phase-two",
			from: "owner",
			to: "worker",
			body: "Phase two replaces my temporary read-only plan. Stay in the same tree. Production writes remain forbidden.",
			ts: Date.now(),
		};
		await Promise.all([child.instance.deliverIrcMessage(resume), child.instance.deliverIrcMessage(resume)]);
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		await Promise.all([child.instance.replayIrcContinuations(), child.instance.replayIrcContinuations()]);
		const completions = parent.store
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
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
		expect(
			child.mock.calls[0]?.context.messages.some(
				message => message.role === "user" && message.attribution === "agent",
			),
		).toBe(true);
	});

	it("aggregates a nested child's B to the root as a separate native result", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const root = await session("root", [{ content: ["Root received B"], stopReason: "stop" }]);
		const parent = await session("parent", [yielded("aggregate-B")]);
		const child = await session("child", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "root", displayName: "Root", kind: "main", scope: "tree", session: root.instance });
		registry.register({
			id: "parent",
			displayName: "Parent",
			kind: "sub",
			parentId: "root",
			scope: "tree",
			session: parent.instance,
		});
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "parent",
			scope: "tree",
			session: child.instance,
		});
		await fs.mkdir(child.store.getArtifactsDir()!, { recursive: true });
		await fs.writeFile(path.join(child.store.getArtifactsDir()!, "child.md"), JSON.stringify({ value: "A" }));
		await child.instance.deliverIrcMessage({
			id: "resume-nested-child",
			from: "parent",
			to: "child",
			body: "Return B.",
			ts: Date.now(),
		});
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		await root.instance.waitForIdle();
		const parentResult = parent.store
			.getEntries()
			.find(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		const rootResult = root.store
			.getEntries()
			.find(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(parentResult?.type).toBe("custom_message");
		expect(rootResult?.type).toBe("custom_message");
		if (parentResult?.type !== "custom_message" || rootResult?.type !== "custom_message")
			throw new Error("Expected nested native completions");
		expect(parentResult.content).toContain('"value":"B"');
		expect(rootResult.content).toContain('"value":"aggregate-B"');
		expect(Reflect.get(parentResult.details!, "handle")).not.toBe(Reflect.get(rootResult.details!, "handle"));
		expect(await fs.readFile(path.join(child.store.getArtifactsDir()!, "child.md"), "utf8")).toBe('{"value":"A"}');
		expect(child.mock.calls).toHaveLength(1);
	});

	it("keeps a parent message received during native B as a separate C completion", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Handled B and C"], stopReason: "stop" }]);
		const child = await session("worker", [{ ...yielded("B"), delayMs: 30 }, yielded("C")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});
		await child.store.ensureOnDisk();
		await fs.mkdir(child.store.getArtifactsDir()!, { recursive: true });
		await fs.writeFile(path.join(child.store.getArtifactsDir()!, "worker.md"), JSON.stringify({ value: "A" }));
		const bDelivery = child.instance.deliverIrcMessage({
			id: "resume-B",
			from: "owner",
			to: "worker",
			body: "Return B.",
			ts: Date.now(),
		});
		const cDelivery = child.instance.deliverIrcMessage({
			id: "resume-C",
			from: "owner",
			to: "worker",
			body: "Return C.",
			ts: Date.now(),
		});
		await Promise.all([bDelivery, cDelivery]);
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		const completions = parent.store
			.getEntries()
			.flatMap(entry =>
				entry.type === "custom_message" && entry.customType === "task:continuation" ? [entry] : [],
			);
		expect(completions).toHaveLength(2);
		expect(completions.map(entry => entry.content)).toEqual([
			expect.stringContaining('"value":"B"'),
			expect.stringContaining('"value":"C"'),
		]);
		expect(Reflect.get(completions[0]!.details ?? {}, "handle")).not.toBe(
			Reflect.get(completions[1]!.details ?? {}, "handle"),
		);
		expect(await fs.readFile(path.join(child.store.getArtifactsDir()!, "worker.md"), "utf8")).toBe('{"value":"A"}');
		expect(child.mock.calls).toHaveLength(2);
	});

	it("routes to the verified root ancestor when the direct parent is unavailable", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const root = await session("root", [{ content: ["Received B"], stopReason: "stop" }]);
		const child = await session("child", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "root", displayName: "Root", kind: "main", scope: "tree", session: root.instance });
		registry.register({
			id: "missing-parent",
			displayName: "Missing Parent",
			kind: "sub",
			parentId: "root",
			scope: "tree",
			session: null,
		});
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "missing-parent",
			scope: "tree",
			session: child.instance,
		});
		await child.instance.deliverIrcMessage({
			id: "resume-orphaned-child",
			from: "missing-parent",
			to: "child",
			body: "Return B.",
			ts: Date.now(),
		});
		await child.instance.waitForIdle();
		await root.instance.waitForIdle();
		const completion = root.store
			.getEntries()
			.find(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completion?.type).toBe("custom_message");
		if (completion?.type !== "custom_message") throw new Error("Expected verified ancestor completion");
		expect(completion.content).toContain('"value":"B"');
		expect(child.mock.calls).toHaveLength(1);
	});

	it("does not route a completion to an unrelated root when verified lineage ends", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const foreignRoot = await session("foreign-root", [{ content: ["Must not receive B"], stopReason: "stop" }]);
		const child = await session("child", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({
			id: "foreign-root",
			displayName: "Foreign Root",
			kind: "main",
			scope: "foreign",
			session: foreignRoot.instance,
		});
		registry.register({
			id: "missing-parent",
			displayName: "Missing Parent",
			kind: "sub",
			scope: "isolated",
			session: null,
		});
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "missing-parent",
			scope: "isolated",
			session: child.instance,
		});
		await child.instance.deliverIrcMessage({
			id: "resume-unverified-lineage",
			from: "missing-parent",
			to: "child",
			body: "Return B.",
			ts: Date.now(),
		});
		await child.instance.waitForIdle();
		const completions = foreignRoot.store
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completions).toHaveLength(0);
		const outbox = new IrcContinuationOutbox(child.store);
		expect(outbox.pending()).toHaveLength(1);
		const pending = outbox.pending()[0]!;
		expect(pending.output).toContain('"value":"B"');
		expect(pending.handle).toStartWith("agent://child.phase-");
		expect(
			await fs.readFile(path.join(child.store.getArtifactsDir()!, `${pending.handle.slice(8)}.md`), "utf8"),
		).toBe(pending.output);
		expect(child.mock.calls).toHaveLength(1);
	});

	it("replays an older unfinished parent phase before a newly arrived parent message", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Received B then C"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("B"), yielded("C")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});
		const originalTs = 1700000000000;
		const oldPhase = {
			role: "custom" as const,
			customType: "irc:incoming",
			content: "Resume older phase B",
			display: true,
			timestamp: originalTs,
			attribution: "agent" as const,
			details: { id: "resume-B", from: "owner", source: "agent", relation: "parent", sentAt: originalTs },
		};
		new IrcContinuationOutbox(child.store).begin("resume-B", oldPhase);
		await child.store.ensureOnDisk();
		await child.store.sync();
		await child.instance.dispose();
		const reopened = await SessionManager.open(child.store.getSessionFile()!);
		const recovered = await session("worker", [yielded("B"), yielded("C")], reopened);
		registry.attachSession("worker", recovered.instance, reopened.getSessionFile()!);
		await recovered.instance.deliverIrcMessage({
			id: "resume-C",
			from: "owner",
			to: "worker",
			body: "Resume newer phase C",
			ts: Date.now(),
		});
		await recovered.instance.waitForIdle();
		await parent.instance.waitForIdle();
		const completions = parent.store
			.getEntries()
			.flatMap(entry =>
				entry.type === "custom_message" && entry.customType === "task:continuation" ? [entry] : [],
			);
		expect(completions.map(entry => Reflect.get(entry.details ?? {}, "phaseId"))).toEqual(["resume-B", "resume-C"]);
		expect(completions.map(entry => entry.content)).toEqual([
			expect.stringContaining('"value":"B"'),
			expect.stringContaining('"value":"C"'),
		]);
		expect(recovered.mock.calls).toHaveLength(2);
		const resumed = recovered.instance.agent.state.messages.find(
			m => m.role === "custom" && Reflect.get(m.details ?? {}, "id") === "resume-B",
		);
		if (resumed?.role !== "custom") throw new Error("Expected recovered input");
		expect(resumed?.timestamp).toBe(originalTs);
		expect(Reflect.get(resumed?.details ?? {}, "sentAt")).toBe(originalTs);
	});

	it("replays a durable root continuation after reopen without duplicating its receipt", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const root = await session("root", [{ content: ["Received B"], stopReason: "stop" }]);
		const child = await session("child", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "root", displayName: "Root", kind: "main", scope: "tree", session: root.instance });
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "root",
			scope: "tree",
			session: child.instance,
		});
		const completionId = "durable-completion-before-wake";
		root.store.appendCustomMessageEntry(
			"task:continuation",
			"B",
			true,
			{ id: "incoming-B", from: "child", completionId, source: "agent" },
			"agent",
		);
		await root.store.ensureOnDisk();
		await root.store.sync();
		await root.instance.dispose();
		const reopened = await SessionManager.open(root.store.getSessionFile()!);
		const recovered = await session("root", [{ content: ["Received B"], stopReason: "stop" }], reopened);
		registry.attachSession("root", recovered.instance, reopened.getSessionFile()!);
		await recovered.instance.replayIrcContinuations();
		await recovered.instance.waitForIdle();
		const consumed = reopened
			.getEntries()
			.filter(
				entry =>
					entry.type === "custom" && entry.customType === "irc:completion-consumed" && entry.data === completionId,
			);
		expect(consumed).toHaveLength(1);
		expect(recovered.mock.calls).toHaveLength(1);
		await recovered.instance.replayIrcContinuations();
		expect(
			reopened
				.getEntries()
				.filter(
					entry =>
						entry.type === "custom" &&
						entry.customType === "irc:completion-consumed" &&
						entry.data === completionId,
				),
		).toHaveLength(1);
		expect(recovered.mock.calls).toHaveLength(1);
	});

	it("recovers persisted native yields after restart without executing either phase again", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Results received"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("B"), yielded("C")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});
		const outbox = new IrcContinuationOutbox(child.store);
		for (const phase of ["B", "C"]) {
			const record = {
				role: "custom" as const,
				customType: "irc:incoming",
				content: `Resume phase ${phase}`,
				display: true,
				timestamp: Date.now(),
				attribution: "agent" as const,
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
		await IrcBus.global().send(
			{ from: "worker", to: "owner", body: receipt!.body },
			{ completion: receipt!.completion },
		);
		expect(await duplicateWait).toBeNull();
		expect(receipt?.completion?.phaseId).toBe("resume-B");
		const completions = parent.store
			.getEntries()
			.flatMap(entry =>
				entry.type === "custom_message" && entry.customType === "task:continuation" ? [entry] : [],
			);
		expect(completions.map(entry => Reflect.get(entry.details ?? {}, "phaseId"))).toEqual(["resume-B", "resume-C"]);
		expect(completions.map(entry => entry.content)).toEqual([
			expect.stringContaining('"value":"B"'),
			expect.stringContaining('"value":"C"'),
		]);
		expect(recovered.mock.calls).toHaveLength(0);
		expect(new IrcContinuationOutbox(reopened).unfinished()).toEqual([]);
		await recovered.instance.replayIrcContinuations();
		expect(
			parent.store
				.getEntries()
				.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation"),
		).toHaveLength(2);
	});

	it.each([
		{
			name: "a phase without a native yield",
			response: { content: ["Stopped without yielding"], stopReason: "stop" } as MockResponse,
			source: "harness",
		},
		{
			name: "an agent's explicit refusal",
			response: {
				content: [
					{
						type: "toolCall",
						id: "declined",
						name: "yield",
						arguments: { result: { error: "Declined within the safety boundary" } },
					},
				],
				stopReason: "toolUse",
			} as MockResponse,
			source: "agent",
		},
	])("keeps the real source for $name, without inventing a human stop", async ({ response, source }) => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Result received"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("A"), response]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});
		await child.instance.prompt("Phase A", { attribution: "agent" });
		await child.instance.deliverIrcMessage({
			id: "bounded-resume",
			from: "owner",
			to: "worker",
			body: "Complete the safe phase only.",
			ts: Date.now(),
		});
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		const completion = parent.store
			.getEntries()
			.find(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		if (completion?.type !== "custom_message") throw new Error("Expected native phase completion");
		expect(completion.details).toMatchObject({ resultSource: source });
		expect(completion.content).toContain(`"source":"${source}"`);
		expect(child.instance.agent.state.systemPrompt).toEqual(["Operator: production writes are forbidden."]);
	});

	it("does not create a turn or completion when replaying an already delivered parent message missing a continuation phase", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Received newer"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("newer-result")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		const oldRecord = {
			role: "custom" as const,
			customType: "irc:incoming",
			content: "Already delivered old instruction",
			display: true,
			timestamp: 1000,
			attribution: "agent" as const,
			details: { id: "old", from: "owner", source: "agent", relation: "parent" },
		};
		child.store.appendCustomMessageEntry(
			oldRecord.customType,
			oldRecord.content,
			oldRecord.display,
			oldRecord.details,
			oldRecord.attribution,
		);
		child.instance.agent.state.messages.push(oldRecord);
		await child.store.ensureOnDisk();
		await child.store.sync();

		await child.instance.deliverIrcMessage({
			id: "newer",
			from: "owner",
			to: "worker",
			body: "Execute newer instruction",
			ts: 2000,
		});
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();

		await child.store.ensureOnDisk();
		await child.store.sync();
		await child.instance.dispose();
		const reopened = await SessionManager.open(child.store.getSessionFile()!);
		const recovered = await session("worker", [], reopened);
		registry.attachSession("worker", recovered.instance, reopened.getSessionFile()!);

		await recovered.instance.deliverIrcMessage({
			id: "old",
			from: "owner",
			to: "worker",
			body: "Replayed old instruction",
			ts: 1000,
		});
		await recovered.instance.waitForIdle();
		await parent.instance.waitForIdle();
		await recovered.instance.replayIrcContinuations();
		await recovered.instance.waitForIdle();
		await parent.instance.waitForIdle();

		expect(child.mock.calls).toHaveLength(1);
		expect(recovered.mock.calls).toHaveLength(0);
		const completions = parent.store
			.getEntries()
			.flatMap(entry =>
				entry.type === "custom_message" && entry.customType === "task:continuation" ? [entry] : [],
			);
		expect(completions).toHaveLength(1);
		expect(Reflect.get(completions[0]!.details ?? {}, "phaseId")).toBe("newer");
		expect(completions[0]!.content).toContain('"value":"newer-result"');
	});

	it("executes out-of-order parent messages and marks late record with arrived-after metadata", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Handled both"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("newer-result"), yielded("late-result")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		await child.instance.deliverIrcMessage({
			id: "newer-message",
			from: "owner",
			to: "worker",
			body: "Execute newer instruction",
			ts: 2000,
		});
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();

		await child.instance.deliverIrcMessage({
			id: "late-message",
			from: "owner",
			to: "worker",
			body: "Execute older instruction",
			ts: 1000,
		});
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();

		expect(child.mock.calls).toHaveLength(2);
		const completions = parent.store
			.getEntries()
			.flatMap(entry =>
				entry.type === "custom_message" && entry.customType === "task:continuation" ? [entry] : [],
			);
		expect(completions).toHaveLength(2);
		expect(completions.map(entry => Reflect.get(entry.details ?? {}, "phaseId"))).toEqual([
			"newer-message",
			"late-message",
		]);

		const lateRecord = child.instance.agent.state.messages.find(
			m =>
				m.role === "custom" &&
				(Reflect.get(m.details ?? {}, "phaseId") === "late-message" ||
					Reflect.get(m.details ?? {}, "id") === "late-message"),
		);
		expect(lateRecord).toBeDefined();
		if (lateRecord?.role !== "custom") throw new Error("Expected late input");
		expect(lateRecord!.content).toContain("arrived after newer newer-message from same sender");
		expect(lateRecord!.details).toMatchObject({
			sentAt: 1000,
			phaseId: "late-message",
			arrivedAfter: "newer-message",
		});
	});

	it("does not apply late marker when out-of-order timestamps come from different senders", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Result received"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("owner-result"), yielded("peer-result")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: null,
		});
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		await child.instance.deliverIrcMessage({
			id: "owner-msg-1",
			from: "owner",
			to: "worker",
			body: "Instruction from owner",
			ts: 2000,
		});
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();

		await child.instance.deliverIrcMessage({
			id: "peer-msg-2",
			from: "peer",
			to: "worker",
			body: "Note from peer",
			ts: 1000,
		});
		await child.instance.waitForIdle();

		const peerRecord = child.instance.agent.state.messages.find(
			m =>
				m.role === "custom" &&
				(Reflect.get(m.details ?? {}, "id") === "peer-msg-2" ||
					Reflect.get(m.details ?? {}, "phaseId") === "peer-msg-2"),
		);
		expect(peerRecord).toBeDefined();
		if (peerRecord?.role !== "custom") throw new Error("Expected peer input");
		expect(peerRecord!.content).not.toContain("arrived after newer");
		expect(Reflect.get(peerRecord!.details ?? {}, "arrivedAfter")).toBeUndefined();
	});
	it("claims a durable phase before streaming steer and recovers unconsumed steer without duplicate execution", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Handled B"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		child.instance.agent.state.isStreaming = true;
		const heldSteers: unknown[] = [];
		spyOn(child.instance.agent, "steer").mockImplementation((record: unknown) => {
			heldSteers.push(record);
		});

		const resume = {
			id: "streaming-resume-1",
			from: "owner",
			to: "worker",
			body: "Phase two streaming instruction",
			ts: 1700000001000,
		};

		await Promise.all([child.instance.deliverIrcMessage(resume), child.instance.deliverIrcMessage(resume)]);

		expect(heldSteers).toHaveLength(1);
		const outbox = new IrcContinuationOutbox(child.store);
		expect(outbox.hasPhase("streaming-resume-1")).toBe(true);

		const phaseEntry = child.store
			.getEntries()
			.find(
				entry =>
					entry.type === "custom" &&
					entry.customType === "irc:continuation-phase" &&
					Reflect.get(entry.data ?? {}, "phaseId") === "streaming-resume-1",
			);
		expect(phaseEntry).toBeDefined();
		if (phaseEntry?.type !== "custom") throw new Error("Expected custom phase entry");
		const phaseData = phaseEntry.data;
		const record = phaseData ? Reflect.get(phaseData, "record") : undefined;
		expect(record).toBeDefined();
		const details = record ? Reflect.get(record, "details") : undefined;
		expect(details ? Reflect.get(details, "streamingSteer") : undefined).toBe(true);

		await child.instance.dispose();
		const reopened = await SessionManager.open(child.store.getSessionFile()!);
		const recovered = await session("worker", [yielded("B")], reopened);
		registry.attachSession("worker", recovered.instance, reopened.getSessionFile()!);

		await recovered.instance.replayIrcContinuations();
		await recovered.instance.waitForIdle();
		await parent.instance.waitForIdle();

		expect(recovered.mock.calls).toHaveLength(1);
		await recovered.instance.deliverIrcMessage(resume);
		await recovered.instance.waitForIdle();
		expect(recovered.mock.calls).toHaveLength(1);

		const completions = parent.store
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completions).toHaveLength(1);
		const firstCompletion = completions[0];
		if (firstCompletion?.type !== "custom_message") throw new Error("Expected completion entry");
		expect(Reflect.get(firstCompletion.details ?? {}, "phaseId")).toBe("streaming-resume-1");
	});

	it("ignores streamingSteer phase claim during replay when matching custom_message receipt exists", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Parent ack"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		const outbox = new IrcContinuationOutbox(child.store);
		const phaseId = "stream-consumed-phase";
		const record = {
			role: "custom" as const,
			customType: "irc:incoming" as const,
			content: "Steered content",
			display: true,
			timestamp: Date.now(),
			attribution: "agent" as const,
			details: { id: phaseId, from: "owner", source: "agent", streamingSteer: true },
		};
		outbox.begin(phaseId, record);

		child.store.appendCustomMessageEntry(
			"irc:incoming",
			"Steered content",
			true,
			{ id: phaseId, from: "owner", source: "agent", streamingSteer: true },
			"agent",
		);
		await child.store.ensureOnDisk();
		await child.store.sync();

		const unfinished = outbox.unfinished();
		expect(unfinished.map(m => Reflect.get(m.details ?? {}, "id"))).not.toContain(phaseId);

		await child.instance.replayIrcContinuations();
		await child.instance.waitForIdle();
		expect(child.mock.calls).toHaveLength(0);
	});

	it("pins continuation delivery target to initial parent and avoids reassigning to root after crash", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const root = await session("root", [{ content: ["Root response"], stopReason: "stop" }]);
		const parent = await session("parent", [{ content: ["Parent received"], stopReason: "stop" }]);
		const child = await session("child", [yielded("child-completion")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "root", displayName: "Root", kind: "main", scope: "tree", session: root.instance });
		registry.register({
			id: "parent",
			displayName: "Parent",
			kind: "sub",
			parentId: "root",
			scope: "tree",
			session: parent.instance,
		});
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "parent",
			scope: "tree",
			session: child.instance,
		});

		const outbox = new IrcContinuationOutbox(child.store);
		const completion = await outbox.complete(
			"child",
			"parent",
			"p2-phase-1",
			JSON.stringify({ value: "child-completion" }),
		);

		const originalAppend = child.store.appendCustomEntry.bind(child.store);
		const appendSpy = spyOn(child.store, "appendCustomEntry").mockImplementation((type: string, data: unknown) => {
			if (type === "irc:continuation-delivered") {
				throw new Error("Simulated disk error while recording delivery ack");
			}
			return originalAppend(type, data);
		});

		await expect(child.instance.replayIrcContinuations()).rejects.toThrow("Simulated disk error");

		const reopenedParent = await SessionManager.open(parent.store.getSessionFile()!);
		const parentCompletions = reopenedParent
			.getEntries()
			.filter(e => e.type === "custom_message" && e.customType === "task:continuation");
		expect(parentCompletions).toHaveLength(1);

		appendSpy.mockRestore();

		await child.instance.dispose();
		const reopened = await SessionManager.open(child.store.getSessionFile()!);
		const recoveredChild = await session("child", [], reopened);
		registry.attachSession("child", recoveredChild.instance, reopened.getSessionFile()!);

		const parentEntry = registry.get("parent");
		if (parentEntry) parentEntry.status = "aborted";

		await recoveredChild.instance.replayIrcContinuations();
		await root.instance.waitForIdle();

		const rootCompletionsFromChild = root.store
			.getEntries()
			.filter(
				e =>
					e.type === "custom_message" &&
					e.customType === "task:continuation" &&
					(Reflect.get(e.details ?? {}, "from") === "child" ||
						Reflect.get(e.details ?? {}, "completionId") === completion.id),
			);
		expect(rootCompletionsFromChild).toHaveLength(0);

		const reopenedOutbox = new IrcContinuationOutbox(recoveredChild.store);
		expect(reopenedOutbox.deliveryTarget(completion.id)).toBe("parent");
		expect(reopenedOutbox.pending().some(item => item.id === completion.id)).toBe(true);
	});
	it("does not let a concurrent outbox deliver or resolve an in-memory completion before sync", async () => {
		const child = await session("worker", []);
		await child.store.ensureOnDisk();
		await child.store.sync();
		const first = new IrcContinuationOutbox(child.store);
		const second = new IrcContinuationOutbox(child.store);
		const syncStarted = Promise.withResolvers<void>();
		const syncGate = Promise.withResolvers<void>();
		const originalSync = child.store.sync.bind(child.store);
		let gated = false;
		spyOn(child.store, "sync").mockImplementation(async () => {
			if (gated) {
				syncStarted.resolve();
				await syncGate.promise;
			}
			return originalSync();
		});

		let delivered = false;
		let firstSettled = false;
		let secondSettled = false;
		gated = true;
		try {
			const firstComplete = first.complete("worker", "owner", "shared-phase", '{"value":"done"}').then(result => {
				firstSettled = true;
				return result;
			});
			await syncStarted.promise;
			expect(first.pending()).toHaveLength(1);
			expect(second.pending()).toHaveLength(1);
			expect(second.pending()[0]?.output).toBe('{"value":"done"}');
			const secondComplete = second.complete("worker", "owner", "shared-phase", '{"value":"done"}').then(result => {
				secondSettled = true;
				return result;
			});
			const flush = second.flush(async () => {
				delivered = true;
				return true;
			});
			await setImmediate();
			const deliveredBeforeSync = delivered;
			const firstSettledBeforeSync = firstSettled;
			const secondSettledBeforeSync = secondSettled;
			syncGate.resolve();
			const [firstResult, secondResult] = await Promise.all([firstComplete, secondComplete]);
			await flush;
			expect(deliveredBeforeSync).toBe(false);
			expect(firstSettledBeforeSync).toBe(false);
			expect(secondSettledBeforeSync).toBe(false);
			expect(firstResult.id).toBe(secondResult.id);
			expect(delivered).toBe(true);
		} finally {
			syncGate.resolve();
		}
		await child.instance.dispose();
	});

	it("does not deliver or acknowledge an in-memory completion when every concurrent sync fails", async () => {
		const child = await session("worker", []);
		await child.store.ensureOnDisk();
		await child.store.sync();
		const outbox = new IrcContinuationOutbox(child.store);
		const syncStarted = Promise.withResolvers<void>();
		const syncGate = Promise.withResolvers<void>();
		const originalSync = child.store.sync.bind(child.store);
		let failSyncs = true;
		spyOn(child.store, "sync").mockImplementation(async () => {
			if (failSyncs) {
				syncStarted.resolve();
				await syncGate.promise;
				throw new Error("simulated completion sync failure");
			}
			await originalSync();
		});
		let delivered = false;
		let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
		try {
			const completing = outbox.complete("worker", "owner", "failed-sync-phase", '{"value":"done"}');
			await syncStarted.promise;
			expect(outbox.pending()).toHaveLength(1);
			const flushing = outbox.flush(async () => {
				delivered = true;
				return true;
			});
			settled = Promise.allSettled([completing, flushing]);
			await setImmediate();
			const deliveredBeforeFailure = delivered;
			syncGate.resolve();
			const outcomes = await settled;
			expect(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
			expect(deliveredBeforeFailure).toBe(false);
			expect(delivered).toBe(false);
			expect(
				child.store
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === "irc:continuation-delivered"),
			).toHaveLength(0);
			expect(outbox.pending()).toHaveLength(1);
		} finally {
			failSyncs = false;
			syncGate.resolve();
			await settled;
		}
		await originalSync();
	});

	for (const timing of ["before replay", "after result barrier"] as const) {
		it(`replay waits for an uncommitted sticky target ${timing}`, async () => {
			const parent = await session("owner", [{ content: ["Parent received"], stopReason: "stop" }]);
			const child = await session("worker", []);
			const registry = AgentRegistry.global();
			registry.register({
				id: "owner",
				displayName: "Owner",
				kind: "main",
				scope: "tree",
				session: parent.instance,
			});
			registry.register({
				id: "worker",
				displayName: "Worker",
				kind: "sub",
				parentId: "owner",
				scope: "tree",
				session: child.instance,
			});
			const outbox = new IrcContinuationOutbox(child.store);
			const phaseId = `sticky-target-${timing}`;
			outbox.begin(phaseId);
			const completion = await outbox.complete("worker", "owner", phaseId, '{"value":"result"}');
			const pinStarted = Promise.withResolvers<void>();
			const pinGate = Promise.withResolvers<void>();
			const originalSync = child.store.sync.bind(child.store);
			let injectAfterBarrier = timing === "after result barrier";
			let claim: Promise<string> | undefined;
			let replay: Promise<void> | undefined;
			let released = false;
			let sentBeforePinCommit = false;
			spyOn(child.store, "sync").mockImplementation(async () => {
				if (injectAfterBarrier) {
					injectAfterBarrier = false;
					expect(outbox.deliveryTarget(completion.id)).toBeUndefined();
					await originalSync();
					claim = outbox.claimDeliveryTarget(completion.id, "owner");
					return;
				}
				if (outbox.deliveryTarget(completion.id)) {
					pinStarted.resolve();
					await pinGate.promise;
				}
				await originalSync();
			});
			const bus = IrcBus.global();
			const originalSend = bus.send.bind(bus);
			spyOn(bus, "send").mockImplementation(async (input, options) => {
				if (input.from === "worker" && options?.completion?.id === completion.id) {
					sentBeforePinCommit ||= !released;
				}
				return originalSend(input, options);
			});
			try {
				if (timing === "before replay") {
					claim = outbox.claimDeliveryTarget(completion.id, "owner");
					await pinStarted.promise;
				}
				replay = child.instance.replayIrcContinuations();
				await pinStarted.promise;
				await setImmediate();
				const prematureSend = sentBeforePinCommit;
				released = true;
				pinGate.resolve();
				await replay;
				await claim;
				await parent.instance.waitForIdle();
				expect(prematureSend).toBe(false);
				expect(
					parent.store
						.getEntries()
						.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation"),
				).toHaveLength(1);
				const file = child.store.getSessionFile()!;
				await child.instance.dispose();
				const reopened = await SessionManager.open(file);
				const recovered = await session("worker", [], reopened);
				expect(new IrcContinuationOutbox(reopened).deliveryTarget(completion.id)).toBe("owner");
				await recovered.instance.replayIrcContinuations();
				await parent.instance.waitForIdle();
				expect(
					parent.store
						.getEntries()
						.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation"),
				).toHaveLength(1);
			} finally {
				released = true;
				pinGate.resolve();
				await Promise.allSettled(
					[claim, replay].filter((pending): pending is Promise<string> | Promise<void> => pending !== undefined),
				);
			}
		});
	}

	it("queues a real parent bus send behind a busy child journal without an early receipt or model turn", async () => {
		const parent = await session("owner", [{ content: ["Received"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("BUS-B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "tree", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "tree",
			session: child.instance,
		});
		await child.store.ensureOnDisk();
		await child.store.sync();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const lock = withJournalLock(child.store.getSessionFile()!, async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const rewrite = child.store.rewriteEntries();
		await setImmediate();
		let receiptSettled = false;
		const sending = IrcBus.global()
			.send({ from: "owner", to: "worker", body: "Return BUS-B after the journal commits." })
			.then(receipt => {
				receiptSettled = true;
				return receipt;
			});
		try {
			await setImmediate();
			const earlyReceipt = receiptSettled;
			const earlyTurns = child.mock.calls.length;
			release.resolve();
			await lock;
			await rewrite;
			const receipt = await sending;
			await child.instance.waitForIdle();
			await parent.instance.waitForIdle();
			expect(receipt.error).toBeUndefined();
			expect(earlyReceipt).toBe(false);
			expect(earlyTurns).toBe(0);
			expect(receipt.outcome).not.toBe("failed");
			expect(child.mock.calls).toHaveLength(1);
			expect(
				child.store
					.getEntries()
					.filter(entry => entry.type === "custom_message" && entry.customType === "irc:incoming"),
			).toHaveLength(1);
		} finally {
			release.resolve();
			await lock;
			await Promise.allSettled([rewrite, sending]);
		}
	});

	it("does not annotate arrivedAfter in withOrdering when newer entry is from a different sender", async () => {
		const temp = TempDir.createSync("ordering-sender-isolation-");
		const store = SessionManager.create(temp.path(), temp.path());
		resources.push({ temp });

		store.appendCustomMessageEntry(
			"irc:incoming",
			"Message from peer",
			true,
			{ from: "peer", id: "peer-newer", sentAt: 5000 },
			"agent",
		);
		await store.ensureOnDisk();
		await store.sync();

		const outbox = new IrcContinuationOutbox(store);
		const record = {
			role: "custom" as const,
			customType: "irc:incoming" as const,
			content: "Message from owner",
			display: true,
			timestamp: 1000,
			attribution: "agent" as const,
			details: { from: "owner", id: "owner-older", sentAt: 1000 },
		};

		const ordered = outbox.withOrdering(record);
		expect(ordered.content).not.toContain("arrived after newer");
		expect(Reflect.get(ordered.details ?? {}, "arrivedAfter")).toBeUndefined();
	});

	it("steers a live streaming retained child immediately on parent IRC during an active wake phase", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Handled"], stopReason: "stop" }]);
		const child = await session("worker", [{ content: ["First turn done"], stopReason: "stop" }, yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const originalStreamFn = child.instance.agent.streamFn;
		let callIndex = 0;
		child.instance.agent.streamFn = async (model, context, options) => {
			if (callIndex++ === 0) {
				started.resolve();
				await gate.promise;
			}
			return originalStreamFn(model, context, options);
		};

		const phase1Promise = child.instance.deliverIrcMessage({
			id: "phase-active-1",
			from: "owner",
			to: "worker",
			body: "First wake instruction",
			ts: 1700000001000,
		});
		await started.promise;
		expect(child.instance.agent.state.isStreaming).toBe(true);

		const delivery = await child.instance.deliverIrcMessage({
			id: "steer-during-active-phase",
			from: "owner",
			to: "worker",
			body: "2 GiB installer approved",
			ts: 1700000002000,
		});
		expect(delivery).toBe("injected");

		gate.resolve();
		await phase1Promise;
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();

		// The steered parent message arrived in the second turn of the SAME active wake phase.
		expect(child.mock.calls).toHaveLength(2);
		const secondTurnMessages = child.mock.calls[1]?.context.messages ?? [];
		expect(
			secondTurnMessages.some(message => JSON.stringify(message.content).includes("2 GiB installer approved")),
		).toBe(true);

		const completions = parent.store
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completions).toHaveLength(1);
		const completion = completions[0];
		if (completion?.type !== "custom_message") throw new Error("Expected native completion");
		expect(completion.content).toContain('"value":"B"');
	});

	it("queues parent IRC once in outbox when agent loop already ended during wake settlement", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [
			{ content: ["Handled A"], stopReason: "stop" },
			{ content: ["Handled B"], stopReason: "stop" },
		]);
		const child = await session("worker", [yielded("A"), yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		const settlingStarted = Promise.withResolvers<void>();
		const settlingGate = Promise.withResolvers<void>();
		const originalParentDeliver = parent.instance.deliverIrcMessage.bind(parent.instance);
		let parentDeliverCount = 0;
		spyOn(parent.instance, "deliverIrcMessage").mockImplementation(async msg => {
			if (parentDeliverCount++ === 0) {
				settlingStarted.resolve();
				await settlingGate.promise;
			}
			return originalParentDeliver(msg);
		});

		const phase1Promise = child.instance.deliverIrcMessage({
			id: "phase-settle-1",
			from: "owner",
			to: "worker",
			body: "Initial wake",
			ts: 1700000003000,
		});
		await settlingStarted.promise;
		// Agent loop finished, while wake publication/settlement is still in flight.
		expect(child.instance.agent.state.isStreaming).toBe(false);
		expect(child.instance.isStreaming).toBe(true);

		const delivery = await child.instance.deliverIrcMessage({
			id: "after-provider-settlement",
			from: "owner",
			to: "worker",
			body: "Follow-up after provider finished",
			ts: 1700000004000,
		});
		expect(delivery).toBe("injected");

		settlingGate.resolve();
		await phase1Promise;
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		const followUpCalls = child.mock.calls.filter(call =>
			call.context.messages.some(message =>
				JSON.stringify(message.content).includes("Follow-up after provider finished"),
			),
		);
		expect(followUpCalls).toHaveLength(1);
	});

	it("replays parent IRC queued during normal-prompt post-loop recovery once after in-flight ends", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Handled"], stopReason: "stop" }]);
		const child = await session("worker", [{ content: ["Normal prompt done"], stopReason: "stop" }, yielded("C")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		const providerStarted = Promise.withResolvers<void>();
		const providerGate = Promise.withResolvers<void>();
		const originalStreamFn = child.instance.agent.streamFn;
		let callIndex = 0;
		child.instance.agent.streamFn = async (model, context, options) => {
			if (callIndex++ === 0) {
				providerStarted.resolve();
				await providerGate.promise;
			}
			return originalStreamFn(model, context, options);
		};

		const syncStarted = Promise.withResolvers<void>();
		const syncGate = Promise.withResolvers<void>();
		const originalSync = child.store.sync.bind(child.store);
		let interceptNextSync = false;
		spyOn(child.store, "sync").mockImplementation(async () => {
			if (interceptNextSync) {
				interceptNextSync = false;
				syncStarted.resolve();
				await syncGate.promise;
			}
			return originalSync();
		});

		const normalPrompt = child.instance.prompt("Normal user work");
		await providerStarted.promise;
		expect(child.instance.agent.state.isStreaming).toBe(true);

		interceptNextSync = true;
		const deliverPromise = child.instance.deliverIrcMessage({
			id: "parent-during-normal-prompt",
			from: "owner",
			to: "worker",
			body: "Follow up after normal prompt",
			ts: 1700000005000,
		});
		await syncStarted.promise;

		// Finish the core agent loop while sync is still held, before releasing sync.
		providerGate.resolve();
		for (let i = 0; i < 50 && child.instance.agent.state.isStreaming; i++) {
			await setImmediate();
		}
		expect(child.instance.agent.state.isStreaming).toBe(false);

		syncGate.resolve();
		await deliverPromise;
		await normalPrompt;
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();

		const followUpCalls = child.mock.calls.filter(call =>
			call.context.messages.some(message =>
				JSON.stringify(message.content).includes("Follow up after normal prompt"),
			),
		);
		expect(followUpCalls).toHaveLength(1);
		const completions = parent.store
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completions).toHaveLength(1);
	});

	it("queues non-parent peer IRC during wake settlement instead of starting an overlapping wake", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Handled A"], stopReason: "stop" }]);
		const child = await session("worker", [yielded("A"), { content: ["Peer reply"], stopReason: "stop" }]);
		const peer = await session("peer", [{ content: ["Peer idle"], stopReason: "stop" }]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});
		registry.register({
			id: "peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: peer.instance,
		});

		const settlingStarted = Promise.withResolvers<void>();
		const settlingGate = Promise.withResolvers<void>();
		const originalParentDeliver = parent.instance.deliverIrcMessage.bind(parent.instance);
		let parentDeliverCount = 0;
		spyOn(parent.instance, "deliverIrcMessage").mockImplementation(async msg => {
			if (parentDeliverCount++ === 0) {
				settlingStarted.resolve();
				await settlingGate.promise;
			}
			return originalParentDeliver(msg);
		});

		const phase1Promise = child.instance.deliverIrcMessage({
			id: "phase-peer-settle-1",
			from: "owner",
			to: "worker",
			body: "Initial wake",
			ts: 1700000006000,
		});
		await settlingStarted.promise;

		let idleResolved = false;
		const idlePromise = child.instance.waitForIdle().then(() => {
			idleResolved = true;
		});
		const peerDelivery = await child.instance.deliverIrcMessage({
			id: "peer-during-settlement",
			from: "peer",
			to: "worker",
			body: "Sibling question during publish",
			ts: 1700000007000,
		});
		expect(peerDelivery).toBe("injected");
		await Promise.resolve();
		await Promise.resolve();
		expect(child.mock.calls).toHaveLength(1);
		expect(idleResolved).toBe(false);

		settlingGate.resolve();
		await phase1Promise;
		await idlePromise;
		await parent.instance.waitForIdle();
		expect(idleResolved).toBe(true);
		// Verify the queued peer message was actually delivered after settlement, not discarded.
		const peerCalls = child.mock.calls.filter(call =>
			call.context.messages.some(message =>
				JSON.stringify(message.content).includes("Sibling question during publish"),
			),
		);
		expect(peerCalls).toHaveLength(1);
	});

	it("replays pending parent outbox before stranded peer interrupt when normal prompt settles", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Handled"], stopReason: "stop" }]);
		const child = await session("worker", [
			{ content: ["Normal prompt done"], stopReason: "stop" },
			yielded("B"),
			{ content: ["Peer handled"], stopReason: "stop" },
		]);
		const peer = await session("peer", [{ content: ["Peer idle"], stopReason: "stop" }]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});
		registry.register({
			id: "peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: peer.instance,
		});

		const providerStarted = Promise.withResolvers<void>();
		const providerGate = Promise.withResolvers<void>();
		const originalStreamFn = child.instance.agent.streamFn;
		let callIndex = 0;
		child.instance.agent.streamFn = async (model, context, options) => {
			if (callIndex++ === 0) {
				providerStarted.resolve();
				await providerGate.promise;
			}
			return originalStreamFn(model, context, options);
		};

		const syncStarted = Promise.withResolvers<void>();
		const syncGate = Promise.withResolvers<void>();
		const originalSync = child.store.sync.bind(child.store);
		let interceptNextSync = false;
		spyOn(child.store, "sync").mockImplementation(async () => {
			if (interceptNextSync) {
				interceptNextSync = false;
				syncStarted.resolve();
				await syncGate.promise;
			}
			return originalSync();
		});

		const normalPrompt = child.instance.prompt("Normal prompt");
		await providerStarted.promise;
		interceptNextSync = true;
		const parentDeliver = child.instance.deliverIrcMessage({
			id: "parent-before-peer",
			from: "owner",
			to: "worker",
			body: "Parent continuation B",
			ts: 1700000008000,
		});
		await syncStarted.promise;

		providerGate.resolve();
		for (let i = 0; i < 50 && child.instance.agent.state.isStreaming; i++) {
			await setImmediate();
		}
		expect(child.instance.agent.state.isStreaming).toBe(false);

		// Queue peer C while parent B is still in the outbox and the normal prompt is settling.
		await child.instance.deliverIrcMessage({
			id: "peer-while-b-pending",
			from: "peer",
			to: "worker",
			body: "Peer message C",
			ts: 1700000009000,
		});

		syncGate.resolve();
		await parentDeliver;
		await normalPrompt;
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();

		const lastContextMessages = child.mock.calls.at(-1)?.context.messages ?? [];
		const bMessages = lastContextMessages.filter(message =>
			JSON.stringify(message.content).includes("Parent continuation B"),
		);
		expect(bMessages).toHaveLength(1);
		const completions = parent.store
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completions).toHaveLength(1);
		const cCalls = child.mock.calls.filter(call =>
			call.context.messages.some(message => JSON.stringify(message.content).includes("Peer message C")),
		);
		expect(cCalls).toHaveLength(1);
	});

	it("bounds outbox replay to one attempt when artifact publication fails persistently", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [{ content: ["Handled"], stopReason: "stop" }]);
		const child = await session("worker", [
			{ content: ["Normal prompt done"], stopReason: "stop" },
			yielded("B"),
			yielded("B-recovered"),
		]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		const providerStarted = Promise.withResolvers<void>();
		const providerGate = Promise.withResolvers<void>();
		const originalStreamFn = child.instance.agent.streamFn;
		let callIndex = 0;
		child.instance.agent.streamFn = async (model, context, options) => {
			if (callIndex++ === 0) {
				providerStarted.resolve();
				await providerGate.promise;
			}
			return originalStreamFn(model, context, options);
		};

		const syncStarted = Promise.withResolvers<void>();
		const syncGate = Promise.withResolvers<void>();
		const originalSync = child.store.sync.bind(child.store);
		let interceptNextSync = false;
		spyOn(child.store, "sync").mockImplementation(async () => {
			if (interceptNextSync) {
				interceptNextSync = false;
				syncStarted.resolve();
				await syncGate.promise;
			}
			return originalSync();
		});

		const normalPrompt = child.instance.prompt("Normal prompt");
		await providerStarted.promise;
		interceptNextSync = true;
		const parentDeliver = child.instance.deliverIrcMessage({
			id: "parent-persist-fail",
			from: "owner",
			to: "worker",
			body: "Parent phase B",
			ts: 1700000010000,
		});
		await syncStarted.promise;

		providerGate.resolve();
		for (let i = 0; i < 50 && child.instance.agent.state.isStreaming; i++) {
			await setImmediate();
		}

		// Fault-inject persistent artifact open failure during completion.
		let failWrites = true;
		const origOpen = fs.open.bind(fs);
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			if (failWrites && String(file).includes(".phase-")) {
				throw new Error("ENOSPC: disk full");
			}
			return origOpen(file, flags, mode);
		});
		try {
			syncGate.resolve();
			await parentDeliver;
			await normalPrompt;
			await child.instance.waitForIdle();
			// Exactly 1 normal turn + 1 bounded replay attempt (no unbounded retry loop).
			expect(child.mock.calls).toHaveLength(2);

			// Once storage recovers, an explicit replay publishes the already-computed terminal yield to parent without re-running the LLM.
			failWrites = false;
			await child.instance.replayIrcContinuations();
			await child.instance.waitForIdle();
			await parent.instance.waitForIdle();
			expect(child.mock.calls).toHaveLength(2);
			expect(
				child.store
					.getEntries()
					.some(entry => entry.type === "custom" && entry.customType === "irc:continuation-result"),
			).toBe(true);
		} finally {
			openSpy.mockRestore();
		}
	});

	it("drains stranded peer IRC into context in plan mode even when parent outbox cannot wake", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [
			{ content: ["Handled"], stopReason: "stop" },
			{ content: ["Handled plan parent"], stopReason: "stop" },
		]);
		const child = await session("worker", [
			{ content: ["Normal prompt done"], stopReason: "stop" },
			{ content: ["Plan nudge done"], stopReason: "stop" },
			yielded("Plan parent done"),
		]);
		const peer = await session("peer", [{ content: ["Peer idle"], stopReason: "stop" }]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});
		registry.register({
			id: "peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: peer.instance,
		});

		const outbox = new IrcContinuationOutbox(child.store);
		outbox.begin("seed-plan-parent", {
			role: "custom",
			customType: "irc:incoming",
			content: "Parent blocked by plan mode",
			display: true,
			timestamp: 1700000011000,
			attribution: "agent",
			details: {
				id: "seed-plan-parent",
				from: "owner",
				source: "agent",
				relation: "parent",
				sentAt: 1700000011000,
			},
		});
		expect(outbox.unfinished()).toHaveLength(1);

		const providerStarted = Promise.withResolvers<void>();
		const providerGate = Promise.withResolvers<void>();
		const originalStreamFn = child.instance.agent.streamFn;
		let callIndex = 0;
		child.instance.agent.streamFn = async (model, context, options) => {
			if (callIndex++ === 0) {
				providerStarted.resolve();
				await providerGate.promise;
			}
			return originalStreamFn(model, context, options);
		};

		const normalPrompt = child.instance.prompt("Normal prompt");
		await providerStarted.promise;
		child.instance.setPlanModeState({ enabled: true, planFilePath: "plan.md" });
		await child.instance.deliverIrcMessage({
			id: "peer-in-plan-mode",
			from: "peer",
			to: "worker",
			body: "Peer message in plan mode",
			ts: 1700000012000,
		});
		providerGate.resolve();
		await normalPrompt;
		await child.instance.waitForIdle();

		expect(
			child.mock.calls.some(call => JSON.stringify(call.context.messages).includes("Parent blocked by plan mode")),
		).toBe(false);
		expect(child.mock.calls).toHaveLength(2);
		expect(
			child.instance.agent.state.messages.some(message =>
				JSON.stringify(message).includes("Peer message in plan mode"),
			),
		).toBe(true);

		// Disabling plan mode replays the deferred parent phase without consuming its attempt budget while gated.
		child.instance.setPlanModeState(undefined);
		await child.instance.waitForIdle();
		await parent.instance.waitForIdle();
		const parentDeliveries = child.mock.calls.filter(call =>
			call.context.messages.some(message => JSON.stringify(message.content).includes("Parent blocked by plan mode")),
		);
		expect(parentDeliveries).toHaveLength(1);
		const completions = parent.store
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
		expect(completions).toHaveLength(1);
		expect(completions[0]?.type === "custom_message" ? completions[0].content : "").toContain("Plan parent done");
	});

	it("keeps waitForIdle pending while outbox replay awaits receiver ack before waking next phase", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [
			{ content: ["Handled A"], stopReason: "stop" },
			{ content: ["Handled B"], stopReason: "stop" },
		]);
		const child = await session("worker", [{ content: ["Normal prompt done"], stopReason: "stop" }, yielded("B")]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		// Seed an undelivered result in outbox so replayIrcContinuations awaits flush before waking B.
		const outbox = new IrcContinuationOutbox(child.store);
		outbox.begin("seed-phase", {
			role: "custom",
			customType: "irc:incoming",
			content: "seed",
			display: true,
			timestamp: 1700000000000,
			attribution: "agent",
			details: { id: "seed-phase", from: "owner", source: "agent", relation: "parent", sentAt: 1700000000000 },
		});
		await outbox.complete("worker", "owner", "seed-phase", '{"value":"A"}');

		const flushStarted = Promise.withResolvers<void>();
		const flushGate = Promise.withResolvers<void>();
		const originalParentDeliver = parent.instance.deliverIrcMessage.bind(parent.instance);
		let blockedOnce = false;
		spyOn(parent.instance, "deliverIrcMessage").mockImplementation(async msg => {
			if (!blockedOnce) {
				blockedOnce = true;
				flushStarted.resolve();
				await flushGate.promise;
			}
			return originalParentDeliver(msg);
		});

		const providerStarted = Promise.withResolvers<void>();
		const providerGate = Promise.withResolvers<void>();
		const originalStreamFn = child.instance.agent.streamFn;
		let callIndex = 0;
		child.instance.agent.streamFn = async (model, context, options) => {
			if (callIndex++ === 0) {
				providerStarted.resolve();
				await providerGate.promise;
			}
			return originalStreamFn(model, context, options);
		};

		const syncStarted = Promise.withResolvers<void>();
		const syncGate = Promise.withResolvers<void>();
		const originalSync = child.store.sync.bind(child.store);
		let interceptNextSync = false;
		spyOn(child.store, "sync").mockImplementation(async () => {
			if (interceptNextSync) {
				interceptNextSync = false;
				syncStarted.resolve();
				await syncGate.promise;
			}
			return originalSync();
		});

		const normalPrompt = child.instance.prompt("Normal prompt");
		await providerStarted.promise;
		interceptNextSync = true;
		const parentDeliver = child.instance.deliverIrcMessage({
			id: "parent-after-flush",
			from: "owner",
			to: "worker",
			body: "Parent B after flush",
			ts: 1700000013000,
		});
		await syncStarted.promise;
		providerGate.resolve();
		for (let i = 0; i < 50 && child.instance.agent.state.isStreaming; i++) {
			await setImmediate();
		}
		syncGate.resolve();
		await flushStarted.promise;
		let idleResolved = false;
		const idlePromise = child.instance.waitForIdle().then(() => {
			idleResolved = true;
		});
		await setImmediate();
		expect(idleResolved).toBe(false);

		flushGate.resolve();
		await parentDeliver;
		await normalPrompt;
		await idlePromise;
		await parent.instance.waitForIdle();
		expect(idleResolved).toBe(true);
		expect(child.mock.calls).toHaveLength(2);
	});

	it("activates a distinct parent phase P2 automatically even after P1 failed once", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await session("owner", [
			{ content: ["Handled P1"], stopReason: "stop" },
			{ content: ["Handled P2"], stopReason: "stop" },
		]);
		const child = await session("worker", [
			{ content: ["Normal 1 done"], stopReason: "stop" },
			yielded("P1"),
			{ content: ["Normal 2 done"], stopReason: "stop" },
			yielded("P2"),
		]);
		const registry = AgentRegistry.global();
		registry.register({ id: "owner", displayName: "Owner", kind: "main", scope: "test", session: parent.instance });
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			scope: "test",
			session: child.instance,
		});

		let callIndex = 0;
		let providerStarted = Promise.withResolvers<void>();
		let providerGate = Promise.withResolvers<void>();
		const originalStreamFn = child.instance.agent.streamFn;
		child.instance.agent.streamFn = async (model, context, options) => {
			if (callIndex === 0 || callIndex === 2) {
				providerStarted.resolve();
				await providerGate.promise;
			}
			callIndex++;
			return originalStreamFn(model, context, options);
		};

		let syncStarted = Promise.withResolvers<void>();
		let syncGate = Promise.withResolvers<void>();
		const originalSync = child.store.sync.bind(child.store);
		let interceptNextSync = false;
		spyOn(child.store, "sync").mockImplementation(async () => {
			if (interceptNextSync) {
				interceptNextSync = false;
				syncStarted.resolve();
				await syncGate.promise;
			}
			return originalSync();
		});

		let failWrites = true;
		const origOpen = fs.open.bind(fs);
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			if (failWrites && String(file).includes(".phase-")) {
				throw new Error("ENOSPC: disk full");
			}
			return origOpen(file, flags, mode);
		});
		try {
			const prompt1 = child.instance.prompt("Normal 1");
			await providerStarted.promise;
			interceptNextSync = true;
			const deliverP1 = child.instance.deliverIrcMessage({
				id: "distinct-p1",
				from: "owner",
				to: "worker",
				body: "Parent phase P1",
				ts: 1700000020000,
			});
			await syncStarted.promise;
			providerGate.resolve();
			for (let i = 0; i < 50 && child.instance.agent.state.isStreaming; i++) {
				await setImmediate();
			}
			syncGate.resolve();
			await deliverP1;
			await prompt1;
			await child.instance.waitForIdle();
			expect(child.mock.calls).toHaveLength(2);

			// Storage recovers, then a second streaming prompt receives distinct phase P2.
			failWrites = false;
			providerStarted = Promise.withResolvers<void>();
			providerGate = Promise.withResolvers<void>();
			syncStarted = Promise.withResolvers<void>();
			syncGate = Promise.withResolvers<void>();
			const prompt2 = child.instance.prompt("Normal 2");
			await providerStarted.promise;
			interceptNextSync = true;
			const deliverP2 = child.instance.deliverIrcMessage({
				id: "distinct-p2",
				from: "owner",
				to: "worker",
				body: "Parent phase P2",
				ts: 1700000021000,
			});
			await syncStarted.promise;
			providerGate.resolve();
			for (let i = 0; i < 50 && child.instance.agent.state.isStreaming; i++) {
				await setImmediate();
			}
			syncGate.resolve();
			await deliverP2;
			await prompt2;
			await child.instance.waitForIdle();
			await parent.instance.waitForIdle();

			const p2Calls = child.mock.calls.filter(call =>
				call.context.messages.some(message => JSON.stringify(message.content).includes("Parent phase P2")),
			);
			expect(p2Calls).toHaveLength(1);
			const completions = parent.store
				.getEntries()
				.filter(entry => entry.type === "custom_message" && entry.customType === "task:continuation");
			const hasP2 = (content: string | readonly unknown[]): boolean =>
				(typeof content === "string" ? content : JSON.stringify(content)).includes('"value":"P2"');
			expect(completions.some(c => c.type === "custom_message" && hasP2(c.content))).toBe(true);
			expect(completions.filter(c => c.type === "custom_message" && hasP2(c.content))).toHaveLength(1);
		} finally {
			openSpy.mockRestore();
		}
	});
});
