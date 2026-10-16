/**
 * WHY: model roles were folded into the Roster. A feature's own model call (the
 * advisor, plan mode, commit messages, titles…) is a helper, configured in the
 * Helpers section that leads the Roster page, above the Subagents section. The
 * defects this closes: a helper missing from the page (so its model can only be
 * set by hand-editing config), the sections in the wrong order, and a helper row
 * whose editor writes another helper's entry or the agents table.
 *
 * The sweep runs over `HELPER_IDS`, so a new helper is listed and edited here
 * without touching this file. It drives the Effort row; the Model row writes
 * through the same `#writeHelper` path, and the chain picker it opens is covered
 * by the model-chain suites, not here.
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
import { HELPER_IDS, HELPERS } from "@veyyon/coding-agent/task/helper-settings";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { configuredThinkingLevelOptions } from "@veyyon/coding-agent/thinking";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";
import { useTrackedTempDirs } from "../../../helpers/tracked-temp-dir";

const ENTER = "\n";
const DOWN = "\x1b[B";
const WIDTH = 220;

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

function frameOf(component: SettingsSelectorComponent): string {
	return component
		.render(WIDTH)
		.map(line => stripVTControlCharacters(line))
		.join("\n");
}

/** The settings screen with the Roster open, after agent discovery has drawn the list. */
async function openRoster(): Promise<Roster> {
	const root = makeTempDir();
	const agentDir = path.join(root, "profile");
	const cwd = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
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
			availableModels: [model],
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

describe("the Roster page", () => {
	it("leads with a Helpers section listing every helper in order, then the Subagents", async () => {
		const { component } = await openRoster();
		const lines = frameOf(component).split("\n");
		const helpersHeader = headerIndex(lines, "Helpers");
		const firstHelper = lines.findIndex(line => line.includes(HELPERS[HELPER_IDS[0]].label));
		expect(helpersHeader).toBeGreaterThanOrEqual(0);
		expect(helpersHeader).toBeLessThan(firstHelper);

		for (const [index, id] of HELPER_IDS.entries()) {
			if (index > 0) component.handleInput(DOWN);
			expect(frameOf(component)).toContain(HELPERS[id].label);
			expect(selectedDescription(component)).toBe(HELPERS[id].description);
		}

		// One past the last helper is the first subagent, under its own header.
		component.handleInput(DOWN);
		expect(selectedDescription(component)).toBeUndefined();
		expect(headerIndex(frameOf(component).split("\n"), "Subagents")).toBeGreaterThanOrEqual(0);
	});

	const effortOptions = configuredThinkingLevelOptions({
		scope: [model],
		inheritLabel: "Inherit",
		inheritDescription: "Follow the session's effort",
	});

	describe.each([...HELPER_IDS])("the %s row", id => {
		it("opens that helper's page and writes only its agent.helpers entry", async () => {
			const { component, changes } = await openRoster();
			for (let i = 0; i < HELPER_IDS.indexOf(id); i++) component.handleInput(DOWN);
			component.handleInput(ENTER);
			expect(frameOf(component)).toContain(`Helper: ${HELPERS[id].label}`);
			expect(frameOf(component)).toContain("inherit · the session's model");

			// Effort row, then the first level below Inherit.
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			expect(frameOf(component)).toContain(`Effort · ${HELPERS[id].label}`);
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			await Settings.instance.flush();

			const level = effortOptions[1]!.value;
			expect(changes).toContain("agent.helpers");
			expect(changes).not.toContain("agent.agents");
			expect(settings.layerValue("profile", ["agent", "helpers"])).toEqual({ [id]: { thinkingLevel: level } });
			expect(settings.layerValue("profile", ["agent", "agents"])).toBeUndefined();
			expect(frameOf(component)).toContain(`Helper: ${HELPERS[id].label}`);

			// Reset clears the entry it wrote.
			component.handleInput(DOWN);
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			await Settings.instance.flush();
			const after = settings.layerValue("profile", ["agent", "helpers"]);
			expect(after === undefined || Object.keys(after as Record<string, unknown>).length === 0).toBe(true);
		});
	});
});
