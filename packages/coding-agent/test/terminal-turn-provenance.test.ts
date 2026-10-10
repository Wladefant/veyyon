import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { createTerminalTranscriptProjector } from "../src/modes/terminal/terminal-control";

const entry = (message: unknown) => ({ type: "message", message }) as SessionEntry;
const answer = (names: string[] = [], stopReason = "stop") =>
	entry({
		role: "assistant",
		stopReason,
		content: [{ type: "text", text: "Done" }, ...names.map(name => ({ type: "toolCall", name }))],
	});

describe("terminal final reply provenance", () => {
	it("marks a background acknowledgement without operator input", () => {
		const projector = createTerminalTranscriptProjector();
		projector.observe({ type: "custom_message", attribution: "agent", customType: "async-result" } as SessionEntry);
		projector.observe(answer(["job"], "toolUse"));
		expect(projector.observe(answer())).toEqual({
			hasOperatorMessage: false,
			hasSubstantiveToolCall: false,
			toolNames: ["job"],
			isMain: true,
		});
	});
	it("keeps operator input and resets it after the final answer", () => {
		const projector = createTerminalTranscriptProjector();
		projector.observe(entry({ role: "user", content: "status?" }));
		expect(projector.observe(answer())?.hasOperatorMessage).toBe(true);
		expect(projector.observe(answer())?.hasOperatorMessage).toBe(false);
	});
	it("keeps mid-turn operator input and substantive tool calls", () => {
		const projector = createTerminalTranscriptProjector();
		projector.observe(answer(["bash"], "toolUse"));
		projector.observe(entry({ role: "user", content: "change this" }));
		expect(projector.observe(answer())).toEqual({
			hasOperatorMessage: true,
			hasSubstantiveToolCall: true,
			toolNames: ["bash"],
			isMain: true,
		});
	});
	it("does not treat agent attributed input as operator input", () => {
		const projector = createTerminalTranscriptProjector();
		projector.observe(entry({ role: "user", attribution: "agent", content: "continue" }));
		expect(projector.observe(answer())?.hasOperatorMessage).toBe(false);
	});
	it("resets activity when the journal is rebuilt", () => {
		const projector = createTerminalTranscriptProjector();
		projector.observe(entry({ role: "user", content: "old" }));
		projector.observe(answer(["task"], "toolUse"));
		projector.reset();
		expect(projector.observe(answer())).toEqual({
			hasOperatorMessage: false,
			hasSubstantiveToolCall: false,
			toolNames: [],
			isMain: true,
		});
	});
});
