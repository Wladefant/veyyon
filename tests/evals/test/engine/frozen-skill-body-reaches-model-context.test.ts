/**
 * WHY: Registering a Skill in AgentSession only exposes its metadata; unless the real hidden
 * autoload message reaches model context, baseline and treatment trials can run the same prompt.
 * This test drives the production append boundary through a real AgentSession and mock provider.
 *
 * WHAT IT DOES NOT CATCH: provider-specific request serialization or createAgentSession startup
 * wiring. The mock inspects AgentSession's actual model context, not an HTTP request body.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { appendFrozenSkillPrompt, observeFrozenSkillPrompt } from "../../backends/in-process/client";
import { buildSkillArms } from "../../engine/skills/arms";

const BASE_CONTENT = "Baseline-only context.";
const OMITTED_CONTENT = "Treatment-only phrase: maple compass.";
const fullContent = `${BASE_CONTENT}\n${OMITTED_CONTENT}\n`;
const [baseline, full, ablation] = buildSkillArms({
	version: 1,
	skillName: "frozen-eval-skill",
	sourceHash: createHash("sha256").update(fullContent).digest("hex"),
	content: fullContent,
	components: [{ name: "treatment-note", content: `${OMITTED_CONTENT}\n` }],
});

const CORE_SYSTEM_PROMPT = "Unmodified core system prompt sentinel.";

describe("frozen skill body reaches the in-process model context", () => {
	it("keeps baseline absent and delivers exact full or ablated bodies without changing system prompt", async () => {
		if (!baseline || !full || !ablation) throw new Error("expected baseline, full, and ablation arms");
		for (const arm of [baseline, full, ablation]) {
			const temp = await TempDir.create("eval-frozen-skill-message-");
			let authStorage: AuthStorage | undefined;
			let session: AgentSession | undefined;
			try {
				const cwd = temp.path();
				const skillDir = path.join(cwd, "frozen-eval-skill");
				await fs.mkdir(skillDir, { recursive: true });
				const filePath = path.join(skillDir, "SKILL.md");
				if (arm.content !== null) await fs.writeFile(filePath, arm.content, "utf8");
				const skill =
					arm.content === null
						? []
						: [
								{
									name: arm.skillName,
									description: "Frozen experiment resource",
									filePath,
									baseDir: skillDir,
									source: "eval-experiment",
								},
							];
				const mock = createMockModel({ handler: { content: ["done"] } });
				const agent = new Agent({
					getApiKey: () => "test-key",
					initialState: { model: mock.model, systemPrompt: [CORE_SYSTEM_PROMPT], tools: [] },
					streamFn: mock.stream,
					convertToLlm,
				});
				authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
				authStorage.setRuntimeApiKey("mock", "test-key");
				session = new AgentSession({
					agent,
					sessionManager: SessionManager.inMemory(cwd),
					settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
					modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
					skills: skill,
				});
				if (arm.content !== null) {
					await expect(observeFrozenSkillPrompt(session, arm)).rejects.toThrow(
						"body is absent from model history",
					);
				}
				await appendFrozenSkillPrompt(session, arm);
				const receipt = await observeFrozenSkillPrompt(session, arm);
				expect(receipt.present).toBe(arm.content !== null);
				expect(receipt.contentHash).toBe(arm.content === null ? null : arm.contentHash);
				expect(session.systemPrompt).toEqual([CORE_SYSTEM_PROMPT]);
				expect(session.agent.state.messages.filter(message => message.role === "developer")).toHaveLength(
					arm.content === null ? 0 : 1,
				);
				await session.prompt("Respond with done.");
				await session.waitForIdle();
				const modelContext = mock.calls[0]?.context;
				expect(modelContext).toBeDefined();
				expect(modelContext?.systemPrompt).toContain(CORE_SYSTEM_PROMPT);
				const requestMessages = JSON.stringify(modelContext?.messages);
				if (arm.kind === "full") expect(requestMessages).toContain(OMITTED_CONTENT);
				else expect(requestMessages).not.toContain(OMITTED_CONTENT);
				if (arm.content !== null)
					expect(requestMessages).toContain(JSON.stringify(arm.content.trim()).slice(1, -1));
			} finally {
				if (session) await session.dispose();
				authStorage?.close();
				await temp.remove();
			}
		}
	});
});
