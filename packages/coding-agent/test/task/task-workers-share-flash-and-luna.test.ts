import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { resolveAgentModel } from "../../src/task/agent-settings";

describe("task workers share Flash and GPT-6 Luna deterministically", () => {
	const flash = "google/gemini-3.8-flash";
	const luna = "openai-codex/gpt-6-luna";
	const fallback = "anthropic/claude-sonnet-4";

	it("always picks configured Luna-first for task workers across spawn IDs including ProbeTaskD1", () => {
		const settings = Settings.isolated({
			"agent.agents": { task: { model: [luna, flash, fallback] } },
		});
		const probeResolved = resolveAgentModel({
			settings,
			agentName: "task",
			taskDepth: 1,
			spawnId: "ProbeTaskD1",
		});
		expect(probeResolved.patterns[0]).toBe(luna);
		expect(probeResolved.patterns[1]).toBe(flash);
		expect(probeResolved.patterns.slice(2)).toEqual([fallback]);

		const counts: Record<string, number> = {};
		for (let index = 0; index < 100; index++) {
			const spawnId = `spawn-${index}`;
			const resolved = resolveAgentModel({ settings, agentName: "task", taskDepth: 1, spawnId });
			const first = resolved.patterns[0];
			counts[first] = (counts[first] ?? 0) + 1;
			expect(resolveAgentModel({ settings, agentName: "task", taskDepth: 1, spawnId }).patterns).toEqual(
				resolved.patterns,
			);
			expect(resolved.patterns[0]).toBe(luna);
			expect(resolved.patterns[1]).toBe(flash);
			expect(resolved.patterns.slice(2)).toEqual([fallback]);
		}
		expect(counts[luna]).toBe(100);
		expect(counts[flash] ?? 0).toBe(0);
	});

	it("always picks configured Flash-first for qa-verifier across spawn IDs including ProbeTaskD1", () => {
		const settings = Settings.isolated({
			"agent.agents": { "qa-verifier": { model: [flash, luna, fallback] } },
		});
		const probeResolved = resolveAgentModel({
			settings,
			agentName: "qa-verifier",
			taskDepth: 1,
			spawnId: "ProbeTaskD1",
		});
		expect(probeResolved.patterns[0]).toBe(flash);
		expect(probeResolved.patterns[1]).toBe(luna);
		expect(probeResolved.patterns.slice(2)).toEqual([fallback]);

		const counts: Record<string, number> = {};
		for (let index = 0; index < 100; index++) {
			const spawnId = `variant-${index}`;
			const resolved = resolveAgentModel({ settings, agentName: "qa-verifier", taskDepth: 1, spawnId });
			const first = resolved.patterns[0];
			counts[first] = (counts[first] ?? 0) + 1;
			expect(resolved.patterns[0]).toBe(flash);
			expect(resolved.patterns[1]).toBe(luna);
			expect(resolved.patterns.slice(2)).toEqual([fallback]);
		}
		expect(counts[flash]).toBe(100);
		expect(counts[luna] ?? 0).toBe(0);
	});

	it("leaves other agent types and incomplete pairs alone", () => {
		const incomplete = Settings.isolated({ "agent.agents": { task: { model: [flash, fallback] } } });
		expect(resolveAgentModel({ settings: incomplete, agentName: "task", spawnId: "incomplete" }).patterns).toEqual([
			flash,
			fallback,
		]);
		const other = Settings.isolated({ "agent.agents": { reviewer: { model: [flash, luna, fallback] } } });
		expect(resolveAgentModel({ settings: other, agentName: "reviewer", spawnId: "review" }).patterns).toEqual([
			flash,
			luna,
			fallback,
		]);
	});

	it("preserves configured model order at deeper configured depths", () => {
		const deepTask = Settings.isolated({
			"agent.agents": { task: { agents: { agents: { model: [luna, flash, fallback] } } } },
		});
		const deepQa = Settings.isolated({
			"agent.agents": { "qa-verifier": { agents: { agents: { model: [flash, luna, fallback] } } } },
		});
		for (let index = 0; index < 100; index++) {
			const taskResolved = resolveAgentModel({
				settings: deepTask,
				agentName: "task",
				taskDepth: 3,
				spawnId: `reset-${index}`,
			});
			expect(taskResolved.patterns[0]).toBe(luna);
			expect(taskResolved.patterns[1]).toBe(flash);
			expect(taskResolved.patterns.slice(2)).toEqual([fallback]);

			const qaResolved = resolveAgentModel({
				settings: deepQa,
				agentName: "qa-verifier",
				taskDepth: 3,
				spawnId: `reset-${index}`,
			});
			expect(qaResolved.patterns[0]).toBe(flash);
			expect(qaResolved.patterns[1]).toBe(luna);
			expect(qaResolved.patterns.slice(2)).toEqual([fallback]);
		}
	});
});

describe("the Flash and Luna share follows quota suppression and the live provider name", () => {
	const antigravityFlash = "google-antigravity/gemini-3.8-flash";
	const luna = "openai-codex/gpt-6-luna";
	const fallback = "anthropic/claude-sonnet-4";
	const settings = Settings.isolated({
		"agent.agents": { task: { model: [antigravityFlash, luna, fallback] } },
	});
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-share-suppression-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		registry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function firstChoices(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (let index = 0; index < 100; index++) {
			const resolved = resolveAgentModel({
				settings,
				agentName: "task",
				taskDepth: 1,
				spawnId: `quota-${index}`,
				modelRegistry: registry,
			});
			expect(resolved.patterns.slice(2)).toEqual([fallback]);
			counts[resolved.patterns[0]] = (counts[resolved.patterns[0]] ?? 0) + 1;
		}
		return counts;
	}

	it("respects configured first choice for live google-antigravity provider name", () => {
		registry.clearSuppressedSelectors();
		const counts = firstChoices();
		expect(counts[antigravityFlash]).toBe(100);
		expect(counts[luna] ?? 0).toBe(0);
	});

	it("starts new spawns on the other pool while one is suppressed, and restores configured order after reset", () => {
		registry.clearSuppressedSelectors();
		registry.suppressSelector(luna, Date.now() + 60_000);
		const lunaDown = firstChoices();
		expect(lunaDown[antigravityFlash]).toBe(100);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(antigravityFlash, Date.now() + 60_000);
		const flashDown = firstChoices();
		expect(flashDown[luna]).toBe(100);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(antigravityFlash, Date.now() - 1);
		const afterReset = firstChoices();
		expect(afterReset[antigravityFlash]).toBe(100);
		expect(afterReset[luna] ?? 0).toBe(0);
	});

	it("keeps configured order when both pools are suppressed", () => {
		registry.clearSuppressedSelectors();
		registry.suppressSelector(luna, Date.now() + 60_000);
		registry.suppressSelector(antigravityFlash, Date.now() + 60_000);
		const counts = firstChoices();
		expect(counts[antigravityFlash]).toBe(100);
		expect(counts[luna] ?? 0).toBe(0);
		registry.clearSuppressedSelectors();
	});

	it("never puts Opus or Astra in a routine chain, healthy or suppressed", () => {
		const opus = "anthropic/claude-opus-5-5";
		const astra = "openai-codex/gpt-6-astra";
		const withExpensiveTail = Settings.isolated({
			"agent.agents": { task: { model: [antigravityFlash, luna, fallback, opus, astra, "anthropic/*", "claude-opus"] } },
		});
		const resolve = (spawnId: string) =>
			resolveAgentModel({ settings: withExpensiveTail, agentName: "task", taskDepth: 1, spawnId, modelRegistry: registry })
				.patterns;

		registry.clearSuppressedSelectors();
		expect(resolve("tail-0").slice(2)).toEqual([fallback]);

		registry.suppressSelector(luna, Date.now() + 60_000);
		registry.suppressSelector(antigravityFlash, Date.now() + 60_000);
		const exhausted = resolve("tail-1");
		expect(exhausted.slice(0, 2).sort()).toEqual([antigravityFlash, luna].sort());
		expect(exhausted.slice(2)).toEqual([fallback]);
		registry.clearSuppressedSelectors();
	});
});
