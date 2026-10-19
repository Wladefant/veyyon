/**
 * Reading the frames a GitLab Duo Workflow socket delivers: the JSON record a frame carries, the
 * `ui_chat_log` checkpoint it reports (agent text, reasoning, turn boundaries, context occupancy), and
 * the MCP tool action it asks the client to run.
 */
import { tryParseJson } from "@veyyon/utils/json";
import { isRecord } from "@veyyon/utils/type-guards";
import * as AIError from "../../error";

const GITLAB_DUO_WORKFLOW_ACTION_NAMES = ["runMCPTool", "run_mcp_tool"] as const;

export interface GitLabDuoWorkflowActionDescriptor {
	requestID: string;
	name: string;
	args: unknown;
}

export type GitLabDuoWorkflowCheckpointKind = "text" | "thinking";

export interface GitLabDuoWorkflowCheckpointAgentEntry {
	kind: GitLabDuoWorkflowCheckpointKind;
	messageIndex: number;
	messageKey: string;
	content: string;
}

export interface GitLabDuoWorkflowCheckpointBoundaryEntry {
	kind: "boundary";
	messageIndex: number;
}

export type GitLabDuoWorkflowCheckpointEntry =
	| GitLabDuoWorkflowCheckpointAgentEntry
	| GitLabDuoWorkflowCheckpointBoundaryEntry;

export interface GitLabDuoWorkflowContextUsage {
	used: number;
	window: number;
}

export interface GitLabDuoWorkflowCheckpointContent {
	entries: GitLabDuoWorkflowCheckpointEntry[];
	contentLength: number;
	latestMessageType?: string;
	contextUsage?: GitLabDuoWorkflowContextUsage;
}

export function parseGitLabDuoWorkflowSocketData(data: unknown): Record<string, unknown> | null {
	if (typeof data === "string") return parseJsonRecord(data);
	if (data instanceof ArrayBuffer) return parseJsonRecord(new TextDecoder().decode(data));
	if (data instanceof Uint8Array) return parseJsonRecord(new TextDecoder().decode(data));
	if (data && typeof data === "object") return data as Record<string, unknown>;
	return null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
	const parsed = tryParseJson(text);
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function extractGitLabDuoWorkflowCheckpoint(
	event: Record<string, unknown>,
): GitLabDuoWorkflowCheckpointContent | undefined {
	const action = getRecord(event, "action");
	const checkpoint =
		getRecord(action, "newCheckpoint") ?? getRecord(event, "newCheckpoint") ?? getRecord(event, "checkpoint");
	if (!checkpoint) return undefined;
	const directText =
		getRecordString(checkpoint, "message") ??
		getRecordString(checkpoint, "text") ??
		getRecordString(checkpoint, "content") ??
		getNestedRecordString(checkpoint, "checkpoint", "message") ??
		getNestedRecordString(checkpoint, "checkpoint", "text");
	const contextUsage = extractGitLabDuoWorkflowContextUsage(event, action, checkpoint);
	if (directText) {
		return {
			entries: [{ kind: "text", messageIndex: 0, messageKey: "direct:text", content: directText }],
			contentLength: directText.length,
			contextUsage,
		};
	}
	const checkpointJson = getRecordString(checkpoint, "checkpoint");
	const content = checkpointJson ? extractGitLabCheckpointEntries(checkpointJson) : undefined;
	if (content) {
		if (contextUsage) content.contextUsage = contextUsage;
		return content;
	}
	if (contextUsage) {
		return { entries: [], contentLength: 0, contextUsage };
	}
	return undefined;
}

// GitLab Duo Workflow Service attaches per-agent context occupancy to every checkpoint
// (`checkpointer/notifier.py`): agent_context_usage[<agent>] = { total_tokens, max_tokens }.
// total_tokens is the server-side token estimate of that agent's full history; max_tokens
// is the model context window (claude_opus_4_8 observed at 1_000_000). The field rides on
// the event root in practice but can also appear under `action`/`newCheckpoint`.
function extractGitLabDuoWorkflowContextUsage(
	...sources: (Record<string, unknown> | undefined)[]
): GitLabDuoWorkflowContextUsage | undefined {
	for (const source of sources) {
		const usageMap = getRecord(source, "agent_context_usage");
		if (!usageMap) continue;
		const selected = selectGitLabDuoWorkflowContextUsageAgent(usageMap);
		if (selected) return selected;
	}
	return undefined;
}

const GITLAB_DUO_WORKFLOW_CONTEXT_AGENT_PRIORITY = ["Chat Agent", "context_builder"];

function selectGitLabDuoWorkflowContextUsageAgent(
	usageMap: Record<string, unknown>,
): GitLabDuoWorkflowContextUsage | undefined {
	for (const preferred of GITLAB_DUO_WORKFLOW_CONTEXT_AGENT_PRIORITY) {
		const usage = readGitLabDuoWorkflowAgentUsage(usageMap[preferred]);
		if (usage) return usage;
	}
	for (const value of Object.values(usageMap)) {
		const usage = readGitLabDuoWorkflowAgentUsage(value);
		if (usage) return usage;
	}
	return undefined;
}

function readGitLabDuoWorkflowAgentUsage(value: unknown): GitLabDuoWorkflowContextUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const used = numberField(record, "total_tokens");
	const window = numberField(record, "max_tokens");
	if (used === undefined || window === undefined || window <= 0) return undefined;
	return { used, window };
}

function extractGitLabCheckpointEntries(checkpointJson: string): GitLabDuoWorkflowCheckpointContent | undefined {
	const checkpoint = parseJsonRecord(checkpointJson);
	const chatLog = getRecord(checkpoint, "channel_values")?.ui_chat_log;
	if (!Array.isArray(chatLog)) return undefined;
	const entries: GitLabDuoWorkflowCheckpointEntry[] = [];
	for (let index = 0; index < chatLog.length; index++) {
		const entry = readGitLabDuoWorkflowChatLogEntry(chatLog[index], index);
		if (entry) entries.push(entry);
	}
	return {
		entries,
		contentLength: checkpointJson.length,
		latestMessageType: getGitLabDuoWorkflowLatestMessageType(chatLog),
	};
}

/** Maps one `ui_chat_log` record to a checkpoint entry: agent text or reasoning, or a request/tool turn boundary. */
function readGitLabDuoWorkflowChatLogEntry(
	value: unknown,
	index: number,
): GitLabDuoWorkflowCheckpointEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const messageType = getRecordString(value, "message_type");
	if (messageType === "request" || messageType === "tool") return { kind: "boundary", messageIndex: index };
	if (messageType !== "agent") return undefined;
	const content = getRecordString(value, "content");
	if (!content) return undefined;
	const messageId = getRecordString(value, "message_id");
	// `message_sub_type: "reasoning"` is the agent's pre-tool-call
	// commentary the inline flow opts into via `on_agent_reasoning`; map it
	// to a thinking block. Other agent text is the answer → text.
	const isReasoning = getRecordString(value, "message_sub_type") === "reasoning";
	return {
		kind: isReasoning ? "thinking" : "text",
		messageIndex: index,
		messageKey: messageId ? `agent:${messageId}` : isReasoning ? `reasoning:${index}` : `agent:${index}`,
		content,
	};
}

function getGitLabDuoWorkflowLatestMessageType(chatLog: unknown[]): string | undefined {
	for (let index = chatLog.length - 1; index >= 0; index--) {
		const entry = chatLog[index];
		if (!entry || typeof entry !== "object") continue;
		const messageType = getRecordString(entry, "message_type");
		if (messageType) return messageType;
	}
	return undefined;
}

export function extractGitLabDuoWorkflowAction(
	event: Record<string, unknown>,
): GitLabDuoWorkflowActionDescriptor | undefined {
	const wrappedAction =
		getRecord(event, "action") ?? getRecord(event, "workflowAction") ?? getRecord(event, "toolCall");
	if (wrappedAction) {
		if (getRecord(wrappedAction, "newCheckpoint")) return undefined;
		const name =
			getRecordString(wrappedAction, "name") ??
			getRecordString(wrappedAction, "action") ??
			getRecordString(wrappedAction, "type") ??
			getRecordString(event, "actionName");
		if (!name) return undefined;
		const requestID =
			getRecordString(wrappedAction, "requestID") ??
			getRecordString(wrappedAction, "requestId") ??
			getRecordString(wrappedAction, "id") ??
			getRecordString(event, "requestID") ??
			getRecordString(event, "requestId");
		const resolvedRequestID = requireGitLabDuoWorkflowRequestID(requestID, name, wrappedAction);
		const args = getRecord(wrappedAction, "args") ?? getRecord(wrappedAction, "arguments") ?? wrappedAction;
		return { requestID: resolvedRequestID, name, args: withGitLabDuoWorkflowToolCallId(args, resolvedRequestID) };
	}
	for (const name of GITLAB_DUO_WORKFLOW_ACTION_NAMES) {
		const args = getRecord(event, name);
		if (args) {
			const requestID = getRecordString(event, "requestID") ?? getRecordString(event, "requestId");
			const resolvedRequestID = requireGitLabDuoWorkflowRequestID(requestID, name, event);
			return { requestID: resolvedRequestID, name, args: withGitLabDuoWorkflowToolCallId(args, resolvedRequestID) };
		}
	}
	return undefined;
}

// DWS assigns every executor Action a non-empty `requestID` (contract.proto Action
// field 1; emitted verbatim by Workhorse's proto->JSON relay). The client MUST echo
// that exact id back in `actionResponse.requestID` or the server's outbox silently
// discards the response (outbox.set_action_response: a non-empty id that misses the
// awaiting-futures map hits the "doesn't expect responses, discarding" branch) and
// the tool call's future never resolves — the model then re-issues the same tool
// call, looping. A synthesized id is therefore never correct: it is either redundant
// (the real id was present) or actively harmful (guaranteed-discarded). Fail fast so
// the socket loop surfaces a protocol drift instead of stalling.
function requireGitLabDuoWorkflowRequestID(
	requestID: string | undefined,
	actionName: string,
	source: Record<string, unknown>,
): string {
	if (requestID) return requestID;
	throw new AIError.ValidationError(
		`GitLab Duo Workflow action "${actionName}" missing requestID (keys: ${Object.keys(source).slice(0, 20).join(", ")})`,
	);
}

function withGitLabDuoWorkflowToolCallId(args: unknown, requestID: string): unknown {
	const record = isRecord(args) ? (args as Record<string, unknown>) : {};
	if (typeof record.toolCallId === "string" || typeof record.tool_call_id === "string") {
		return record;
	}
	return { ...record, toolCallId: requestID, tool_call_id: requestID };
}

export function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const nested = (value as Record<string, unknown>)[key];
	return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
}

export function getRecordString(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const nested = (value as Record<string, unknown>)[key];
	return typeof nested === "string" || typeof nested === "number" ? String(nested) : undefined;
}

export function getNestedRecordString(value: unknown, parentKey: string, key: string): string | undefined {
	return getRecordString(getRecord(value, parentKey), key);
}
