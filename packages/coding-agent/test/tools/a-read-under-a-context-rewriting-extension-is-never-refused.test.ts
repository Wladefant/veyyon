/**
 * A read is never refused while an extension `context` handler can rewrite what the model sees.
 *
 * THE DEFECT. `read` refuses a re-read whose rows an earlier result in the live messages still
 * displays. An extension `context` handler rewrites those messages on the way to every request
 * (`emitContext` in the request hooks), so the live messages stop stating what the model sees: a
 * handler that elides old read output leaves the model told to "work from" output it never received.
 *
 * THE CLASS. The production tool session reports no live messages while any extension handles
 * `context`, so no read is refused. This drives the real `createAgentSession`, its real tool session
 * and real `read` tool, with a scripted model, and asserts both arms: the same two reads are refused
 * with no handler and delivered with one.
 *
 * NOT COVERED. A handler registered by a request-level hook outside the extension runner; the session
 * exposes no such seam today.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolResultMessage } from "@veyyon/ai";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@veyyon/coding-agent/sdk";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const MOCK_API_SOURCE = "read-refusal-context-handler";
const ELIDED = "[read output elided by extension]";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	unregisterCustomApis(MOCK_API_SOURCE);
});

/** Replaces every read result's text before each request, the way a context-trimming extension does. */
const elideReads: ExtensionFactory = pi => {
	pi.on("context", event => ({
		messages: event.messages.map(message =>
			message.role === "toolResult" && message.toolName === "read"
				? { ...message, content: [{ type: "text" as const, text: ELIDED }] }
				: message,
		),
	}));
};

/** Run one turn in which the model reads `notes.txt` twice; return the read results and the model. */
async function readTwice(
	extension: ExtensionFactory | undefined,
): Promise<{ reads: ToolResultMessage<ReadToolDetails>[]; model: MockModel }> {
	const tempDir = TempDir.createSync("veyyon-read-refusal-context-");
	const agentDir = tempDir.join("profile");
	const cwd = tempDir.join("project");
	for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(cwd, "notes.txt"), "note 1\nnote 2\nnote 3\n");
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("mock", "mock-key");
	registerMockApi(MOCK_API_SOURCE);
	const readNotes = { content: [{ type: "toolCall" as const, name: "read", arguments: { path: "notes.txt" } }] };
	const model = createMockModel({ responses: [readNotes, readNotes], handler: { content: ["done"] } });
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({ "secrets.enabled": false, "compaction.enabled": false }),
		model,
		disableExtensionDiscovery: true,
		extensions: extension ? [extension] : [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
	});
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	await session.prompt("read the notes twice");
	await session.waitForIdle();
	const reads = session.agent.state.messages.filter(
		(message): message is ToolResultMessage<ReadToolDetails> =>
			message.role === "toolResult" && message.toolName === "read",
	);
	expect(reads).toHaveLength(2);
	return { reads, model };
}

function refused(result: ToolResultMessage<ReadToolDetails>): boolean {
	return (
		result.isError === true &&
		result.content.some(block => block.type === "text" && block.text.startsWith("Read refused:"))
	);
}

describe("a read under an extension context handler", () => {
	it("is refused when no extension handles context", async () => {
		const { reads } = await readTwice(undefined);
		expect(reads.map(refused)).toEqual([false, true]);
	});

	it("is delivered when an extension rewrites the read output the model sees", async () => {
		const { reads, model } = await readTwice(elideReads);
		// The handler ran: the request after the first read carried the elided text, not the rows.
		const sentResults = (model.calls[1]?.context.messages ?? []).filter(message => message.role === "toolResult");
		expect(sentResults.map(message => message.content)).toEqual([[{ type: "text", text: ELIDED }]]);
		expect(reads.map(refused)).toEqual([false, false]);
		expect(reads[1]!.content.map(block => (block.type === "text" ? block.text : "")).join("\n")).toContain("note 2");
	});
});
