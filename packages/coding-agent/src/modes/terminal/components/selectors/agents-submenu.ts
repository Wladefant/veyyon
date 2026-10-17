/**
 * The settings card's agent roster: the helper and subagent rows, each agent's lanes by spawn depth,
 * and the model and effort pickers a lane opens.
 */
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { type Component, Container, type SelectItem, type SelectList, Text, TruncatedText } from "@veyyon/tui";
import { clamp, errorMessage, isRecord } from "@veyyon/utils";
import { matchesKey } from "@veyyon/utils/keys";
import { padding } from "@veyyon/utils/padding";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { namesInheritedModel, normalizeModelPatternList } from "../../../../config/model-pattern-list";
import type { ModelRegistry } from "../../../../config/model-registry";
import { extractExplicitThinkingSelector, parseModelString } from "../../../../config/model-resolver";
import { settings } from "../../../../config/settings";
import type { AgentLaneSettings, AgentSettings, HelperLaneSettings } from "../../../../config/settings-domains/agents";
import type { SettingPath } from "../../../../config/settings-schema";
import {
	AGENT_ENABLE_STATE_LABEL,
	type AgentModelSource,
	agentEnableState,
	agentScopeIsShared,
	agentSettingsFor,
	delegationBlockedNotice,
	isAgentEnableDefaulted,
	nextAgentEnableValue,
	type ResolvedAgentModel,
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

/** What the Roster page is, for the status frame drawn while agents are being read. */
const AGENT_LIST_DESCRIPTION = "The model and effort each subagent and each helper runs.";

const AGENTS_PATH = "agent.agents" satisfies SettingPath;

const HELPERS_PATH = "agent.helpers" satisfies SettingPath;

/**
 * Rows the roster shows at once before it scrolls, its two section headings included. Ten keeps
 * the bundled subagents and the first helpers on screen in a 36-row terminal beside the page's
 * description, the column heading, the focused row's one-line description and the authoring hint.
 */
const ROSTER_MAX_ROWS = 10;

/**
 * Width of the name column: the longest helper label and the two-cell gap after it. The column
 * heading is laid out from the same number.
 */
const ROSTER_NAME_COLUMN = 17;

/** Width of a subagent row's state cell. Helper rows leave it blank so their columns line up. */
const ROSTER_STATE_COLUMN = 10;

/**
 * Width of the effort cell: the longest level, `minimal`, or the `session` an unset cell reads,
 * and the two-cell gap after it. The model cell after it takes the rest of the row.
 */
const ROSTER_EFFORT_COLUMN = 9;

/** Columns the select list draws before a row's name: the cursor and the gap after it. */
const ROSTER_ROW_PREFIX = 2;

/** What a cell holding no value of its own reads: the row follows the session. */
const SESSION_CELL_TEXT = "session";

/** Width of the label column on an agent's or a helper's page: "Reset to defaults" and its gap. */
const PAGE_LABEL_COLUMN = 20;

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

	/**
	 * What one lane runs, for its page header: the model, the effort, and in words where a value
	 * came from when it was not chosen on this page.
	 */
	#runsSummary(agent: AgentDefinition, depth = 0): string {
		const resolved = resolveAgentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			taskDepth: depth + 1,
		});
		if (resolved.unresolved) return theme.fg("error", `${resolved.unresolved.value} matches no model`);
		const level = resolveAgentThinkingLevel({
			settings,
			agentName: agent.name,
			agentThinkingLevel: agent.thinkingLevel,
			taskDepth: depth + 1,
		});
		const head = resolved.inherited ? undefined : resolved.patterns[0];
		const model = head === undefined ? SESSION_CELL : modelCell(resolved.patterns);
		const origin = runsOrigin(resolved, depth);
		return `${runsText(model, this.#effortCell(head, level))}${origin ? theme.fg("dim", ` (${origin})`) : ""}`;
	}

	/**
	 * One subagent's row: whether it may be spawned, then the effort and model a spawn runs. A row
	 * an override layer supplies shows `overridden` across the Effort and Model columns instead,
	 * since this page cannot change it, and its detail line shows what it runs.
	 */
	#agentRow(agent: AgentDefinition, overridden?: string): string {
		const state = agentEnableState(agent, this.#row(agent.name).enabled);
		const stateText = theme.fg(state === "on" ? "success" : "dim", AGENT_ENABLE_STATE_LABEL[state]);
		if (overridden) return `${padEnd(stateText, ROSTER_STATE_COLUMN)}${theme.fg("dim", overridden)}`;
		const resolved = resolveAgentModel({ settings, agentName: agent.name, agentModel: agent.model, taskDepth: 1 });
		const level = resolveAgentThinkingLevel({
			settings,
			agentName: agent.name,
			agentThinkingLevel: agent.thinkingLevel,
			taskDepth: 1,
		});
		if (resolved.unresolved) {
			return rosterRow(
				stateText,
				{ text: `${resolved.unresolved.value} matches no model`, tone: "error" },
				this.#effortCell(undefined, level),
			);
		}
		if (resolved.inherited) return rosterRow(stateText, SESSION_CELL, this.#effortCell(undefined, level));
		return rosterRow(
			stateText,
			modelCell(resolved.patterns, ROSTER_SOURCE_NOTE[resolved.source]),
			this.#effortCell(resolved.patterns[0], level),
		);
	}

	/** One helper's row, on the subagent row's columns with the state cell left blank. */
	#helperRow(id: HelperId, overridden?: string): string {
		if (overridden) return `${padding(ROSTER_STATE_COLUMN)}${theme.fg("dim", overridden)}`;
		const patterns = helperModelPatterns(settings, id);
		return rosterRow("", modelCell(patterns), this.#effortCell(patterns[0], helperThinkingLevel(settings, id)));
	}

	/**
	 * The effort a row runs: a `:level` on its model head wins, as it does at dispatch, then the
	 * configured level. Inherit and nothing both follow the session. A head that is a catalog id
	 * ending in `:max` names that model, as the resolver reads it, and carries no effort.
	 */
	#effortCell(head: string | undefined, level: string | undefined): RosterCell {
		const models = this.models;
		const explicit = extractExplicitThinkingSelector(head, {
			isLiteralModelId: (provider, id) =>
				models?.some(model => model.provider === provider && model.id === id) === true,
		});
		const effective = explicit ?? level;
		if (effective === undefined || effective === ThinkingLevel.Inherit) return SESSION_CELL;
		return { text: effective, tone: "set" };
	}

	/**
	 * The roster: subagents, then helpers, one aligned row each.
	 *
	 * `focus` is the row to put the cursor on, so leaving an agent's or a helper's page lands on
	 * the row that opened it instead of the top of the list.
	 */
	#showAgentList(focus?: string): void {
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

		// Subagents first, since they are what this page is opened for, then helpers. There is
		// no row answering for the whole list: a control that reached every agent at once is
		// what made "I changed the model" and "my agents changed model" one event.
		const items: SelectItem[] = [];
		for (const agent of this.#agents) {
			const source = recordEntrySource(AGENTS_PATH, agent.name);
			if (isOverrideSource(source)) {
				items.push({
					value: agent.name,
					label: agent.name,
					description: this.#agentRow(agent, overriddenEntryLabel(source)),
					group: SUBAGENTS_GROUP,
					disabled: true,
				});
				continue;
			}
			items.push({
				value: agent.name,
				label: agent.name,
				description: this.#agentRow(agent),
				group: SUBAGENTS_GROUP,
			});
		}
		if (this.#agents.length === 0) {
			items.push({ value: AGENT_ROW_NONE, label: "No agent types found", group: SUBAGENTS_GROUP, disabled: true });
		}
		for (const id of HELPER_IDS) {
			const value = `${HELPER_ROW_PREFIX}${id}`;
			const source = recordEntrySource(HELPERS_PATH, id);
			if (isOverrideSource(source)) {
				items.push({
					value,
					label: HELPERS[id].label,
					description: this.#helperRow(id, overriddenEntryLabel(source)),
					group: HELPERS_GROUP,
					disabled: true,
				});
				continue;
			}
			items.push({ value, label: HELPERS[id].label, description: this.#helperRow(id), group: HELPERS_GROUP });
		}

		const selectList = createFocusedSelectList(items, clamp(items.length, 1, ROSTER_MAX_ROWS), focus, {
			onSelect: item => {
				const helper = helperFromRowValue(item.value);
				if (helper) this.#showHelperEditor(helper);
				else this.#showAgentEditor(item.value);
				this.requestRender?.();
			},
			onCancel: this.onCancel,
			minPrimaryColumnWidth: ROSTER_NAME_COLUMN,
			maxPrimaryColumnWidth: ROSTER_NAME_COLUMN,
			// The settings card's footer names Enter and Esc, and typing still filters: the status
			// row appears with the query as soon as there is one.
			statusLegend: false,
			searchPrompt: false,
			tabularDescription: true,
		});
		this.#selectList = selectList;

		const focused = items.find(item => item.value === focus) ?? items[0];
		const detail = new Container();
		this.#fillDetail(detail, focused?.value);
		selectList.onSelectionChange = item => {
			this.#fillDetail(detail, item.value);
			this.requestRender?.();
		};

		const session = this.sessionModel ? ` (${this.sessionModel.provider}/${this.sessionModel.id})` : "";
		this.renderSubmenuFrame({
			title: "Roster",
			description: `A cell that reads ${SESSION_CELL_TEXT} follows this session's model and effort${session}.`,
			headerExtra,
			bodyLead: new Text(theme.fg("dim", rosterHeading()), 0, 0),
			body: selectList,
			footerExtra: detail,
		});
	}

	#agent(name: string): AgentDefinition | undefined {
		return this.#agents.find(candidate => candidate.name === name);
	}

	/**
	 * The focused row's detail under the list: its description on one line, which the row's own
	 * page shows whole, so the list keeps its rows at any description length. A row an override
	 * layer supplies cannot be opened, so its detail adds what it runs. Any other subagent row adds
	 * where a new agent type is written, since the roster is where someone looking for an agent
	 * that does not exist yet arrives.
	 */
	#fillDetail(detail: Container, value: string | undefined): void {
		detail.clear();
		if (value === undefined) return;
		const helper = helperFromRowValue(value);
		const agent = helper ? undefined : this.#agent(value);
		const description = helper ? HELPERS[helper].description : agent?.description?.trim();
		if (description) detail.addChild(new TruncatedText(theme.fg("muted", `  ${description}`)));
		const overridden = helper
			? isOverrideSource(recordEntrySource(HELPERS_PATH, helper))
			: isOverrideSource(recordEntrySource(AGENTS_PATH, value));
		if (overridden) {
			const runs = helper ? this.#helperSummary(helper) : agent ? this.#runsSummary(agent) : undefined;
			if (runs) detail.addChild(new TruncatedText(pageHeaderRow("Runs", runs)));
			return;
		}
		if (!helper) detail.addChild(new Text(theme.fg("dim", `  ${CUSTOM_AGENT_HINT}`), 0, 0));
	}

	/**
	 * One lane's page. `depth` 0 is the agent itself; each step down is one
	 * `Can spawn` row followed, and the page shape never changes. `focus` is the
	 * row to put the cursor on when the page is drawn again after a change.
	 */
	#showAgentEditor(name: string, depth = 0, focus?: string): void {
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
		headerExtra.addChild(new Text(pageHeaderRow("Runs", this.#runsSummary(agent, depth)), 0, 0));
		if (shared) {
			headerExtra.addChild(
				new Text(theme.fg("dim", "  Same Model for All Agents is on: Agents → Shared Model sets it."), 0, 0),
			);
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
				label: "Can spawn",
				description: spawnAllowed
					? `on · ${laneModelSummary(child, depth + 1)}`
					: theme.fg("dim", "off · may not spawn agents"),
			},
		];
		if (Object.keys(lane).length > 0) {
			items.push({
				value: AGENT_ROW_RESET,
				label: "Reset to defaults",
				description: theme.fg("dim", "clears every value on this page"),
			});
		}

		const selectList = createFocusedSelectList(items, items.length, focus, {
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
						this.#showAgentEditor(name, depth, AGENT_ROW_OFFERED);
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
				if (depth === 0) this.#showAgentList(name);
				else this.#showAgentEditor(name, depth - 1, AGENT_ROW_NESTED);
				this.requestRender?.();
			},
			minPrimaryColumnWidth: PAGE_LABEL_COLUMN,
			maxPrimaryColumnWidth: PAGE_LABEL_COLUMN,
			statusLegend: false,
			searchPrompt: false,
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
		const back = () => this.#showAgentEditor(name, depth, AGENT_ROW_MODEL);
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
		const back = () => this.#showAgentEditor(name, depth, AGENT_ROW_EFFORT);
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

	/** What a helper runs, for its page header: the model, then the effort. */
	#helperSummary(id: HelperId): string {
		const patterns = helperModelPatterns(settings, id);
		return runsText(modelCell(patterns), this.#effortCell(patterns[0], helperThinkingLevel(settings, id)));
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

	/**
	 * One helper's page: its Model and its Effort, each unset to follow the session. `focus` is
	 * the row to put the cursor on when the page is drawn again after a change.
	 */
	#showHelperEditor(id: HelperId, focus?: string): void {
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
				description: theme.fg("dim", "clears this helper's model and effort"),
			});
		}

		const selectList = createFocusedSelectList(items, items.length, focus, {
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
				this.#showAgentList(`${HELPER_ROW_PREFIX}${id}`);
				this.requestRender?.();
			},
			minPrimaryColumnWidth: PAGE_LABEL_COLUMN,
			maxPrimaryColumnWidth: PAGE_LABEL_COLUMN,
			statusLegend: false,
			searchPrompt: false,
		});
		this.#selectList = selectList;

		this.renderSubmenuFrame({
			title: `Helper: ${info.label}`,
			description: info.description,
			headerExtra: new Text(pageHeaderRow("Runs", this.#helperSummary(id)), 0, 0),
			body: selectList,
		});
	}

	#showHelperModelPicker(id: HelperId): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showHelperEditor(id, AGENT_ROW_MODEL);
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
		const back = () => this.#showHelperEditor(id, AGENT_ROW_EFFORT);
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

/** One roster cell: its text and how it reads — a value of its own, a value it follows, or a fault. */
interface RosterCell {
	text: string;
	tone: "set" | "unset" | "error";
}

const SESSION_CELL: RosterCell = { text: SESSION_CELL_TEXT, tone: "unset" };

const ROSTER_CELL_COLOR = { set: "text", unset: "dim", error: "error" } as const;

/**
 * Where a roster model came from, when it is not the row's own value: a note on the cell, so a
 * model the row never set does not read as one it did. A lane is the row's own value, and the
 * default is the session, which the cell already reads as.
 */
const ROSTER_SOURCE_NOTE: Record<AgentModelSource, string | undefined> = {
	shared: "all agents",
	frontmatter: "definition",
	lane: undefined,
	default: undefined,
};

/** `text` padded with spaces to `width` visible columns. ANSI styling counts for nothing. */
function padEnd(text: string, width: number): string {
	return text + padding(Math.max(0, width - visibleWidth(text)));
}

/** A cell painted for its tone; with a `width`, cut with an ellipsis or padded to fill it. */
function paintCell(cell: RosterCell, width?: number): string {
	const text = width === undefined ? cell.text : padEnd(truncateToWidth(cell.text, width - 1), width);
	return theme.fg(ROSTER_CELL_COLOR[cell.tone], text);
}

/**
 * One roster row's description: state, effort and model, each in its column. The model is last
 * so it takes whatever width the card has left, and the list cuts it with an ellipsis where the
 * card is narrow; the fixed columns before it stay whole.
 */
function rosterRow(state: string, model: RosterCell, effort: RosterCell): string {
	return `${padEnd(state, ROSTER_STATE_COLUMN)}${paintCell(effort, ROSTER_EFFORT_COLUMN)}${paintCell(model)}`;
}

/** The column heading over the roster, laid out from the widths the rows are drawn with. */
function rosterHeading(): string {
	return `${padding(ROSTER_ROW_PREFIX + ROSTER_NAME_COLUMN)}${padEnd("State", ROSTER_STATE_COLUMN)}${padEnd("Effort", ROSTER_EFFORT_COLUMN)}Model`;
}

/** A line above an agent's or a helper's rows, its value in the rows' value column. */
function pageHeaderRow(label: string, value: string): string {
	return `${padding(ROSTER_ROW_PREFIX)}${theme.fg("muted", padEnd(label, PAGE_LABEL_COLUMN))}${value}`;
}

/**
 * What a page's "Runs" line reads: the model, then the effort, each in words when it follows the
 * session, and one phrase when both do.
 */
function runsText(model: RosterCell, effort: RosterCell): string {
	if (model.tone === "unset" && effort.tone === "unset") return theme.fg("dim", "the session's model and effort");
	const modelText = model.tone === "unset" ? theme.fg("dim", "the session's model") : paintCell(model);
	const effortText = effort.tone === "unset" ? theme.fg("dim", "the session's effort") : `${effort.text} effort`;
	return `${modelText} · ${effortText}`;
}

/** A model selector without its `:level`, which the effort cell shows instead. */
function bareModel(raw: string): string {
	const trimmed = raw.trim();
	const parsed = parseModelString(trimmed);
	return parsed ? `${parsed.provider}/${parsed.id}` : trimmed;
}

/** A model chain's cell: its head, how many fallbacks follow, and an optional source note. */
function modelCell(patterns: ReadonlyArray<string>, note?: string): RosterCell {
	const head = patterns[0];
	if (head === undefined) return SESSION_CELL;
	const fallbacks = patterns.length > 1 ? ` +${patterns.length - 1}` : "";
	return { text: `${bareModel(head)}${fallbacks}${note ? ` · ${note}` : ""}`, tone: "set" };
}

/**
 * Where a lane page's model came from, in words, when it was not chosen on that page. `depth`
 * is the page's lane level; a lane that decided at another level is the level above.
 */
function runsOrigin(resolved: ResolvedAgentModel, depth: number): string | undefined {
	switch (resolved.source) {
		case "shared":
			return "Same Model for All Agents";
		case "frontmatter":
			return "from the agent definition";
		case "lane":
			return (resolved.depth ?? 0) === depth ? undefined : "from the level above";
		case "default":
			return undefined;
	}
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
