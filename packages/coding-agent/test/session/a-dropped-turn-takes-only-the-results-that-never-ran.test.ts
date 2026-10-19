/**
 * WHY: a failed assistant turn is dropped from active context so a retry or
 * recovery does not replay it. A turn that failed with tool calls is not last
 * in context: the agent loop pairs every call with a never-ran placeholder
 * result, so the turn is found behind those placeholders and leaves with them.
 * A result that is not a placeholder records a call that ran; dropping it, or
 * the turn it answers, discards work whose side effects are real.
 *
 * The suite runs `removeAssistantMessageFromActiveContext` over a real `Agent`
 * for each tail shape: no results, a batch of placeholders, a real result, a
 * call an interrupt cut short inside the tool, and a tail that belongs to some
 * other turn. Every caller (auto-retry, the classifier-refusal prune, the
 * overflow and incomplete recoveries, the empty-stop discard) removes through
 * this function. The retry caller is also driven end to end in
 * `agent-session-retry-cap.test.ts`.
 *
 * Not covered: which placeholder shapes count as never-ran, which
 * `toolResultNeverRan` in agent-core defines and its own suite proves.
 */

import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { removeAssistantMessageFromActiveContext } from "@veyyon/coding-agent/session/runtime/turn-context-check";

const PROMPT: AgentMessage = { role: "user", content: "write the report", timestamp: 1 };

function failedTurn(timestamp: number, callIds: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: callIds.map(id => ({ type: "toolCall", id, name: "write", arguments: {} })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "The operation timed out.",
		timestamp,
	};
}

function result(toolCallId: string, details: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "write",
		content: [{ type: "text", text: "result" }],
		details,
		isError: false,
		timestamp: 3,
	};
}

const neverRan = (id: string) => result(id, { __synthetic: true, source: "assistant_stop_error", executed: false });

function agentWith(messages: AgentMessage[]): Agent {
	return new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages } });
}

describe("removeAssistantMessageFromActiveContext", () => {
	it("drops a turn that is last in context", () => {
		const turn = failedTurn(2, []);
		const agent = agentWith([PROMPT, turn]);
		removeAssistantMessageFromActiveContext(agent, turn);
		expect(agent.state.messages).toEqual([PROMPT]);
	});

	it("drops a turn behind a batch of never-ran placeholders, and the placeholders with it", () => {
		const turn = failedTurn(2, ["a", "b", "c"]);
		const agent = agentWith([PROMPT, turn, neverRan("a"), neverRan("b"), neverRan("c")]);
		removeAssistantMessageFromActiveContext(agent, turn);
		expect(agent.state.messages).toEqual([PROMPT]);
	});

	it("finds the turn by timestamp, route and stop when handed a copy", () => {
		const turn = failedTurn(2, ["a"]);
		const agent = agentWith([PROMPT, turn, neverRan("a")]);
		removeAssistantMessageFromActiveContext(agent, { ...turn, content: [] });
		expect(agent.state.messages).toEqual([PROMPT]);
	});

	it.each([
		{ name: "a call that ran", tail: result("a", undefined) },
		{ name: "a call an interrupt cut short inside the tool", tail: result("a", { __skipped: true, entered: true }) },
	])("keeps the turn and every result when the tail answers $name", ({ tail }) => {
		const turn = failedTurn(2, ["a"]);
		const messages = [PROMPT, turn, tail];
		const agent = agentWith(messages);
		removeAssistantMessageFromActiveContext(agent, turn);
		expect(agent.state.messages).toEqual(messages);
	});

	it("keeps a real result even when placeholders follow it", () => {
		const turn = failedTurn(2, ["a", "b"]);
		const messages = [PROMPT, turn, result("a", undefined), neverRan("b")];
		const agent = agentWith(messages);
		removeAssistantMessageFromActiveContext(agent, turn);
		expect(agent.state.messages).toEqual(messages);
	});

	it("leaves the context alone when the tail turn is a different one", () => {
		const earlier = failedTurn(2, ["a"]);
		const later = failedTurn(4, ["b"]);
		const messages = [PROMPT, later, neverRan("b")];
		const agent = agentWith(messages);
		removeAssistantMessageFromActiveContext(agent, earlier);
		expect(agent.state.messages).toEqual(messages);
	});
});
