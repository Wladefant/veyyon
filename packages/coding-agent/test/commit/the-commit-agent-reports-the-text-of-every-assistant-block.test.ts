/**
 * WHY: the commit agent turns each streamed assistant message into a one-line
 * preview and each finished message into the markdown it reports. Both read the
 * message's content blocks, so a reader that keeps only the first text block, or
 * joins blocks without a boundary, reports a preview that runs two words
 * together or a final message missing its tail.
 *
 * The run is driven through `runCommitAgentSession` with a session that emits
 * the events a real one does, so the assertion is on what reaches the reporter.
 *
 * It does not catch a provider that splits one word across two text blocks:
 * the preview joins blocks with a space, which is the documented behavior.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { type CommitAgentReporter, runCommitAgentSession } from "@veyyon/coding-agent/commit/agentic/agent";
import * as toolsModule from "@veyyon/coding-agent/commit/agentic/tools";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import type { CreateAgentSessionResult } from "@veyyon/coding-agent/session/factory-options";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, timestamp: 0 } as AssistantMessage;
}

function update(message: AssistantMessage): AgentSessionEvent {
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: message },
	};
}

function end(message: AssistantMessage): AgentSessionEvent {
	return { type: "message_end", message };
}

async function reportsFor(events: AgentSessionEvent[]): Promise<{ previews: string[]; messages: string[] }> {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	let emitted = false;
	const session = {
		prompt: async () => {
			if (emitted) return;
			emitted = true;
			for (const event of events) listener?.(event);
		},
		subscribe: (next: (event: AgentSessionEvent) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		dispose: async () => {},
	};
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as unknown as CreateAgentSessionResult);
	vi.spyOn(toolsModule, "createCommitTools").mockReturnValue([]);

	const previews: string[] = [];
	const messages: string[] = [];
	const reporter: CommitAgentReporter = {
		thinking: preview => previews.push(preview),
		messageEnded: () => {},
		assistantError: () => {},
		assistantMessage: markdown => messages.push(markdown),
		toolFinished: () => {},
		finished: () => {},
	};
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	await runCommitAgentSession({
		cwd: ".",
		model,
		settings: Settings.isolated(),
		modelRegistry: {} as never,
		authStorage: {} as never,
		changelogTargets: [],
		requireChangelog: false,
		reporter,
	});
	return { previews, messages };
}

describe("the commit agent reports the text of every assistant block", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("previews every text block on one line, a space between blocks, thinking and blank blocks dropped", async () => {
		const message = assistant([
			{ type: "text", text: "  weighing   the" },
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: "diff\n now " },
			{ type: "text", text: "   " },
		]);
		const { previews } = await reportsFor([update(message)]);
		expect(previews).toEqual(["weighing the diff now"]);
	});

	it("reports no preview for a message with no text yet", async () => {
		const message = assistant([
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: " \n " },
		]);
		const { previews } = await reportsFor([update(message)]);
		expect(previews).toEqual([]);
	});

	it("reports a finished message as its non-blank text blocks, one per line", async () => {
		const message = assistant([
			{ type: "text", text: "  " },
			{ type: "text", text: "## Proposal" },
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: "ready  " },
		]);
		const { messages } = await reportsFor([end(message)]);
		expect(messages).toEqual(["## Proposal\nready"]);
	});
});
