import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	convertMessageToLlm,
	REMOTE_COMPACTION_PRESERVE_KEY,
	type RemoteCompactionPreserveData,
} from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import { buildResponsesInput, supportsFreeformApplyPatch } from "@veyyon/ai/providers/openai-shared";
import type { Message } from "@veyyon/ai/types";
import { emptyUsage } from "@veyyon/catalog/models";
import { buildSessionContext } from "@veyyon/kernel/session/session-context";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import { requireBundledModel } from "../../../agent/test/helpers";

/**
 * The resume/rebuild contract for OpenAI server-side (remote) compaction.
 *
 * A remote compaction entry is single-window: it stores the provider's
 * canonical compacted window and NO summary text, because the window is the
 * compacted context. Nothing dual-writes a local summary beside it, and
 * nothing is meant to. These tests compact remotely, then prove rebuild,
 * reload (JSON round trip), fork, and provider replay all produce the correct
 * model-visible context with exact content and counts, including the fork and
 * cross-provider cases where the window cannot be replayed and the original
 * messages are re-expanded instead.
 */

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") {
		return { ...base, message: { role, content: text, timestamp: 1 } };
	}
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.1",
			usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 },
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

/** The canonical window the compact endpoint returned, stored verbatim. */
const REMOTE_WINDOW: Array<Record<string, unknown>> = [
	{
		id: "msg_000",
		type: "message",
		status: "completed",
		role: "user",
		content: [{ type: "input_text", text: "turn one" }],
	},
	{ id: "cmp_001", type: "compaction", encrypted_content: "gAAAAABpM0Yj-fake" },
];

function remoteCompaction(id: string, parentId: string | null, firstKeptEntryId: string): CompactionEntry {
	const data: RemoteCompactionPreserveData = {
		version: 1,
		provider: "openai",
		api: "openai-responses",
		model: "gpt-5.1",
		window: REMOTE_WINDOW,
		inputTokens: 139,
		outputTokens: 438,
		compactedAt: "2025-01-01T00:01:00Z",
	};
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:01:00Z",
		// What `compactWithProvider` writes, verbatim: the window and no summary.
		// A fixture carrying summary text here would pin an entry shape nothing
		// produces, and every assertion below would be about an artifact that
		// does not exist.
		summary: "",
		firstKeptEntryId,
		tokensBefore: 221_568,
		preserveData: { [REMOTE_COMPACTION_PRESERVE_KEY]: data },
	};
}

/**
 * `activeModel` seeds a model_change entry, which is how the rebuild learns
 * which provider the session is on now. That is the whole input to the replay
 * decision, so a suite that never sets it can only ever test one half.
 */
function sessionEntries(activeModel?: string): SessionEntry[] {
	const head: SessionEntry[] = activeModel
		? [
				{
					type: "model_change",
					id: "model-0",
					parentId: null,
					timestamp: "2025-01-01T00:00:00Z",
					model: activeModel,
				},
			]
		: [];
	const rootParent = activeModel ? "model-0" : null;
	return [
		...head,
		msg("msg-1", rootParent, "user", "turn one"),
		msg("msg-2", "msg-1", "assistant", "reply one"),
		msg("msg-3", "msg-2", "user", "turn two"),
		msg("msg-4", "msg-3", "assistant", "reply two"),
		msg("msg-5", "msg-4", "user", "kept turn"),
		remoteCompaction("compact-1", "msg-5", "msg-5"),
		msg("msg-6", "compact-1", "user", "after compaction"),
	];
}

function codexFallbackEntries(): SessionEntry[] {
	const entries = sessionEntries("anthropic/claude-sonnet-4");
	const firstMessage = entries.find((entry): entry is SessionMessageEntry => entry.type === "message");
	if (!firstMessage) throw new Error("Expected the Codex fallback fixture to have a first message");
	firstMessage.parentId = "model-1";
	entries.splice(1, 0, {
		type: "model_change",
		id: "model-1",
		parentId: "model-0",
		timestamp: "2025-01-01T00:00:01Z",
		model: "openai-codex/gpt-6.1-sol",
		role: "fallback",
	});
	const compaction = entries.find((entry): entry is CompactionEntry => entry.type === "compaction");
	if (!compaction?.preserveData) throw new Error("Expected the Codex fallback fixture to have remote data");
	const remote = compaction.preserveData[REMOTE_COMPACTION_PRESERVE_KEY] as RemoteCompactionPreserveData;
	compaction.preserveData[REMOTE_COMPACTION_PRESERVE_KEY] = {
		...remote,
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-6.1-sol",
	};
	return entries;
}

test("live Codex fallback replays compaction despite an Anthropic default", () => {
	const entries = codexFallbackEntries();
	const live = buildSessionContext(entries, undefined, undefined, { activeProvider: "openai-codex" });
	expect(live.messages).toHaveLength(3);
	expect(summaryMessage(live.messages).providerPayload?.items).toEqual(REMOTE_WINDOW);
	expect(live.messages[1].role === "user" && live.messages[1].content).toBe("kept turn");
	expect(live.messages[2].role === "user" && live.messages[2].content).toBe("after compaction");

	const offline = buildSessionContext(entries);
	expect(offline.messages.some(message => message.role === "compactionSummary")).toBe(false);
	expect(offline.messages.some(message => message.role === "user" && message.content === "turn one")).toBe(true);
});

test("foreign live provider never replays Codex encrypted data", () => {
	const entries = codexFallbackEntries();
	const foreign = buildSessionContext(entries, undefined, undefined, { activeProvider: "anthropic" });
	expect(foreign.messages.some(message => message.role === "compactionSummary")).toBe(false);
	expect(JSON.stringify(foreign.messages)).not.toContain("gAAAAABpM0Yj-fake");
	expect(foreign.messages.some(message => message.role === "user" && message.content === "turn one")).toBe(true);
});


function getOpenAIModel(): Model {
	return requireBundledModel("openai", "gpt-5.1");
}

function summaryMessage(messages: AgentMessage[]) {
	const first = messages[0];
	if (first?.role !== "compactionSummary") throw new Error(`Expected a compactionSummary first, got ${first?.role}`);
	return first;
}

describe("remote compaction entry rebuild", () => {
	test("rebuild emits the window-bearing divider first, then the kept tail", () => {
		const ctx = buildSessionContext(sessionEntries("openai/gpt-5.1"));

		// Divider + kept user turn + post-compaction turn: 3 messages, and the
		// four pre-cut messages are gone behind the window.
		expect(ctx.messages).toHaveLength(3);
		const summary = summaryMessage(ctx.messages);
		expect(summary.summary).toBe("");
		expect(summary.compactedBy).toBe("openai/gpt-5.1");
		expect(summary.providerPayload?.type).toBe("openaiResponsesHistory");
		expect(summary.providerPayload?.items).toEqual(REMOTE_WINDOW);
		expect(ctx.messages[1].role === "user" && ctx.messages[1].content).toBe("kept turn");
		expect(ctx.messages[2].role === "user" && ctx.messages[2].content).toBe("after compaction");
	});

	test("reload after a JSON round trip (process restart) rebuilds the identical context", () => {
		const revived = JSON.parse(JSON.stringify(sessionEntries("openai/gpt-5.1"))) as SessionEntry[];
		const ctx = buildSessionContext(revived);

		expect(ctx.messages).toHaveLength(3);
		// The opaque window survives persistence byte-for-byte: it is stateless
		// provider data, so a reloaded session still replays it natively.
		expect(summaryMessage(ctx.messages).providerPayload?.items).toEqual(REMOTE_WINDOW);
	});

	test("fork below the compaction keeps the window on the new branch", () => {
		const entries = [...sessionEntries("openai/gpt-5.1"), msg("msg-7", "msg-6", "user", "forked turn")];
		const ctx = buildSessionContext(entries, "msg-7");

		expect(ctx.messages).toHaveLength(4);
		expect(summaryMessage(ctx.messages).providerPayload?.items).toEqual(REMOTE_WINDOW);
		const last = ctx.messages[3];
		expect(last.role === "user" && last.content).toBe("forked turn");
	});

	test("a Responses provider replays the native window at the wire level", () => {
		const ctx = buildSessionContext(sessionEntries("openai/gpt-5.1"));
		const llmMessages = ctx.messages
			.map(message => convertMessageToLlm(message))
			.filter((message): message is Message => message !== undefined);

		const model = getOpenAIModel() as Model<"openai-responses">;
		const input = buildResponsesInput({
			model,
			context: { messages: llmMessages },
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			supportsCustomToolCalls: supportsFreeformApplyPatch(model),
			supportsDeveloperRole: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});

		const wire = JSON.stringify(input);
		// The opaque item replays, and the span it stands in for is not sent a
		// second time beside it. That non-duplication is the whole saving.
		expect(wire).toContain("gAAAAABpM0Yj-fake");
		expect(wire).not.toContain("reply two");
		expect(wire).toContain("kept turn");
		expect(wire).toContain("after compaction");
	});

	test("a provider that cannot replay the window sends the original messages instead", () => {
		const azure = requireBundledModel("azure", "gpt-4");
		// Resumed onto azure: the window is an openai blob azure cannot decrypt,
		// and no summary stands in for the span. The rebuild must re-expand the
		// real messages, because the alternative is a blank divider where four
		// turns used to be, with those turns still sitting on disk.
		const ctx = buildSessionContext(sessionEntries("azure/gpt-4"));
		const llmMessages = ctx.messages
			.map(message => convertMessageToLlm(message))
			.filter((message): message is Message => message !== undefined);

		const input = buildResponsesInput({
			model: azure as Model<"azure-openai-responses">,
			context: { messages: llmMessages },
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			supportsCustomToolCalls: false,
			supportsDeveloperRole: true,
			nativeHistory: { replay: false, filterReasoning: false },
		});

		const wire = JSON.stringify(input);
		expect(wire).not.toContain("gAAAAABpM0Yj-fake");
		expect(wire).toContain("turn one");
		expect(wire).toContain("reply two");
		expect(wire).toContain("kept turn");
	});
});
