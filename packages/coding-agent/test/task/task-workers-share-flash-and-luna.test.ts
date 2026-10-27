import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { resolveAgentModel } from "../../src/task/agent-settings";

describe("task workers share Flash and GPT-6 Luna deterministically", () => {
	const L = "openai-codex/gpt-6-luna:medium";
	const F = "google-antigravity/gemini-3.8-flash:high";
	const H = "anthropic/claude-haiku-5-5:max";
	const standardFlash = "google/gemini-3.8-flash";
	const standardLuna = "openai-codex/gpt-6-luna";

	it("always picks configured Luna-first for task workers across spawn IDs including ProbeTaskD1", () => {
		const settings = Settings.isolated({
			"agent.agents": { task: { model: [L, F, H] } },
		});
		const probeResolved = resolveAgentModel({
			settings,
			agentName: "task",
			taskDepth: 1,
			spawnId: "ProbeTaskD1",
		});
		expect(probeResolved.patterns[0]).toBe(L);
		expect(probeResolved.patterns[1]).toBe(F);
		expect(probeResolved.patterns.slice(2)).toEqual([H]);

		const counts: Record<string, number> = {};
		for (let index = 0; index < 100; index++) {
			const spawnId = `spawn-${index}`;
			const resolved = resolveAgentModel({ settings, agentName: "task", taskDepth: 1, spawnId });
			const first = resolved.patterns[0];
			counts[first] = (counts[first] ?? 0) + 1;
			expect(resolveAgentModel({ settings, agentName: "task", taskDepth: 1, spawnId }).patterns).toEqual(
				resolved.patterns,
			);
			expect(resolved.patterns[0]).toBe(L);
			expect(resolved.patterns[1]).toBe(F);
			expect(resolved.patterns.slice(2)).toEqual([H]);
		}
		expect(counts[L]).toBe(100);
		expect(counts[F] ?? 0).toBe(0);
	});

	it("always picks configured Flash-first for qa-verifier across spawn IDs including ProbeTaskD1", () => {
		const settings = Settings.isolated({
			"agent.agents": { "qa-verifier": { model: [F, L, H] } },
		});
		const probeResolved = resolveAgentModel({
			settings,
			agentName: "qa-verifier",
			taskDepth: 1,
			spawnId: "ProbeTaskD1",
		});
		expect(probeResolved.patterns[0]).toBe(F);
		expect(probeResolved.patterns[1]).toBe(L);
		expect(probeResolved.patterns.slice(2)).toEqual([H]);

		const counts: Record<string, number> = {};
		for (let index = 0; index < 100; index++) {
			const spawnId = `variant-${index}`;
			const resolved = resolveAgentModel({ settings, agentName: "qa-verifier", taskDepth: 1, spawnId });
			const first = resolved.patterns[0];
			counts[first] = (counts[first] ?? 0) + 1;
			expect(resolved.patterns[0]).toBe(F);
			expect(resolved.patterns[1]).toBe(L);
			expect(resolved.patterns.slice(2)).toEqual([H]);
		}
		expect(counts[F]).toBe(100);
		expect(counts[L] ?? 0).toBe(0);
	});

	it("leaves explicit H-first unchanged, and leaves other agent types and incomplete pairs alone", () => {
		const incomplete = Settings.isolated({ "agent.agents": { task: { model: [F, H] } } });
		expect(resolveAgentModel({ settings: incomplete, agentName: "task", spawnId: "incomplete" }).patterns).toEqual([
			F,
			H,
		]);

		const other = Settings.isolated({ "agent.agents": { reviewer: { model: [F, L, H] } } });
		expect(resolveAgentModel({ settings: other, agentName: "reviewer", spawnId: "review" }).patterns).toEqual([
			F,
			L,
			H,
		]);

		const haikuSettings = Settings.isolated({ "agent.agents": { haiku: { model: [H, L, F] } } });
		expect(resolveAgentModel({ settings: haikuSettings, agentName: "haiku", spawnId: "haiku-spawn" }).patterns).toEqual([
			H,
			L,
			F,
		]);
		for (let index = 0; index < 100; index++) {
			const spawnId = `haiku-${index}`;
			expect(resolveAgentModel({ settings: haikuSettings, agentName: "haiku", taskDepth: 1, spawnId }).patterns).toEqual([
				H,
				L,
				F,
			]);
		}

		const haikuAlt = Settings.isolated({ "agent.agents": { haiku: { model: [H, F, L] } } });
		expect(resolveAgentModel({ settings: haikuAlt, agentName: "haiku", spawnId: "haiku-alt" }).patterns).toEqual([
			H,
			F,
			L,
		]);
	});

	it("preserves configured model order at deeper configured depths", () => {
		const deepTask = Settings.isolated({
			"agent.agents": { task: { agents: { agents: { model: [L, F, H] } } } },
		});
		const deepQa = Settings.isolated({
			"agent.agents": { "qa-verifier": { agents: { agents: { model: [F, L, H] } } } },
		});
		for (let index = 0; index < 100; index++) {
			const taskResolved = resolveAgentModel({
				settings: deepTask,
				agentName: "task",
				taskDepth: 3,
				spawnId: `reset-${index}`,
			});
			expect(taskResolved.patterns[0]).toBe(L);
			expect(taskResolved.patterns[1]).toBe(F);
			expect(taskResolved.patterns.slice(2)).toEqual([H]);

			const qaResolved = resolveAgentModel({
				settings: deepQa,
				agentName: "qa-verifier",
				taskDepth: 3,
				spawnId: `reset-${index}`,
			});
			expect(qaResolved.patterns[0]).toBe(F);
			expect(qaResolved.patterns[1]).toBe(L);
			expect(qaResolved.patterns.slice(2)).toEqual([H]);
		}
	});

	it("also preserves configured model order for standard provider names", () => {
		const standardTask = Settings.isolated({
			"agent.agents": { task: { model: [standardLuna, standardFlash, H] } },
		});
		const res = resolveAgentModel({ settings: standardTask, agentName: "task", taskDepth: 1, spawnId: "std-1" });
		expect(res.patterns).toEqual([standardLuna, standardFlash, H]);
	});
});

describe("the Flash and Luna share follows quota suppression and the live provider name", () => {
	const F = "google-antigravity/gemini-3.8-flash:high";
	const L = "openai-codex/gpt-6-luna:medium";
	const H = "anthropic/claude-haiku-5-5:max";

	const settings = Settings.isolated({
		"agent.agents": { task: { model: [F, L, H] } },
	});
	const taskLFirstSettings = Settings.isolated({
		"agent.agents": { task: { model: [L, F, H] } },
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

	function firstChoices(targetSettings = settings, agentName = "task"): Record<string, number> {
		const counts: Record<string, number> = {};
		for (let index = 0; index < 100; index++) {
			const resolved = resolveAgentModel({
				settings: targetSettings,
				agentName,
				taskDepth: 1,
				spawnId: `quota-${index}`,
				modelRegistry: registry,
			});
			expect(resolved.patterns).toContain(H);
			counts[resolved.patterns[0]] = (counts[resolved.patterns[0]] ?? 0) + 1;
		}
		return counts;
	}

	it("respects configured first choice for live google-antigravity provider name", () => {
		registry.clearSuppressedSelectors();
		const flashCounts = firstChoices(settings);
		expect(flashCounts[F]).toBe(100);
		expect(flashCounts[L] ?? 0).toBe(0);

		const lunaCounts = firstChoices(taskLFirstSettings);
		expect(lunaCounts[L]).toBe(100);
		expect(lunaCounts[F] ?? 0).toBe(0);
	});

	it("starts new spawns on the other pool while one is suppressed, and restores configured order after reset", () => {
		registry.clearSuppressedSelectors();
		registry.suppressSelector(L, Date.now() + 60_000);
		const lunaDown = firstChoices(settings);
		expect(lunaDown[F]).toBe(100);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(F, Date.now() + 60_000);
		const flashDown = firstChoices(settings);
		expect(flashDown[L]).toBe(100);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(F, Date.now() - 1);
		const afterReset = firstChoices(settings);
		expect(afterReset[F]).toBe(100);
		expect(afterReset[L] ?? 0).toBe(0);

		// Also check task L-first under suppression
		registry.clearSuppressedSelectors();
		registry.suppressSelector(L, Date.now() + 60_000);
		const lFirstLunaDown = firstChoices(taskLFirstSettings);
		expect(lFirstLunaDown[F]).toBe(100);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(F, Date.now() + 60_000);
		const lFirstFlashDown = firstChoices(taskLFirstSettings);
		expect(lFirstFlashDown[L]).toBe(100);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(L, Date.now() - 1);
		const lFirstReset = firstChoices(taskLFirstSettings);
		expect(lFirstReset[L]).toBe(100);
		expect(lFirstReset[F] ?? 0).toBe(0);
	});

	it("starts on the healthy tail H when both shared pools are suppressed", () => {
		registry.clearSuppressedSelectors();
		registry.suppressSelector(L, Date.now() + 60_000);
		registry.suppressSelector(F, Date.now() + 60_000);
		const counts = firstChoices(settings);
		expect(counts[H]).toBe(100);
		expect(counts[F] ?? 0).toBe(0);
		expect(counts[L] ?? 0).toBe(0);

		const lFirstBothDown = firstChoices(taskLFirstSettings);
		expect(lFirstBothDown[H]).toBe(100);
		expect(lFirstBothDown[L] ?? 0).toBe(0);
		registry.clearSuppressedSelectors();
	});

	it("never puts Opus or Astra in a routine chain, healthy or suppressed", () => {
		const opus = "anthropic/claude-opus-5-5";
		const astra = "openai-codex/gpt-6-astra";
		const withExpensiveTail = Settings.isolated({
			"agent.agents": { task: { model: [F, L, H, opus, astra, "anthropic/*", "claude-opus"] } },
		});
		const resolve = (spawnId: string) =>
			resolveAgentModel({ settings: withExpensiveTail, agentName: "task", taskDepth: 1, spawnId, modelRegistry: registry })
				.patterns;

		registry.clearSuppressedSelectors();
		expect(resolve("tail-0").slice(2)).toEqual([H]);

		registry.suppressSelector(L, Date.now() + 60_000);
		registry.suppressSelector(F, Date.now() + 60_000);
		const exhausted = resolve("tail-1");
		expect(exhausted[0]).toBe(H);
		expect(exhausted.slice(1).sort()).toEqual([F, L].sort());
		registry.clearSuppressedSelectors();
	});

	it("verifies full-triad closure across all triad lanes and suppression states", () => {
		// 1. Task lane (L-first): healthy [L, F, H], L-down [F, L, H], F-down [L, F, H], both-down [H, L, F]
		const taskSettings = Settings.isolated({
			"agent.agents": { task: { model: [L, F, H] } },
		});
		registry.clearSuppressedSelectors();
		let res = resolveAgentModel({ settings: taskSettings, agentName: "task", taskDepth: 1, spawnId: "triad-t1", modelRegistry: registry });
		expect(res.patterns).toEqual([L, F, H]);

		registry.suppressSelector(L, Date.now() + 60_000);
		res = resolveAgentModel({ settings: taskSettings, agentName: "task", taskDepth: 1, spawnId: "triad-t2", modelRegistry: registry });
		expect(res.patterns).toEqual([F, L, H]);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(F, Date.now() + 60_000);
		res = resolveAgentModel({ settings: taskSettings, agentName: "task", taskDepth: 1, spawnId: "triad-t3", modelRegistry: registry });
		expect(res.patterns).toEqual([L, F, H]);

		registry.suppressSelector(L, Date.now() + 60_000);
		res = resolveAgentModel({ settings: taskSettings, agentName: "task", taskDepth: 1, spawnId: "triad-t4", modelRegistry: registry });
		expect(res.patterns).toEqual([H, L, F]);

		// 2. QA lane (F-first): healthy [F, L, H], F-down [L, F, H], L-down [F, L, H], both-down [H, F, L]
		const qaSettings = Settings.isolated({
			"agent.agents": { "qa-verifier": { model: [F, L, H] } },
		});
		registry.clearSuppressedSelectors();
		res = resolveAgentModel({ settings: qaSettings, agentName: "qa-verifier", taskDepth: 1, spawnId: "triad-q1", modelRegistry: registry });
		expect(res.patterns).toEqual([F, L, H]);

		registry.suppressSelector(F, Date.now() + 60_000);
		res = resolveAgentModel({ settings: qaSettings, agentName: "qa-verifier", taskDepth: 1, spawnId: "triad-q2", modelRegistry: registry });
		expect(res.patterns).toEqual([L, F, H]);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(L, Date.now() + 60_000);
		res = resolveAgentModel({ settings: qaSettings, agentName: "qa-verifier", taskDepth: 1, spawnId: "triad-q3", modelRegistry: registry });
		expect(res.patterns).toEqual([F, L, H]);

		registry.suppressSelector(F, Date.now() + 60_000);
		res = resolveAgentModel({ settings: qaSettings, agentName: "qa-verifier", taskDepth: 1, spawnId: "triad-q4", modelRegistry: registry });
		expect(res.patterns).toEqual([H, F, L]);

		// 3. Haiku lane (explicit H-first): [H, L, F] stays [H, L, F] unchanged under all suppression states
		const haikuSettings = Settings.isolated({
			"agent.agents": { haiku: { model: [H, L, F] } },
		});
		registry.clearSuppressedSelectors();
		res = resolveAgentModel({ settings: haikuSettings, agentName: "haiku", taskDepth: 1, spawnId: "triad-h1", modelRegistry: registry });
		expect(res.patterns).toEqual([H, L, F]);

		registry.suppressSelector(H, Date.now() + 60_000);
		registry.suppressSelector(L, Date.now() + 60_000);
		registry.suppressSelector(F, Date.now() + 60_000);
		res = resolveAgentModel({ settings: haikuSettings, agentName: "haiku", taskDepth: 1, spawnId: "triad-h2", modelRegistry: registry });
		expect(res.patterns).toEqual([H, L, F]);

		// 4. Triad with expensive tail: Opus/Astra stripped, H preserved in safe tail
		const closedTriadWithTail = Settings.isolated({
			"agent.agents": {
				task: { model: [L, F, H, "anthropic/claude-opus-5-5", "openai-codex/gpt-6-astra"] },
				"qa-verifier": { model: [F, L, H, "anthropic/claude-opus-5-5", "openai-codex/gpt-6-astra"] },
			},
		});
		registry.clearSuppressedSelectors();
		const taskClosed = resolveAgentModel({ settings: closedTriadWithTail, agentName: "task", taskDepth: 1, spawnId: "triad-tail-1", modelRegistry: registry });
		expect(taskClosed.patterns).toEqual([L, F, H]);

		const qaClosed = resolveAgentModel({ settings: closedTriadWithTail, agentName: "qa-verifier", taskDepth: 1, spawnId: "triad-tail-2", modelRegistry: registry });
		expect(qaClosed.patterns).toEqual([F, L, H]);

		registry.clearSuppressedSelectors();
	});
});
