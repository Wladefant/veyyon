import { afterEach, beforeEach, expect, test } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { InternalUrlRouter } from "@veyyon/coding-agent/internal-urls/router";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { IrcBus, type IrcMessage } from "@veyyon/coding-agent/task/irc-bus";
import { IrcTool } from "@veyyon/coding-agent/tools/agent/irc";
import { splitInternalUrlSel } from "@veyyon/coding-agent/tools/core/path-utils";
import { ArtifactManager } from "@veyyon/kernel/session/artifacts";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	InternalUrlRouter.resetForTests();
});

afterEach(() => {
	InternalUrlRouter.resetForTests();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

test("an artifact link delivered by IRC opens the sender's bytes despite a local collision", async () => {
	const temp = TempDir.createSync("@veyyon-irc-artifact-");
	const source = SessionManager.inMemory(temp.path());
	const recipient = SessionManager.inMemory(temp.path());
	try {
		source.adoptArtifactManager(new ArtifactManager(temp.join("source")));
		recipient.adoptArtifactManager(new ArtifactManager(temp.join("recipient")));
		const id = await source.saveArtifact("sender evidence", "test");
		expect(id).toBeDefined();
		expect(await recipient.saveArtifact("recipient evidence", "test")).toBe(id);

		const registry = AgentRegistry.global();
		const delivered: IrcMessage[] = [];
		registry.register({
			id: "Receiver",
			displayName: "receiver",
			kind: "main",
			scope: "test-conversation",
			session: {
				sessionManager: recipient,
				deliverIrcMessage: async (message: IrcMessage) => {
					delivered.push(message);
					return "injected";
				},
			} as unknown as AgentSession,
		});
		registry.register({
			id: "Sender",
			displayName: "sender",
			kind: "sub",
			parentId: "Receiver",
			session: { sessionManager: source, emitIrcRelayObservation: () => {} } as unknown as AgentSession,
		});
		const tool = new IrcTool(
			makeToolSession({
				settings: Settings.isolated(),
				agentRegistry: registry,
				getAgentId: () => "Sender",
				getSessionId: () => source.getSessionId(),
				getArtifactsDir: () => source.getArtifactsDir(),
			}),
		);
		const bare = `artifact://${id}`;
		await tool.execute("send", { op: "send", to: "Receiver", message: bare });
		expect(delivered).toHaveLength(1);
		const context = {
			localProtocolOptions: {
				getArtifactsDir: () => recipient.getArtifactsDir(),
				getSessionId: () => recipient.getSessionId(),
			},
		};
		const router = InternalUrlRouter.instance();
		expect((await router.resolve(bare, context)).content).toBe("recipient evidence");
		expect((await router.resolve(delivered[0].body, context)).content).toBe("sender evidence");

		const sourceLink = delivered[0].body;
		const recipientLink = `${bare}?session=${recipient.getSessionId()}`;
		await tool.execute("send", {
			op: "send",
			to: "Receiver",
			message: `Read \`${bare}:raw:1-1\`, ${bare}?view=metadata, or ${recipientLink}.`,
		});
		expect(delivered[1].body).toBe(
			`Read \`${sourceLink}:raw:1-1\`, ${bare}?view=metadata&session=${source.getSessionId()}, or ${recipientLink}.`,
		);
		const ranged = delivered[1].body.match(/`([^`]+)`/)?.[1] ?? "";
		expect(splitInternalUrlSel(ranged)).toEqual({ path: sourceLink, sel: "raw:1-1" });

		const sharedStore = recipient.getArtifactManager();
		if (!sharedStore) throw new Error("Expected a shared artifact store");
		source.adoptArtifactManager(sharedStore);
		await tool.execute("send", { op: "send", to: "Receiver", message: bare });
		registry.unregister("Sender");
		expect(delivered[2].body).toBe(recipientLink);
		expect((await router.resolve(delivered[2].body, context)).content).toBe("recipient evidence");
	} finally {
		await source.close();
		await recipient.close();
		await temp.remove();
	}
});
