import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { resolveModelOverride } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getBundledAgent, loadBundledAgents } from "@veyyon/coding-agent/task/agents";

describe("bundled agent parsing", () => {
	/**
	 * The reviewer states no effort of its own, so an `:effort` suffix on whichever
	 * model the operator gave its agents survives all the way to the request.
	 * A level here would silently outrank that suffix (see
	 * `resolveEffectiveSubagentThinkingLevel`).
	 */
	it("lets reviewer inherit thinking effort from the resolved agent model", () => {
		const reviewer = getBundledAgent("reviewer");

		expect(reviewer).toBeDefined();
		expect(reviewer?.source).toBe("bundled");
		expect(reviewer?.thinkingLevel).toBeUndefined();
	});

	/**
<<<<<<< HEAD
	 * The reviewer pins an explicit spawn allowlist so it can delegate mechanical
	 * sub-steps to the task agent and reconnaissance to scout, without granting
	 * unrestricted spawning.
	 */
	it("pins the per-agent spawn allowlist for reviewer", () => {
		const reviewer = getBundledAgent("reviewer");

		expect(reviewer).toBeDefined();
		expect(reviewer?.spawns).toEqual(["task", "scout"]);
	});

	/**
	 * No bundled agent pins a model.
=======
	 * No bundled agent pins a model or an effort.
>>>>>>> santhreal/main
	 *
	 * They used to: the default lane carried `@task`, `scout`/`sonic` carried
	 * `@smol`, `reviewer` carried `@slow`, `designer` carried `@designer`. Those
	 * aliases resolved through role expansion before any agent model setting was
	 * consulted, so a stock install fanned its agents across several different
	 * models and changing the agent model appeared to do nothing. The models now
	 * come from the Agents settings area, so a definition that names a model here
	 * is a regression of that bug. An effort is the same: a pinned level (scout and
	 * sonic carried `medium`, librarian `minimal`) outranks the session's effort
	 * for an agent nobody configured, which is the case that must follow the
	 * session.
	 *
	 * The roster is READ OFF the loader rather than listed here. A hand-written list
	 * goes stale silently in both directions: a renamed lane makes
	 * `getBundledAgent(name)?.model` undefined and the case passes for the wrong
	 * reason, and a NEW lane that pins a model is never asked about at all.
	 */
	it("ships no model and no effort on any bundled agent, so the session decides", () => {
		const bundled = loadBundledAgents();

		expect(bundled.map(agent => agent.name).sort()).toEqual([
			"deep",
			"designer",
			"librarian",
			"reviewer",
			"scout",
			"sonic",
		]);
		for (const agent of bundled) {
			expect(agent.model, `${agent.name} must not pin a model`).toBeUndefined();
			expect(agent.thinkingLevel, `${agent.name} must not pin an effort`).toBeUndefined();
			expect(agent.source, agent.name).toBe("bundled");
		}
	});

	// Issue #4761: an explicit effort suffix on the model configured for a
	// bundled agent must survive model resolution. The executor prefers an
	// explicit resolved suffix over the agent-definition default
	// (task/executor.ts), so the resolved level below is what the agent runs at.
	it("resolves the effort suffix of the model configured for reviewer", () => {
		const gpt55 = buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const settings = Settings.isolated({});
		const registry = { getAvailable: () => [gpt55] } as Parameters<typeof resolveModelOverride>[1];

		const agent = getBundledAgent("reviewer");
		expect(agent?.thinkingLevel).toBeUndefined();
		// The configured agent model is what a bundled specialist runs, so its
		// `:xhigh` suffix has to survive resolution. The bundled definitions carry
		// no `model:` of their own; see the test above.
		const patterns = ["openai-codex/gpt-5.5:xhigh"];
		const resolved = resolveModelOverride(patterns, registry, settings);
		expect(resolved.model?.provider).toBe("openai-codex");
		expect(resolved.model?.id).toBe("gpt-5.5");
		expect(resolved.thinkingLevel).toBe(Effort.XHigh);
		expect(resolved.explicitThinkingLevel).toBe(true);
	});
});
