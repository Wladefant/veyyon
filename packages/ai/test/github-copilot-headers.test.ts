import { describe, expect, it } from "bun:test";
import {
	buildCopilotDynamicHeaders,
	getCopilotInitiatorOverride,
	hasCopilotVisionInput,
	inferCopilotInitiator,
} from "@veyyon/ai/providers/github-copilot-headers";
import type { Message } from "@veyyon/ai/types";
import { COPILOT_USER_AGENT } from "@veyyon/catalog/wire/github-copilot";
import { VERSION } from "@veyyon/utils";

describe("inferCopilotInitiator", () => {
	it("returns 'user' when there are no messages", () => {
		expect(inferCopilotInitiator([])).toBe("user");
	});

	it("returns 'agent' when last message role is assistant", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-completions",
				provider: "github-copilot",
				model: "gpt-4o",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("returns 'agent' when last message is toolResult", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc_1",
				toolName: "bash",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("returns 'user' when last message is user with text content", () => {
		const messages: Message[] = [{ role: "user", content: "what time is it?", timestamp: Date.now() }];
		expect(inferCopilotInitiator(messages)).toBe("user");
	});

	it("returns 'user' when last message is user with text content blocks", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "explain this image" }],
				timestamp: Date.now(),
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("user");
	});

	it("prefers explicit attribution over role when attribution is agent", () => {
		const messages: Message[] = [
			{ role: "user", content: "internal reminder", attribution: "agent", timestamp: Date.now() },
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("prefers explicit attribution over role when attribution is user", () => {
		const messages: Message[] = [
			{ role: "developer", content: "forward user note", attribution: "user", timestamp: Date.now() },
		];
		expect(inferCopilotInitiator(messages)).toBe("user");
	});
	it("returns 'agent' when last message is user but last content block is tool_result", () => {
		const messages: unknown[] = [
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tc_1", content: "done" }],
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("returns 'agent' for any non-user role", () => {
		const messages: unknown[] = [
			{
				role: "tool",
				tool_call_id: "call_abc123",
				content: "tool output",
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});
});

describe("getCopilotInitiatorOverride", () => {
	it("returns undefined when no initiator header is configured", () => {
		expect(getCopilotInitiatorOverride(undefined)).toBeUndefined();
		expect(getCopilotInitiatorOverride({})).toBeUndefined();
	});

	it("returns the last valid case-insensitive initiator value", () => {
		const headers = {
			"x-initiator": "agent",
			"X-Initiator": "user",
			"X-INITIATOR": "invalid",
			"x-InItIaToR": "agent",
		};
		expect(getCopilotInitiatorOverride(headers)).toBe("agent");
	});

	it("ignores invalid initiator values", () => {
		expect(getCopilotInitiatorOverride({ "X-Initiator": "system" })).toBeUndefined();
	});
});
describe("hasCopilotVisionInput", () => {
	it("returns false when no messages have images", () => {
		const messages: Message[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});

	it("returns true when a user message has image content", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "describe this" },
					{ type: "image", data: "abc123", mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});

	it("returns true when a toolResult has image content", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc_1",
				toolName: "screenshot",
				content: [{ type: "image", data: "def456", mimeType: "image/jpeg" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});

	it("returns false when user message has only text content", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "just text" }],
				timestamp: Date.now(),
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});
});

describe("buildCopilotDynamicHeaders", () => {
	it("keeps sending X-Initiator and Openai-Intent", () => {
		const { headers, initiator } = buildCopilotDynamicHeaders({ messages: [], hasImages: false });
		expect(initiator).toBe("user");
		expect(headers["X-Initiator"]).toBe("user");
		expect(headers["Openai-Intent"]).toBe("conversation-edits");
	});

	it("identifies as Veyyon with its version, never as another client", () => {
		const { headers } = buildCopilotDynamicHeaders({ messages: [], hasImages: false });
		expect(headers["User-Agent"]).toBe(`veyyon/${VERSION}`);
		expect(COPILOT_USER_AGENT).toBe(`veyyon/${VERSION}`);
		expect(headers["User-Agent"]).not.toMatch(/opencode/i);
	});

	it("derives no premium-request figure from the initiator", () => {
		const user = buildCopilotDynamicHeaders({ messages: [], hasImages: false });
		const agent = buildCopilotDynamicHeaders({ messages: [], hasImages: false, initiatorOverride: "agent" });
		expect(agent.headers["X-Initiator"]).toBe("agent");
		// `agent => 0` was an invented figure; GitHub bills Copilot in credits since 2026-06-01.
		expect("premiumRequests" in user).toBe(false);
		expect("premiumRequests" in agent).toBe(false);
	});

	it("preserves explicit initiator override over inferred value", () => {
		const { headers } = buildCopilotDynamicHeaders({
			messages: [
				{
					role: "user",
					content:
						"<conversation>\nuser: summarize the discarded history\nassistant: keep the latest turn\n</conversation>\n\nProvide a compaction summary.",
				},
			],
			hasImages: false,
			initiatorOverride: "agent",
		});
		expect(headers["X-Initiator"]).toBe("agent");
		expect(headers["Openai-Intent"]).toBe("conversation-edits");
	});

	it("sets Copilot-Vision-Request when hasImages is true", () => {
		const { headers } = buildCopilotDynamicHeaders({ messages: [], hasImages: true });
		expect(headers["X-Initiator"]).toBe("user");
		expect(headers["Openai-Intent"]).toBe("conversation-edits");
		expect(headers["Copilot-Vision-Request"]).toBe("true");
	});
});
