/**
 * The goal and system slot of a GitLab Duo Workflow start request: the session's messages rendered as
 * a flat ChatML transcript, and veyyon's system prompt with the history note that keeps the model from
 * copying the transcript's markers.
 */
import { AI_PROMPTS } from "../../prompts/registry";
import type { AssistantMessage, Context, Message } from "../../types";
import { normalizeSystemPrompts } from "../../utils";

interface GitLabDuoWorkflowReplayToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface GitLabDuoWorkflowReplayMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	toolCalls?: GitLabDuoWorkflowReplayToolCall[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

// Trimmed once: the static note tells the model the goal transcript's ChatML/`<ran>`
// markers are a historical record, not a syntax to emit.
const GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE = AI_PROMPTS["provider/gitlab-duo-workflow-chatml-note"].text.trim();

// The veyyon system prompt that rides the inline flow's `prompt_template.system` slot.
// DWS wraps it in its own gateway boilerplate, but the slot content is delivered to
// the model verbatim, so veyyon's authoritative rules go here directly — no redirect
// preamble and no embedding inside the goal. When the goal is a multi-turn ChatML
// transcript (not a lone bare-text prompt), append the history-note so the model does
// not mimic the transcript's `<|im_start|>`/`<ran …>` markers as its own tool-call
// output — markers it kept copying even after they were reframed to past tense.
export function buildGitLabDuoWorkflowSystemPrompt(context: Context): string {
	const base = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	if (!isGitLabDuoWorkflowChatMlGoal(context)) return base;
	return base ? `${base}\n\n${GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE}` : GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE;
}

// A goal renders as a literal ChatML transcript only when more than one turn survives
// the replay filter; a lone turn is sent as bare text (see buildGitLabDuoWorkflowGoal),
// so the history-note would describe markers that are not present.
function isGitLabDuoWorkflowChatMlGoal(context: Context): boolean {
	return buildGitLabDuoWorkflowConversationHistory(context.messages).length > 1;
}

// The goal carries ONLY the conversation, rendered as a bare ChatML transcript. The
// system prompt lives in the flow's system slot, so the goal needs no envelope, no
// `<instructions>` section, and no preamble. A lone turn is sent verbatim; a real
// multi-turn session becomes the flat ChatML transcript, every turn equal-weight,
// ending naturally on the last turn. ChatML markers are literal text here (DWS does
// not tokenize the goal as a chat template), chosen because `<|im_start|>`/`<|im_end|>`
// effectively never collide with natural message content and are not Claude-reserved
// conversation sequences the way `Human:`/`Assistant:` are.
export function buildGitLabDuoWorkflowGoal(context: Context): string {
	const conversation = buildGitLabDuoWorkflowConversationHistory(context.messages);
	if (conversation.length <= 1) {
		return extractLatestUserPrompt(context.messages);
	}
	return renderGitLabDuoWorkflowChatMl(conversation);
}

const GITLAB_DUO_WORKFLOW_CHATML_START = "<|im_start|>";
const GITLAB_DUO_WORKFLOW_CHATML_END = "<|im_end|>";

// Render the flat transcript as literal ChatML. Each turn is
// `<|im_start|>role\n<body><|im_end|>`. An assistant turn that issued tool calls
// renders them after its text as `<ran NAME>{args}</ran>` records — a PAST-tense log
// of a call that already executed, deliberately NOT the `{name,arguments}` shape the
// live structured tool-use channel uses, so the model reads history as a record and
// does not mimic it as emittable call grammar. The paired result rides the next
// `tool` turn, linked by adjacency (1 call/turn), so the chain stays intact.
function renderGitLabDuoWorkflowChatMl(conversation: readonly GitLabDuoWorkflowReplayMessage[]): string {
	return conversation.map(renderGitLabDuoWorkflowChatMlTurn).join("\n");
}

function renderGitLabDuoWorkflowChatMlTurn(message: GitLabDuoWorkflowReplayMessage): string {
	const body = gitLabDuoWorkflowChatMlBody(message);
	return `${GITLAB_DUO_WORKFLOW_CHATML_START}${message.role}\n${body}${GITLAB_DUO_WORKFLOW_CHATML_END}`;
}

function gitLabDuoWorkflowChatMlBody(message: GitLabDuoWorkflowReplayMessage): string {
	const parts: string[] = [];
	if (message.content.length > 0) parts.push(message.content);
	if (message.role === "assistant" && message.toolCalls) {
		for (const toolCall of message.toolCalls) {
			parts.push(renderGitLabDuoWorkflowChatMlToolCall(toolCall));
		}
	}
	if (message.role === "tool") {
		const header = gitLabDuoWorkflowChatMlToolResultHeader(message);
		return header ? `${header}\n${message.content}\n` : `${message.content}\n`;
	}
	return `${parts.join("\n")}\n`;
}

function gitLabDuoWorkflowChatMlToolResultHeader(message: GitLabDuoWorkflowReplayMessage): string | undefined {
	if (!message.toolName && !message.toolCallId) return undefined;
	const status = message.isError ? " status=error" : "";
	// The tool name is omitted: the result rides the turn immediately after its call
	// (1:1, adjacent), so the model pairs them by position; repeating the name is dead
	// weight and makes the result read like an independent construct. `<ran:result>` is
	// past-tense — the adjacent output of the prior historical run, not emittable grammar.
	return `<ran:result${status}>`;
}

function renderGitLabDuoWorkflowChatMlToolCall(toolCall: GitLabDuoWorkflowReplayToolCall): string {
	// The goal is a plain text transcript fed to the model, not an HTML/script
	// context, so `<`/`>` need no escaping. Render as a past-tense `<ran NAME>` record:
	// the tag names the tool, the body is just the arguments JSON (the `{name,arguments}`
	// wrapper is dropped — it was the exact shape the model copied as a would-be live
	// call). The call id is veyyon-internal wiring the model never reads (call→result pair
	// by adjacency), so it is omitted to save bytes. `arguments` carries the `i` (intent)
	// key only at live dispatch; on replay it is stripped (see gitLabDuoWorkflowAssistantToolCalls).
	const args = JSON.stringify(toolCall.arguments) ?? "null";
	return `<ran ${toolCall.name}>${args}</ran>`;
}

// The whole session as a flat, equal-weight transcript. Every turn — including the
// latest user message — is one entry; nothing is elevated to a privileged
// `<current_request>`. DWS' goal blob has no native turn priority, so elevating the
// last turn (the old template) caused mid-task reminders / IRC wakes to outrank the
// actual task. A flat transcript ending naturally on the last turn removes that skew.
function buildGitLabDuoWorkflowConversationHistory(messages: readonly Message[]): GitLabDuoWorkflowReplayMessage[] {
	const history: GitLabDuoWorkflowReplayMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const replayMessage = buildGitLabDuoWorkflowReplayMessage(messages[index]);
		if (replayMessage) history.push(replayMessage);
	}
	return history;
}

function buildGitLabDuoWorkflowReplayMessage(message: Message | undefined): GitLabDuoWorkflowReplayMessage | undefined {
	if (!message) return undefined;
	if (message.role === "toolResult") {
		const content = gitLabDuoWorkflowMessageContentToText(message);
		return {
			role: "tool",
			content,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError,
		};
	}
	if (message.role === "assistant") {
		const content = gitLabDuoWorkflowMessageContentToText(message);
		const toolCalls = gitLabDuoWorkflowAssistantToolCalls(message);
		if (content.length === 0 && toolCalls.length === 0) return undefined;
		return toolCalls.length > 0 ? { role: "assistant", content, toolCalls } : { role: "assistant", content };
	}
	const content = gitLabDuoWorkflowMessageContentToText(message);
	if (content.length === 0) return undefined;
	return { role: "user", content };
}

function gitLabDuoWorkflowAssistantToolCalls(message: AssistantMessage): GitLabDuoWorkflowReplayToolCall[] {
	const toolCalls: GitLabDuoWorkflowReplayToolCall[] = [];
	for (const item of message.content) {
		if (item.type === "toolCall") {
			toolCalls.push({
				id: item.id,
				name: item.name,
				arguments: stripGitLabDuoWorkflowReplayIntent(item.arguments),
			});
		}
	}
	return toolCalls;
}

// The `i` key is veyyon's per-call intent narration (e.g. "Reading kernel smoke body").
// It is UI-time metadata describing the call as it is made; on replay the tool name
// plus arguments already say what the call did, so the intent is dead transcript
// weight. Drop it from the rendered history. (Live dispatch never reads the replayed
// args, so this only affects the bytes the model sees, never tool execution.)
function stripGitLabDuoWorkflowReplayIntent(args: Record<string, unknown>): Record<string, unknown> {
	if (!("i" in args)) return args;
	const { i: _intent, ...rest } = args;
	return rest;
}

function extractLatestUserPrompt(messages: readonly Message[]): string {
	const index = findLatestGitLabDuoWorkflowUserMessageIndex(messages);
	if (index < 0) return "";
	return gitLabDuoWorkflowUserContentToText(messages[index] as Exclude<Message, AssistantMessage>);
}

function findLatestGitLabDuoWorkflowUserMessageIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user" || message?.role === "developer") return index;
	}
	return -1;
}

function gitLabDuoWorkflowMessageContentToText(message: Message): string {
	if (message.role === "assistant") {
		return message.content
			.map(item => {
				if (item.type === "text") return item.text;
				if (item.type === "thinking" || item.type === "redactedThinking") return "";
				return "";
			})
			.join("\n");
	}
	return gitLabDuoWorkflowUserContentToText(message);
}

function gitLabDuoWorkflowUserContentToText(message: Exclude<Message, AssistantMessage>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}
