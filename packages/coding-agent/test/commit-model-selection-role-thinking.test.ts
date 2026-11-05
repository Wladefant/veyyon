import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { resolveCommitHelperModel, resolvePrimaryModel } from "@veyyon/coding-agent/commit/model-selection";
import { requireBundledModel } from "../../agent/test/helpers";

function createSettings(helpers: Record<string, { model?: string; thinkingLevel?: string }>, defaultModel?: string) {
	return {
		get(path: string) {
			if (path === "agent.helpers") return helpers;
			if (path === "defaultModel") return defaultModel ? [defaultModel] : [];
			return undefined;
		},
	} as never;
}

function registryOf(...models: Model<Api>[]) {
	return {
		getAvailable: () => models,
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		authStorage: { rotateSessionCredential: async () => false as const },
		resolver: () => async () => "test-key",
	};
}

describe("commit helper effort selection", () => {
	// Opus 4.5 declares `low`/`medium`/`high` and takes `low` as `low`, so a
	// suffix that never reached the request could not fake the assertion by
	// clamping. Sonnet 4.5's budget ladder stops at `xhigh`, which answers the
	// separate question of what a level the model lacks resolves to.
	it("lets a `:level` suffix on the commit helper's model outrank the row's effort", async () => {
		const model = requireBundledModel("anthropic", "claude-opus-4-5");
		const settings = createSettings({
			commit: { model: `${model.provider}/${model.id}:low`, thinkingLevel: "high" },
		});
		const registry = registryOf(model);

		const primary = await resolvePrimaryModel(undefined, settings, registry);
		expect(primary.model.id).toBe(model.id);
		expect(primary.thinkingLevel).toBe(Effort.Low);

		const helper = await resolveCommitHelperModel(settings, registry, model, "fallback-key");
		expect(helper.model.id).toBe(model.id);
		expect(helper.thinkingLevel).toBe(Effort.Low);
	});

	it("resolves a suffix the model cannot take against the model's own ladder", async () => {
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const settings = createSettings({ commit: { model: `${model.provider}/${model.id}:max` } });

		const primary = await resolvePrimaryModel(undefined, settings, registryOf(model));

		expect(primary.model.id).toBe(model.id);
		expect(primary.thinkingLevel).toBe(Effort.XHigh);
	});

	it("fits an unset helper's effort to the default model, never to the default model's own suffix", async () => {
		const defaultModel = requireBundledModel("anthropic", "claude-opus-4-5");
		const commitModel = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const settings = createSettings(
			{ commit: { thinkingLevel: "minimal" } },
			`${defaultModel.provider}/${defaultModel.id}:high`,
		);

		const helper = await resolveCommitHelperModel(
			settings,
			registryOf(defaultModel, commitModel),
			commitModel,
			"fallback-key",
		);

		expect(helper.model.id).toBe(defaultModel.id);
		// Opus 4.5 declares no level below `low`, so `minimal` resolves to `low`,
		// and never to the `high` the default model's selector stores.
		expect(helper.thinkingLevel).toBe(Effort.Low);
	});
});

describe("commit unavailable-default fallback (parity with the main session)", () => {
	it("substitutes an available model with a loud warning when the configured default is unavailable", async () => {
		const availableModel = requireBundledModel("anthropic", "claude-sonnet-4-5");
		// Configured default points at a provider/model that is not available.
		const settings = createSettings({}, "gonezo/model-that-left");
		const registry = {
			getAvailable: () => [availableModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const warnings: string[] = [];
		const primary = await resolvePrimaryModel(undefined, settings, registry, message => warnings.push(message));

		expect(primary.model.id).toBe(availableModel.id);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"gonezo/model-that-left"');
		expect(warnings[0]).toContain(`${availableModel.provider}/${availableModel.id}`);
	});

	it("still fails hard for an explicit override that does not resolve", async () => {
		const availableModel = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const settings = createSettings({});
		const registry = {
			getAvailable: () => [availableModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const warnings: string[] = [];
		await expect(
			resolvePrimaryModel("gonezo/model-that-left", settings, registry, message => warnings.push(message)),
		).rejects.toThrow("No model available for commit generation");
		expect(warnings).toHaveLength(0);
	});

	it("substitutes silently when no default model is configured at all", async () => {
		const availableModel = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const settings = createSettings({});
		const registry = {
			getAvailable: () => [availableModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const warnings: string[] = [];
		const primary = await resolvePrimaryModel(undefined, settings, registry, message => warnings.push(message));

		// Picking an available model IS the default resolution here — nothing
		// configured was skipped, so no warning (mirrors main.ts).
		expect(primary.model.id).toBe(availableModel.id);
		expect(warnings).toHaveLength(0);
	});

	it("warns when a configured commit helper model is skipped for missing credentials", async () => {
		const primaryModel = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const helperModel = requireBundledModel("anthropic", "claude-opus-4-5");
		const settings = createSettings({ commit: { model: `${helperModel.provider}/${helperModel.id}` } });
		const registry = {
			getAvailable: () => [primaryModel, helperModel],
			// The configured commit helper model resolves but its provider has no key.
			getApiKey: async (model: { id: string }) => (model.id === helperModel.id ? undefined : "test-key"),
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const warnings: string[] = [];
		const helper = await resolveCommitHelperModel(settings, registry, primaryModel, "fallback-key", message =>
			warnings.push(message),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`${helperModel.provider}/${helperModel.id}`);
		// Substitution still lands on an authenticated model, never the unauthed one.
		expect(helper.model.id).not.toBe(helperModel.id);
	});

	it("still fails hard when no model is available at all", async () => {
		const settings = createSettings({}, "gonezo/model-that-left");
		const registry = {
			getAvailable: () => [],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		await expect(resolvePrimaryModel(undefined, settings, registry, () => {})).rejects.toThrow(
			"No model available for commit generation",
		);
	});
});
