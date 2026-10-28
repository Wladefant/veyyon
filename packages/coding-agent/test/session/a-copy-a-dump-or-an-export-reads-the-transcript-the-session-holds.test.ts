/**
 * WHY THIS SUITE EXISTS. `/copy`, `/dump` and `/export` hand the transcript to someone outside the
 * session: the clipboard, a bug report, a file shared with another person. Each reads the session it
 * runs in, not a file on disk, so a reading that picked the wrong message, dropped the thinking level
 * the session runs at, sent the model's own message shapes where the provider gets converted ones, or
 * skipped the redaction a share asked for would hand over a transcript the session never sent, or a
 * secret it was told to hide.
 *
 * THE CLASS. What `TranscriptExports` reads for each reader, driven through a real `AgentSession`: the
 * last assistant text a copy picks up (joined, trimmed, an empty aborted turn skipped); the newest
 * visible handoff it falls back to; the dump's configuration and tool inventory, which the session's
 * `pruneToolDescriptions` moves into the system prompt; the request snapshot (thinking level, service
 * tier, wire tool fields only when set, converted messages, and nothing written for an empty
 * transcript); and the HTML export's working directory, embedded system prompt and redaction.
 *
 * WHAT IT DOES NOT CATCH. The HTML palette, which changes only the page's colours, and the rendering
 * each formatter applies; `session-dump-format.ts` and `export/html` own those.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, ThinkingLevel } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CustomMessage } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { requireBundledModel } from "../../../agent/test/helpers";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const SYSTEM_PROMPT = "You are the transcript export test.";
const SECRET = "sk-live-TRANSCRIPTLEAK-0123456789";

interface SessionOptions {
	readonly messages: AgentMessage[];
	readonly settings?: Partial<Record<SettingPath, unknown>>;
	readonly tools?: AgentTool[];
	readonly obfuscator?: SecretObfuscator;
	readonly pruneToolDescriptions?: boolean;
}

let tempDir: TempDir;
let authStorage: AuthStorage;
let session: AgentSession | undefined;
/** Files a test wrote outside its temporary directory, removed after it. */
const written: string[] = [];

beforeAll(async () => {
	tempDir = TempDir.createSync("@transcript-exports-");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	for (const file of written.splice(0)) fs.rmSync(file, { force: true });
});

afterAll(() => {
	authStorage?.close();
	tempDir?.removeSync();
});

/** A file-backed session whose agent holds `messages`; the user and assistant turns are on disk too. */
function openSession(options: SessionOptions): AgentSession {
	const cwd = tempDir.join(`project-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(cwd, { recursive: true });
	const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	for (const message of options.messages) {
		if (message.role === "user" || message.role === "assistant") sessionManager.appendMessage(message);
	}
	const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
	const agent = new Agent({
		initialState: { model, systemPrompt: [SYSTEM_PROMPT], tools: options.tools ?? [], messages: options.messages },
	});
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, ...options.settings }),
		modelRegistry: new ModelRegistry(authStorage),
		obfuscator: options.obfuscator,
		pruneToolDescriptions: options.pruneToolDescriptions,
	});
	return session;
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1_756_080_000 };
}

function assistantBlocks(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return { ...createAssistantMessage(""), content, stopReason };
}

function handoff(content: CustomMessage["content"], display: boolean, customType = "handoff"): CustomMessage {
	return { role: "custom", customType, content, display, attribution: "agent", timestamp: 1_756_080_000 };
}

const emptyObject = type("object");

function tool(name: string, extra?: Pick<AgentTool, "strict" | "customWireName">): AgentTool {
	return {
		name,
		label: name,
		description: `The ${name} tool.`,
		parameters: emptyObject,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		...extra,
	};
}

/** The request snapshot `/dump` writes, read back and removed with the test. */
async function snapshotOf(target: AgentSession): Promise<Record<string, unknown>> {
	const file = await target.dumpLlmRequestToTmpDir();
	if (!file) throw new Error("Expected a request snapshot file");
	written.push(file);
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** The JSON the exported page embeds, decoded the way its viewer decodes it. */
function exportedData(file: string): string {
	const html = fs.readFileSync(file, "utf8");
	const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html);
	if (!match) throw new Error("The exported page embeds no session data");
	return Buffer.from(match[1], "base64").toString("utf8");
}

describe("the text /copy picks up", () => {
	it("is the last assistant message's text joined and trimmed, past an aborted turn with no content", () => {
		const target = openSession({
			messages: [
				user("first"),
				createAssistantMessage("an older answer"),
				user("second"),
				assistantBlocks([
					{ type: "thinking", thinking: "weighing it" },
					{ type: "text", text: "  part one " },
					{ type: "text", text: "part two  " },
				]),
				assistantBlocks([], "aborted"),
			],
		});

		expect(target.getLastAssistantText()).toBe("part one part two");
		expect(target.hasCopyCandidateAssistantMessage()).toBe(true);
	});

	it("is nothing when the last assistant message holds no text, though the message is a candidate", () => {
		const target = openSession({
			messages: [user("first"), assistantBlocks([{ type: "thinking", thinking: "only thought" }])],
		});

		expect(target.getLastAssistantText()).toBeUndefined();
		expect(target.hasCopyCandidateAssistantMessage()).toBe(true);
	});

	it("is nothing, with no candidate, before any assistant message", () => {
		const target = openSession({ messages: [user("first")] });

		expect(target.getLastAssistantText()).toBeUndefined();
		expect(target.hasCopyCandidateAssistantMessage()).toBe(false);
	});
});

describe("the handoff a copy falls back to", () => {
	it("is the newest handoff shown in the transcript, past a hidden handoff and other custom messages", () => {
		const target = openSession({
			messages: [
				handoff("  the first handoff  ", true),
				handoff(
					[
						{ type: "text", text: "  the second " },
						{ type: "text", text: "handoff\n" },
					],
					true,
				),
				handoff("a notice shown after it", true, "notice"),
				handoff("a hidden handoff", false),
			],
		});

		expect(target.getLastVisibleHandoffText()).toBe("the second handoff");
	});

	it("is a handoff's text trimmed when it was stored as a string", () => {
		const target = openSession({ messages: [handoff("  the first handoff  ", true)] });

		expect(target.getLastVisibleHandoffText()).toBe("the first handoff");
	});
});

describe("the text /dump copies", () => {
	it("states the thinking level the session runs at and lists its tools", () => {
		const target = openSession({ messages: [user("first")], tools: [tool("probe")] });
		target.setThinkingLevel(ThinkingLevel.High);

		const text = target.formatSessionAsText();

		expect(text).toContain(SYSTEM_PROMPT);
		expect(text).toContain("Thinking Level: high");
		expect(text).toContain("## Available Tools");
	});

	it("leaves the tool list to the system prompt when the session prunes tool descriptions", () => {
		const target = openSession({ messages: [user("first")], tools: [tool("probe")], pruneToolDescriptions: true });

		expect(target.formatSessionAsText()).not.toContain("## Available Tools");
	});
});

describe("the request snapshot /dump writes", () => {
	it("holds the thinking level, the service tier, the wire tool fields that are set and the converted messages", async () => {
		const target = openSession({
			messages: [user("first"), createAssistantMessage("an answer"), handoff("carried context", true)],
			tools: [tool("alpha", { strict: true, customWireName: "alpha_wire" }), tool("beta")],
		});
		target.setThinkingLevel(ThinkingLevel.High);
		target.setServiceTierFamily("anthropic", "priority");

		const snapshot = await snapshotOf(target);

		expect(snapshot.thinkingLevel).toBe("high");
		expect(snapshot.serviceTier).toEqual({ anthropic: "priority" });
		expect(snapshot.systemPrompt).toEqual([SYSTEM_PROMPT]);
		const tools = snapshot.tools as Array<Record<string, unknown>>;
		expect(tools.map(entry => Object.keys(entry).sort())).toEqual([
			["customWireName", "description", "name", "parameters", "strict"],
			["description", "name", "parameters"],
		]);
		expect(tools[0]).toMatchObject({ name: "alpha", strict: true, customWireName: "alpha_wire" });
		const messages = snapshot.messages as Array<{ role: string }>;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "developer"]);
	});

	it("records no service tier when none is set", async () => {
		const target = openSession({ messages: [user("first")] });

		expect((await snapshotOf(target)).serviceTier).toBeNull();
	});

	it("is not written for a transcript with no messages", async () => {
		const target = openSession({ messages: [] });

		expect(await target.dumpLlmRequestToTmpDir()).toBeUndefined();
	});
});

describe("the HTML /export writes", () => {
	const SECRET_TURN = [user(`the key is ${SECRET}`), createAssistantMessage("noted")];

	it("resolves a relative path against the session's working directory and embeds the system prompt", async () => {
		const target = openSession({ messages: SECRET_TURN });
		const name = `transcript-${Math.random().toString(36).slice(2)}.html`;
		// A path resolved against the process instead would land here; removed either way.
		written.push(path.resolve(name));

		const file = await target.exportToHtml(name);

		expect(file).toBe(path.join(target.sessionManager.getCwd(), name));
		expect(exportedData(file)).toContain(SYSTEM_PROMPT);
	});

	it("hides a configured secret when shares redact secrets", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		const target = openSession({ messages: SECRET_TURN, obfuscator, settings: { "share.redactSecrets": true } });

		const data = exportedData(await target.exportToHtml(undefined));

		expect(data).not.toContain(SECRET);
		expect(data).toContain("the key is");
	});

	it("keeps the secret when shares are set to keep secrets", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		const target = openSession({ messages: SECRET_TURN, obfuscator, settings: { "share.redactSecrets": false } });

		expect(exportedData(await target.exportToHtml(undefined))).toContain(SECRET);
	});
});
