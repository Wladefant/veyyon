/**
 * WHY: the advisor reads the primary session through `formatSessionHistoryMarkdown`, and every field that
 * renderer prints has to pass through the secret obfuscator first. The obfuscation is a switch over message
 * roles and block types whose default returns the message untouched, so a role or block the switch misses
 * (an assistant `thinking` block, or a case dropped while merging two identical ones) sends a configured
 * secret to the advisor model in plain text, with no error anywhere.
 *
 * The sweep builds one message per rendered field, proves the field is printed by rendering it without an
 * obfuscator, and then asserts the advisor prompt holds the placeholder and never the secret.
 *
 * Gap: the rows are listed here, not read from the renderer. A role the renderer starts printing without a
 * row here is not swept.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { type AdvisorAgent, AdvisorRuntime } from "@veyyon/coding-agent/advisor/runtime";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { formatSessionHistoryMarkdown } from "@veyyon/coding-agent/session/session-history-format";

const SECRET = "ADVISOR_SWEEP_SECRET_4242";

/** The options the advisor renders its session update with. */
const ADVISOR_RENDER = {
	includeThinking: true,
	includeToolIntent: true,
	watchedRoles: true,
	expandPrimaryContext: true,
	expandEditDiffs: true,
} as const;

const ROWS: ReadonlyArray<readonly [string, readonly unknown[]]> = [
	["a user message", [{ role: "user", content: `deploy with ${SECRET}`, timestamp: 1 }]],
	["a developer message", [{ role: "developer", content: `key ${SECRET}`, timestamp: 1 }]],
	["assistant text", [{ role: "assistant", content: [{ type: "text", text: `using ${SECRET}` }], timestamp: 1 }]],
	[
		"assistant thinking",
		[{ role: "assistant", content: [{ type: "thinking", thinking: `the token is ${SECRET}` }], timestamp: 1 }],
	],
	[
		"assistant tool call arguments",
		[
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: `curl -H ${SECRET}` } }],
				timestamp: 1,
			},
		],
	],
	[
		"an edit diff in tool result details",
		[
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "config.ts" } }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "c2",
				toolName: "edit",
				content: [{ type: "text", text: "ok" }],
				details: { diff: `--- a/config.ts\n+++ b/config.ts\n@@ -1 +1 @@\n-old\n+const token = "${SECRET}";` },
				isError: false,
				timestamp: 2,
			},
		],
	],
	[
		"a bash execution command",
		[{ role: "bashExecution", command: `export TOKEN=${SECRET}`, output: "", exitCode: 0, timestamp: 1 }],
	],
	[
		"a python execution",
		[{ role: "pythonExecution", code: `token = "${SECRET}"`, output: "", exitCode: 0, timestamp: 1 }],
	],
	[
		"a custom message",
		[{ role: "custom", customType: "note", content: `noted ${SECRET}`, display: true, timestamp: 1 }],
	],
	[
		"a hook message",
		[{ role: "hookMessage", customType: "hook", content: `hooked ${SECRET}`, display: true, timestamp: 1 }],
	],
	["a branch summary", [{ role: "branchSummary", summary: `branch used ${SECRET}`, fromId: "e1", timestamp: 1 }]],
	[
		"a compaction summary",
		[{ role: "compactionSummary", summary: `compacted ${SECRET}`, tokensBefore: 10, timestamp: 1 }],
	],
	[
		"a file mention path",
		[{ role: "fileMention", files: [{ path: `notes/${SECRET}.txt`, content: "" }], timestamp: 1 }],
	],
];

async function advisorPromptFor(messages: readonly unknown[], obfuscator: SecretObfuscator): Promise<string> {
	const prompts: string[] = [];
	const agent: AdvisorAgent = {
		prompt: async input => {
			prompts.push(input);
		},
		abort: () => {},
		reset: () => {},
		state: { messages: [] },
	};
	const runtime = new AdvisorRuntime(agent, {
		snapshotMessages: () => messages as AgentMessage[],
		enqueueAdvice: () => {},
		obfuscator,
	});
	runtime.onTurnEnd();
	await Promise.resolve();
	expect(prompts).toHaveLength(1);
	return prompts[0]!;
}

describe("a secret in any message the advisor reads is hidden from it", () => {
	const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
	const placeholder = obfuscator.obfuscate(SECRET);

	for (const [field, messages] of ROWS) {
		it(`replaces the secret in ${field} with its placeholder`, async () => {
			// The row reaches a field the advisor's renderer prints; otherwise the sweep below proves nothing.
			expect(formatSessionHistoryMarkdown([...messages], ADVISOR_RENDER)).toContain(SECRET);

			const prompt = await advisorPromptFor(messages, obfuscator);
			expect(prompt).toContain(placeholder);
			expect(prompt).not.toContain(SECRET);
		});
	}
});
