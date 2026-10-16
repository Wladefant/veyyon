/**
 * The settings card's agent roster: the helper and subagent rows, each agent's lanes by spawn depth,
 * and the model and effort pickers a lane opens.
 */
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { type Component, Container, type SelectItem, type SelectList, Spacer, Text } from "@veyyon/tui";
import { clamp, errorMessage, isRecord } from "@veyyon/utils";
import { matchesKey } from "@veyyon/utils/keys";
import { namesInheritedModel, normalizeModelPatternList } from "../../../../config/model-pattern-list";
import type { ModelRegistry } from "../../../../config/model-registry";
import { extractExplicitThinkingSelector } from "../../../../config/model-resolver";
import { settings } from "../../../../config/settings";
import type { AgentLaneSettings, AgentSettings, HelperLaneSettings } from "../../../../config/settings-domains/agents";
import type { SettingPath } from "../../../../config/settings-schema";
import {
	AGENT_ENABLE_STATE_LABEL,
	agentEnableState,
	agentModelSourceLabel,
	agentScopeIsShared,
	agentSettingsFor,
	delegationBlockedNotice,
	isAgentEnableDefaulted,
	nextAgentEnableValue,
	resolveAgentMaxNestedSpawnDepth,
	resolveAgentModel,
	resolveAgentThinkingLevel,
	resolveDelegation,
} from "../../../../task/agent-settings";
import { discoverAgents } from "../../../../task/discovery";
import {
	HELPER_IDS,
	HELPERS,
	type HelperId,
	helperModelPatterns,
	helperSettingsFor,
	helperThinkingLevel,
	isHelperId,
} from "../../../../task/helper-settings";
import { type AgentDefinition, canSpawnAtDepth } from "../../../../task/types";
import { theme } from "../../../../theme/theme-binding";
import {
	configuredThinkingLevelOptions,
	INHERIT_EFFORT_OPTION_VALUE,
	noSelectableEffortNotice,
} from "../../../../thinking";
import { barePickerSelector, ModelChainSubmenu } from "./model-chain-submenu";
import { MouseRoutedSubmenu } from "./select-list-mouse-routing";
import { isOverrideSource, overriddenEntryLabel, profileWritableRecord, recordEntrySource } from "./setting-source";
import {
	createFocusedSelectList,
	formatModelSummaryWithFallbacks,
	MODEL_CATALOG_UNAVAILABLE,
	renderAsyncStatusFrame,
	SelectSubmenu,
} from "./settings-submenus";

const AGENT_LIST_DESCRIPTION =
	"Helpers are model calls features make on their own; subagents are agents the model may spawn. Unset rows run the session's model and effort.";

const AGENTS_PATH = "agent.agents" satisfies SettingPath;

const HELPERS_PATH = "agent.helpers" satisfies SettingPath;

/**
 * Rows the roster shows at once before it scrolls. Eight keeps the page's footer on screen in a
 * 40-row terminal with a three-line agent description under the list.
 */
const ROSTER_MAX_ROWS = 8;

const AGENT_ROW_OFFERED = "\u0000agent-offered";

const AGENT_ROW_NESTED = "\u0000agent-nested";

const AGENT_ROW_RESET = "\u0000agent-reset";

/**
 * Row ids for the two settings an agent's own page edits: the model and the
 * effort THAT agent runs. The page that shows a lane's value is the page that
 * changes it, because the previous shape showed a value and then named a
 * different screen to go and change it on.
 */
const AGENT_ROW_MODEL = "\u0000agent-model";

const AGENT_ROW_EFFORT = "\u0000agent-effort";

/** Prefix of a helper row's value, so a helper and an agent of the same name stay distinct. */
const HELPER_ROW_PREFIX = "\u0000helper:";

const AGENT_ROW_NONE = "\u0000agent-none";

const HELPERS_GROUP = "Helpers";

const SUBAGENTS_GROUP = "Subagents";

const CUSTOM_AGENT_HINT =
	"Write your own: a markdown file in ~/.veyyon/subagents/. Guide: veyyon.dev/docs/features/agents-authoring.html";

/** The settings one pass through the roster can write. */
type AgentRosterPath = "agent.agents" | "agent.helpers";

/**
 * What a lane's Effort row narrows against, as three distinct answers rather
 * than one nullable model.
 *
 * `model` — a model is named and resolved: the lane's chain head, or the
 * session's own model when the lane names none.
 * `unresolved` — a model is named and this session has no catalog entry for it
 * (an unauthenticated provider, a pattern matching nothing). Offering a ladder
 * here invents one: the picker says which pattern it cannot read instead.
 * `blanket` — nothing is named at all, so the row spans the catalog and the
 * honest list is the union of what the catalog declares.
 *
 * The three used to be one `Model | undefined`, and undefined fell through to
 * the full vocabulary: `minimal` on a row whose endpoint declares `low, high,
 * max`, and an invented ladder for an id like `cursor-grok-4.6-medium` whose id
 * IS its effort.
 */
type AgentEffortScope = { kind: "model"; model: Model } | { kind: "unresolved"; pattern: string } | { kind: "blanket" };

export function effortScopeForPattern(
	models: ReadonlyArray<Model> | undefined,
	head: string | undefined,
	sessionModel: Model | undefined,
): AgentEffortScope {
	if (!head) return sessionModel ? { kind: "model", model: sessionModel } : { kind: "blanket" };
	const bare = models ? barePickerSelector(head, models as Model<Api>[]) : head;
	const found = models?.find(candidate => `${candidate.provider}/${candidate.id}` === bare);
	return found ? { kind: "model", model: found } : { kind: "unresolved", pattern: head };
}

/** The picker rows and the sentence that explains a short list, from one scope. */
export function agentEffortOptions(
	scope: AgentEffortScope,
	catalog: ReadonlyArray<Model> | undefined,
): { options: Array<{ value: string; label: string; description: string }>; notice: string | undefined } {
	if (scope.kind === "unresolved") {
		return {
			options: configuredThinkingLevelOptions({
				inheritLabel: "Inherit",
				inheritDescription: "Follow the session's effort",
			}).map(option => ({ ...option })),
			notice: `No model in this session matches \`${scope.pattern}\`, so its effort levels are unknown. Inherit is the only choice that means anything until the chain resolves.`,
		};
	}
	const options = configuredThinkingLevelOptions({
		model: scope.kind === "model" ? scope.model : undefined,
		scope: scope.kind === "blanket" ? catalog : undefined,
		inheritLabel: "Inherit",
		inheritDescription: "Follow the session's effort",
	}).map(option => ({ ...option }));
	if (options.length > 1) return { options, notice: undefined };
	return {
		options,
		notice:
			scope.kind === "model"
				? noSelectableEffortNotice()
				: "No model in this session declares a selectable effort, so only Inherit applies.",
	};
}

/**
 * Whether a lane at `depth` may run, with the default applied.
 *
 * `depth` is the lane's index in the chain, and lane index `i` is the process
 * at task depth `i + 1`, so a lane runs exactly when the level above it may
 * spawn — {@link canSpawnAtDepth} against the cap that governs this agent.
 * Unset is NOT off: it is the blanket ceiling still answering, which is why a
 * stock roster shows the nested level off and a config that raised the ceiling
 * shows it on without anything being written per agent.
 *
 * Stated once here because the page, the summary row and the resolver all need
 * the same answer, and a hardcoded "off below the first level" gave the page a
 * different one than the spawn gate.
 */
function laneSpawnEnabled(lane: AgentLaneSettings, depth: number, resolvedMax: number): boolean {
	return lane.enabled ?? canSpawnAtDepth(resolvedMax, depth);
}

function lanePath(name: string, depth: number): string {
	return `agent.agents.${name}${".agents".repeat(depth)}`;
}

/**
 * One lane with its empty fields dropped, or undefined when nothing is left.
 *
 * A lane that stores only `{}` — or only `{ agents: {} }` — is a row that
 * reads as configured to everything that checks for one, while deciding nothing.
 * Pruning bottom-up is what lets a page be opened, looked at, and left without
 * writing anything.
 */
function pruneLane(lane: AgentLaneSettings): AgentLaneSettings | undefined {
	const cleaned: AgentLaneSettings = {};
	if (lane.enabled !== undefined) cleaned.enabled = lane.enabled;
	if (lane.model !== undefined && (Array.isArray(lane.model) ? lane.model.length > 0 : lane.model.trim().length > 0)) {
		cleaned.model = lane.model;
	}
	if (lane.thinkingLevel !== undefined && lane.thinkingLevel.trim().length > 0) {
		cleaned.thinkingLevel = lane.thinkingLevel;
	}
	const child = lane.agents === undefined ? undefined : pruneLane(lane.agents);
	if (child !== undefined) cleaned.agents = child;
	// The pre-tree number survives only while there is no chain. It still decides
	// in that state, so dropping it on an unrelated toggle would silently change
	// the ceiling; once a chain exists it decides nothing, and leaving it behind
	// is a dead value in the operator's file that once did.
	if (lane.maxNestedSpawnDepth !== undefined && child === undefined) {
		cleaned.maxNestedSpawnDepth = lane.maxNestedSpawnDepth;
	}
	return Object.keys(cleaned).length === 0 ? undefined : cleaned;
}

/**
 * The `agent.agents` table: the discovered agents, each with what it runs and
 * what it may spawn.
 *
 * Every answer comes from `task/agent-settings.ts` — the enable default, the
 * state wording, the model precedence and the layer that decided it — so this and
 * `/agents` cannot describe the same row differently. It edits settings rows only;
 * writing an agent FILE stays in `/agents`, which is why the footer points there.
 *
 * A lane is RECURSIVE and every page has the same shape: Enabled, Model, Effort,
 * and a door to what this lane may spawn. Open `deep`, and you are setting what
 * `deep` runs; open its `Agents` row and you are setting what `deep` spawns,
 * with `inherit` meaning the page you came from. There is no ceiling: the chain
 * goes as deep as levels are turned on, and `Agents → Enabled` IS the depth
 * limit, which is why no numeric row sits beside it.
 *
 * The hazard this shape has to keep answering: a per-agent model once outranked
 * the blanket setting from a screen that did not show it, and two screens gave
 * different answers for one agent. The rule that fixes it is not "no per-agent
 * layer" but "the page that SHOWS a value CHANGES that value" — every row here
 * edits the lane it is drawn on, and the badge names the exact path that decided.
 *
 * The list is discovered rather than read off the stored table: a row exists only
 * once something is overridden, so a table-driven list would be empty on a stock
 * install and would hide exactly the specialists the operator came to turn on.
 */
export class AgentsSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#agents: AgentDefinition[] = [];
	#loadError: string | undefined;
	#loaded = false;
	#escapeTo: (() => void) | undefined;

	constructor(
		private readonly cwd: string,
		private readonly sessionModel: Model | undefined,
		private readonly models: ReadonlyArray<Model> | undefined,
		private readonly picker: { registry: ModelRegistry; models: ReadonlyArray<Model> } | undefined,
		private readonly onChange: (path: AgentRosterPath) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showAgentList();
		void this.#load();
	}

	async #load(): Promise<void> {
		try {
			const { agents } = await discoverAgents(this.cwd);
			this.#agents = agents.slice().sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			this.#loadError = errorMessage(error);
		}
		this.#loaded = true;
		this.#showAgentList();
		this.requestRender?.();
	}

	/**
	 * The rows the profile itself holds, always an object so callers can spread
	 * it. Writing one lane never copies a row an override supplies into the
	 * profile.
	 */
	#table(): Record<string, AgentSettings> {
		const stored = profileWritableRecord(AGENTS_PATH);
		return stored && typeof stored === "object" ? ({ ...stored } as Record<string, AgentSettings>) : {};
	}

	#row(name: string): AgentSettings {
		return { ...agentSettingsFor(settings, name) };
	}

	/**
	 * The lane a page is showing: `[]` is the agent's own page, `["agents"]`
	 * the page for what it may spawn, and one more step per level below that.
	 *
	 * A level the operator has not opened yet does not exist in the file, so this
	 * answers with an empty lane rather than undefined: the page renders the
	 * defaults, and nothing is written until something is chosen.
	 */
	#lane(name: string, depth: number): AgentLaneSettings {
		let lane: AgentLaneSettings = this.#row(name);
		for (let step = 0; step < depth; step++) lane = lane.agents ?? {};
		return { ...lane };
	}

	/**
	 * Write one lane back into its agent's row, rebuilding the chain above it.
	 *
	 * Empty fields and empty lanes are dropped on the way up, and a row left with
	 * nothing is deleted: an empty row and no row must not be distinguishable,
	 * because a bare `{}` in the file reads as "configured" to anything checking
	 * for a row.
	 */
	#writeLane(name: string, depth: number, next: AgentLaneSettings): void {
		const chain: AgentLaneSettings[] = [];
		let lane: AgentLaneSettings = this.#row(name);
		for (let step = 0; step < depth; step++) {
			chain.push(lane);
			lane = lane.agents ?? {};
		}
		let rebuilt = pruneLane(next);
		for (let step = chain.length - 1; step >= 0; step--) {
			rebuilt = pruneLane({ ...chain[step], agents: rebuilt });
		}
		const table = this.#table();
		if (rebuilt === undefined) delete table[name];
		else table[name] = rebuilt;
		settings.set("agent.agents", table);
		this.onChange("agent.agents");
	}

	#runsSummary(agent: AgentDefinition, depth = 0): string {
		const model = modelSummary(agent, depth);
		const resolved = resolveAgentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			taskDepth: depth + 1,
		});
		const head = resolved.patterns[0];
		if (head && extractExplicitThinkingSelector(head) !== undefined) return model;
		const effort = resolveAgentThinkingLevel({
			settings,
			agentName: agent.name,
			agentThinkingLevel: agent.thinkingLevel,
			taskDepth: depth + 1,
		});
		if (effort !== ThinkingLevel.Inherit) return `${model} ${theme.fg("dim", `· ${effort} effort`)}`;
		if (resolved.inherited) return theme.fg("dim", "the session's model and effort");
		return `${model} ${theme.fg("dim", "· session effort")}`;
	}

	#showAgentList(): void {
		this.clear();
		this.#escapeTo = undefined;

		this.#selectList = undefined;

		if (
			renderAsyncStatusFrame(
				this,
				"Roster",
				AGENT_LIST_DESCRIPTION,
				this.#loaded,
				this.#loadError,
				"Reading agents…",
				"Could not read the agent directories",
			)
		) {
			return;
		}

		let headerExtra: Component | undefined;
		// Whether this table has any effect is decided by `agent.delegation` as
		// well, and that setting is a row the reader is not looking at right now. So
		// the panel says when nothing will be delegated, from the one resolver that
		// reads both — the same sentence `/agents` shows, for the same reason.
		const blocked = delegationBlockedNotice(
			resolveDelegation(
				settings,
				this.#agents
					.filter(agent => agentEnableState(agent, this.#row(agent.name).enabled) === "on")
					.map(agent => agent.name),
			),
		);
		if (blocked) {
			headerExtra = new Text(theme.fg("warning", `  ${blocked}`), 0, 0);
		}

		// Helpers, then one row per discovered agent. There is no header pair
		// answering for the whole list: a control that reached every agent at once
		// is what made "I changed the model" and "my agents changed model" one
		// event.
		const items: SelectItem[] = HELPER_IDS.map(id => {
			const value = `${HELPER_ROW_PREFIX}${id}`;
			const shown = this.#helperSummary(id);
			const source = recordEntrySource(HELPERS_PATH, id);
			if (isOverrideSource(source)) {
				return {
					value,
					label: HELPERS[id].label,
					description: `${shown} · ${overriddenEntryLabel(source)}`,
					group: HELPERS_GROUP,
					disabled: true,
				};
			}
			return { value, label: HELPERS[id].label, description: shown, group: HELPERS_GROUP };
		});
		for (const agent of this.#agents) {
			const shown = `${AGENT_ENABLE_STATE_LABEL[agentEnableState(agent, this.#row(agent.name).enabled)]} · ${modelSummary(agent)}`;
			const source = recordEntrySource(AGENTS_PATH, agent.name);
			if (isOverrideSource(source)) {
				items.push({
					value: agent.name,
					label: agent.name,
					description: `${shown} · ${overriddenEntryLabel(source)}`,
					group: SUBAGENTS_GROUP,
					disabled: true,
				});
				continue;
			}
			items.push({ value: agent.name, label: agent.name, description: shown, group: SUBAGENTS_GROUP });
		}
		if (this.#agents.length === 0) {
			items.push({ value: AGENT_ROW_NONE, label: "No agent types found", group: SUBAGENTS_GROUP, disabled: true });
		}

		const selectList = createFocusedSelectList(items, clamp(items.length, 1, ROSTER_MAX_ROWS), undefined, {
			onSelect: item => {
				const helper = helperFromRowValue(item.value);
				if (helper) this.#showHelperEditor(helper);
				else this.#showAgentEditor(item.value);
				this.requestRender?.();
			},
			onCancel: this.onCancel,
		});
		this.#selectList = selectList;

		const detail = new Text(this.#detailText(items[0]?.value), 0, 0);
		selectList.onSelectionChange = item => {
			if (detail.setText(this.#detailText(item.value))) this.requestRender?.();
		};

		const footerExtra = new Container();
		footerExtra.addChild(detail);
		footerExtra.addChild(new Spacer(1));
		footerExtra.addChild(new Text(theme.fg("muted", `  ${CUSTOM_AGENT_HINT}`), 0, 0));

		this.renderSubmenuFrame({
			title: "Roster",
			description: AGENT_LIST_DESCRIPTION,
			headerExtra,
			body: selectList,
			footerExtra,
			footerHint: "  Enter to configure · Esc to go back",
		});
	}

	#agent(name: string): AgentDefinition | undefined {
		return this.#agents.find(candidate => candidate.name === name);
	}

	#detailText(value: string | undefined): string {
		if (value === undefined) return "";
		const helper = helperFromRowValue(value);
		const description = helper ? HELPERS[helper].description : this.#agent(value)?.description?.trim();
		if (!description) return "";
		return theme.fg("muted", `  ${description}`);
	}

	/**
	 * One lane's page. `depth` 0 is the agent itself; each step down is one
	 * `Agents` row followed, and the page shape never changes.
	 */
	#showAgentEditor(name: string, depth = 0): void {
		const agent = this.#agent(name);
		if (!agent) {
			this.#showAgentList();
			return;
		}
		const lane = this.#lane(name, depth);
		const child = lane.agents ?? {};
		// The cap this agent's whole tree runs under, asked once: every default on
		// this page is read off it, so the page cannot claim a level the spawn gate
		// would refuse.
		const resolvedMax = resolveAgentMaxNestedSpawnDepth(settings, name);
		const spawnAllowed = laneSpawnEnabled(child, depth + 1, resolvedMax);

		this.clear();
		this.#escapeTo = undefined;
		// The trail, not just the name: three levels down, "Agent: deep" alone
		// cannot say which of the three pages you are on.
		const trail = depth === 0 ? `Agent: ${name}` : `${name}${" › agents".repeat(depth)}`;
		// One scope draws its rows and the other draws none. A Model row here
		// while the blanket switch is on would show a value no spawn reads, which
		// is the exact confusion that retired the switch the first time. The
		// signpost replaces the rows rather than sitting beside them, so the page
		// still says where the answer is instead of looking like it lost one.
		const shared = agentScopeIsShared(settings);

		const headerExtra = new Container();
		// What this lane runs, resolved, above the rows that change it — and the
		// rows below change THIS lane, so the reader is never sent elsewhere to
		// edit the value they are looking at.
		headerExtra.addChild(new Text(`  ${theme.fg("muted", "Runs")} ${this.#runsSummary(agent, depth)}`, 0, 0));
		if (shared) {
			headerExtra.addChild(new Spacer(1));
			headerExtra.addChild(new Text(theme.fg("dim", "  Set for every agent · Agents → Shared Model"), 0, 0));
		}

		const items: SelectItem[] = [
			{
				value: AGENT_ROW_OFFERED,
				label: "Enabled",
				description:
					depth === 0
						? `${AGENT_ENABLE_STATE_LABEL[agentEnableState(agent, lane.enabled)]}${
								isAgentEnableDefaulted(lane.enabled) ? theme.fg("dim", " (default)") : ""
							}`
						: `${laneSpawnEnabled(lane, depth, resolvedMax) ? "on" : "off"}${
								lane.enabled === undefined ? theme.fg("dim", " (default)") : ""
							}`,
			},
			...(shared
				? []
				: [
						{ value: AGENT_ROW_MODEL, label: "Model", description: laneModelSummary(lane, depth, agent) },
						{ value: AGENT_ROW_EFFORT, label: "Effort", description: laneEffortSummary(lane, depth, agent) },
					]),
			{
				value: AGENT_ROW_NESTED,
				label: "Agents",
				description: spawnAllowed
					? laneModelSummary(child, depth + 1)
					: theme.fg("dim", "off · may not spawn agents"),
			},
		];
		if (Object.keys(lane).length > 0) {
			items.push({
				value: AGENT_ROW_RESET,
				label: "Reset to defaults",
				description: theme.fg("dim", `clears ${lanePath(name, depth)}`),
			});
		}

		const selectList = createFocusedSelectList(items, items.length, undefined, {
			onSelect: item => {
				switch (item.value) {
					case AGENT_ROW_OFFERED:
						this.#writeLane(
							name,
							depth,
							depth === 0
								? { ...lane, enabled: nextAgentEnableValue(agent, lane.enabled) }
								: { ...lane, enabled: !laneSpawnEnabled(lane, depth, resolvedMax) },
						);
						this.#showAgentEditor(name, depth);
						break;
					case AGENT_ROW_MODEL:
						this.#showLaneModelPicker(name, depth);
						break;
					case AGENT_ROW_EFFORT:
						this.#showLaneEffortPicker(name, depth);
						break;
					case AGENT_ROW_NESTED:
						this.#showAgentEditor(name, depth + 1);
						break;
					case AGENT_ROW_RESET:
						this.#writeLane(name, depth, {});
						this.#showAgentEditor(name, depth);
						break;
				}
				this.requestRender?.();
			},
			onCancel: () => {
				if (depth === 0) this.#showAgentList();
				else this.#showAgentEditor(name, depth - 1);
				this.requestRender?.();
			},
		});
		this.#selectList = selectList;

		this.renderSubmenuFrame({
			title: trail,
			description:
				depth === 0
					? agent.description || `${agent.source} agent`
					: `What ${depth === 1 ? name : "the agents at this level"} may spawn. Unset follows the level above.`,
			headerExtra,
			body: selectList,
			footerHint: "  Enter to change · Esc to go back",
		});
	}

	/**
	 * One lane's model chain, edited through the SAME chain editor every other
	 * model surface uses ({@link ModelChainSubmenu}) — handed a writer instead of
	 * a settings key, because a lane lives inside the `agent.agents` record
	 * and only that record's owner can prune the chain of lanes above it.
	 */
	#showLaneModelPicker(name: string, depth: number): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showAgentEditor(name, depth);
		this.#escapeTo = back;
		if (!this.picker) {
			this.#renderCatalogUnavailable(
				depth === 0 ? `Model · ${name}` : `Model · what ${name} spawns${" (nested)".repeat(depth - 1)}`,
			);
			return;
		}
		const lane = this.#lane(name, depth);
		this.addChild(
			new ModelChainSubmenu(
				{
					write: chain => {
						const next = { ...this.#lane(name, depth) };
						if (chain === undefined) delete next.model;
						else next.model = chain;
						this.#writeLane(name, depth, next);
					},
				},
				this.picker.registry,
				this.picker.models,
				depth === 0 ? `Model · ${name}` : `Model · what ${name} spawns${" (nested)".repeat(depth - 1)}`,
				lane.model,
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => this.onChange("agent.agents"),
				this.requestRender,
			),
		);
	}

	#showLaneEffortPicker(name: string, depth: number): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showAgentEditor(name, depth);
		this.#escapeTo = back;
		const lane = this.#lane(name, depth);
		const { options, notice } = agentEffortOptions(this.#laneEffortScope(name, depth), this.models);
		const description =
			notice === undefined
				? depth === 0
					? `Effort ${name} runs at. Inherit follows the session's effort; a \`:level\` on the model chain still wins.`
					: "Effort the agents spawned at this level run at. Inherit follows the level above."
				: `Effort the agents spawned at this level run at. ${notice}`;
		this.addChild(
			new SelectSubmenu(
				depth === 0 ? `Effort · ${name}` : `Effort · what ${name} spawns`,
				description,
				options,
				lane.thinkingLevel?.trim() ?? "",
				value => {
					const next = { ...this.#lane(name, depth) };
					if (value === INHERIT_EFFORT_OPTION_VALUE) delete next.thinkingLevel;
					else next.thinkingLevel = value;
					this.#writeLane(name, depth, next);
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
			),
		);
	}

	/**
	 * What this lane's effort narrows against: the model the lane RESOLVES to,
	 * found by asking the same resolver a spawn asks, so the page and the spawn
	 * cannot disagree about which ladder is on screen.
	 */
	#laneEffortScope(name: string, depth: number): AgentEffortScope {
		const head = resolveAgentModel({
			settings,
			agentName: name,
			agentModel: this.#agent(name)?.model,
			taskDepth: depth + 1,
		}).patterns[0];
		return effortScopeForPattern(this.models, head, this.sessionModel);
	}

	#renderCatalogUnavailable(title: string): void {
		const container = new Container();
		container.addChild(new Text(theme.fg("warning", MODEL_CATALOG_UNAVAILABLE), 0, 0));
		this.renderSubmenuFrame({ title, body: container, footerHint: "  Esc to go back" });
	}

	/** What a helper runs, as its row and its page header show it. */
	#helperSummary(id: HelperId): string {
		const patterns = helperModelPatterns(settings, id);
		const level = helperThinkingLevel(settings, id);
		const head = patterns[0];
		if (head === undefined && level === undefined) return theme.fg("dim", "the session's model and effort");
		const model = head === undefined ? "session model" : formatModelSummaryWithFallbacks(head, patterns.length - 1);
		if (head !== undefined && extractExplicitThinkingSelector(head) !== undefined) return model;
		if (level !== undefined) return `${model} ${theme.fg("dim", `· ${level} effort`)}`;
		return `${model} ${theme.fg("dim", "· session effort")}`;
	}

	/**
	 * Write one helper's row into `agent.helpers`. Empty fields are dropped and a
	 * row left with nothing is deleted, so an unconfigured helper and a cleared
	 * one read the same. Starts from the profile's own record, so an entry an
	 * override supplies is never copied into the profile.
	 */
	#writeHelper(id: HelperId, next: HelperLaneSettings): void {
		const stored = profileWritableRecord(HELPERS_PATH);
		const table: Record<string, HelperLaneSettings> = isRecord(stored)
			? { ...(stored as Record<string, HelperLaneSettings>) }
			: {};
		const cleaned: HelperLaneSettings = {};
		if (normalizeModelPatternList(next.model).length > 0) cleaned.model = next.model;
		if (next.thinkingLevel !== undefined && next.thinkingLevel.trim().length > 0) {
			cleaned.thinkingLevel = next.thinkingLevel;
		}
		if (cleaned.model === undefined && cleaned.thinkingLevel === undefined) delete table[id];
		else table[id] = cleaned;
		settings.set(HELPERS_PATH, table);
		this.onChange(HELPERS_PATH);
	}

	/** One helper's page: its Model and its Effort, each unset to follow the session. */
	#showHelperEditor(id: HelperId): void {
		const info = HELPERS[id];
		const row = helperSettingsFor(settings, id);
		const patterns = helperModelPatterns(settings, id);
		const level = helperThinkingLevel(settings, id);
		this.clear();
		this.#escapeTo = undefined;

		const items: SelectItem[] = [
			{
				value: AGENT_ROW_MODEL,
				label: "Model",
				description:
					patterns[0] === undefined
						? theme.fg("dim", "inherit · the session's model")
						: formatModelSummaryWithFallbacks(patterns[0], patterns.length - 1),
			},
			{
				value: AGENT_ROW_EFFORT,
				label: "Effort",
				description: level === undefined ? theme.fg("dim", "inherit · the session's effort") : level,
			},
		];
		if (row.model !== undefined || row.thinkingLevel !== undefined) {
			items.push({
				value: AGENT_ROW_RESET,
				label: "Reset to defaults",
				description: theme.fg("dim", `clears ${HELPERS_PATH}.${id}`),
			});
		}

		const selectList = createFocusedSelectList(items, items.length, undefined, {
			onSelect: item => {
				switch (item.value) {
					case AGENT_ROW_MODEL:
						this.#showHelperModelPicker(id);
						break;
					case AGENT_ROW_EFFORT:
						this.#showHelperEffortPicker(id);
						break;
					case AGENT_ROW_RESET:
						this.#writeHelper(id, {});
						this.#showHelperEditor(id);
						break;
				}
				this.requestRender?.();
			},
			onCancel: () => {
				this.#showAgentList();
				this.requestRender?.();
			},
		});
		this.#selectList = selectList;

		this.renderSubmenuFrame({
			title: `Helper: ${info.label}`,
			description: info.description,
			headerExtra: new Text(`  ${theme.fg("muted", "Runs")} ${this.#helperSummary(id)}`, 0, 0),
			body: selectList,
			footerHint: "  Enter to change · Esc to go back",
		});
	}

	#showHelperModelPicker(id: HelperId): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showHelperEditor(id);
		this.#escapeTo = back;
		const title = `Model · ${HELPERS[id].label}`;
		if (!this.picker) {
			this.#renderCatalogUnavailable(title);
			return;
		}
		this.addChild(
			new ModelChainSubmenu(
				{ write: chain => this.#writeHelper(id, { ...helperSettingsFor(settings, id), model: chain }) },
				this.picker.registry,
				this.picker.models,
				title,
				helperSettingsFor(settings, id).model,
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => this.onChange(HELPERS_PATH),
				this.requestRender,
			),
		);
	}

	#showHelperEffortPicker(id: HelperId): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showHelperEditor(id);
		this.#escapeTo = back;
		const label = HELPERS[id].label;
		const scope = effortScopeForPattern(this.models, helperModelPatterns(settings, id)[0], this.sessionModel);
		const { options, notice } = agentEffortOptions(scope, this.models);
		const leave = () => {
			this.#escapeTo = undefined;
			back();
			this.requestRender?.();
		};
		this.addChild(
			new SelectSubmenu(
				`Effort · ${label}`,
				notice ??
					`Effort ${label} runs at. Inherit follows the session's effort; a \`:level\` on the model chain still wins.`,
				options,
				helperSettingsFor(settings, id).thinkingLevel?.trim() ?? "",
				value => {
					const next = { ...helperSettingsFor(settings, id) };
					if (value === INHERIT_EFFORT_OPTION_VALUE) delete next.thinkingLevel;
					else next.thinkingLevel = value;
					this.#writeHelper(id, next);
					leave();
				},
				leave,
			),
		);
	}

	mouseTarget(): SelectList | ModelChainSubmenu | SelectSubmenu | undefined {
		if (this.#selectList) return this.#selectList;
		return this.children.find(
			(child): child is ModelChainSubmenu | SelectSubmenu =>
				child instanceof ModelChainSubmenu || child instanceof SelectSubmenu,
		);
	}

	override handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		if (this.#escapeTo && (matchesKey(data, "escape") || data === "\x1b")) {
			const back = this.#escapeTo;
			this.#escapeTo = undefined;
			back();
			this.requestRender?.();
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/** The helper a roster row names, or undefined for an agent row. */
function helperFromRowValue(value: string): HelperId | undefined {
	if (!value.startsWith(HELPER_ROW_PREFIX)) return undefined;
	const id = value.slice(HELPER_ROW_PREFIX.length);
	return isHelperId(id) ? id : undefined;
}

function modelSummary(agent: AgentDefinition, depth = 0): string {
	// `taskDepth` is the depth a SPAWN runs at, and a lane page describes exactly
	// one: the agent's own page is a direct child (depth 1), each level down is
	// one deeper. Passing it is what makes the badge name the lane that decided
	// rather than the table.
	const resolved = resolveAgentModel({
		settings,
		agentName: agent.name,
		agentModel: agent.model,
		taskDepth: depth + 1,
	});
	if (resolved.unresolved) return theme.fg("error", `${resolved.unresolved.value} matches no model`);
	// Short, because a roster row also has to fit the agent's state and a read-only source marker.
	if (resolved.inherited) return theme.fg("dim", "session model");
	const pattern = resolved.patterns[0];
	if (!pattern) return theme.fg("dim", "no model resolved");
	const fallbacks = resolved.patterns.length - 1;
	const summary = formatModelSummaryWithFallbacks(pattern, fallbacks, true);
	return `${summary} ${theme.fg("dim", `· ${agentModelSourceLabel(resolved.source, agent.name, resolved.depth)}`)}`;
}

/**
 * One lane's Model row: what it stores, or the level it inherits from.
 *
 * The stored value rather than the resolved one, because this row EDITS the
 * stored value — a row showing a resolved answer it does not own is how a
 * screen comes to look configured when it has not been.
 */
function laneModelSummary(lane: AgentLaneSettings, depth: number, agent?: AgentDefinition): string {
	const chain = lane.model;
	if (chain === undefined || (Array.isArray(chain) ? chain.length === 0 : chain.trim().length === 0)) {
		if (depth > 0) return theme.fg("dim", "inherit · the level above");
		const own = agent?.model;
		const named = own !== undefined && own.length > 0 && !namesInheritedModel(own);
		return theme.fg(
			"dim",
			named ? `definition · ${Array.isArray(own) ? own.join(", ") : own}` : "inherit · the session's model",
		);
	}
	const entries = Array.isArray(chain) ? chain : [chain];
	const head = entries[0] ?? "";
	const fallbacks = entries.length - 1;
	return formatModelSummaryWithFallbacks(head, fallbacks, true);
}

/** One lane's Effort row, on the same stored-not-resolved rule as the model. */
function laneEffortSummary(lane: AgentLaneSettings, depth: number, agent: AgentDefinition): string {
	const level = lane.thinkingLevel?.trim() ?? "";
	if (level.length > 0) return level;
	if (depth > 0) return theme.fg("dim", "inherit · the level above");
	const own = agent.thinkingLevel;
	return theme.fg(
		"dim",
		own !== undefined && own !== ThinkingLevel.Inherit ? `definition · ${own}` : "inherit · the session's effort",
	);
}
