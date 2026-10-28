/**
 * WHY: the alt+p / `/model` picker lists the authenticated models, but it resolved the configured
 * `defaultModel` against the whole catalog. Startup resolves the same setting against the
 * authenticated models (`StartupModelSelection.begin`: `resolveAllowedModels`, then
 * `resolveModelSelectorValue`). A selector that matches an unauthenticated provider's model in the
 * catalog and a listed model among the authenticated ones therefore put no default mark on the row
 * a session would start on. Resolving against the catalog also built every provider's models,
 * which was most of the picker's first open.
 *
 * The class closed: the row the picker marks default, and selects first, disagrees with the model
 * startup picks. The sweep covers each selector shape the resolver distinguishes (exact listed,
 * exact on an unauthenticated provider, bare id, fuzzy, a chain, unknown, unset), and the
 * expectation comes from startup's own resolver rather than from this file.
 *
 * Not caught: an `enabledModels` scope. The picker then lists `session.scopedModels`, which
 * startup computes, and resolves against that list; this suite drives the unscoped picker only.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import {
	getModelMatchPreferences,
	resolveAllowedModels,
	resolveModelSelectorValue,
} from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ModelPickerComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/model-picker";
import { setThemeInstance, theme } from "@veyyon/coding-agent/theme/theme";
import type { TUI } from "@veyyon/tui";
import { requireTheme } from "../../../helpers/require-theme";

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	});
}

/** No credential for this provider: the catalog holds it, the picker does not list it. */
const unauthenticated = makeModel("anthropic", "claude-sonnet-4-5");
const listed = [
	makeModel("openrouter", "anthropic/claude-sonnet-4.5"),
	makeModel("openrouter", "openai/gpt-5"),
	makeModel("openai", "gpt-5-mini"),
];

const registry = {
	refresh: async () => {},
	getError: () => undefined,
	getAvailable: () => listed,
	getAll: () => [unauthenticated, ...listed],
} as unknown as ModelRegistry;

const SELECTORS: (string | undefined)[] = [
	"openrouter/openai/gpt-5",
	"anthropic/claude-sonnet-4-5",
	"claude-sonnet-4-5",
	"claude-sonnet",
	"gpt-5-mini",
	"anthropic/claude-sonnet-4-5,openai/gpt-5-mini",
	"no-such-model",
	undefined,
];

async function startupDefault(settings: Settings): Promise<Model | undefined> {
	const matchPreferences = getModelMatchPreferences(settings);
	const allowed = await resolveAllowedModels(registry, settings, matchPreferences);
	return resolveModelSelectorValue(settings.get("defaultModel"), allowed, { settings, matchPreferences }).model;
}

function openPicker(settings: Settings): { render: () => string; enter: () => Model | undefined } {
	const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	let picked: Model | undefined;
	const picker = new ModelPickerComponent(ui, settings, registry, [], {
		onPick: model => {
			picked = model;
		},
		onCancel: () => {},
	});
	return {
		render: () => stripVTControlCharacters(picker.render(200).join("\n")),
		enter: () => {
			picker.handleInput("\n");
			return picked;
		},
	};
}

beforeAll(async () => {
	const dark = await requireTheme("dark");
	setThemeInstance(dark);
});

describe("the model picker's default", () => {
	test.each(SELECTORS)("marks and selects the model startup picks for defaultModel %p", async selector => {
		const settings = Settings.isolated(selector === undefined ? {} : { defaultModel: selector });
		const expected = await startupDefault(settings);
		const picker = openPicker(settings);
		const chip = `${theme.status.enabled}default`;

		if (expected === undefined) {
			expect(picker.render()).not.toContain(chip);
			return;
		}
		expect(picker.render()).toContain(chip);
		expect(picker.enter()).toBe(expected);
	});

	test("the sweep reaches a selector the catalog and the listed models resolve differently", async () => {
		const differing: string[] = [];
		for (const selector of SELECTORS) {
			if (selector === undefined) continue;
			const settings = Settings.isolated({ defaultModel: selector });
			const matchPreferences = getModelMatchPreferences(settings);
			const fromCatalog = resolveModelSelectorValue(selector, registry.getAll(), {
				settings,
				matchPreferences,
			}).model;
			if (fromCatalog !== (await startupDefault(settings))) differing.push(selector);
		}
		expect(differing).toEqual([
			"anthropic/claude-sonnet-4-5",
			"claude-sonnet-4-5",
			"claude-sonnet",
			"anthropic/claude-sonnet-4-5,openai/gpt-5-mini",
		]);
	});
});
