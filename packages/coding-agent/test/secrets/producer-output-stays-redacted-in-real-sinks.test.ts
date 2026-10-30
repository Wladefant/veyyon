/**
 * WHY: producer output was redacted before it left the tool wrapper, but no test followed that
 * same result into the session journal, HTML export, and provider-shaped messages. A later provider
 * redactor can hide a leak in a test that checks only the final request.
 *
 * This test closes that sink gap with a real SecretObfuscator, wrapped synthetic tool, SessionManager
 * JSONL file, HTML exporter, and provider message conversion with no provider redactor. The unsafe
 * control proves the same sinks can expose the canary when producer protection is absent.
 *
 * WHAT IT DOES NOT CATCH: this does not run the full compaction summarizer/provider call. The
 * available compaction fixtures require an AgentSession turn and remote/model setup; this test does
 * not invent a fake compaction path.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { runWithProducerSecretOwner } from "@veyyon/coding-agent/secrets/producer-owner";
import { obfuscateProviderPayload } from "@veyyon/coding-agent/session/agent-session-provider-request";
import { wrapToolWithMetaNotice } from "@veyyon/coding-agent/tools/core/output-meta";
import { exportFromFile } from "../../src/export/html";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const CANARY = "synthetic-producer-sink-canary-73f1b4";
const PLACEHOLDER = "#PRODUCER_CANARY#";
let tempDir: TempDir | undefined;

afterEach(async () => {
	await tempDir?.remove();
	tempDir = undefined;
});

function toolResult(content: string, details: unknown): AgentToolResult {
	return {
		content: [{ type: "text", text: content }],
		details,
	};
}

async function persistResult(manager: SessionManager, result: AgentToolResult): Promise<void> {
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "synthetic-call",
		toolName: "synthetic",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: 1,
	});
}

async function exportedSnapshot(outputPath: string): Promise<string> {
	const html = await fs.readFile(outputPath, "utf8");
	const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html);
	if (!match) throw new Error("HTML export has no session-data snapshot");
	return Buffer.from(match[1]!, "base64").toString("utf8");
}

describe("producer output remains redacted in actual downstream sinks", () => {
	it("persists, exports, and converts safe output without depending on provider masking", async () => {
		tempDir = TempDir.createSync("producer-sink-safe-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("SessionManager did not create a session file");
		const obfuscator = new SecretObfuscator([
			{ type: "plain", origin: "config", content: CANARY, name: "PRODUCER_CANARY" },
		]);
		const owner = {
			redact: (text: string) => obfuscator.obfuscate(text),
			pendingPrefixLength: (text: string) => obfuscator.pendingRedactionPrefixLength(text),
		};
		const updates: AgentToolResult[] = [];
		const original = {
			name: "synthetic",
			description: "synthetic output sink test",
			parameters: {},
			execute: async (
				_id: string,
				_params: unknown,
				_signal?: AbortSignal,
				onUpdate?: (result: AgentToolResult) => void,
			) => {
				const result = toolResult(`content ${CANARY}`, { nested: `details ${CANARY}` });
				onUpdate?.(toolResult(`progress ${CANARY}`, { nested: `progress details ${CANARY}` }));
				return result;
			},
		} as unknown as AgentTool;
		const wrapped = wrapToolWithMetaNotice(original);
		const result = await runWithProducerSecretOwner(owner, () =>
			wrapped.execute("synthetic-call", {} as never, undefined, update => updates.push(update)),
		);

		expect(updates).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain(CANARY);
		expect(JSON.stringify(updates)).not.toContain(CANARY);
		expect(JSON.stringify(result)).toContain(PLACEHOLDER);
		await persistResult(manager, result);
		const journal = await fs.readFile(sessionFile, "utf8");
		expect(journal).not.toContain(CANARY);
		expect(journal).toContain(PLACEHOLDER);

		const outputPath = path.join(tempDir.path(), "safe.html");
		await exportFromFile(sessionFile, { outputPath });
		const snapshot = await exportedSnapshot(outputPath);
		expect(snapshot).not.toContain(CANARY);
		expect(snapshot).toContain(PLACEHOLDER);

		const providerPayload = obfuscateProviderPayload(
			{ messages: [{ role: "user", content: JSON.stringify(result), timestamp: 1 }] },
			undefined,
		);
		expect(JSON.stringify(providerPayload)).not.toContain(CANARY);
		expect(JSON.stringify(providerPayload)).toContain(PLACEHOLDER);
	});

	it("shows the raw canary in test-owned sinks when the wrapper has no owner", async () => {
		tempDir = TempDir.createSync("producer-sink-unsafe-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("SessionManager did not create a session file");
		const original = {
			name: "synthetic",
			description: "synthetic output sink test",
			parameters: {},
			execute: async () => toolResult(`content ${CANARY}`, { nested: CANARY }),
		} as unknown as AgentTool;
		const result = await wrapToolWithMetaNotice(original).execute("synthetic-call", {} as never);
		expect(JSON.stringify(result)).toContain(CANARY);
		await persistResult(manager, result);
		const journal = await fs.readFile(sessionFile, "utf8");
		expect(journal).toContain(CANARY);
		const outputPath = path.join(tempDir.path(), "unsafe.html");
		await exportFromFile(sessionFile, { outputPath });
		expect(await exportedSnapshot(outputPath)).toContain(CANARY);
	});
});
