import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

/**
 * WHY: GitHub Copilot hands out short-lived tokens. When Copilot refuses one for authentication, the
 * stored token is the thing that has to change, and a settle that kept it presented the same
 * rejected token on every later request of the session.
 *
 * CLASS CLOSED: the settle drops the stored Copilot credential when a Copilot turn ends on an
 * authentication failure, and on nothing else. Swept over the failure shapes that classify as an
 * authentication refusal (401, 403, a refusal stated only in prose) and the ones that do not (a
 * throttle, a server fault, a clean stop, an abort whose reason reads like a refusal), and over a
 * refusal from another provider, which must leave Copilot's credential in place: a drop keyed on the
 * failure alone would sign the user out of Copilot whenever any provider rejected a key.
 *
 * NOT CAUGHT: whether the next Copilot request fetches a fresh token. That is the Copilot token
 * exchange's contract, tested with it.
 */

interface SettleCase {
	readonly name: string;
	readonly provider: string;
	readonly stopReason: AssistantMessage["stopReason"];
	readonly errorStatus?: number;
	readonly errorMessage?: string;
	readonly copilotCredentialKept: boolean;
}

const CASES: readonly SettleCase[] = [
	{
		name: "a Copilot 401",
		provider: "github-copilot",
		stopReason: "error",
		errorStatus: 401,
		errorMessage: "401 Unauthorized: token expired",
		copilotCredentialKept: false,
	},
	{
		name: "a Copilot 403",
		provider: "github-copilot",
		stopReason: "error",
		errorStatus: 403,
		errorMessage: "403 Forbidden: token rejected",
		copilotCredentialKept: false,
	},
	{
		name: "a Copilot refusal stated only in prose",
		provider: "github-copilot",
		stopReason: "error",
		errorMessage: "No API key found for github-copilot",
		copilotCredentialKept: false,
	},
	{
		name: "a Copilot throttle",
		provider: "github-copilot",
		stopReason: "error",
		errorStatus: 429,
		errorMessage: "429 Too Many Requests",
		copilotCredentialKept: true,
	},
	{
		name: "a Copilot server fault",
		provider: "github-copilot",
		stopReason: "error",
		errorStatus: 500,
		errorMessage: "500 Internal Server Error",
		copilotCredentialKept: true,
	},
	{
		name: "a clean Copilot stop",
		provider: "github-copilot",
		stopReason: "stop",
		copilotCredentialKept: true,
	},
	{
		name: "a Copilot turn aborted with a reason that reads like a refusal",
		provider: "github-copilot",
		stopReason: "aborted",
		errorMessage: "401 Unauthorized",
		copilotCredentialKept: true,
	},
	{
		name: "a 401 from another provider",
		provider: "anthropic",
		stopReason: "error",
		errorStatus: 401,
		errorMessage: "401 Unauthorized: invalid x-api-key",
		copilotCredentialKept: true,
	},
];

describe("a Copilot turn refused for authentication", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-copilot-auth-drop-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		await authStorage.set("github-copilot", { type: "api_key", key: "copilot-test-token" });
		await authStorage.set("anthropic", { type: "api_key", key: "anthropic-stored-key" });
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	for (const settleCase of CASES) {
		it(`${settleCase.copilotCredentialKept ? "keeps" : "drops"} the Copilot credential after ${settleCase.name}`, async () => {
			const reply: AssistantMessage = {
				role: "assistant",
				content: settleCase.stopReason === "stop" ? [{ type: "text", text: "done" }] : [],
				api: "openai-completions",
				provider: settleCase.provider,
				model: "gpt-4o",
				stopReason: settleCase.stopReason,
				errorStatus: settleCase.errorStatus,
				errorMessage: settleCase.errorMessage,
				usage: { ...emptyUsage(), input: 10, totalTokens: 10 },
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: reply });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [reply] });
			await session.waitForIdle();
			await delay(20);
			await session.waitForIdle();

			expect(authStorage.has("github-copilot")).toBe(settleCase.copilotCredentialKept);
			// The drop is Copilot's alone: no failure shape reaches another provider's credential.
			expect(authStorage.has("anthropic")).toBe(true);
		});
	}
});
