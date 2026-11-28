import { expect, it } from "bun:test";
import { convertMessages } from "@veyyon/ai/providers/google-shared";
import type { Message } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { emptyUsage } from "@veyyon/catalog/models";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { buildSessionContextFromPath } from "@veyyon/kernel/session/session-context";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";

it("replays the compacted tool history when returning from a fallback model to Neon", () => {
	const neon = buildModel({
		api: "google-gemini-cli",
		provider: "google-antigravity",
		id: "gemini-4-neon-medium",
		name: "Gemini 4 Neon",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65536,
	});
	const fallback = buildModel({ ...neon, id: "gemini-4-hydrogen-medium" });
	const timestamp = "2026-01-01T00:00:00.000Z";
	const path: SessionEntry[] = [];
	const appendMessage = (id: string, message: Message) => {
		path.push({ type: "message", id, parentId: path.at(-1)?.id ?? null, timestamp, message });
	};
	const appendStep = (model: typeof neon, id: string, name: string, thoughtSignature: string) => {
		appendMessage(id, {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "toolUse",
			timestamp: 1,
			content: [{ type: "toolCall", id, name, arguments: {}, thoughtSignature }],
		});
		appendMessage(`${id}-result`, {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 1,
		});
	};

	appendMessage("old-prompt", { role: "user", content: "Before the kept tail", timestamp: 1 });
	appendStep(neon, "old-call", "search", "QUJDQQ==");
	appendMessage("kept-prompt", { role: "user", content: "Continue with the new files", timestamp: 1 });
	const neonSignature = "TkVPTg==";
	const fallbackSignature = "RkFMTExBQ0s=";
	appendStep(neon, "neon-call", "read", neonSignature);
	appendStep(fallback, "fallback-call", "irc", fallbackSignature);
	path.push({
		type: "compaction",
		id: "summary",
		parentId: "fallback-call-result",
		timestamp,
		firstKeptEntryId: "kept-prompt",
		tokensBefore: 100,
		summary: "The earlier search was completed.",
	});

	const context = { messages: convertToLlm(buildSessionContextFromPath(path, { activeProvider: neon.provider }).messages) };
	const callsFor = (model: typeof neon) =>
		convertMessages(model, context)
			.flatMap(turn => turn.parts ?? [])
			.filter(part => part.functionCall)
			.map(part => [part.functionCall?.name, part.thoughtSignature]);
	const skip = "skip_thought_signature_validator";
	// Both requests read the same journal. A fallback request must not mutate the stored Neon signature.
	expect(callsFor(fallback)).toEqual([["read", skip], ["irc", fallbackSignature]]);
	expect(callsFor(neon)).toEqual([["read", neonSignature], ["irc", skip]]);
});
