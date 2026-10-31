import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import {
	computeModalDims,
	MODAL_SIZING_SETTINGS,
	sizingForArea,
} from "@veyyon/coding-agent/modes/terminal/components/chrome/modal-geometry";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

const activeSelectors = new Set<SettingsSelectorComponent>();

function layoutPaneWidth(terminalWidth: number): number {
	const termHeight = Math.max(1, process.stdout.rows || 40);
	const sizing = sizingForArea(MODAL_SIZING_SETTINGS, termHeight);
	const dims = computeModalDims(terminalWidth, termHeight, sizing)!;
	const contentWidth = dims.contentWidth;
	const sidebarWidth = Math.min(19, Math.max(10, Math.floor(contentWidth / 3)));
	return Math.max(1, contentWidth - sidebarWidth - 3);
}

function createSelector(
	overrides: {
		getStatusLinePreview?: (width?: number) => string;
		onCancel?: () => void;
		requestRender?: () => void;
	} = {},
): SettingsSelectorComponent {
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["titanium"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
			requestRender: overrides.requestRender,
		},
		{
			onChange: () => {},
			onCancel: overrides.onCancel ?? (() => {}),
			getStatusLinePreview: overrides.getStatusLinePreview,
		},
	);
	activeSelectors.add(component);
	component.render(131);
	return component;
}

function strippedFrame(component: SettingsSelectorComponent, width: number): string[] {
	return component.render(width).map(stripVTControlCharacters);
}

describe("agent roster and unset settings visibility contracts", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		for (const selector of activeSelectors) {
			selector.dispose();
		}
		activeSelectors.clear();
		resetSettingsForTest();
	});
	it("renders (unset) for empty text settings in the settings list", () => {
		// Ensure an optional text/array setting is empty/unset
		settings.unset("tools.essentialOverride");
		const component = createSelector();
		component.handleInput("essential tools override");

		const frame = strippedFrame(component, 131);
		const row = frame.find(line => line.includes("Essential Tools Override"));
		expect(row).toBeDefined();
		expect(row).toContain("(unset)");
	});

	it("passes paneWidth to getStatusLinePreview without artificial ellipsis", () => {
		let capturedWidth: number | undefined;
		const component = createSelector({
			getStatusLinePreview: width => {
				capturedWidth = width;
				return "location-line\ncapability-line";
			},
		});

		const frame = strippedFrame(component, 131);
		expect(capturedWidth).toBe(layoutPaneWidth(131));

		const previewLine = frame.find(line => line.includes("capability-line"));
		expect(previewLine).toBeDefined();
		expect(previewLine).not.toContain("…");
	});

	it("renders navigation footer and custom agent hint in agent roster without clipping", async () => {
		let rendered = Promise.withResolvers<void>();
		const component = createSelector({ requestRender: () => rendered.resolve() });

		// Type search query to filter for Roster
		component.handleInput("Roster");
		component.render(131);

		// Activate the Roster row with Return
		component.handleInput("\r");
		component.render(131);

		// Wait on discovery's re-render request, not on the clock, until the roster replaces its loading frame.
		while (strippedFrame(component, 131).some(line => line.includes("Reading agents"))) {
			await rendered.promise;
			rendered = Promise.withResolvers<void>();
		}

		// The subagents lead the list, so the first frame already shows a discovered agent row.
		const frame = strippedFrame(component, 131);

		// Discovered agent rows, CUSTOM_AGENT_HINT and the card's sub-pane keys must be present
		const agentRow = frame.find(line => line.includes("scout"));
		const hintLine = frame.find(line => line.includes("~/.veyyon/subagents/"));
		const navLine = frame.find(line => line.includes("enter confirm") && line.includes("esc back"));

		expect(agentRow, frame.join("\n")).toBeDefined();
		expect(hintLine, frame.join("\n")).toBeDefined();
		expect(navLine, frame.join("\n")).toBeDefined();
	});
});
