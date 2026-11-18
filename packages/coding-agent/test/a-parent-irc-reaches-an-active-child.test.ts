/** WHY: A parent-to-child IRC send during the child's live model turn must reach the child once.
 * This drives real AgentSession instances, lineage registration and IrcBus; only the provider is scripted.
 * Gap: it proves the mock-provider turn path, not delivery through an external provider or host process.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { setTimeout as delay, setImmediate } from "node:timers/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { Message } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { withJournalLock } from "@veyyon/kernel/session/session-storage";
import { isRecord, TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { IrcBus } from "../src/task/irc-bus";

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

async function makeSession(id: string, response: MockResponse | MockResponse[], tools: AgentTool[] = []) {
	const temp = TempDir.createSync("active-child-irc-");
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	auth.setRuntimeApiKey("mock", "test-key");
	const responses = Array.isArray(response) ? response : [response];
	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
	const sessionManager = SessionManager.create(temp.path(), temp.path());
	const agent = new Agent({
		getApiKey: () => "fake-test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Read-only test session."],
			tools,
			messages: sessionManager.buildSessionContext().messages,
		},
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		agentId: id,
		sessionManager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		}),
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	resources.push({ session, auth, temp });
	return { session, mock, sessionManager };
}

function createBlockingTool(name = "block_until_released") {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name,
		label: name,
		description: "Blocks until the test releases it.",
		parameters: type({}),
		async execute() {
			started.resolve();
			await release.promise;
			return { content: [{ type: "text" as const, text: "unblocked" }] };
		},
	};
	return { tool, started: started.promise, release: () => release.resolve() };
}

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function durableIncomingBodies(sessionManager: SessionManager): string[] {
	return sessionManager.getEntries().flatMap(entry => {
		if (entry.type !== "custom_message" || entry.customType !== "irc:incoming" || !isRecord(entry.details)) {
			return [];
		}
		return typeof entry.details.message === "string" ? [entry.details.message] : [];
	});
}

describe("parent IRC delivery to an active child", () => {
	it("injects parent steering into the streaming child exactly once", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const parent = await makeSession("parent", { content: ["parent response"], stopReason: "stop" });
		const child = await makeSession("child", { content: ["child response"], stopReason: "stop", delayMs: 2_000 });
		const registry = AgentRegistry.global();
		registry.register({ id: "parent", displayName: "Parent", kind: "main", scope: "test", session: parent.session });
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "parent",
			scope: "test",
			session: child.session,
		});
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
			const receipt = await IrcBus.global().send({
				from: "parent",
				to: "child",
				body: "Pause edits and report current status.",
			});
			expect(receipt).toMatchObject({ to: "child", outcome: "injected" });
			expect(child.session.isStreaming).toBe(true);
			expect(received).toEqual(["Pause edits and report current status."]);
			await child.session.waitForIdle();
			await turn;
			expect(received).toEqual(["Pause edits and report current status."]);
		} finally {
			await child.session.waitForIdle();
		}
	});

	it("queues parent steering behind the busy child's journal rewrite and delivers each message once", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const blocker = createBlockingTool();
		const parent = await makeSession("parent", { content: ["parent response"], stopReason: "stop" });
		const child = await makeSession(
			"child",
			[
				{
					content: [{ type: "toolCall", id: "block-1", name: blocker.tool.name, arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["child done"], stopReason: "stop" },
			],
			[blocker.tool],
		);
		child.session.agent.setSteeringMode("all");
		const registry = AgentRegistry.global();
		registry.register({ id: "parent", displayName: "Parent", kind: "main", scope: "test", session: parent.session });
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "parent",
			scope: "test",
			session: child.session,
		});
		const turn = child.session.prompt("Run the blocking tool.", { attribution: "agent" });
		try {
			await blocker.started;
			const firstBody = "First parent steer: pause edits.";
			const secondBody = "Second parent steer: report status.";
			const entered = Promise.withResolvers<void>();
			const releaseJournal = Promise.withResolvers<void>();
			const lock = withJournalLock(child.sessionManager.getSessionFile()!, async () => {
				entered.resolve();
				await releaseJournal.promise;
			});
			await entered.promise;
			const rewrite = child.sessionManager.rewriteEntries();
			let delivered = false;
			const pending = IrcBus.global()
				.send({ from: "parent", to: "child", body: firstBody })
				.finally(() => {
					delivered = true;
				});
			try {
				await setImmediate();
				expect(delivered).toBe(false);
			} finally {
				releaseJournal.resolve();
				await lock;
			}
			const firstReceipt = await pending;
			await rewrite;
			const secondReceipt = await IrcBus.global().send({ from: "parent", to: "child", body: secondBody });
			expect(firstReceipt).toMatchObject({ to: "child", outcome: "injected" });
			expect(secondReceipt).toMatchObject({ to: "child", outcome: "injected" });
			blocker.release();
			await child.session.waitForIdle();
			await turn;
			expect(child.mock.calls).toHaveLength(2);
			const nextTexts = child.mock.calls[1]!.context.messages.map(messageText);
			const firstIndices = nextTexts.flatMap((text, index) => (text.includes(firstBody) ? [index] : []));
			const secondIndices = nextTexts.flatMap((text, index) => (text.includes(secondBody) ? [index] : []));
			expect(firstIndices).toHaveLength(1);
			expect(secondIndices).toHaveLength(1);
			expect(firstIndices[0]!).toBeLessThan(secondIndices[0]!);
			expect(durableIncomingBodies(child.sessionManager)).toEqual([firstBody, secondBody]);
		} finally {
			blocker.release();
			await child.session.waitForIdle();
		}
	});

	it("steers a parent message into the next model request during an active IRC wake phase", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const blocker = createBlockingTool();
		const parent = await makeSession("parent", [
			{ content: ["parent ack 1"], stopReason: "stop" },
			{ content: ["parent ack 2"], stopReason: "stop" },
		]);
		const child = await makeSession(
			"child",
			[
				{
					content: [{ type: "toolCall", id: "wake-block-1", name: blocker.tool.name, arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["wake done"], stopReason: "stop" },
			],
			[blocker.tool],
		);
		const registry = AgentRegistry.global();
		registry.register({ id: "parent", displayName: "Parent", kind: "main", scope: "test", session: parent.session });
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "parent",
			scope: "test",
			session: child.session,
		});
		const wakeBody = "Wake phase: run blocking tool.";
		const steerBody = "Mid-wake steer: include summary.";
		try {
			const wakeReceipt = await IrcBus.global().send({ from: "parent", to: "child", body: wakeBody });
			expect(wakeReceipt).toMatchObject({ to: "child", outcome: "woken" });
			await blocker.started;
			const steerReceipt = await IrcBus.global().send({ from: "parent", to: "child", body: steerBody });
			expect(steerReceipt).toMatchObject({ to: "child", outcome: "injected" });
			blocker.release();
			await child.session.waitForIdle();
			expect(child.mock.calls).toHaveLength(2);
			const nextTexts = child.mock.calls[1]!.context.messages.map(messageText);
			const wakeIndices = nextTexts.flatMap((text, index) => (text.includes(wakeBody) ? [index] : []));
			const steerIndices = nextTexts.flatMap((text, index) => (text.includes(steerBody) ? [index] : []));
			expect(wakeIndices).toHaveLength(1);
			expect(steerIndices).toHaveLength(1);
			expect(wakeIndices[0]!).toBeLessThan(steerIndices[0]!);
			expect(durableIncomingBodies(child.sessionManager)).toEqual([wakeBody, steerBody]);
		} finally {
			blocker.release();
			await child.session.waitForIdle();
		}
	});

	it("delivers two distinct parent steers in order across successive requests in default one-at-a-time mode", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const blocker = createBlockingTool();
		const parent = await makeSession("parent", { content: ["parent response"], stopReason: "stop" });
		const child = await makeSession(
			"child",
			[
				{
					content: [{ type: "toolCall", id: "block-seq-1", name: blocker.tool.name, arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["after first steer"], stopReason: "stop" },
				{ content: ["after second steer"], stopReason: "stop" },
			],
			[blocker.tool],
		);
		const registry = AgentRegistry.global();
		registry.register({ id: "parent", displayName: "Parent", kind: "main", scope: "test", session: parent.session });
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "parent",
			scope: "test",
			session: child.session,
		});
		const turn = child.session.prompt("Run blocking tool in default mode.", { attribution: "agent" });
		try {
			await blocker.started;
			const firstBody = "Default mode steer 1: pause.";
			const secondBody = "Default mode steer 2: summarize.";
			const firstReceipt = await IrcBus.global().send({ from: "parent", to: "child", body: firstBody });
			const secondReceipt = await IrcBus.global().send({ from: "parent", to: "child", body: secondBody });
			expect(firstReceipt).toMatchObject({ to: "child", outcome: "injected" });
			expect(secondReceipt).toMatchObject({ to: "child", outcome: "injected" });
			blocker.release();
			await child.session.waitForIdle();
			await turn;
			expect(child.mock.calls).toHaveLength(3);
			const secondReqTexts = child.mock.calls[1]!.context.messages.map(messageText);
			const thirdReqTexts = child.mock.calls[2]!.context.messages.map(messageText);
			expect(secondReqTexts.filter(text => text.includes(firstBody))).toHaveLength(1);
			expect(secondReqTexts.filter(text => text.includes(secondBody))).toHaveLength(0);
			expect(thirdReqTexts.filter(text => text.includes(firstBody))).toHaveLength(1);
			expect(thirdReqTexts.filter(text => text.includes(secondBody))).toHaveLength(1);
			expect(durableIncomingBodies(child.sessionManager)).toEqual([firstBody, secondBody]);
		} finally {
			blocker.release();
			await child.session.waitForIdle();
		}
	});

	it("recovers a parent steer once when SessionManager.sync outlives the active turn's final drain", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const blocker = createBlockingTool();
		const parent = await makeSession("parent", { content: ["parent response"], stopReason: "stop" });
		const child = await makeSession(
			"child",
			[
				{
					content: [{ type: "toolCall", id: "block-sync-1", name: blocker.tool.name, arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["initial turn done"], stopReason: "stop" },
				{ content: ["recovered steer done"], stopReason: "stop" },
			],
			[blocker.tool],
		);
		const registry = AgentRegistry.global();
		registry.register({ id: "parent", displayName: "Parent", kind: "main", scope: "test", session: parent.session });
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "parent",
			scope: "test",
			session: child.session,
		});
		const origSync = child.sessionManager.sync.bind(child.sessionManager);
		const syncEntered = Promise.withResolvers<void>();
		const releaseSync = Promise.withResolvers<void>();
		let gateNextSync = false;
		child.sessionManager.sync = async () => {
			if (gateNextSync) {
				gateNextSync = false;
				syncEntered.resolve();
				await releaseSync.promise;
			}
			await origSync();
		};
		const turn = child.session.prompt("Run tool then finish.", { attribution: "agent" });
		try {
			await blocker.started;
			gateNextSync = true;
			const steerBody = "Late steer during sync barrier.";
			const sendPromise = IrcBus.global().send({ from: "parent", to: "child", body: steerBody });
			await syncEntered.promise;
			blocker.release();
			await turn;
			releaseSync.resolve();
			const receipt = await sendPromise;
			expect(receipt).toMatchObject({ to: "child", outcome: "injected" });
			await child.session.waitForIdle();
			const matchingCalls = child.mock.calls.filter(call =>
				call.context.messages.some(msg => messageText(msg).includes(steerBody)),
			);
			expect(matchingCalls).toHaveLength(1);
			expect(durableIncomingBodies(child.sessionManager)).toEqual([steerBody]);
		} finally {
			blocker.release();
			releaseSync.resolve();
			await child.session.waitForIdle();
		}
	});

	it("recovers a parent steer once when SessionManager.sync outlives an active IRC wake phase", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const blocker = createBlockingTool();
		const parent = await makeSession("parent", [
			{ content: ["parent ack 1"], stopReason: "stop" },
			{ content: ["parent ack 2"], stopReason: "stop" },
		]);
		const child = await makeSession(
			"child",
			[
				{
					content: [{ type: "toolCall", id: "wake-sync-1", name: blocker.tool.name, arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["wake phase done"], stopReason: "stop" },
				{ content: ["recovered steer done"], stopReason: "stop" },
			],
			[blocker.tool],
		);
		const registry = AgentRegistry.global();
		registry.register({ id: "parent", displayName: "Parent", kind: "main", scope: "test", session: parent.session });
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "parent",
			scope: "test",
			session: child.session,
		});
		const origSync = child.sessionManager.sync.bind(child.sessionManager);
		const syncEntered = Promise.withResolvers<void>();
		const releaseSync = Promise.withResolvers<void>();
		let gateNextSync = false;
		child.sessionManager.sync = async () => {
			if (gateNextSync) {
				gateNextSync = false;
				syncEntered.resolve();
				await releaseSync.promise;
			}
			await origSync();
		};
		const wakeBody = "Wake phase: run blocking tool.";
		const steerBody = "Late steer during active wake sync barrier.";
		try {
			const wakeReceipt = await IrcBus.global().send({ from: "parent", to: "child", body: wakeBody });
			expect(wakeReceipt).toMatchObject({ to: "child", outcome: "woken" });
			await blocker.started;
			gateNextSync = true;
			const sendPromise = IrcBus.global().send({ from: "parent", to: "child", body: steerBody });
			await syncEntered.promise;
			blocker.release();
			await child.session.waitForIdle();
			releaseSync.resolve();
			const steerReceipt = await sendPromise;
			expect(steerReceipt).toMatchObject({ to: "child", outcome: "injected" });
			await child.session.waitForIdle();
			const matchingCalls = child.mock.calls.filter(call =>
				call.context.messages.some(msg => messageText(msg).includes(steerBody)),
			);
			expect(matchingCalls).toHaveLength(1);
			expect(durableIncomingBodies(child.sessionManager)).toEqual([wakeBody, steerBody]);
		} finally {
			blocker.release();
			releaseSync.resolve();
			await child.session.waitForIdle();
		}
	});
});
