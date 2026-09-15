import { beforeEach, describe, expect, test } from "bun:test";
import {
	handleTelegramControlCommand,
	handleTelegramExtensionCommand,
	type NativeControlAuth,
	type NativeControlDeniedError,
	renderWorkerRoster,
	type TelegramExtensionPort,
	TelegramNativeControlBridge,
} from "../../src/native-control/telegram-control-bridge";
import {
	getTelegramNativeControlHost,
	installTelegramNativeControlHost,
} from "../../src/native-control/telegram-control-host";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { IrcBus, type IrcMessage } from "../../src/task/irc-bus";

const TOKEN = "native-control-test-token-0000000000000000";
const AUTH: NativeControlAuth = {
	authToken: TOKEN,
	actorId: "telegram-user-17",
	chatId: "telegram-chat-29",
	sessionId: "session-a",
};

let registry: AgentRegistry;
let bus: IrcBus;
let bridge: TelegramNativeControlBridge;

beforeEach(() => {
	registry = new AgentRegistry();
	bus = new IrcBus(registry);
	bridge = new TelegramNativeControlBridge({
		binding: { ...AUTH },
		registry,
		bus,
	});
});

describe("TelegramNativeControlBridge authenticated reads", () => {
	test("returns only bounded agents in the bound session with progress and result", async () => {
		const fakeSession = {
			getLastAssistantText: () => "finished\u001b[31m safely",
		} as unknown as AgentSession;
		registry.register({
			id: "WorkerA",
			displayName: "Worker A",
			kind: "sub",
			session: fakeSession,
			scope: AUTH.sessionId,
			status: "running",
		});
		registry.setActivity("WorkerA", "reading\u001b[2J repository");
		registry.register({
			id: "OtherSession",
			displayName: "Other session",
			kind: "sub",
			session: null,
			scope: "session-b",
			status: "idle",
		});

		const page = await bridge.listAgents({ ...AUTH, limit: 50 });
		expect(page).toEqual({
			items: [
				expect.objectContaining({
					id: "WorkerA",
					name: "Worker A",
					status: "running",
					summary: "reading [2J repository",
				}),
			],
		});
		const detail = await bridge.getAgentDetail({ ...AUTH, agentId: "WorkerA" });
		expect(detail.progress).toBe("reading [2J repository");
		expect(detail.result).toBe("finished safely");
		await expect(bridge.getAgentDetail({ ...AUTH, agentId: "OtherSession" })).rejects.toMatchObject({
			code: "AGENT_NOT_FOUND",
		});
	});

	test("denies invalid credentials, actors, chats, sessions, and cursors", async () => {
		const cases: Array<[Partial<NativeControlAuth>, NativeControlDeniedError["code"]]> = [
			[{ authToken: "wrong" }, "UNAUTHORIZED"],
			[{ actorId: "attacker" }, "ACTOR_MISMATCH"],
			[{ chatId: "other-chat" }, "CHAT_MISMATCH"],
			[{ sessionId: "session-b" }, "SESSION_MISMATCH"],
		];
		for (const [override, code] of cases) {
			await expect(bridge.listAgents({ ...AUTH, ...override })).rejects.toMatchObject({ code });
		}
		await expect(bridge.listAgents({ ...AUTH, cursor: "-1" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
	});
});

describe("Telegram native control host wiring", () => {
	test("publishes a bindable in-process host and invalidates it on session switch", async () => {
		let activeSessionId = AUTH.sessionId;
		const installed = installTelegramNativeControlHost(() => activeSessionId, {
			registry,
			bus,
		});
		expect(getTelegramNativeControlHost()).toBe(installed);

		const client = installed.bind({
			...AUTH,
		});
		expect(client.getSessionIdentity(AUTH)).toEqual({
			id: AUTH.sessionId,
			actorId: AUTH.actorId,
			chatId: AUTH.chatId,
		});
		expect(await client.listAgents({ ...AUTH, limit: 5 })).toEqual({ items: [] });

		activeSessionId = "session-b";
		await expect(client.listAgents({ ...AUTH, limit: 5 })).rejects.toMatchObject({
			code: "SESSION_NOT_ACTIVE",
		});
		expect(() =>
			installed.bind({
				...AUTH,
			}),
		).toThrow(expect.objectContaining({ code: "SESSION_NOT_ACTIVE" }));
	});
});

describe("Telegram extension worker registry and targeted messaging", () => {
	test("drives command handler with two fake agents: renders roster, delivers to inbox, and reports negative receipt for unknown id", async () => {
		const now = 1_700_000_000_000;
		const fakeAgent1Inbox: IrcMessage[] = [];
		const fakeAgent2Inbox: IrcMessage[] = [];

		const session1 = {
			deliverIrcMessage: async (msg: IrcMessage) => {
				fakeAgent1Inbox.push(msg);
				return "injected" as const;
			},
		} as unknown as AgentSession;

		const session2 = {
			deliverIrcMessage: async (msg: IrcMessage) => {
				fakeAgent2Inbox.push(msg);
				return "woken" as const;
			},
		} as unknown as AgentSession;

		registry.register({
			id: "worker-alpha",
			displayName: "Worker Alpha",
			kind: "sub",
			status: "running",
			model: "google/gemini-2.5-flash",
			session: session1,
			scope: AUTH.sessionId,
			createdAt: now - 15_000,
		});

		registry.register({
			id: "worker-beta",
			displayName: "Worker Beta",
			kind: "sub",
			status: "idle",
			model: "anthropic/claude-3-5-sonnet",
			session: session2,
			scope: AUTH.sessionId,
			createdAt: now - 120_000,
		});

		// 1. Read path: /workers renders live roster with id, agent type, model, state, age
		const rosterResult = await handleTelegramControlCommand("/workers", {
			registry,
			bus,
			now: () => now,
		});
		expect(rosterResult).not.toBeNull();
		expect(rosterResult?.handled).toBe(true);
		expect(rosterResult?.command).toBe("workers");
		expect(rosterResult?.text).toContain("<b>Live Workers (2):</b>");
		expect(rosterResult?.text).toContain(
			"• <code>worker-alpha</code> (type: <code>sub</code>, model: <code>google/gemini-2.5-flash</code>, state: <b>running</b>, age: 15s ago)",
		);
		expect(rosterResult?.text).toContain(
			"• <code>worker-beta</code> (type: <code>sub</code>, model: <code>anthropic/claude-3-5-sonnet</code>, state: idle, age: 2m ago)",
		);

		// Also verify direct renderWorkerRoster function
		const renderedDirect = renderWorkerRoster(registry.list(), { now });
		expect(renderedDirect).toBe(rosterResult?.text ?? "");

		// 2. Targeted message path: /msg <id> <text> delivers through IrcBus and reaches agent's inbox
		const sendResult = await handleTelegramControlCommand("/msg worker-alpha Investigate failing test", {
			registry,
			bus,
			sender: "TelegramOperator",
		});
		expect(sendResult).not.toBeNull();
		expect(sendResult?.handled).toBe(true);
		expect(sendResult?.command).toBe("msg");
		expect(sendResult?.receipt?.outcome).toBe("injected");
		expect(sendResult?.receipt?.to).toBe("worker-alpha");
		expect(sendResult?.text).toBe(
			"<b>Message delivered to <code>worker-alpha</code>.</b> (outcome: <code>injected</code>)",
		);

		// Assert that the message arrived in worker-alpha's inbox
		expect(fakeAgent1Inbox).toHaveLength(1);
		expect(fakeAgent1Inbox[0]).toMatchObject({
			from: "TelegramOperator",
			to: "worker-alpha",
			body: "Investigate failing test",
		});
		expect(fakeAgent2Inbox).toHaveLength(0);

		// Send to second agent: delivers and wakes
		const sendResult2 = await handleTelegramControlCommand("/msg worker-beta Plan next task", {
			registry,
			bus,
			sender: "TelegramOperator",
		});
		expect(sendResult2?.handled).toBe(true);
		expect(sendResult2?.receipt?.outcome).toBe("woken");
		expect(sendResult2?.text).toBe(
			"<b>Message delivered to <code>worker-beta</code>.</b> (outcome: <code>woken</code>)",
		);
		expect(fakeAgent2Inbox).toHaveLength(1);
		expect(fakeAgent2Inbox[0]).toMatchObject({
			from: "TelegramOperator",
			to: "worker-beta",
			body: "Plan next task",
		});

		// 3. Negative test: unknown id → failed receipt
		const failedResult = await handleTelegramControlCommand("/msg unknown-worker-99 Status update", {
			registry,
			bus,
			sender: "TelegramOperator",
		});
		expect(failedResult).not.toBeNull();
		expect(failedResult?.handled).toBe(true);
		expect(failedResult?.command).toBe("msg");
		expect(failedResult?.receipt?.outcome).toBe("failed");
		expect(failedResult?.receipt?.to).toBe("unknown-worker-99");
		expect(failedResult?.text).toContain("<b>Message delivery failed to <code>unknown-worker-99</code>.</b>");
		expect(failedResult?.text).toContain("Unknown agent &quot;unknown-worker-99&quot;");

		// Inboxes of existing agents remain unchanged after failed send
		expect(fakeAgent1Inbox).toHaveLength(1);
		expect(fakeAgent2Inbox).toHaveLength(1);
	});

	test("returns syntax usage when /msg is invoked with missing arguments", async () => {
		const resultNoArgs = await handleTelegramControlCommand("/msg", { registry, bus });
		expect(resultNoArgs?.handled).toBe(true);
		expect(resultNoArgs?.text).toBe("<b>Usage:</b> <code>/msg &lt;id&gt; &lt;text&gt;</code>");

		const resultNoBody = await handleTelegramControlCommand("/msg worker-alpha", { registry, bus });
		expect(resultNoBody?.handled).toBe(true);
		expect(resultNoBody?.text).toBe("<b>Usage:</b> <code>/msg &lt;id&gt; &lt;text&gt;</code>");

		const unhandled = await handleTelegramControlCommand("/status", { registry, bus });
		expect(unhandled).toBeNull();
	});

	test("drives extension port interface and bridge handleCommand", async () => {
		const sentHtml: string[] = [];
		const port: TelegramExtensionPort = {
			send: (html: string) => {
				sentHtml.push(html);
			},
		};

		registry.register({
			id: "worker-gamma",
			displayName: "Worker Gamma",
			kind: "sub",
			status: "idle",
			session: null,
			scope: AUTH.sessionId,
		});

		const handled = await handleTelegramExtensionCommand("/workers", port, { registry, bus });
		expect(handled).toBe(true);
		expect(sentHtml).toHaveLength(1);
		expect(sentHtml[0]).toContain("worker-gamma");

		const unhandled = await handleTelegramExtensionCommand("/other", port, { registry, bus });
		expect(unhandled).toBe(false);
		expect(sentHtml).toHaveLength(1);

		// Drive through bridge instance
		const bridgeRoster = await bridge.renderWorkers(AUTH);
		expect(bridgeRoster).toContain("worker-gamma");

		const bridgeCmd = await bridge.handleCommand("/workers", AUTH);
		expect(bridgeCmd?.handled).toBe(true);
		expect(bridgeCmd?.text).toContain("worker-gamma");

		const bridgeMsg = await bridge.handleCommand("/msg unknown-id test", AUTH);
		expect(bridgeMsg?.handled).toBe(true);
		expect(bridgeMsg?.receipt?.outcome).toBe("failed");
	});

	test("excludes advisor agents from worker roster", () => {
		registry.register({
			id: "advisor-1",
			displayName: "Advisor",
			kind: "advisor",
			status: "running",
			session: null,
		});

		const rendered = renderWorkerRoster(registry.list());
		expect(rendered).toContain("<b>Live Workers (0):</b>");
		expect(rendered).not.toContain("advisor-1");
	});
	test("scope override attempt has no effect and excludes foreign and unscoped workers", async () => {
		registry.register({
			id: "worker-local",
			displayName: "Worker Local",
			kind: "sub",
			status: "idle",
			session: null,
			scope: AUTH.sessionId,
		});
		registry.register({
			id: "worker-foreign",
			displayName: "Worker Foreign",
			kind: "sub",
			status: "idle",
			session: null,
			scope: "session-b",
		});
		registry.register({
			id: "worker-unscoped",
			displayName: "Worker Unscoped",
			kind: "sub",
			status: "idle",
			session: null,
		});

		// Caller attempts to pass scope: "session-b" to renderWorkers
		const rendered = await bridge.renderWorkers({
			...AUTH,
			scope: "session-b",
		} as unknown as WorkerRosterRequest);
		expect(rendered).toContain("<b>Live Workers (1):</b>");
		expect(rendered).toContain("worker-local");
		expect(rendered).not.toContain("worker-foreign");
		expect(rendered).not.toContain("worker-unscoped");

		// Direct renderWorkerRoster with scope also excludes unscoped refs
		const scopedDirect = renderWorkerRoster(registry.list(), { scope: AUTH.sessionId });
		expect(scopedDirect).toContain("<b>Live Workers (1):</b>");
		expect(scopedDirect).toContain("worker-local");
		expect(scopedDirect).not.toContain("worker-foreign");
		expect(scopedDirect).not.toContain("worker-unscoped");
	});

	test("cross-session and unscoped target ids return failed receipt without message delivery", async () => {
		const foreignInbox: IrcMessage[] = [];
		const foreignSession = {
			deliverIrcMessage: async (msg: IrcMessage) => {
				foreignInbox.push(msg);
				return "injected" as const;
			},
		} as unknown as AgentSession;

		registry.register({
			id: "worker-other-session",
			displayName: "Worker Other Session",
			kind: "sub",
			status: "idle",
			session: foreignSession,
			scope: "session-b",
		});

		const unscopedInbox: IrcMessage[] = [];
		const unscopedSession = {
			deliverIrcMessage: async (msg: IrcMessage) => {
				unscopedInbox.push(msg);
				return "injected" as const;
			},
		} as unknown as AgentSession;

		registry.register({
			id: "worker-no-scope",
			displayName: "Worker No Scope",
			kind: "sub",
			status: "idle",
			session: unscopedSession,
		});

		// 1. bridge.sendMessage targeting cross-session worker
		const sendResult = await bridge.sendMessage({
			...AUTH,
			to: "worker-other-session",
			message: "cross-session probe",
		});
		expect(sendResult.outcome).toBe("failed");
		expect(sendResult.error).toContain('Agent "worker-other-session" is not available in the bound session');
		expect(sendResult.formatted).toContain("<b>Message delivery failed to <code>worker-other-session</code>.</b>");
		expect(foreignInbox).toHaveLength(0);

		// 2. bridge.handleCommand with /msg targeting cross-session worker
		const cmdResult = await bridge.handleCommand("/msg worker-other-session hello", AUTH);
		expect(cmdResult?.handled).toBe(true);
		expect(cmdResult?.command).toBe("msg");
		expect(cmdResult?.receipt?.outcome).toBe("failed");
		expect(cmdResult?.receipt?.error).toContain('Agent "worker-other-session" is not available in the bound session');
		expect(cmdResult?.text).toContain("<b>Message delivery failed to <code>worker-other-session</code>.</b>");
		expect(foreignInbox).toHaveLength(0);

		// 3. handleTelegramControlCommand with explicit scope targeting cross-session worker
		const scopedCmdResult = await handleTelegramControlCommand("/msg worker-other-session scoped hello", {
			registry,
			bus,
			scope: AUTH.sessionId,
			sender: "TelegramOperator",
		});
		expect(scopedCmdResult?.handled).toBe(true);
		expect(scopedCmdResult?.receipt?.outcome).toBe("failed");
		expect(scopedCmdResult?.receipt?.error).toContain('Agent "worker-other-session" is not available in the bound session');
		expect(foreignInbox).toHaveLength(0);

		// 4. bridge.sendMessage targeting unscoped worker
		const unscopedResult = await bridge.sendMessage({
			...AUTH,
			to: "worker-no-scope",
			message: "unscoped probe",
		});
		expect(unscopedResult.outcome).toBe("failed");
		expect(unscopedResult.error).toContain('Agent "worker-no-scope" is not available in the bound session');
		expect(unscopedInbox).toHaveLength(0);
	});
});
