import { describe, expect, it } from "bun:test";
import {
	buildGitLabDuoWorkflowGoal,
	buildGitLabDuoWorkflowSystemPrompt,
} from "@veyyon/ai/providers/gitlab-duo-workflow/goal";
import type { AssistantMessage, Context, Message, ToolResultMessage, UserMessage } from "@veyyon/ai/types";
import { emptyUsage } from "@veyyon/catalog/models";

/**
 * A GitLab Duo Workflow goal is the session replayed as text: a lone turn goes as the bare prompt, a
 * longer session as a flat ChatML transcript whose tool calls read as past-tense `<ran>` records. The
 * system slot carries the history note only when the goal is a transcript, because the note describes
 * markers a bare prompt does not contain.
 *
 * Not covered here: how the goal rides the start request and the byte budget that bounds it, which
 * the provider suite drives through `buildGitLabDuoWorkflowStartRequest`.
 */
const NOTE_FRAGMENT = "never write `<ran …>`";

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "gitlab-duo-agent",
		provider: "gitlab-duo-agent",
		model: "duo",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResult(text: string, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

function context(messages: Message[]): Context {
	return { systemPrompt: ["Be exact."], messages };
}

describe("A single surviving turn is sent as the bare prompt", () => {
	it("sends the latest user text with no ChatML markers and no history note", () => {
		const ctx = context([user("Fix the build.")]);
		expect(buildGitLabDuoWorkflowGoal(ctx)).toBe("Fix the build.");
		expect(buildGitLabDuoWorkflowSystemPrompt(ctx)).toBe("Be exact.");
	});

	it("drops an assistant turn with neither text nor tool calls before counting turns", () => {
		const ctx = context([user("Fix the build."), assistant([{ type: "thinking", thinking: "hmm" }])]);
		expect(buildGitLabDuoWorkflowGoal(ctx)).toBe("Fix the build.");
		expect(buildGitLabDuoWorkflowSystemPrompt(ctx)).not.toContain(NOTE_FRAGMENT);
	});

	it("sends a lone developer message as the prompt", () => {
		const ctx = context([{ role: "developer", content: "Use tabs.", timestamp: 0 }]);
		expect(buildGitLabDuoWorkflowGoal(ctx)).toBe("Use tabs.");
	});

	it("names an image part by its media type in the bare prompt", () => {
		const ctx = context([
			user([
				{ type: "text", text: "What is this?" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			]),
		]);
		expect(buildGitLabDuoWorkflowGoal(ctx)).toBe("What is this?\n[image/png image]");
	});
});

describe("A multi-turn session is sent as a flat ChatML transcript", () => {
	const session = context([
		user("Read the entry point."),
		assistant([
			{ type: "text", text: "Reading it." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/main.ts", i: "Reading entry" } },
		]),
		toolResult("ENOENT", true),
		user("Try index.ts."),
	]);

	it("renders every turn in order with the call as a past-tense record and the failed result marked", () => {
		expect(buildGitLabDuoWorkflowGoal(session)).toBe(
			[
				"<|im_start|>user\nRead the entry point.\n<|im_end|>",
				'<|im_start|>assistant\nReading it.\n\n<ran read>{"path":"src/main.ts"}</ran>\n<|im_end|>',
				"<|im_start|>tool\n<ran:result status=error>\nENOENT\n<|im_end|>",
				"<|im_start|>user\nTry index.ts.\n<|im_end|>",
			].join("\n"),
		);
	});

	it("appends the history note to the system prompt, and sends the note alone when there is none", () => {
		expect(buildGitLabDuoWorkflowSystemPrompt(session)).toMatch(/^Be exact\.\n\n/);
		expect(buildGitLabDuoWorkflowSystemPrompt(session)).toContain(NOTE_FRAGMENT);
		const bare = buildGitLabDuoWorkflowSystemPrompt({ messages: session.messages });
		expect(bare.startsWith("Be exact.")).toBe(false);
		expect(bare).toContain(NOTE_FRAGMENT);
	});

	it("marks a successful tool result with no status", () => {
		const ok = context([user("a"), toolResult("done", false)]);
		expect(buildGitLabDuoWorkflowGoal(ok)).toContain("<|im_start|>tool\n<ran:result>\ndone\n<|im_end|>");
	});
});
