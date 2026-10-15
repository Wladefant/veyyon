import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { resolveAgentModel } from "../../src/task/agent-settings";

describe("task workers share Flash and GPT-6 Luna", () => {
	const flash = "google/gemini-3.8-flash";
	const luna = "openai-codex/gpt-6-luna";
	const fallback = "anthropic/claude-sonnet-4";

	it("balances stable task spawn identities and preserves fallback candidates", () => {
		const settings = Settings.isolated({
			"agent.agents": { task: { model: [flash, luna, fallback] } },
		});
		const counts: Record<string, number> = {};
		for (let index = 0; index < 100; index++) {
			const spawnId = `spawn-${index}`;
			const resolved = resolveAgentModel({ settings, agentName: "task", taskDepth: 1, spawnId });
			const first = resolved.patterns[0];
			counts[first] = (counts[first] ?? 0) + 1;
			expect(resolveAgentModel({ settings, agentName: "task", taskDepth: 1, spawnId }).patterns).toEqual(
				resolved.patterns,
			);
			expect(resolved.patterns.slice(2)).toEqual([fallback]);
		}
		expect(counts[flash]).toBeGreaterThanOrEqual(40);
		expect(counts[flash]).toBeLessThanOrEqual(60);
		expect(counts[luna]).toBeGreaterThanOrEqual(40);
		expect(counts[luna]).toBeLessThanOrEqual(60);
	});

	it("splits nested task and qa-verifier chains while leaving other types and incomplete pairs alone", () => {
		const nested = Settings.isolated({
			"agent.agents": { task: { agents: { model: [flash, luna, fallback] } } },
		});
		const qaSettings = Settings.isolated({
			"agent.agents": { "qa-verifier": { model: [flash, luna, fallback] } },
		});
		const countsByLane: Record<string, Record<string, number>> = {
			task: {},
			"qa-verifier": {},
		};
		for (let index = 0; index < 100; index++) {
			for (const [agentName, settings, taskDepth] of [
				["task", nested, 2],
				["qa-verifier", qaSettings, 1],
			] as const) {
				const resolved = resolveAgentModel({
					settings,
					agentName,
					taskDepth,
					spawnId: `variant-${index}`,
				});
				const counts = countsByLane[agentName]!;
				counts[resolved.patterns[0]] = (counts[resolved.patterns[0]] ?? 0) + 1;
				expect(resolved.patterns.slice(2)).toEqual([fallback]);
			}
		}
		for (const agentName of ["task", "qa-verifier"]) {
			const counts = countsByLane[agentName]!;
			expect(counts[flash]).toBeGreaterThanOrEqual(40);
			expect(counts[flash]).toBeLessThanOrEqual(60);
			expect(counts[luna]).toBeGreaterThanOrEqual(40);
			expect(counts[luna]).toBeLessThanOrEqual(60);
		}

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

	it("keeps the split at deeper configured depths and starts a fresh split for new spawns", () => {
		const deepTask = Settings.isolated({
			"agent.agents": { task: { agents: { agents: { model: [flash, luna, fallback] } } } },
		});
		const deepQa = Settings.isolated({
			"agent.agents": { "qa-verifier": { agents: { agents: { model: [flash, luna, fallback] } } } },
		});
		for (const [agentName, settings] of [
			["task", deepTask],
			["qa-verifier", deepQa],
		] as const) {
			const counts: Record<string, number> = {};
			for (let index = 0; index < 100; index++) {
				const resolved = resolveAgentModel({
					settings,
					agentName,
					taskDepth: 3,
					spawnId: `reset-${index}`,
				});
				counts[resolved.patterns[0]] = (counts[resolved.patterns[0]] ?? 0) + 1;
				expect(resolved.patterns.slice(2)).toEqual([fallback]);
			}
			expect(counts[flash]).toBeGreaterThanOrEqual(40);
			expect(counts[flash]).toBeLessThanOrEqual(60);
			expect(counts[luna]).toBeGreaterThanOrEqual(40);
			expect(counts[luna]).toBeLessThanOrEqual(60);
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
			expect(resolved.patterns).toContain(fallback);
			counts[resolved.patterns[0]] = (counts[resolved.patterns[0]] ?? 0) + 1;
		}
		return counts;
	}

	it("splits the live google-antigravity provider name against Luna", () => {
		registry.clearSuppressedSelectors();
		const counts = firstChoices();
		expect(counts[antigravityFlash]).toBeGreaterThanOrEqual(40);
		expect(counts[antigravityFlash]).toBeLessThanOrEqual(60);
		expect(counts[luna]).toBeGreaterThanOrEqual(40);
		expect(counts[luna]).toBeLessThanOrEqual(60);
	});

	it("starts new spawns on the other pool while one is suppressed, and restores the split after reset", () => {
		registry.clearSuppressedSelectors();
		registry.suppressSelector(luna, Date.now() + 60_000);
		const lunaDown = firstChoices();
		expect(lunaDown[antigravityFlash]).toBe(100);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(antigravityFlash, Date.now() + 60_000);
		const flashDown = firstChoices();
		expect(flashDown[luna]).toBe(100);

		registry.clearSuppressedSelectors();
		registry.suppressSelector(luna, Date.now() - 1);
		const afterReset = firstChoices();
		expect(afterReset[antigravityFlash]).toBeGreaterThanOrEqual(40);
		expect(afterReset[antigravityFlash]).toBeLessThanOrEqual(60);
	});

	it("starts on the healthy tail when both shared pools are suppressed", () => {
		registry.clearSuppressedSelectors();
		registry.suppressSelector(luna, Date.now() + 60_000);
		registry.suppressSelector(antigravityFlash, Date.now() + 60_000);
		const counts = firstChoices();
		expect(counts[fallback]).toBe(100);
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
		expect(exhausted[0]).toBe(fallback);
		expect(exhausted.slice(1).sort()).toEqual([antigravityFlash, luna].sort());
		registry.clearSuppressedSelectors();
	});
});
