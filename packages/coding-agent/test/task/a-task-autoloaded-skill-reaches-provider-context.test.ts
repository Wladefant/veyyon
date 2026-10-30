/**
 * WHY: unit tests that replace createAgentSession cannot catch a custom skill message that is
 * persisted correctly but filtered out of the provider request. This probe follows a real child
 * session from an actual SKILL.md through streamSimple and back through the persisted transcript.
 *
 * NOT CAUGHT: a real provider endpoint, compaction (disabled to keep the history observable), and
 * unrelated message kinds beyond the ordinary user skill and developer controls asserted here.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Context, Message } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as aiStream from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { Skill } from "@veyyon/coding-agent/extensibility/skills";
import { buildSessionContext } from "@veyyon/kernel/session/session-context";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "@veyyon/coding-agent/session/messages";
import { createCustomMessage } from "@veyyon/agent-core/compaction/messages";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import { YIELD_TOOL_NAME } from "@veyyon/coding-agent/task/subprocess-tool-registry";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { sessionFileName } from "@veyyon/utils/session-file";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
useIsolatedAgentDir();

function messageText(message: Message): string {
	return typeof message.content === "string"
		? message.content
		: message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

describe("an autoloaded skill reaches a child agent's provider context", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("keeps autoloaded skill content and provenance through provider conversion and session rebuild", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-autoload-context-"));
		const skillDir = path.join(tempDir, "skills", "custom-context");
		await fs.mkdir(skillDir, { recursive: true });
		const body = "Use the narrowest safe change.\nPreserve the caller's intent.";
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.writeFile(skillPath, `---\nname: custom-context\ndescription: Context probe\n---\n\n${body}\n`, "utf8");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.modelFallback": false,
			"retry.maxRetries": 0,
		});
		settings.setDefaultModel(`${model.provider}/${model.id}`);
		const skill: Skill = {
			name: "custom-context",
			description: "Context probe",
			filePath: skillPath,
			baseDir: skillDir,
			source: "user",
		};
		let providerContext: Context | undefined;
		vi.spyOn(aiStream, "streamSimple").mockImplementation((_model, context) => {
			providerContext = context;
			const message = {
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "yield-call", name: YIELD_TOOL_NAME, arguments: { data: { ok: true } } }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse" as const,
				usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...message, content: [] } });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
			});
			return stream;
		});

		const agent: AgentDefinition = { name: "task", description: "Context probe", systemPrompt: "Follow the task instructions.", source: "bundled" };
		const result = await runSubprocess({
			cwd: tempDir,
			agent,
			task: "Inspect the skill instructions and report completion.",
			description: "Context probe",
			index: 0,
			id: "skill-context-probe",
			settings,
			modelRegistry,
			artifactsDir: tempDir,
			modelOverride: `${model.provider}/${model.id}`,
			enableLsp: false,
			skills: [skill],
			autoloadSkills: { kind: "resolved", skills: [skill] },
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
			maxRuntimeMs: 10_000,
		});
		expect(result.exitCode).toBe(0);
		expect(providerContext).toBeDefined();
		const skillPrompt = body;
		const inProvider = providerContext!.messages.filter(message => messageText(message).includes(skillPrompt));
		expect(inProvider).toHaveLength(1);
		expect(inProvider[0]).toMatchObject({ role: "developer", attribution: "agent" });
		const providerSkillText = messageText(inProvider[0]!);
		expect(providerSkillText).toContain(body);
		expect(providerSkillText.split(body)).toHaveLength(2);
		expect(providerContext!.messages.find(message =>
			messageText(message).includes("Inspect the skill instructions"),
		)).toMatchObject({ role: "user", attribution: "agent" });
		expect(convertToLlm([
			createCustomMessage(SKILL_PROMPT_MESSAGE_TYPE, body, false, undefined, new Date().toISOString(), "user"),
			createCustomMessage("ordinary-custom", "Keep this developer note.", false, undefined, new Date().toISOString(), "agent"),
		])).toMatchObject([
			{ role: "user", attribution: "user", content: [{ type: "text", text: body }] },
			{ role: "developer", attribution: "agent", content: [{ type: "text", text: "Keep this developer note." }] },
		]);
		const sessionPath = path.join(tempDir, sessionFileName("skill-context-probe"));
		const sessionManager = await SessionManager.open(sessionPath, tempDir);
		const rebuilt = buildSessionContext(sessionManager.getEntries());
		const skillHistory = rebuilt.messages.filter(
			message => message.role === "custom" && typeof message.content === "string" && message.content.includes(skillPrompt),
		);
		expect(skillHistory).toHaveLength(1);
		expect(skillHistory[0]).toMatchObject({ role: "custom", customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "agent" });
		const rebuiltSkill = convertToLlm(rebuilt.messages).filter(message => messageText(message).includes(body));
		expect(rebuiltSkill).toHaveLength(1);
		expect(rebuiltSkill[0]).toMatchObject({ role: "developer", attribution: "agent" });
		expect(messageText(rebuiltSkill[0]!)).toBe(providerSkillText);
		expect(rebuilt.messages.find(message => message.role === "user" &&
			(typeof message.content === "string" ? message.content : message.content.map(block => block.type === "text" ? block.text : "").join("\n"))
				.includes("Inspect the skill instructions"),
		)).toMatchObject({ role: "user", attribution: "agent" });
	}, 30_000);
});
