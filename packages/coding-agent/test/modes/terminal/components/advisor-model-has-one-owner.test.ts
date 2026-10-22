/**
 * WHY: a feature's model asked for in two places is a model the operator sets
 * in one place while the feature reads the other. The advisor's model used to
 * have an "Advisor Model" row in the Advisor group and a slot in a generic role
 * table. It now has one owner: the Advisor helper on the Roster, stored at
 * `agent.helpers.advisor`, which is what the advisor runtime resolves.
 *
 * The class this closes is "a settings row other than the helper's own edits
 * the advisor's model". Every declared setting is swept, so a model row
 * labelled for the advisor anywhere else turns this suite red.
 *
 * Not caught here: the per-advisor `model:` override in WATCHDOG.yml, which is
 * a second layer with different scope (one advisor, not the profile), edited
 * by `/advisor configure` and covered by advisor/config.test.ts. Driving the
 * Roster's helper editor is covered by the roster suite.
 */

import { describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getAllSettingDefs } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
import { resolveHelperModel } from "@veyyon/coding-agent/task/helper-settings";

function makeModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

const MODELS = [makeModel("reviewer-model"), makeModel("second-model")];

describe("advisor model has one owner", () => {
	it("keeps the Advisor group free of a model row", () => {
		const advisorGroup = getAllSettingDefs().filter(def => def.tab === "model" && def.group === "Advisor");
		expect(advisorGroup.map(def => def.label)).toEqual([
			"Enable Advisor",
			"Advisor for Spawned Agents",
			"Advisor Sync Backlog",
			"Advisor Immune Turns",
		]);
	});

	it("declares no model picker labelled for the advisor on any tab", () => {
		const advisorModelRows = getAllSettingDefs().filter(
			def => /advisor/i.test(def.label) && /model/i.test(def.label),
		);
		expect(advisorModelRows.map(def => def.path)).toEqual([]);
	});

	it("runs the model the Advisor helper names", () => {
		const settings = Settings.isolated({ "agent.helpers": { advisor: { model: "test/reviewer-model" } } });
		const resolved = resolveHelperModel(settings, "advisor", MODELS, MODELS[1]);
		expect(resolved?.model.id).toBe("reviewer-model");
		expect(resolved?.inherited).toBe(false);
	});

	it("runs the live session model while the Advisor helper is unset", () => {
		const settings = Settings.isolated({});
		const resolved = resolveHelperModel(settings, "advisor", MODELS, MODELS[1]);
		expect(resolved?.model.id).toBe("second-model");
		expect(resolved?.inherited).toBe(true);
	});
});
