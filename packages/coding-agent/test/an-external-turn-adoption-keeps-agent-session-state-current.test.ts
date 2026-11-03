import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { RetryRuntime } from "@veyyon/coding-agent/session/runtime/retry-runtime";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@veyyon/coding-agent/tools/agent/todo";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { ArgotSession, type Vocabulary } from "argot";

const MODEL = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
const SECRET = "SESSION_DISPLAY_SECRET_6281";
const EXPANSION = "src/database/connection.ts";
function completedAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}
async function seedManager(manager: SessionManager): Promise<AgentMessage[]> {
	manager.appendMessage({ role: "user", content: "Seed this persisted session.", timestamp: 1 });
	manager.appendMessage(completedAssistant("Seeded."));
	await manager.flush();
	return manager.buildSessionContext().messages;
}

/**
 * WHY: an ACP client adopts transcript entries through the real AgentSession, not through its
 * SessionManager alone. Adoption must update the Agent's prompt and TodoRuntime, while the client
 * display projection must expand Argot, redact secrets, and omit hidden custom messages. The
 * implicit refresh formerly performed during prompt admission also allowed a cancelled request to
 * start provider work before its caller could make the explicit adoption decision.
 *
 * This closes the session-to-transcript state transition and display projection on real session
 * and file-backed manager instances. It does not exercise ACP notification serialization or a real
 * provider endpoint; those boundaries have their own protocol/provider suites.
 */
describe("external turn adoption keeps real AgentSession state current", () => {
	let directory: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	async function modelRegistryForTest(): Promise<ModelRegistry> {
		if (!directory) throw new Error("Expected a temporary session directory");
		authStorage = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		return new ModelRegistry(authStorage);
	}
	let external: SessionManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await external?.close();
		await session?.dispose();
		await authStorage?.close();
		directory?.removeSync();
		external = undefined;
		session = undefined;
		directory = undefined;
	});

	it("adopts external todos and projects only visible custom messages with Argot and secrets", async () => {
		directory = TempDir.createSync("@external-agent-session-");
		const manager = SessionManager.create(directory.path(), directory.path());
		const messages = await seedManager(manager);
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: MODEL, systemPrompt: ["Test"], tools: [], messages } }),
			sessionManager: manager,
			settings: Settings.isolated({}),
			modelRegistry: await modelRegistryForTest(),
			obfuscator,
			argot: new ArgotSession(),
		});
		const vocab: Vocabulary = {
			version: 1,
			sigil: "§",
			handles: new Map([["dbconn", EXPANSION]]),
			meta: new Map(),
		};
		const argot = session.getArgotSession();
		if (!argot) throw new Error("Expected the real session to retain its Argot codec");
		argot.loadVocab(vocab);
		expect(argot.loaded).toBe(true);

		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected the file-backed session to have a transcript");
		external = await SessionManager.open(file, directory.path());
		external.appendMessage({ role: "user", content: "Continue the adopted work.", timestamp: 2 });
		external.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "External work", tasks: [{ content: "Update adopted state", status: "pending" }] }],
		});
		const visibleId = external.appendCustomMessageEntry("fixture", "visible custom fixture", true);
		external.appendCustomMessageEntry("fixture", "private transcript detail", false);
		external.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `Connect §dbconn using ${obfuscator.obfuscate(SECRET)}` }],
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 3,
		});
		await external.flush();
		await external.close();
		external = undefined;

		const adopted = await session.refreshExternalTurn();

		expect(adopted).toHaveLength(5);
		expect(session.getTodoPhases()).toEqual([
			{ name: "External work", tasks: [{ content: "Update adopted state", status: "pending" }] },
		]);
		const visibleEntry = manager.getBranch().find(entry => entry.id === visibleId);
		if (!visibleEntry) throw new Error("Expected the adopted visible custom entry");
		const projected = session.buildDisplayMessagesForEntry(visibleEntry);
		expect(projected).toHaveLength(1);
		expect(projected[0]).toMatchObject({ role: "custom", display: true, content: "visible custom fixture" });
		const assistantEntry = manager
			.getBranch()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some(block => block.type === "text" && block.text.includes("§dbconn")),
			);
		if (!assistantEntry)
			throw new Error("Expected the adopted assistant message carrying a handle and secret placeholder");
		const assistantDisplay = session.buildDisplayMessagesForEntry(assistantEntry);
		expect(assistantDisplay[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: `Connect ${EXPANSION} using ${obfuscator.obfuscate(SECRET)}` }],
		});
		expect(JSON.stringify(assistantDisplay)).not.toContain(SECRET);
		expect(JSON.stringify(assistantDisplay)).not.toContain("§dbconn");
		const hiddenEntry = manager.getBranch().find(entry => entry.type === "custom_message" && entry.display === false);
		if (!hiddenEntry) throw new Error("Expected the adopted hidden custom entry");
		expect(session.buildDisplayMessagesForEntry(hiddenEntry)).toEqual([]);
	});

	it("does not start provider work for a prompt aborted before admission", async () => {
		directory = TempDir.createSync("@cancelled-agent-session-");
		const manager = SessionManager.inMemory(directory.path());
		const messages = await seedManager(manager);
		const localBranchIds = manager.getBranch().map(entry => entry.id);
		const provider = vi.fn(() => new AssistantMessageEventStream());
		const refresh = vi.spyOn(manager, "refreshExternalTurn").mockResolvedValue([]);
		const admitted = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		vi.spyOn(RetryRuntime.prototype, "maybeRestoreFallbackPrimary").mockImplementationOnce(async () => {
			admitted.resolve();
			await released.promise;
		});
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: MODEL, systemPrompt: ["Test"], tools: [], messages },
				streamFn: provider,
			}),
			sessionManager: manager,
			settings: Settings.isolated({}),
			modelRegistry: await modelRegistryForTest(),
		});

		const turn = session.prompt("do not start");
		await admitted.promise;
		await session.abort();
		released.resolve();
		await turn;

		expect(refresh).not.toHaveBeenCalled();
		expect(provider).not.toHaveBeenCalled();
		expect(session.agent.state.messages).toEqual(messages);
		expect(manager.getBranch().map(entry => entry.id)).toEqual(localBranchIds);
	});
});
