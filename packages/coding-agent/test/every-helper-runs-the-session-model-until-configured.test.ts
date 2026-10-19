/**
 * WHY: every helper (`agent.helpers.<id>`) follows the rule an unconfigured
 * agent follows: no model runs the session's model, no effort runs the
 * session's effort. A helper that names a model nothing can resolve gets no
 * model, so the feature reports the setting instead of quietly running the
 * session's model on a configuration the user believes is in force.
 *
 * The class closed: one helper falling back to a different model than its
 * siblings (a leftover role chain, `defaultModel` ahead of the live model), a
 * configured-but-unresolvable chain falling through to the session model, and
 * a row's effort outranking the `:level` the matching entry carries. The suite
 * sweeps `HELPER_IDS`, so a new helper is covered the moment it is declared.
 *
 * Gap: `resolveHelperModel` is the choke point; a feature that bypasses it is
 * not seen here. inspect_image does, on purpose, to search for an
 * image-capable model when the session model has none.
 */
import { describe, expect, test } from "bun:test";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { HELPER_IDS, type HelperId, resolveHelperModel } from "@veyyon/coding-agent/task/helper-settings";

function model(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	});
}

const live = model("live-model");
const configured = model("configured-model");
const backup = model("backup-model");
const persistedDefault = model("persisted-default");
const available = [live, configured, backup, persistedDefault];

function settingsWith(id: HelperId, row: Record<string, unknown> | undefined, defaultModel?: string): Settings {
	return Settings.isolated({
		"agent.helpers": row === undefined ? {} : { [id]: row },
		...(defaultModel === undefined ? {} : { defaultModel }),
	});
}

describe.each([...HELPER_IDS])("the %s helper", id => {
	test("with no row, runs the live session model at the session's effort", () => {
		const selection = resolveHelperModel(settingsWith(id, undefined, "test/persisted-default"), id, available, live);
		expect(selection).toEqual({ model: live, thinkingLevel: undefined, inherited: true });
	});

	test("with `inherit` as its model, runs the live session model", () => {
		const selection = resolveHelperModel(settingsWith(id, { model: "inherit" }), id, available, live);
		expect(selection?.model).toBe(live);
		expect(selection?.inherited).toBe(true);
	});

	test("with no session, runs the persisted defaultModel", () => {
		const selection = resolveHelperModel(settingsWith(id, undefined, "test/persisted-default"), id, available);
		expect(selection?.model).toBe(persistedDefault);
		expect(selection?.inherited).toBe(true);
	});

	test("with only an effort, runs the live model at that effort", () => {
		const selection = resolveHelperModel(settingsWith(id, { thinkingLevel: "low" }), id, available, live);
		expect(selection).toEqual({ model: live, thinkingLevel: Effort.Low, inherited: true });
	});

	test("with a chain, runs its first entry that matches an available model", () => {
		const selection = resolveHelperModel(
			settingsWith(id, { model: ["test/not-a-model", "test/configured-model", "test/backup-model"] }),
			id,
			available,
			live,
		);
		expect(selection).toEqual({ model: configured, thinkingLevel: undefined, inherited: false });
	});

	test("with a chain that matches nothing, gets no model rather than the session's", () => {
		const selection = resolveHelperModel(
			settingsWith(id, { model: "test/not-a-model" }, "test/persisted-default"),
			id,
			available,
			live,
		);
		expect(selection).toBeUndefined();
	});

	test("a :level on the matching entry outranks the row's effort", () => {
		const selection = resolveHelperModel(
			settingsWith(id, { model: "test/configured-model:high", thinkingLevel: "low" }),
			id,
			available,
			live,
		);
		expect(selection).toEqual({ model: configured, thinkingLevel: Effort.High, inherited: false });
	});

	test("the row's effort applies to a configured model without a :level", () => {
		const selection = resolveHelperModel(
			settingsWith(id, { model: "test/configured-model", thinkingLevel: "low" }),
			id,
			available,
			live,
		);
		expect(selection).toEqual({ model: configured, thinkingLevel: Effort.Low, inherited: false });
	});

	test("an effort the model lacks is fitted to one it has", () => {
		const selection = resolveHelperModel(settingsWith(id, { thinkingLevel: "xhigh" }), id, available, live);
		expect([Effort.Low, Effort.High]).toContain(selection?.thinkingLevel as Effort);
	});

	test("another helper's row does not reach it", () => {
		const other = HELPER_IDS.find(candidate => candidate !== id) as HelperId;
		const settings = Settings.isolated({
			"agent.helpers": { [other]: { model: "test/configured-model", thinkingLevel: "low" } },
		});
		expect(resolveHelperModel(settings, id, available, live)).toEqual({
			model: live,
			thinkingLevel: undefined,
			inherited: true,
		});
	});
});
