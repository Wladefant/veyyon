import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadSkillsFromDir } from "@veyyon/coding-agent/extensibility/skills";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import { resolveAutoloadSkills } from "@veyyon/coding-agent/task/inherited-collections";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { YIELD_TOOL_NAME } from "@veyyon/coding-agent/task/subprocess-tool-registry";
import { TempDir } from "@veyyon/utils";
import { asGlobalFetch } from "../helpers/fetch-mock";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

const SKILL_NAME = "qa-first-turn";
const SKILL_BODY = "QA_AUTOLOAD_SKILL_BODY_762: preserve this exact test-only instruction.";
const TASK_PROMPT = "Complete the temporary QA task after reading its autoloaded skill.";

interface AnthropicMessage {
	role: string;
	content: unknown;
}

interface AnthropicRequest {
	system: unknown;
	messages: AnthropicMessage[];
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			part !== null && typeof part === "object" &&
				"type" in part && part.type === "text" &&
				"text" in part && typeof part.text === "string")
		.map(part => part.text)
		.join("\n");
}

function yieldToolResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_mock_autoload",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_mock_yield", name: YIELD_TOOL_NAME, input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"result":{"data":"done"}}' },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("task skill autoload provider-context boundary", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the loaded skill body in the real child's first provider request", async () => {
		const temp = TempDir.createSync("@veyyon-task-autoload-first-turn-");
		let auth: AuthStorage | undefined;
		try {
			const projectDir = temp.path();
			const skillsDir = path.join(projectDir, ".qa-skills");
			const skillDir = path.join(skillsDir, SKILL_NAME);
			const artifactsDir = path.join(projectDir, "artifacts");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.mkdir(artifactsDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---\nname: ${SKILL_NAME}\ndescription: Temporary first-turn regression skill\nhide: true\n---\n\n${SKILL_BODY}\n`,
			);
			const loaded = await loadSkillsFromDir({ dir: skillsDir, source: "test:project" });
			const skill = loaded.skills.find(candidate => candidate.name === SKILL_NAME);
			if (!skill) throw new Error(`Expected temporary skill ${SKILL_NAME} to load`);

			auth = await AuthStorage.create(path.join(projectDir, "auth.db"));
			auth.setRuntimeApiKey("anthropic", "mock-only-key");
			const modelRegistry = new ModelRegistry(auth, path.join(projectDir, "models.yml"));
			const agent: AgentDefinition = {
				name: "task",
				description: "temporary task agent",
				systemPrompt: "Complete the task using the supplied skill.",
				source: "bundled",
				tools: [YIELD_TOOL_NAME],
				autoloadSkills: [SKILL_NAME],
				skillList: "none",
			};
			const autoloadSkills = resolveAutoloadSkills<typeof skill>(agent.autoloadSkills, undefined, agent.name);
			const providerRequests: string[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				if (!url.startsWith("https://api.anthropic.com/v1/messages")) {
					throw new Error(`Unexpected request escaped provider-only mock: ${url}`);
				}
				const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
				if (typeof rawBody !== "string") throw new Error("Anthropic request body was not text");
				providerRequests.push(rawBody);
				return yieldToolResponse();
			}));

			const result = await runSubprocess({
				cwd: projectDir,
				agent,
				task: TASK_PROMPT,
				description: "QA task",
				index: 0,
				id: "qa-task-autoload-first-turn",
				modelOverride: "anthropic/claude-sonnet-4-5",
				authStorage: auth,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false }),
				artifactsDir,
				skills: [skill],
				autoloadSkills,
				enableLsp: false,
				keepAlive: false,
				maxRuntimeMs: 15_000,
			});

			expect(result.exitCode).toBe(0);
			expect(providerRequests).toHaveLength(1);
			const firstRequest = JSON.parse(providerRequests[0]!) as AnthropicRequest;
			const requestMessages = firstRequest.messages.map(message => ({
				role: message.role,
				text: textContent(message.content),
			}));
			const skillMessages = requestMessages.filter(message => message.text.includes(SKILL_BODY));
			expect(skillMessages).toHaveLength(1);
			expect(requestMessages.map(message => message.text).join("\n")).toContain(TASK_PROMPT);
			expect(textContent(firstRequest.system)).not.toContain(SKILL_BODY);
		} finally {
			auth?.close();
			temp.removeSync();
		}
	});
});
