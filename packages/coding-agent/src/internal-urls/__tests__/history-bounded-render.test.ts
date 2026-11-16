import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { formatSessionHistoryMarkdownAsync, MAX_RECORD_BYTES } from "../../session/session-history-format";
import { HistoryProtocolHandler } from "../history-protocol";
import { parseInternalUrl } from "../parse";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "../registry-helpers";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

it("returns the same markdown prefix without rendering later message content", async () => {
	const messages = [{ role: "user", content: "first\nsecond\nthird\nfourth\nfifth" }];
	const full = await formatSessionHistoryMarkdownAsync(messages, { title: "Scout (running)" });
	const tail = {
		role: "user",
		get content(): never {
			throw new Error("tail rendered");
		},
	};
	AgentRegistry.global().register({
		id: "Scout",
		displayName: "Scout",
		kind: "sub",
		status: "running",
		sessionFile: null,
		session: {
			messages: [...messages, tail],
			sessionManager: { getArtifactsDir: () => null },
		} as unknown as AgentSession,
	});
	const result = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://Scout"), {
		historyMaxLines: 7,
	});
	expect(result.content.split("\n").slice(0, 7)).toEqual(full.split("\n").slice(0, 7));
	expect(result.contentIncomplete).toBe(true);
});

it("keeps tool-result lookahead summaries identical in a bounded prefix", async () => {
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "example.ts" } }],
		},
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "alpha\nbeta" }],
		},
	];
	const full = await formatSessionHistoryMarkdownAsync(messages, { title: "fixture" });
	const tail = {
		role: "user",
		get content(): never {
			throw new Error("tail rendered");
		},
	};
	const prefix = await formatSessionHistoryMarkdownAsync([...messages, tail], { title: "fixture", maxLines: 5 });
	expect(prefix.split("\n").slice(0, 5)).toEqual(full.split("\n").slice(0, 5));
	expect(prefix).toContain("2 lines");
});

it("keeps the existing byte bound for a message used by the prefix", async () => {
	await expect(
		formatSessionHistoryMarkdownAsync([{ role: "user", content: "x".repeat(MAX_RECORD_BYTES + 1) }], { maxLines: 5 }),
	).rejects.toThrow("byte output cap");
});

it("lists disk transcript names without parsing their contents and reports unknown IDs", async () => {
	const temp = TempDir.createSync("history-bounded-index-");
	try {
		await fs.writeFile(temp.join("Scout.jsonl"), "not JSON, and not needed by the index");
		registerArtifactsDir(temp.path());
		const handler = new HistoryProtocolHandler();
		const index = await handler.resolve(parseInternalUrl("history://"));
		expect(index.content).toContain("| Scout | on disk |");
		await expect(handler.resolve(parseInternalUrl("history://Missing"))).rejects.toThrow("Unknown agent: Missing");
	} finally {
		temp.removeSync();
	}
});
