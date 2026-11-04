/**
 * Regression coverage for live /reload-config rules reload.
 *
 * Contract:
 *   - ProjectPromptInputs.refresh(force = false): Promise<void>
 *   - force=true forces re-discovery of project inputs (context files, skills, rules)
 *     even when the live cwd matches the rendered snapshot cwd.
 *   - force=false (or omitted) preserves the existing fast short-circuit when
 *     liveCwd === snapshot.cwd.
 *   - When AGENTS.md or other context files are edited, added, or removed in the same
 *     cwd, calling inputs.refresh(true) re-runs discovery via loadProjectContextFiles
 *     and updates the prompt snapshot, allowing buildSystemPrompt to reflect new rules.
 *   - When discovery throws during a forced refresh, the previous valid snapshot
 *     is preserved, and a subsequent forced refresh can recover.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import type { Skill } from "@veyyon/coding-agent/extensibility/skills";
import { discoverRules, type ProjectInputDiscovery } from "@veyyon/coding-agent/session/factory-extensions";
import { ProjectPromptInputs, type ProjectPromptSnapshot } from "@veyyon/coding-agent/session/prompt-inputs";
import { buildSystemPrompt, loadProjectContextFiles } from "@veyyon/coding-agent/system-prompt";
import type { ContextFileEntry } from "@veyyon/coding-agent/tools";
import { TempDir } from "@veyyon/utils";

function makeSkill(name: string, description: string, baseDir: string): Skill {
	return {
		name,
		description,
		filePath: path.join(baseDir, name, "SKILL.md"),
		baseDir,
		source: "test",
	};
}

function emptySnapshot(
	cwd: string,
	contextFiles: ContextFileEntry[] = [],
	skills: Skill[] = [],
): ProjectPromptSnapshot {
	return {
		cwd,
		contextFiles,
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		activeRepoContext: null,
		nonProjectCwd: null,
		skills,
		rulebookRules: [],
		alwaysApplyRules: [],
	};
}

describe("rules reload refreshes project prompt inputs", () => {
	it("does not re-discover when force is omitted or false and cwd is unchanged", async () => {
		using dir = TempDir.createSync("@reload-rules-unforced-");
		using agentDir = TempDir.createSync("@reload-rules-agent-unforced-");
		const cwd = dir.path();
		const agentsPath = path.join(cwd, "AGENTS.md");

		fs.writeFileSync(agentsPath, "# Original Rules\nmarker: original-unforced-rule-alpha\n");
		const initialFiles = await loadProjectContextFiles({ cwd, agentDir: agentDir.path() });

		let discoveryCount = 0;
		const discover = (target: string): ProjectInputDiscovery => {
			discoveryCount++;
			return {
				cwd: target,
				contextFiles: loadProjectContextFiles({ cwd: target, agentDir: agentDir.path() }),
				workspaceTree: Promise.resolve({
					rootPath: target,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				}),
				activeRepoContext: Promise.resolve(null),
				nonProjectCwd: Promise.resolve(null),
				skills: Promise.resolve({ skills: [], warnings: [] }),
				rules: Promise.resolve([]),
				watchdogFiles: Promise.resolve([]),
				advisors: Promise.resolve({ advisors: [], sharedInstructions: undefined }),
			};
		};

		const inputs = new ProjectPromptInputs({
			initial: emptySnapshot(cwd, initialFiles),
			getCwd: () => cwd,
			discover,
			ttsrManager: new TtsrManager(undefined, { getCwd: () => cwd }),
			ttsrOptions: () => ({}),
			onChange: () => {},
		});

		const initialPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		expect(initialPrompt.systemPrompt.join("\n")).toContain("marker: original-unforced-rule-alpha");

		// Modify AGENTS.md on disk
		fs.writeFileSync(agentsPath, "# Modified Rules\nmarker: ignored-modification-beta\n");

		// An unforced refresh should short-circuit because live cwd === snapshot cwd
		await inputs.refresh();
		await inputs.refresh(false);

		expect(discoveryCount).toBe(0);
		const unchangedPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		expect(unchangedPrompt.systemPrompt.join("\n")).toContain("marker: original-unforced-rule-alpha");
		expect(unchangedPrompt.systemPrompt.join("\n")).not.toContain("marker: ignored-modification-beta");
	});

	it("re-reads modified AGENTS.md on forced refresh in the same cwd", async () => {
		using dir = TempDir.createSync("@reload-rules-modified-");
		using agentDir = TempDir.createSync("@reload-rules-agent-modified-");
		const cwd = dir.path();
		const agentsPath = path.join(cwd, "AGENTS.md");

		fs.writeFileSync(agentsPath, "# Original Instructions\nmarker: initial-old-rule-marker-7812\nRules body text.\n");
		const initialFiles = await loadProjectContextFiles({ cwd, agentDir: agentDir.path() });

		let discoveryCount = 0;
		const discover = (target: string): ProjectInputDiscovery => {
			discoveryCount++;
			return {
				cwd: target,
				contextFiles: loadProjectContextFiles({ cwd: target, agentDir: agentDir.path() }),
				workspaceTree: Promise.resolve({
					rootPath: target,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				}),
				activeRepoContext: Promise.resolve(null),
				nonProjectCwd: Promise.resolve(null),
				skills: Promise.resolve({ skills: [], warnings: [] }),
				rules: Promise.resolve([]),
				watchdogFiles: Promise.resolve([]),
				advisors: Promise.resolve({ advisors: [], sharedInstructions: undefined }),
			};
		};

		const inputs = new ProjectPromptInputs({
			initial: emptySnapshot(cwd, initialFiles),
			getCwd: () => cwd,
			discover,
			ttsrManager: new TtsrManager(undefined, { getCwd: () => cwd }),
			ttsrOptions: () => ({}),
			onChange: () => {},
		});

		const initialPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		const initialText = initialPrompt.systemPrompt.join("\n");
		expect(initialText).toContain("marker: initial-old-rule-marker-7812");
		expect(initialText).not.toContain("marker: reloaded-new-rule-marker-9934");

		// Edit AGENTS.md on disk with the new marker
		fs.writeFileSync(
			agentsPath,
			"# Updated Instructions\nmarker: reloaded-new-rule-marker-9934\nFresh rules active.\n",
		);

		// Trigger forced refresh in the same cwd
		await inputs.refresh(true);

		const rebuiltPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		const rebuiltText = rebuiltPrompt.systemPrompt.join("\n");

		// Behavioral assertions: new marker must be present, old marker must be gone
		expect(rebuiltText).toContain("marker: reloaded-new-rule-marker-9934");
		expect(rebuiltText).not.toContain("marker: initial-old-rule-marker-7812");
		expect(discoveryCount).toBeGreaterThan(0);

		fs.unlinkSync(agentsPath);
		fs.mkdirSync(agentsPath);
		const failedReload = await inputs.reload();
		expect(inputs.current.contextFiles.find(file => file.path === agentsPath)?.content).toContain(
			"marker: reloaded-new-rule-marker-9934",
		);
		expect(failedReload.join("\n")).toContain("keeping the previous rules and skills");
		expect(failedReload.join("\n")).not.toContain("No longer in effect");
		fs.rmdirSync(agentsPath);
		fs.writeFileSync(agentsPath, "RECOVERED_RULE\n");
		await inputs.reload();
		expect(inputs.current.contextFiles.find(file => file.path === agentsPath)?.content).toContain("RECOVERED_RULE");
	});

	it("re-discovers newly added and deleted context files in the same cwd on forced refresh", async () => {
		using dir = TempDir.createSync("@reload-rules-add-remove-");
		using agentDir = TempDir.createSync("@reload-rules-agent-add-remove-");
		const cwd = dir.path();
		const agentsPath = path.join(cwd, "AGENTS.md");
		const claudePath = path.join(agentDir.path(), "AGENTS.md");

		fs.writeFileSync(agentsPath, "# Base Rules\nmarker: base-agents-marker-4011\n");
		const initialFiles = await loadProjectContextFiles({ cwd, agentDir: agentDir.path() });

		const discover = (target: string): ProjectInputDiscovery => ({
			cwd: target,
			contextFiles: loadProjectContextFiles({ cwd: target, agentDir: agentDir.path() }),
			workspaceTree: Promise.resolve({
				rootPath: target,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			}),
			activeRepoContext: Promise.resolve(null),
			nonProjectCwd: Promise.resolve(null),
			skills: Promise.resolve({ skills: [], warnings: [] }),
			rules: Promise.resolve([]),
			watchdogFiles: Promise.resolve([]),
			advisors: Promise.resolve({ advisors: [], sharedInstructions: undefined }),
		});

		const inputs = new ProjectPromptInputs({
			initial: emptySnapshot(cwd, initialFiles),
			getCwd: () => cwd,
			discover,
			ttsrManager: new TtsrManager(undefined, { getCwd: () => cwd }),
			ttsrOptions: () => ({}),
			onChange: () => {},
		});

		const initialPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		expect(initialPrompt.systemPrompt.join("\n")).toContain("marker: base-agents-marker-4011");

		// Add the profile layer without replacing the project's higher-priority file.
		fs.writeFileSync(claudePath, "# Claude Guidelines\nmarker: added-claude-marker-5022\n");
		await inputs.refresh(true);

		const withAddedPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		const withAddedText = withAddedPrompt.systemPrompt.join("\n");
		expect(withAddedText).toContain("marker: added-claude-marker-5022");
		expect(withAddedText).toContain("marker: base-agents-marker-4011");

		// Remove the profile layer.
		fs.unlinkSync(claudePath);
		await inputs.refresh(true);

		const afterRemovedPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		const afterRemovedText = afterRemovedPrompt.systemPrompt.join("\n");
		expect(afterRemovedText).not.toContain("marker: added-claude-marker-5022");
		expect(afterRemovedText).toContain("marker: base-agents-marker-4011");

		const invalidNewLayer = path.join(cwd, ".veyyon", "AGENTS.md");
		fs.mkdirSync(invalidNewLayer, { recursive: true });
		const failedReload = await inputs.reload();
		expect(failedReload.join("\n")).toContain(invalidNewLayer);
		expect(failedReload.join("\n")).toContain("keeping the previous rules and skills");
		expect(inputs.current.contextFiles.find(file => file.path === agentsPath)?.content).toContain(
			"marker: base-agents-marker-4011",
		);
		fs.rmdirSync(invalidNewLayer);
		fs.writeFileSync(invalidNewLayer, "FIXED_NEW_LAYER\n");
		expect((await inputs.reload()).join("\n")).toContain(`Rule files and skills now in effect: ${invalidNewLayer}`);
	});

	it("updates skills on forced refresh in the same cwd", async () => {
		using dir = TempDir.createSync("@reload-rules-skills-");
		using agentDir = TempDir.createSync("@reload-rules-agent-skills-");
		const cwd = dir.path();
		const agentsPath = path.join(cwd, "AGENTS.md");
		fs.writeFileSync(agentsPath, "# Rules\nmarker: skills-test-marker-1001\n");

		let currentSkills: Skill[] = [makeSkill("alpha-skill", "Alpha description", cwd)];
		const skillPath = currentSkills[0].filePath;
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(skillPath, "Initial skill body\n");

		const discover = (target: string): ProjectInputDiscovery => ({
			cwd: target,
			contextFiles: loadProjectContextFiles({ cwd: target, agentDir: agentDir.path() }),
			workspaceTree: Promise.resolve({
				rootPath: target,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			}),
			activeRepoContext: Promise.resolve(null),
			nonProjectCwd: Promise.resolve(null),
			skills: Promise.resolve({ skills: currentSkills, warnings: [] }),
			rules: Promise.resolve([]),
			watchdogFiles: Promise.resolve([]),
			advisors: Promise.resolve({ advisors: [], sharedInstructions: undefined }),
		});

		const inputs = new ProjectPromptInputs({
			initial: emptySnapshot(cwd, await loadProjectContextFiles({ cwd, agentDir: agentDir.path() }), currentSkills),
			getCwd: () => cwd,
			discover,
			ttsrManager: new TtsrManager(undefined, { getCwd: () => cwd }),
			ttsrOptions: () => ({}),
			onChange: () => {},
		});

		const initialPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		expect(initialPrompt.systemPrompt.join("\n")).toContain("alpha-skill");
		expect(inputs.current.skills.map(s => s.name)).toEqual(["alpha-skill"]);

		fs.writeFileSync(skillPath, "Updated skill body with unchanged metadata\n");
		expect((await inputs.reload()).join("\n")).toContain(`Changed rule files and skills: ${skillPath}`);

		// Update skills in place
		currentSkills = [makeSkill("beta-skill", "Beta description", cwd)];
		await inputs.refresh(true);

		const updatedPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		const updatedText = updatedPrompt.systemPrompt.join("\n");
		expect(updatedText).toContain("beta-skill");
		expect(updatedText).not.toContain("alpha-skill");
		expect(inputs.current.skills.map(s => s.name)).toEqual(["beta-skill"]);
	});

	it("recovers on subsequent refresh when a forced discovery fails", async () => {
		using dir = TempDir.createSync("@reload-rules-failure-recovery-");
		using agentDir = TempDir.createSync("@reload-rules-agent-failure-recovery-");
		const cwd = dir.path();
		const agentsPath = path.join(cwd, "AGENTS.md");

		fs.writeFileSync(agentsPath, "# Rules\nmarker: initial-recovery-marker-3301\n");
		const initialFiles = await loadProjectContextFiles({ cwd, agentDir: agentDir.path() });

		let shouldFail = false;
		const discover = (target: string): ProjectInputDiscovery => {
			if (shouldFail) {
				return {
					cwd: target,
					contextFiles: Promise.reject(new Error("forced discovery failed: simulated disk read error")),
					workspaceTree: Promise.resolve({
						rootPath: target,
						rendered: "",
						truncated: false,
						totalLines: 0,
						agentsMdFiles: [],
					}),
					activeRepoContext: Promise.resolve(null),
					nonProjectCwd: Promise.resolve(null),
					skills: Promise.resolve({ skills: [], warnings: [] }),
					rules: Promise.resolve([]),
					watchdogFiles: Promise.resolve([]),
					advisors: Promise.resolve({ advisors: [], sharedInstructions: undefined }),
				};
			}
			return {
				cwd: target,
				contextFiles: loadProjectContextFiles({ cwd: target, agentDir: agentDir.path() }),
				workspaceTree: Promise.resolve({
					rootPath: target,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				}),
				activeRepoContext: Promise.resolve(null),
				nonProjectCwd: Promise.resolve(null),
				skills: Promise.resolve({ skills: [], warnings: [] }),
				rules: Promise.resolve([]),
				watchdogFiles: Promise.resolve([]),
				advisors: Promise.resolve({ advisors: [], sharedInstructions: undefined }),
			};
		};

		const inputs = new ProjectPromptInputs({
			initial: emptySnapshot(cwd, initialFiles),
			getCwd: () => cwd,
			discover,
			ttsrManager: new TtsrManager(undefined, { getCwd: () => cwd }),
			ttsrOptions: () => ({}),
			onChange: () => {},
		});

		// Trigger failed forced refresh
		shouldFail = true;
		fs.writeFileSync(agentsPath, "# Rules\nmarker: failed-marker-not-installed\n");

		await expect(inputs.refresh(true)).rejects.toThrow("forced discovery failed: simulated disk read error");

		// Prior snapshot must remain intact after discovery failure
		expect(inputs.current.contextFiles[0]?.content).toContain("marker: initial-recovery-marker-3301");

		// Recovery: subsequent forced refresh succeeds
		shouldFail = false;
		fs.writeFileSync(agentsPath, "# Rules\nmarker: recovered-success-marker-4402\n");
		await inputs.refresh(true);

		const recoveredPrompt = await buildSystemPrompt({
			...inputs.promptOptions(),
			agentDir: agentDir.path(),
		});
		expect(recoveredPrompt.systemPrompt.join("\n")).toContain("marker: recovered-success-marker-4402");
		expect(recoveredPrompt.systemPrompt.join("\n")).not.toContain("marker: initial-recovery-marker-3301");
	});

	it("keeps the last good rule snapshot when RULES.md frontmatter becomes malformed", async () => {
		using dir = TempDir.createSync("@reload-rules-malformed-");
		using agentDir = TempDir.createSync("@reload-rules-malformed-profile-");
		const cwd = dir.path();
		const rulePath = path.join(agentDir.path(), "RULES.md");
		fs.writeFileSync(rulePath, "---\nalwaysApply: true\n---\nLAST_GOOD_PARSED_RULE\n");
		const initialRules = (await discoverRules(cwd, agentDir.path())).items;
		expect(initialRules.find(rule => rule.path === rulePath)?.content).toContain("LAST_GOOD_PARSED_RULE");
		const inputs = new ProjectPromptInputs({
			initial: { ...emptySnapshot(cwd), alwaysApplyRules: initialRules },
			getCwd: () => cwd,
			discover: target => ({
				cwd: target,
				contextFiles: Promise.resolve([]),
				workspaceTree: Promise.resolve({
					rootPath: target,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				}),
				activeRepoContext: Promise.resolve(null),
				nonProjectCwd: Promise.resolve(null),
				skills: Promise.resolve({ skills: [], warnings: [] }),
				rules: discoverRules(target, agentDir.path()).then(result => result.items),
				watchdogFiles: Promise.resolve([]),
				advisors: Promise.resolve({ advisors: [], sharedInstructions: undefined }),
			}),
			ttsrManager: new TtsrManager(undefined, { getCwd: () => cwd }),
			ttsrOptions: () => ({}),
			onChange: () => {},
		});
		fs.writeFileSync(rulePath, "---\nalwaysApply: [broken\n---\nMALFORMED_NEW_RULE\n");
		const lines = await inputs.reload();
		const prompt = await buildSystemPrompt({ ...inputs.promptOptions(), agentDir: agentDir.path() });
		expect(prompt.systemPrompt.join("\n")).toContain("LAST_GOOD_PARSED_RULE");
		expect(prompt.systemPrompt.join("\n")).not.toContain("MALFORMED_NEW_RULE");
		expect(lines.join("\n")).toContain("keeping the previous rules and skills");
		expect(lines.join("\n")).toContain(rulePath);
		fs.writeFileSync(rulePath, "---\nalwaysApply: true\n---\nRECOVERED_PARSED_RULE\n");
		expect((await inputs.reload()).join("\n")).not.toContain("keeping the previous rules and skills");
		expect(inputs.current.alwaysApplyRules.find(rule => rule.path === rulePath)?.content).toContain(
			"RECOVERED_PARSED_RULE",
		);
	});
});
