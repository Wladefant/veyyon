/**
 * The predicates a setting's `ui.condition` names.
 *
 * A dependent knob declares `condition: "lspEnabled"` and the front end that
 * draws the settings screen resolves that name here. Two front ends draw it —
 * the terminal selector and the desktop settings page — and each one used to
 * carry its own copy of the table, so a condition added for one of them left
 * the other rendering a knob whose feature is off. The name is a closed
 * vocabulary with one definition, and a front end adds only what settings
 * cannot answer: what the terminal resolved for its graphics protocol.
 *
 * A predicate reads the store it is handed rather than the process singleton,
 * because the desktop dumps the settings of the session it is serving, which is
 * an isolated store when the client opened a session in another directory.
 */

import { AUTO_THINKING } from "../thinking";
import { resolveEffort, withLegacyDefaultEffort } from "./effort-resolver";
import type { Settings } from "./settings";
import type { SettingValue as SchemaSettingValue, SettingPath } from "./settings-schema";

/** Whether the feature behind a dependent knob is on, per the store handed in. */
export type SettingCondition = (settings: Settings) => boolean;

/**
 * A store that cannot answer hides the knob. A settings read throws for a path
 * the profile cannot resolve, and a knob drawn on an unresolved master is the
 * inert row the condition exists to remove.
 */
function whenSettingsSay(read: () => boolean): boolean {
	try {
		return read();
	} catch {
		return false;
	}
}

const settingFlag =
	(path: SettingPath): SettingCondition =>
	settings =>
		whenSettingsSay(() => settings.get(path) === true);

const settingValue =
	<P extends SettingPath>(path: P, check: (val: SchemaSettingValue<P>) => boolean): SettingCondition =>
	settings =>
		whenSettingsSay(() => check(settings.get(path)));

/**
 * Every condition a setting declares, except the ones a front end answers from
 * its own capabilities. A name missing here resolves to no predicate, and the
 * row renders unconditionally; `test/architecture/an-off-feature-hides-its-knobs.test.ts`
 * and `test/architecture/a-declared-condition-resolves-on-every-front-end.test.ts`
 * fail on a declared name no front end resolves.
 */
export const SETTING_CONDITIONS: Record<string, SettingCondition> = {
	advisorEnabled: settingFlag("advisor.enabled"),
	argotEnabled: settingFlag("argot.enabled"),
	autoQaEnabled: settingFlag("dev.autoqa"),
	statusLineEnabled: settingFlag("statusLine.enabled"),
	cpuLimitEnabled: settingValue("session.cpuLimitCores", v => v > 0),
	writeBudgetEnabled: settingValue("session.writeBudgetGb", v => v > 0),
	cacheRejectionReported: settingFlag("cache.reportRejection"),
	agentPruneEnabled: settingFlag("agent.prune.enabled"),
	agentSharedModel: settingFlag("agent.sharedModel"),
	agentIsolationEnabled: settingValue("agent.isolation.mode", v => v !== "none"),
	agentSoftRequestBudgetEnabled: settingValue("agent.softRequestBudget", v => (v ?? 0) > 0),
	bashAutoBackgroundEnabled: settingFlag("bash.autoBackground.enabled"),
	bashStallDetectionEnabled: settingFlag("bash.stallDetection.enabled"),
	hindsightActive: settingValue("memory.backend", v => v === "hindsight"),
	mnemopiActive: settingValue("memory.backend", v => v === "mnemopi"),
	autolearnActive: settingFlag("autolearn.enabled"),
	autoThinkingActive: settings =>
		whenSettingsSay(
			() =>
				resolveEffort({
					defaultEffort: withLegacyDefaultEffort(
						settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
						settings.get("defaultThinkingLevel"),
					),
				}).level === AUTO_THINKING,
		),
	planModeEnabled: settingValue("plan.enabled", Boolean),
	speechEnabled: settingFlag("speech.enabled"),
	sttEnabled: settingFlag("stt.enabled"),
	unexpectedStopDetection: settingFlag("features.unexpectedStopDetection"),
	lspEnabled: settingFlag("lsp.enabled"),
	browserEnabled: settingFlag("browser.enabled"),
	githubEnabled: settingFlag("github.enabled"),
	launchEnabled: settingFlag("launch.enabled"),
	githubCacheEnabled: settings =>
		whenSettingsSay(() => settings.get("github.enabled") === true && settings.get("github.cache.enabled") === true),
	secretsEnabled: settingFlag("secrets.enabled"),
	prewalkEnabled: settingFlag("prewalk.enabled"),
};

/**
 * The same table against one store, for a front end that reads the process
 * settings and wants a nullary predicate per name.
 */
export function bindSettingConditions(read: () => Settings): Record<string, () => boolean> {
	const bound: Record<string, () => boolean> = {};
	for (const [name, met] of Object.entries(SETTING_CONDITIONS)) {
		bound[name] = () => met(read());
	}
	return bound;
}
