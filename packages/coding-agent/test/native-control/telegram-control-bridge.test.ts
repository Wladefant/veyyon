import { beforeEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import {
	NativeControlDeniedError,
	TelegramNativeControlBridge,
	type NativeControlAuth,
} from "../../src/native-control/telegram-control-bridge";
import {
	getTelegramNativeControlHost,
	installTelegramNativeControlHost,
} from "../../src/native-control/telegram-control-host";

const TOKEN = "native-control-test-token-0000000000000000";
const AUTH: NativeControlAuth = {
	authToken: TOKEN,
	actorId: "telegram-user-17",
	chatId: "telegram-chat-29",
	sessionId: "session-a",
};

let registry: AgentRegistry;
let bridge: TelegramNativeControlBridge;

beforeEach(() => {
	registry = new AgentRegistry();
	bridge = new TelegramNativeControlBridge({
		binding: { ...AUTH },
		registry,
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
				expect.objectContaining({ id: "WorkerA", name: "Worker A", status: "running", summary: "reading [2J repository" }),
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
		).toThrow(
			expect.objectContaining({ code: "SESSION_NOT_ACTIVE" }),
		);
	});
});
