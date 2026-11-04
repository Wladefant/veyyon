import { describe, expect, it } from "bun:test";
import { ValidationError } from "@veyyon/ai/error";
import {
	extractGitLabDuoWorkflowAction,
	extractGitLabDuoWorkflowCheckpoint,
	parseGitLabDuoWorkflowSocketData,
} from "@veyyon/ai/providers/gitlab-duo-workflow/frames";

/**
 * A GitLab Duo Workflow socket frame arrives as text, bytes or an object, and carries either a
 * checkpoint (the `ui_chat_log` the stream turns into text and reasoning, plus the server's context
 * occupancy) or a tool action whose `requestID` the client must echo. A frame read wrong either drops
 * the answer, mislabels reasoning as answer text, or answers an action under an id the server discards.
 *
 * Not covered here: how the stream emits the entries it reads, which the provider suite drives over a
 * fake socket.
 */
const encoder = new TextEncoder();

describe("A socket frame is decoded into one JSON record", () => {
	const frame = { type: "checkpoint", n: 1 };

	it("reads text, an ArrayBuffer, a byte view and an already-parsed object alike", () => {
		const text = JSON.stringify(frame);
		expect(parseGitLabDuoWorkflowSocketData(text)).toEqual(frame);
		expect(parseGitLabDuoWorkflowSocketData(encoder.encode(text).buffer)).toEqual(frame);
		expect(parseGitLabDuoWorkflowSocketData(encoder.encode(text))).toEqual(frame);
		expect(parseGitLabDuoWorkflowSocketData(frame)).toBe(frame);
	});

	it("yields nothing for malformed JSON, a JSON scalar or a non-object frame", () => {
		expect(parseGitLabDuoWorkflowSocketData("{not json")).toBeNull();
		expect(parseGitLabDuoWorkflowSocketData("42")).toBeNull();
		expect(parseGitLabDuoWorkflowSocketData(42)).toBeNull();
	});
});

function chatLogFrame(chatLog: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		newCheckpoint: { checkpoint: JSON.stringify({ channel_values: { ui_chat_log: chatLog } }) },
		...extra,
	};
}

describe("A checkpoint frame is read into ordered chat-log entries", () => {
	it("maps agent text, reasoning and request/tool boundaries, keyed by message id or position", () => {
		const content = extractGitLabDuoWorkflowCheckpoint(
			chatLogFrame([
				{ message_type: "request", content: "do it" },
				{ message_type: "agent", message_sub_type: "reasoning", content: "thinking aloud" },
				{ message_type: "agent", content: "Done.", message_id: "m-7" },
				{ message_type: "agent", content: "" },
				{ message_type: "tool", content: "ran" },
				{ message_type: "user", content: "ignored" },
			]),
		);
		expect(content?.entries).toEqual([
			{ kind: "boundary", messageIndex: 0 },
			{ kind: "thinking", messageIndex: 1, messageKey: "reasoning:1", content: "thinking aloud" },
			{ kind: "text", messageIndex: 2, messageKey: "agent:m-7", content: "Done." },
			{ kind: "boundary", messageIndex: 4 },
		]);
		expect(content?.latestMessageType).toBe("user");
	});

	it("keys anonymous agent text by position and reports the checkpoint's byte length", () => {
		const frame = chatLogFrame([{ message_type: "agent", content: "Hi." }]);
		const checkpointJson = (frame.newCheckpoint as { checkpoint: string }).checkpoint;
		const content = extractGitLabDuoWorkflowCheckpoint(frame);
		expect(content?.entries).toEqual([{ kind: "text", messageIndex: 0, messageKey: "agent:0", content: "Hi." }]);
		expect(content?.contentLength).toBe(checkpointJson.length);
	});

	it("reads a checkpoint nested under the action as well as at the frame root", () => {
		const nested = { action: chatLogFrame([{ message_type: "agent", content: "Nested." }]) };
		expect(extractGitLabDuoWorkflowCheckpoint(nested)?.entries).toEqual([
			{ kind: "text", messageIndex: 0, messageKey: "agent:0", content: "Nested." },
		]);
	});

	it("takes a direct message over the chat log", () => {
		const content = extractGitLabDuoWorkflowCheckpoint({
			newCheckpoint: { message: "Direct.", checkpoint: JSON.stringify({ channel_values: { ui_chat_log: [] } }) },
		});
		expect(content).toEqual({
			entries: [{ kind: "text", messageIndex: 0, messageKey: "direct:text", content: "Direct." }],
			contentLength: 7,
			contextUsage: undefined,
		});
	});

	it("yields nothing for a frame with no checkpoint", () => {
		expect(extractGitLabDuoWorkflowCheckpoint({ type: "ping" })).toBeUndefined();
	});
});

describe("A checkpoint's context occupancy prefers the chat agent's reading", () => {
	it("reads the Chat Agent before any other agent, and skips a reading with no window", () => {
		const content = extractGitLabDuoWorkflowCheckpoint(
			chatLogFrame([], {
				agent_context_usage: {
					planner: { total_tokens: 5, max_tokens: 10 },
					"Chat Agent": { total_tokens: 400, max_tokens: 1000 },
				},
			}),
		);
		expect(content?.contextUsage).toEqual({ used: 400, window: 1000 });
	});

	it("falls back to the first agent with a usable reading", () => {
		const content = extractGitLabDuoWorkflowCheckpoint(
			chatLogFrame([], {
				agent_context_usage: {
					"Chat Agent": { total_tokens: 1, max_tokens: 0 },
					broken: { total_tokens: -1, max_tokens: 10 },
					planner: { total_tokens: 5, max_tokens: 10 },
				},
			}),
		);
		expect(content?.contextUsage).toEqual({ used: 5, window: 10 });
	});

	it("reports occupancy alone when the checkpoint carries no chat log", () => {
		expect(
			extractGitLabDuoWorkflowCheckpoint({
				newCheckpoint: {},
				agent_context_usage: { "Chat Agent": { total_tokens: 3, max_tokens: 9 } },
			}),
		).toEqual({ entries: [], contentLength: 0, contextUsage: { used: 3, window: 9 } });
	});
});

describe("A tool action is read with the request id the server expects back", () => {
	it("reads a wrapped action's name, id and arguments, and stamps the id as the tool call id", () => {
		expect(
			extractGitLabDuoWorkflowAction({
				action: { name: "runMCPTool", requestID: "req-1", args: { name: "read", args: "{}" } },
			}),
		).toEqual({
			requestID: "req-1",
			name: "runMCPTool",
			args: { name: "read", args: "{}", toolCallId: "req-1", tool_call_id: "req-1" },
		});
	});

	it("keeps a tool call id the action already carries", () => {
		const action = extractGitLabDuoWorkflowAction({
			action: { name: "runMCPTool", requestId: "req-2", arguments: { toolCallId: "own" } },
		});
		expect(action?.args).toEqual({ toolCallId: "own" });
	});

	it("reads the bare runMCPTool form with the id at the frame root", () => {
		expect(extractGitLabDuoWorkflowAction({ requestID: "req-3", runMCPTool: { name: "ls" } })).toEqual({
			requestID: "req-3",
			name: "runMCPTool",
			args: { name: "ls", toolCallId: "req-3", tool_call_id: "req-3" },
		});
	});

	it("rejects an action with no request id instead of inventing one", () => {
		expect(() => extractGitLabDuoWorkflowAction({ action: { name: "runMCPTool", args: {} } })).toThrow(
			ValidationError,
		);
		expect(() => extractGitLabDuoWorkflowAction({ run_mcp_tool: {} })).toThrow(ValidationError);
	});

	it("treats a checkpoint wrapped as an action as no action", () => {
		expect(extractGitLabDuoWorkflowAction({ action: { newCheckpoint: {}, name: "x", requestID: "r" } })).toBe(
			undefined,
		);
	});
});
