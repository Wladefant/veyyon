/**
 * Regression for #762: task-autoloaded skill text must reach the first model turn.
 *
 * The executor's existing autoload-skills tests spy on sendCustomMessage, but
 * never inspect the model context that follows. This exercises the real
 * AgentSession append/projection/stream path with a synthetic agent-origin
 * skill-prompt and a mock provider. No external provider request is made.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			part !== null && typeof part === "object" &&
			part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n");
}

describe("task skill autoload provider-context boundary", () => {
	it("sends a hidden agent-authored skill once as developer context on the first turn", async () => {
		const temp = TempDir.createSync("@veyyon-task-skill-provider-");
		let auth: AuthStorage | undefined;
		let session: AgentSession | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled mock-provider model");
			auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
			auth.setRuntimeApiKey("anthropic", "mock-only-key");
			const modelRegistry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
			const sessionManager = SessionManager.inMemory(temp.path());
			const observed: Array<Array<{ role: string; attribution: unknown; text: string }>> = [];
			const agent = new Agent({
				getApiKey: () => "mock-only-key",
				initialState: {
					model,
					systemPrompt: ["Mock task"],
					tools: [],
					messages: [],
				},
				convertToLlm,
				streamFn: (_model, context) => {
					observed.push(context.messages.map(message => ({
						role: message.role,
						attribution: "attribution" in message ? message.attribution : undefined,
						text: contentText(message.content),
					})));
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const answer = createAssistantMessage("done");
						stream.push({ type: "start", partial: answer });
						stream.push({ type: "done", reason: "stop", message: answer });
					});
					return stream;
				},
			});
			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
			});

			// Match task/executor.ts autoloadChildSkills: no user attribution and
			// no automatic turn before the task prompt starts.
			const sentinel = "TASK_AUTOLOAD_UNIQUE_SKILL_SENTINEL_762";
			await session.sendCustomMessage({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: `<skill>\n${sentinel}\n</skill>`,
				display: false,
				details: { name: "synthetic-skill", path: "/synthetic/SKILL.md" },
			}, { triggerTurn: false });

			const stored = sessionManager.getBranch().filter(entry => entry.type === "custom_message");
			expect(stored).toHaveLength(1);
			expect(stored[0]).toMatchObject({
				type: "custom_message",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				attribution: "agent",
				display: false,
			});

			await session.prompt("Work on the synthetic task");
			expect(observed).toHaveLength(1);
			const sent = observed[0]!;
			const skillMessages = sent.filter(message => message.text.includes(sentinel));
			expect(skillMessages).toHaveLength(1);
			expect(skillMessages[0]).toMatchObject({ role: "developer", attribution: "agent" });
			expect(sent.some(message =>
				message.role === "user" && message.text.includes("Work on the synthetic task")
			)).toBe(true);
			expect(sent.some(message =>
				message.role === "user" && message.text.includes(sentinel)
			)).toBe(false);
		} finally {
			if (session) await session.dispose();
			auth?.close();
			temp.removeSync();
		}
	});
});
