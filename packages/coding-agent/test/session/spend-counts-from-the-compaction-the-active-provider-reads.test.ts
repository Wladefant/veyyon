/**
 * Session spend counts the history behind the compaction the prompt is built from: the newest one
 * the branch's default model can read. After a provider switch the newest entry can be a
 * server-side window only its minting provider replays, and the context then rebuilds from an
 * earlier summary.
 *
 * WHY. Spend adds the messages before the compaction's keep marker to the live context. Reading the
 * marker of a compaction other than the one the context applies counts a span twice, once as
 * summarized history and once in the live context, or drops it: the newest compaction regardless of
 * provider after a recorded switch, and the running model's compaction after a resume onto a model
 * the branch never recorded, whose context is still built from the branch default.
 *
 * WHAT IT DOES NOT CATCH. Which compaction `getEffectiveCompactionEntry` picks for each provider;
 * session-manager/a-provider-switch-rebuilds-from-the-newest-readable-compaction.test.ts sweeps that,
 * and session-manager/every-reader-of-the-sent-context-boundary-agrees-with-the-context-builder.test.ts
 * sweeps the boundary every other reader takes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { REMOTE_COMPACTION_PRESERVE_KEY, type RemoteCompactionPreserveData } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model, UserMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { emptyUsage, getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const MINTING = getBundledModel("openai", "gpt-5.1");
const OTHER = getBundledModel("anthropic", "claude-sonnet-4-5");

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(model: Model, input: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "reply" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...emptyUsage(), input, totalTokens: input },
		stopReason: "stop",
		timestamp: 1,
	};
}

function remoteWindow(model: Model): Record<string, unknown> {
	const data: RemoteCompactionPreserveData = {
		version: 1,
		provider: model.provider,
		api: "openai-responses",
		model: model.id,
		window: [{ id: "cmp_001", type: "compaction", encrypted_content: "gAAAAABpM0Yj-fake" }],
		compactedAt: "2025-01-01T00:02:00Z",
	};
	return { [REMOTE_COMPACTION_PRESERVE_KEY]: data };
}

describe("session spend counts from the compaction the active provider reads", () => {
	let dir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		dir = TempDir.createSync("@spend-provider-boundary-");
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	});

	afterAll(() => {
		authStorage.close();
		dir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	/**
	 * An ancient reply of 100 input tokens, a local summary keeping the turn after it, a reply of 10
	 * input tokens, then a server-side window minted by `MINTING` and a tail. A recorded switch writes
	 * a `model_change` the way `setModel` does; the unrecorded resume runs `active` on a branch whose
	 * default still resolves to `MINTING` through its newest reply. The live context is the one the
	 * session builds from the branch.
	 */
	it.each([
		["a provider that cannot read the newest window", OTHER, true],
		["the provider that minted the window", MINTING, true],
		["a resume onto a provider that cannot read the window, unrecorded", OTHER, false],
	] as const)("on %s, counts each reply once", (_label, active, recorded) => {
		if (!MINTING || !active) throw new Error("Expected bundled openai and anthropic models");
		const sessionManager = SessionManager.inMemory(dir.path());
		sessionManager.appendMessage(user("ancient turn"));
		sessionManager.appendMessage(assistant(MINTING, 100));
		const keptByLocal = sessionManager.appendMessage(user("kept by local"));
		sessionManager.appendCompaction("Local summary of the ancient span.", undefined, keptByLocal, 50_000);
		sessionManager.appendMessage(user("between turn"));
		sessionManager.appendMessage(assistant(MINTING, 10));
		const keptByRemote = sessionManager.appendMessage(user("kept by remote"));
		sessionManager.appendCompaction("", undefined, keptByRemote, 200_000, undefined, false, remoteWindow(MINTING));
		if (recorded) sessionManager.appendModelChange(`${active.provider}/${active.id}`);
		sessionManager.appendMessage(user("after remote"));

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: active,
					systemPrompt: ["Test"],
					tools: [],
					messages: sessionManager.buildSessionContext().messages,
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
		});

		expect(session.getSessionStats().tokens.input).toBe(110);
	});
});
