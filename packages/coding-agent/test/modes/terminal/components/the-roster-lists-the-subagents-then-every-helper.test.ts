/**
 * WHY: the Roster page is one table of what each subagent and each helper runs. A feature's own
 * model call (the advisor, plan mode, commit messages, titles…) is a helper, listed in the Helpers
 * section below the Subagents section. The defects this closes: a helper missing from the page (so
 * its model can only be set by hand-editing config), the sections in the wrong order, a helper row
 * whose editor writes another helper's entry or the agents table, a row that does not show the
 * value its page wrote, leaving a page landing on the top of the list instead of the row that
 * opened it, a narrow card cutting the effort off a row, and a catalog id ending in `:max` read as
 * max effort.
 *
 * The sweep runs over `HELPER_IDS`, so a new helper is listed and edited here without touching this
 * file. It drives the Effort row; the Model row writes through the same `#writeHelper` path, and the
 * chain picker it opens is covered by the model-chain suites, not here. The narrow-card case runs
 * at the widths in `NARROW_WIDTHS`; a card narrower than the fixed columns drops the description,
 * which the select list owns.
 *
 * Subject: `selectors/agents-submenu.ts`, driven through `SettingsSelectorComponent`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { HELPER_IDS, HELPERS, type HelperId } from "@veyyon/coding-agent/task/helper-settings";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { configuredThinkingLevelOptions } from "@veyyon/coding-agent/thinking";
import * as YAML from "yaml";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";
import { useTrackedTempDirs } from "../../../helpers/tracked-temp-dir";

const ENTER = "\n";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const WIDTH = 220;

/** Terminal widths at which the settings card leaves the roster less room than its widest row. */
const NARROW_WIDTHS = [100, 120, 140];

/** More presses than the roster has rows, so a walk that never arrives fails instead of hanging. */
const MAX_WALK = 64;

const makeTempDir = useTrackedTempDirs("veyyon-roster-helpers-");

const model: Model = buildModel({
	id: "reasoning-model",
	name: "Reasoning model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
});

const modelRegistry = {
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true },
} as unknown as ModelRegistry;

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	resetSettingsForTest();
	geometryStub = stubStdoutGeometry({ columns: WIDTH, rows: 80 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	resetSettingsForTest();
});

interface Roster {
	component: SettingsSelectorComponent;
	changes: SettingPath[];
}

function frameOf(component: SettingsSelectorComponent, width = WIDTH): string {
	return component
		.render(width)
		.map(line => stripVTControlCharacters(line))
		.join("\n");
}

interface RosterOptions {
	/** The profile's `config.yml`, written before settings load. */
	config?: Record<string, unknown>;
	/** The models the settings screen offers; the reasoning model alone by default. */
	models?: Model[];
}

/** The settings screen with the Roster open, after agent discovery has drawn the list. */
async function openRoster(options: RosterOptions = {}): Promise<Roster> {
	const root = makeTempDir();
	const agentDir = path.join(root, "profile");
	const cwd = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	if (options.config) fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(options.config));
	await Settings.init({ agentDir, cwd });

	let rendered = Promise.withResolvers<void>();
	const changes: SettingPath[] = [];
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: [],
			cwd,
			modelRegistry,
			availableModels: options.models ?? [model],
			requestRender: () => rendered.resolve(),
		},
		{ onChange: changed => changes.push(changed), onCancel: () => {} },
	);
	component.openTab("agents");
	expect(component.selectSetting("agent.agents")).toBe(true);
	component.handleInput(ENTER);
	while (frameOf(component).includes("Reading agents")) {
		await rendered.promise;
		rendered = Promise.withResolvers<void>();
	}
	return { component, changes };
}

/** The detail line under the list: the selected row's description, when that row is a helper. */
function selectedDescription(component: SettingsSelectorComponent): string | undefined {
	const frame = frameOf(component);
	return HELPER_IDS.map(id => HELPERS[id].description).find(description => frame.includes(description));
}

/** The index of a section header row: the group name in capitals, then a rule. */
function headerIndex(lines: string[], group: string): number {
	return lines.findIndex(line => line.includes(`${group.toUpperCase()} ─`));
}

/** The roster row under the cursor, by the label it shows. */
function focusedRow(component: SettingsSelectorComponent, label: string): string | undefined {
	return frameOf(component)
		.split("\n")
		.find(line => line.includes(`› ${label} `));
}

/** Move the cursor down until `id`'s helper row is selected; returns how many presses that took. */
function walkToHelper(component: SettingsSelectorComponent, id: HelperId): number {
	for (let presses = 0; presses < MAX_WALK; presses++) {
		if (selectedDescription(component) === HELPERS[id].description) return presses;
		component.handleInput(DOWN);
	}
	throw new Error(`the ${id} helper row was not reached in ${MAX_WALK} presses`);
}

/** The label of the roster or page row under the cursor, read from the pane beside the tab sidebar. */
function selectedLabel(component: SettingsSelectorComponent): string | undefined {
	for (const line of frameOf(component).split("\n")) {
		const pane = line.split("│")[2];
		const match = pane?.match(/^\s*› (\S+(?: \S+)*)\s{2,}/);
		if (match) return match[1];
	}
	return undefined;
}

describe("the Roster page", () => {
	it("lists the Subagents first, then a Helpers section with every helper in order", async () => {
		const { component } = await openRoster();
		const lines = frameOf(component).split("\n");
		// The cursor starts on a subagent: no helper's description is drawn under the list.
		expect(selectedDescription(component)).toBeUndefined();
		const subagentsHeader = headerIndex(lines, "Subagents");
		const helpersHeader = headerIndex(lines, "Helpers");
		expect(subagentsHeader).toBeGreaterThanOrEqual(0);
		expect(helpersHeader).toBeGreaterThan(subagentsHeader);

		// Every subagent row comes before the first helper.
		expect(walkToHelper(component, HELPER_IDS[0])).toBeGreaterThan(0);
		for (const [index, id] of HELPER_IDS.entries()) {
			if (index > 0) component.handleInput(DOWN);
			expect(focusedRow(component, HELPERS[id].label)).toBeDefined();
			expect(selectedDescription(component)).toBe(HELPERS[id].description);
		}
	});

	it("reads session in the model and effort cells of a helper with nothing set", async () => {
		const { component } = await openRoster();
		walkToHelper(component, HELPER_IDS[0]);
		const row = focusedRow(component, HELPERS[HELPER_IDS[0]].label);
		expect(row?.match(/\bsession\b/g)).toHaveLength(2);
	});

	it("keeps a row's effort whole in a narrow card and cuts the model instead", async () => {
		const long = "test/a-model-selector-long-enough-to-run-past-every-card-width-the-roster-is-drawn-at";
		const { component } = await openRoster({
			config: { agent: { helpers: { commit: { model: long, thinkingLevel: "high" } } } },
		});
		walkToHelper(component, "commit");
		for (const width of NARROW_WIDTHS) {
			const lines = frameOf(component, width).split("\n");
			const heading = lines.find(line => /\bState\s+Effort\s+Model\b/.test(line));
			expect({ width, heading: heading !== undefined }).toEqual({ width, heading: true });
			const row = lines.find(line => line.includes(`› ${HELPERS.commit.label} `));
			expect({ width, row }).toEqual({ width, row: expect.stringMatching(/\bhigh\s+test\/a-\S*…/) });
		}
	});

	it("reads a catalog id ending in :max as that model, not as max effort", async () => {
		const literal = buildModel({
			id: "router:max",
			name: "Router max",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		});
		const { component } = await openRoster({
			config: {
				agent: { helpers: { commit: { model: "test/router:max" }, plan: { model: "test/reasoning-model:max" } } },
			},
			models: [model, literal],
		});
		walkToHelper(component, "plan");
		expect(focusedRow(component, HELPERS.plan.label)).toMatch(/\bmax\s+test\/reasoning-model:max\b/);
		walkToHelper(component, "commit");
		expect(focusedRow(component, HELPERS.commit.label)).toMatch(/\bsession\s+test\/router:max\b/);
	});

	it("returns from an agent's page to that agent's row, and from a nested level to Can spawn", async () => {
		const { component } = await openRoster();
		// The second subagent, so a return that lands on the first row is told apart from one that
		// lands on the row that opened the page.
		component.handleInput(DOWN);
		const label = selectedLabel(component);
		expect(label).toBeDefined();
		component.handleInput(ENTER);
		expect(frameOf(component)).toContain(`Agent: ${label}`);

		// Enabled, Model, Effort, then Can spawn opens the nested level.
		for (let row = 0; row < 3; row++) component.handleInput(DOWN);
		expect(selectedLabel(component)).toBe("Can spawn");
		component.handleInput(ENTER);
		expect(frameOf(component)).toContain(`${label} › agents`);

		component.handleInput(ESC);
		expect(frameOf(component)).toContain(`Agent: ${label}`);
		expect(selectedLabel(component)).toBe("Can spawn");

		component.handleInput(ESC);
		expect(frameOf(component)).toContain("SUBAGENTS ─");
		expect(selectedLabel(component)).toBe(label);
	});

	const effortOptions = configuredThinkingLevelOptions({
		scope: [model],
		inheritLabel: "Inherit",
		inheritDescription: "Follow the session's effort",
	});

	describe.each([...HELPER_IDS])("the %s row", id => {
		it("opens that helper's page, writes only its agent.helpers entry, and returns to its row", async () => {
			const { component, changes } = await openRoster();
			const label = HELPERS[id].label;
			walkToHelper(component, id);
			component.handleInput(ENTER);
			expect(frameOf(component)).toContain(`Helper: ${label}`);
			expect(frameOf(component)).toContain("inherit · the session's model");

			// Effort row, then the first level below Inherit.
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			expect(frameOf(component)).toContain(`Effort · ${label}`);
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			await Settings.instance.flush();

			const level = effortOptions[1]!.value;
			expect(changes).toContain("agent.helpers");
			expect(changes).not.toContain("agent.agents");
			expect(settings.layerValue("profile", ["agent", "helpers"])).toEqual({ [id]: { thinkingLevel: level } });
			expect(settings.layerValue("profile", ["agent", "agents"])).toBeUndefined();
			expect(frameOf(component)).toContain(`Helper: ${label}`);
			// The picker hands the cursor back to the row that opened it.
			expect(focusedRow(component, "Effort")).toBeDefined();

			// Back on the roster, on this helper's row, which shows the level the page wrote.
			component.handleInput(ESC);
			expect(selectedDescription(component)).toBe(HELPERS[id].description);
			expect(focusedRow(component, label)).toMatch(new RegExp(`\\b${level}\\b`));

			// Reset, two rows below Model, clears the entry it wrote, and the row reads session again.
			component.handleInput(ENTER);
			component.handleInput(DOWN);
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			await Settings.instance.flush();
			const after = settings.layerValue("profile", ["agent", "helpers"]);
			expect(after === undefined || Object.keys(after as Record<string, unknown>).length === 0).toBe(true);
			component.handleInput(ESC);
			expect(focusedRow(component, label)?.match(/\bsession\b/g)).toHaveLength(2);
		});
	});
});
