/**
 * WHY: a custom command receives `HookCommandContext`, whose `obfuscateProviderText` is required:
 * it is the redaction a command applies to text it sends to a provider itself. `AgentSession`
 * builds that context from the extension runner's command context, and a session constructed
 * without a runner (an SDK caller building `AgentSession` directly) fell back to a context with no
 * such member. A double cast hid the gap from the compiler, so a command calling it threw a
 * TypeError instead of redacting. The context is now typed without the cast, and the fallback
 * redacts through the session's own boundary.
 *
 * Not caught here: the runner path, whose transform the extension runner's own suites own.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { LoadedCustomCommand } from "@veyyon/coding-agent/extensibility/custom-commands";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

const SECRET = "A_COMMAND_SECRET_4417";
const model = { provider: "test", id: "command-model", api: "openai-completions" } as Model;

let session: AgentSession | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
});

describe("a custom command on a session without an extension runner", () => {
	it("redacts provider-bound text through the session's secrets", async () => {
		let sent: string | undefined;
		const customCommands: LoadedCustomCommand[] = [
			{
				path: "send.ts",
				resolvedPath: "/repo/send.ts",
				source: "project",
				command: {
					name: "send",
					description: "Redaction fixture",
					execute(_args, ctx) {
						sent = ctx.obfuscateProviderText(`deploy with ${SECRET}`);
					},
				},
			},
		];
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			modelRegistry: {} as ModelRegistry,
			customCommands,
			obfuscator,
		});

		await session.prompt("/send");

		expect(sent).toBe(`deploy with ${obfuscator.obfuscate(SECRET)}`);
		expect(sent).not.toContain(SECRET);
	});
});
