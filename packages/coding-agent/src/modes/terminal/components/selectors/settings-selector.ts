import { AUTO_COMPACTION_THRESHOLD, parseCompactionThreshold, type ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Effort, Model } from "@veyyon/ai";
import { UNSET_NUMBER, UNSET_NUMBER_OPTION_VALUE } from "@veyyon/kernel/settings/optional-number";
import { Ellipsis } from "@veyyon/natives";
import type { SettingTab, SubmenuOption } from "@veyyon/settings";
import {
	type Component,
	Container,
	type ImageBudget,
	Input,
	rankSettingItems,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	type Tab,
	TabBar,
	Text,
} from "@veyyon/tui";
import { clamp, collapseWhitespace, errorMessage, isRecord, VERSION } from "@veyyon/utils";
import { getKeybindings } from "@veyyon/utils/keybindings";
import { extractPrintableText, matchesKey } from "@veyyon/utils/keys";
import { routeSgrMouseInput, type SgrMouseEvent } from "@veyyon/utils/mouse";
import { padding } from "@veyyon/utils/padding";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { ANY_MODEL_EFFORT_KEY, withLegacyDefaultEffort } from "../../../../config/effort-resolver";
import type { ModelRegistry } from "../../../../config/model-registry";
import {
	extractExplicitThinkingSelector,
	normalizeModelPatternList,
	resolveModelRoleValue,
} from "../../../../config/model-resolver";
import {
	DEFAULT_MODEL_SLOT,
	getRoleInfo,
	isDefaultModelSlot,
	ROLE_INHERIT_LABEL,
	SELECTABLE_MODEL_ROLE_IDS,
} from "../../../../config/model-roles";
import { BUILTIN_PERSONALITY_DESCRIPTIONS, NONE_PERSONALITY } from "../../../../config/personality-resolver";
import {
	normalizeProviderMaxInFlightRequests,
	type SettingSource,
	settings,
	validateProviderMaxInFlightRequests,
} from "../../../../config/settings";
import type { SubagentAgentSettings, SubagentLaneSettings } from "../../../../config/settings-domains/subagents";
import {
	getDefault,
	getType,
	getUi,
	isUnsetNumberPath,
	SETTING_TABS,
	type SettingPath,
	type StatusLinePreset,
	type StatusLineSegmentId,
	TAB_METADATA,
} from "../../../../config/settings-schema";
import { loadCapability } from "../../../../discovery";
import { PROVIDER_ID as NATIVE_RULES_PROVIDER_ID } from "../../../../discovery/builtin";
import { BUILTIN_RULE_SECTIONS, type BuiltinRuleSection } from "../../../../discovery/builtin-rules";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../../../../discovery/capability/rule";
import { discoverAgents } from "../../../../task/discovery";
import {
	delegationBlockedNotice,
	isSubagentEnableDefaulted,
	nextSubagentEnableValue,
	resolveDelegation,
	resolveSubagentMaxNestedSpawnDepth,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	SUBAGENT_ENABLE_STATE_LABEL,
	subagentEnableState,
	subagentModelSourceLabel,
	subagentScopeIsShared,
	subagentSettingsFor,
} from "../../../../task/subagent-settings";
import { type AgentDefinition, canSpawnAtDepth } from "../../../../task/types";
import { withIcon } from "../../../../theme/icon-label";
import { getCurrentThemeName, getSelectListTheme, getSettingsListTheme, theme } from "../../../../theme/theme";
import {
	configuredThinkingLevelOptions,
	hasConfigurableThinkingEffort,
	INHERIT_EFFORT_OPTION_VALUE,
	noSelectableEffortNotice,
} from "../../../../thinking";
import { getTabBarTheme } from "../../shared";
import {
	BREADCRUMB_HOVER_ID,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_SETTINGS,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	pointerMotionEnabled,
	renderModalShell,
	SETTINGS_BROWSE_SHORTCUTS,
	SETTINGS_FILTER_SHORTCUTS,
	SETTINGS_SUBPANE_SHORTCUTS,
	sizingForArea,
} from "../chrome/modal-shell";
import { handleInputOrEscape, PluginSettingsComponent } from "../dialogs/plugin-settings";
import { RollbackPanelComponent } from "../dialogs/rollback-panel";
import { getPreset } from "../status-line/presets";
import { formatSelectorSummary, renderEffortStep } from "./effort-picker";
import { ModelSelectorPanel } from "./model-selector";
import { MouseRoutedSubmenu, routeSettingsListPointer } from "./select-list-mouse-routing";
import {
	ADVISOR_MODEL_SETTING_ID,
	ADVISOR_MODEL_SLOT,
	DEFAULT_MODEL_SETTING_ID,
	formatLspSummary,
	getSettingDef,
	getSettingsForTab,
	isNestedLspKnob,
	LSP_SETTING_PATHS,
	lspPanelPaths,
	type OptionList,
	type SettingDef,
	settingsSearchLandingPath,
} from "./settings-defs";

const DECIMAL_NUMBER = /^-?\d+(?:\.\d+)?$/;

export const UNSET_NUMBER_INPUT = "unset";

export function parseNumberSetting(path: SettingPath, text: string): number | typeof UNSET_NUMBER_INPUT {
	if (text.trim() === "") return UNSET_NUMBER_INPUT;
	if (!DECIMAL_NUMBER.test(text)) throw new Error(`"${text}" is not a number. Type digits only, for example 250.`);
	const parsed = Number(text);
	if (!Number.isFinite(parsed)) throw new Error(`"${text}" is too large to store.`);
	const ui = getUi(path);
	if (ui?.min !== undefined && parsed < ui.min) throw new Error(`Must be at least ${ui.min}.`);
	if (ui?.max !== undefined && parsed > ui.max) throw new Error(`Must be at most ${ui.max}.`);
	return parsed;
}

class TextInputSubmenu extends MouseRoutedSubmenu {
	#input: Input;
	#error: Text | undefined;

	constructor(
		label: string,
		description: string,
		currentValue: string,
		onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super();
		const input = new Input();
		if (currentValue) input.setValue(currentValue);

		this.renderSubmenuFrame({
			title: label,
			description,
			body: input,
			footerHint: "  Enter to save · Esc to cancel · Clear field to unset",
		});

		this.#input = input;
		input.onSubmit = value => {
			try {
				onSubmit(value);
			} catch (error) {
				this.setError(errorMessage(error));
			}
		};
	}

	setError(message: string): void {
		if (this.#error) {
			this.#error.setText(theme.fg("error", truncateToWidth(`  ${message}`, 100)));
			return;
		}
		this.#error = new Text(theme.fg("error", truncateToWidth(`  ${message}`, 100)), 0, 0);
		this.addChild(new Spacer(1));
		this.addChild(this.#error);
	}

	mouseTarget(): Input {
		return this.#input;
	}

	override handleInput(data: string): void {
		handleInputOrEscape(data, this.#input, this.onCancel);
	}
}

class SelectSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList;
	#previewText: Text | null = null;
	#previewUpdateRequestId = 0;

	constructor(
		title: string,
		description: string,
		options: ReadonlyArray<SelectItem>,
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void | Promise<void>,
		private readonly getPreview?: () => string,
		footer?: Component,
	) {
		super();
		const selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme());
		const currentIndex = options.findIndex(o => o.value === currentValue);
		if (currentIndex !== -1) selectList.setSelectedIndex(currentIndex);
		selectList.onSelect = item => onSelect(item.value);
		selectList.onCancel = onCancel;

		let headerExtra: Component | undefined;
		let previewText: Text | null = null;
		if (getPreview) {
			const container = new Container();
			container.addChild(new Text(theme.fg("muted", "Preview:"), 0, 0));
			previewText = new Text(getPreview(), 0, 0);
			container.addChild(previewText);
			headerExtra = container;
		}

		this.renderSubmenuFrame({
			title,
			description,
			headerExtra,
			body: selectList,
			footerHint: "  Enter to select · Esc to go back",
			footerExtra: footer,
		});

		this.#selectList = selectList;
		this.#previewText = previewText;

		if (onSelectionChange) {
			selectList.onSelectionChange = item => {
				const requestId = ++this.#previewUpdateRequestId;
				const result = onSelectionChange(item.value);
				if (result && typeof (result as Promise<void>).then === "function") {
					void (result as Promise<void>).finally(() => {
						if (requestId === this.#previewUpdateRequestId) this.#updatePreview();
					});
					return;
				}
				if (requestId === this.#previewUpdateRequestId) this.#updatePreview();
			};
		}
	}

	#updatePreview(): void {
		if (this.#previewText && this.getPreview) {
			this.#previewText.setText(this.getPreview());
		}
	}

	mouseTarget(): SelectList {
		return this.#selectList;
	}
}

const LSP_PANEL_MAX_ROWS = 8;

class LspSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#focused: string | undefined;

	constructor(
		private readonly onChange: (path: SettingPath, value: boolean) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
		initialFocus?: SettingPath,
	) {
		super();
		this.#focused = initialFocus;
		this.#show();
	}

	#show(): void {
		this.clear();
		const items: SelectItem[] = [];
		for (const path of lspPanelPaths()) {
			const ui = getUi(path);
			if (!ui) continue;
			const on = settings.get(path) === true;
			const state = on ? theme.fg("success", "on") : theme.fg("dim", "off");
			const label = path === "lsp.enabled" ? "Language Servers" : ui.label;
			items.push({ value: path, label, description: `${state} · ${ui.description}` });
		}

		const visible = Math.min(items.length, LSP_PANEL_MAX_ROWS);
		this.#selectList = new SelectList(items, visible, getSelectListTheme(), {
			minPrimaryColumnWidth: 1,
			maxPrimaryColumnWidth: 28,
		});
		const focusedIndex = this.#focused ? items.findIndex(item => item.value === this.#focused) : -1;
		if (focusedIndex >= 0) this.#selectList.setSelectedIndex(focusedIndex);
		this.#selectList.onSelect = item => {
			const path = item.value as SettingPath;
			const next = settings.get(path) !== true;
			settings.set(path, next as never);
			this.onChange(path, next);
			this.#focused = path;
			this.#show();
			this.requestRender?.();
		};
		this.#selectList.onCancel = this.onCancel;
		this.renderSubmenuFrame({
			title: "LSP",
			description: "Each row is its own switch. Enter toggles. Esc returns to Files.",
			body: this.#selectList,
			footerHint: "  Enter to toggle · Esc to go back",
		});
	}

	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}
}

const THRESHOLD_CUSTOM_VALUE = "__custom__";

type ThresholdMode = "auto" | "percent" | "tokens";

function thresholdModeOf(raw: string): { mode: ThresholdMode; invalidRaw?: string } {
	const spec = parseCompactionThreshold(raw);
	if (spec.kind === "percent") return { mode: "percent" };
	if (spec.kind === "tokens") return { mode: "tokens" };
	return { mode: "auto", ...(spec.invalidRaw !== undefined ? { invalidRaw: spec.invalidRaw } : {}) };
}

function formatThresholdShort(raw: string): string {
	const spec = parseCompactionThreshold(raw);
	if (spec.kind === "tokens") {
		if (spec.tokens % 1_000_000 === 0) return `${spec.tokens / 1_000_000}M`;
		if (spec.tokens % 1_000 === 0) return `${spec.tokens / 1_000}k`;
		return String(spec.tokens);
	}
	if (spec.kind === "percent") return `${spec.percent}%`;
	return raw;
}

class CompactionThresholdSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly options: ReadonlyArray<SubmenuOption>,
		private readonly onPersist: () => void,
		private readonly onClose: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showModes();
	}

	#currentRaw(): string {
		return String(settings.get("compaction.threshold") ?? AUTO_COMPACTION_THRESHOLD);
	}

	#marker(active: boolean): string {
		return active ? `${theme.fg("success", theme.status.enabled)} ` : "  ";
	}

	#showModes(): void {
		this.clear();
		this.#selectList = undefined;

		const raw = this.#currentRaw();
		const { mode, invalidRaw } = thresholdModeOf(raw);
		const current = theme.fg("dim", `(current: ${formatThresholdShort(raw)})`);
		const items: SelectItem[] = [
			{
				value: "auto",
				label: `${this.#marker(mode === "auto")}Auto`,
				description: "The model's context window minus the reserve",
			},
			{
				value: "percent",
				label: `${this.#marker(mode === "percent")}Percent${mode === "percent" ? ` ${current}` : ""}`,
				description: "Scales with each model's window",
			},
			{
				value: "tokens",
				label: `${this.#marker(mode === "tokens")}Tokens${mode === "tokens" ? ` ${current}` : ""}`,
				description: "The same trigger on every model",
			},
		];

		const selectList = new SelectList(items, items.length, getSelectListTheme());
		selectList.setSelectedIndex(items.findIndex(item => item.value === mode));
		selectList.onSelect = item => {
			if (item.value === "auto") {
				this.#persist(AUTO_COMPACTION_THRESHOLD);
				return;
			}
			if (item.value === "percent" || item.value === "tokens") {
				this.#showValuePicker(item.value);
				this.requestRender?.();
			}
		};
		selectList.onCancel = this.onClose;
		this.#selectList = selectList;

		let headerExtra: Component | undefined;
		if (invalidRaw !== undefined) {
			headerExtra = new Text(
				theme.fg(
					"warning",
					`Stored value "${invalidRaw}" is not auto, a percent, or a token amount; Auto is in effect.`,
				),
				0,
				0,
			);
		}

		this.renderSubmenuFrame({
			title: "Auto-Compaction Threshold",
			description:
				"When auto-compaction triggers. Auto uses the model's window minus the reserve; a percent scales with each model's window; a token amount is the same trigger on every model.",
			headerExtra,
			body: selectList,
			footerHint: "  Enter to choose · Esc to go back",
		});
	}

	#showValuePicker(mode: "percent" | "tokens"): void {
		this.clear();
		this.#selectList = undefined;
		const title = mode === "percent" ? "Auto-Compaction Threshold — Percent" : "Auto-Compaction Threshold — Tokens";
		const description =
			mode === "percent"
				? "Compact once the context passes this share of the model's window. Follows the window when you switch models."
				: "Compact once the context passes this many tokens, on every model. Larger than the window compacts at the window's edge instead.";

		const raw = this.#currentRaw();
		const presets = this.options.filter(option =>
			mode === "percent" ? option.value.endsWith("%") : /^[0-9_]+$/.test(option.value),
		);
		const items: SelectItem[] = presets.map(option => ({
			value: option.value,
			label: `${this.#marker(option.value === raw)}${option.label}`,
			...(option.description !== undefined ? { description: option.description } : {}),
		}));
		if (thresholdModeOf(raw).mode === mode && !presets.some(option => option.value === raw)) {
			items.unshift({
				value: raw,
				label: `${this.#marker(true)}${formatThresholdShort(raw)} ${theme.fg("dim", "(custom)")}`,
				description: "Set by hand; not one of the presets",
			});
		}
		items.push({
			value: THRESHOLD_CUSTOM_VALUE,
			label: `  Custom…`,
			description: mode === "percent" ? "Type any whole percent from 1 to 99" : "Type any token amount",
		});

		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
		const currentIndex = items.findIndex(item => item.value === raw);
		if (currentIndex !== -1) selectList.setSelectedIndex(currentIndex);
		selectList.onSelect = item => {
			if (item.value === THRESHOLD_CUSTOM_VALUE) {
				this.#showCustomInput(mode);
			} else {
				this.#persist(item.value);
			}
			this.requestRender?.();
		};
		selectList.onCancel = () => {
			this.#showModes();
			this.requestRender?.();
		};
		this.#selectList = selectList;

		this.renderSubmenuFrame({
			title,
			description,
			body: selectList,
			footerHint: "  Enter to select · Esc to go back",
		});
	}

	#showCustomInput(mode: "percent" | "tokens"): void {
		this.clear();
		this.#selectList = undefined;
		const raw = this.#currentRaw();
		const input = new TextInputSubmenu(
			mode === "percent" ? "Custom Percent" : "Custom Token Amount",
			mode === "percent"
				? "A whole percent from 1 to 99 (the parser's clamp range); the % sign is optional."
				: "A positive token amount, e.g. 170000. Underscores are fine (170_000).",
			thresholdModeOf(raw).mode === mode ? raw : "",
			value => {
				this.#persist(this.#validateCustom(mode, value));
				this.requestRender?.();
			},
			() => {
				this.#showValuePicker(mode);
				this.requestRender?.();
			},
		);
		this.addChild(input);
	}

	#validateCustom(mode: "percent" | "tokens", value: string): string {
		const text = value.trim();
		if (mode === "percent") {
			const percent = Number(text.replace(/%$/, "").trim());
			if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
				throw new Error(`"${value}" is not a whole percent from 1 to 99.`);
			}
			return `${percent}%`;
		}
		const tokens = Number(text.replace(/_/g, ""));
		if (!Number.isInteger(tokens) || tokens <= 0) {
			throw new Error(`"${value}" is not a positive token amount (e.g. 170000).`);
		}
		return String(tokens);
	}

	#persist(value: string): void {
		settings.set("compaction.threshold", value);
		this.onPersist();
		this.#showModes();
		this.requestRender?.();
	}

	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}
}

class ProviderLimitsSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly providers: readonly string[],
		private readonly onChange: (value: Record<string, number>) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showProviderList();
	}

	#providerIds(): string[] {
		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		return Array.from(new Set(this.providers.concat(Object.keys(limits)))).sort((a, b) => a.localeCompare(b));
	}

	#showProviderList(): void {
		this.clear();
		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		const providerItems = this.#providerIds().map((provider): SelectItem => {
			const limit = limits[provider];
			return {
				value: provider,
				label: provider,
				description: limit === undefined ? "Unlimited" : `Limit: ${limit}`,
			};
		});
		const clearItem: SelectItem[] =
			Object.keys(limits).length === 0
				? []
				: [{ value: "__clear_all", label: "Clear all limits", description: "Make every provider unlimited" }];
		const items = providerItems.concat(clearItem);
		const selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		selectList.onSelect = item => {
			if (item.value === "__clear_all") {
				settings.set("providers.maxInFlightRequests", {});
				this.onChange({});
				this.#showProviderList();
				this.requestRender?.();
				return;
			}
			this.#showProviderEditor(item.value);
		};
		selectList.onCancel = this.onCancel;
		this.#selectList = selectList;

		this.renderSubmenuFrame({
			title: "Max In-Flight Requests",
			description:
				"Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited.",
			body: selectList,
			footerHint: "  Enter to edit provider · Esc to go back",
		});
	}

	#showProviderEditor(provider: string): void {
		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		this.clear();
		this.#selectList = undefined;
		this.addChild(
			new TextInputSubmenu(
				`Max In-Flight Requests: ${provider}`,
				"Enter a positive number. Decimals round down. Clear the field to make this provider unlimited.",
				limits[provider]?.toString() ?? "",
				value => {
					const next = { ...limits };
					const trimmed = value.trim();
					if (trimmed === "") {
						delete next[provider];
					} else {
						const limit = Number(trimmed);
						if (!Number.isFinite(limit) || limit <= 0) throw new Error("Limit must be a positive number.");
						next[provider] = Math.max(1, Math.floor(limit));
					}
					const normalized = validateProviderMaxInFlightRequests(next);
					settings.set("providers.maxInFlightRequests", normalized);
					this.onChange(normalized);
					this.#showProviderList();
					this.requestRender?.();
				},
				() => {
					this.#showProviderList();
					this.requestRender?.();
				},
			),
		);
	}

	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}
}

export function barePickerSelector(raw: string | undefined, models: ReadonlyArray<Model<Api>>): string | undefined {
	if (!raw) return undefined;
	const resolved = resolveModelRoleValue(raw, models).model;
	return resolved ? `${resolved.provider}/${resolved.id}` : raw;
}

export function replaceModelChainEntry(
	chain: readonly string[],
	index: number | null,
	value: string,
	models: ReadonlyArray<Model<Api>>,
): string[] | undefined {
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	const bare = barePickerSelector(trimmed, models);
	const duplicate = chain.some(
		(candidate, candidateIndex) => candidateIndex !== index && barePickerSelector(candidate, models) === bare,
	);
	if (duplicate) return undefined;
	const next = chain.slice();
	if (index === null) {
		next.push(trimmed);
		return next;
	}
	if (!Number.isInteger(index) || index < 0 || index >= next.length) return undefined;
	next[index] = trimmed;
	return next;
}

class ModelRolesSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#models: ReadonlyArray<Model>;
	#registry: ModelRegistry;
	#soleRole: string | undefined;

	constructor(
		models: ReadonlyArray<Model>,
		registry: ModelRegistry,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
		soleRole?: string,
	) {
		super();
		this.#models = models;
		this.#registry = registry;
		this.#soleRole = soleRole;
		if (soleRole) this.#showModelPicker(soleRole);
		else this.#showRoleList();
	}

	#goBack(): void {
		if (this.#soleRole) {
			this.onCancel();
			return;
		}
		this.#showRoleList();
	}

	#showRoleList(): void {
		this.clear();
		const items: SelectItem[] = SELECTABLE_MODEL_ROLE_IDS.map(role => {
			const info = getRoleInfo(role, settings);
			const assigned = settings.getModelRole(role)?.trim();
			return {
				value: role,
				label: info.name,
				description:
					assigned && assigned.length > 0
						? formatSelectorSummary(assigned)
						: (info.unsetLabel ?? ROLE_INHERIT_LABEL),
			};
		});
		const selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		selectList.onSelect = item => this.#showModelPicker(item.value);
		selectList.onCancel = this.onCancel;
		this.#selectList = selectList;

		this.renderSubmenuFrame({
			title: "Role Models",
			description: "Assign a model per role. Searchable picker · auth status on each row. Per active profile.",
			body: selectList,
			footerHint: "  Enter to pick model · Esc to go back",
		});
	}

	#showModelPicker(role: string): void {
		this.clear();
		this.#selectList = undefined;
		const isDefault = isDefaultModelSlot(role);
		const info = getRoleInfo(role, settings);
		const current = (
			isDefault ? settings.getPersistedModelRole(DEFAULT_MODEL_SLOT) : settings.getModelRole(role)
		)?.trim();
		const panel = new ModelSelectorPanel(
			settings,
			this.#registry,
			this.#models,
			{
				title: isDefault ? info.name : `${info.name} model`,
				description: isDefault
					? `The model each new session starts on, restored on launch. Del or the clear row restores auto-select on launch.`
					: `Role \`${role}\` — used when that work type runs. Del or the (inherit) row clears (${info.unsetLabel ?? "inherit main model"}).`,
				currentSelector: barePickerSelector(current, this.#models as Model<Api>[]),
				allowClear: true,
				clearLabel: isDefault ? `(${info.unsetLabel ?? "auto-select on launch"})` : undefined,
			},
			{
				onPick: (model, selector) => {
					if (isDefault || !hasConfigurableThinkingEffort(model)) {
						this.#persistRole(role, selector);
						return;
					}
					this.#showEffortPicker(role, selector, model);
					this.requestRender?.();
				},
				onClear: () => {
					if (isDefault) {
						settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, undefined);
					} else {
						settings.setModelRole(role, undefined);
					}
					this.onChange();
					this.#goBack();
					this.requestRender?.();
				},
				onCancel: () => {
					this.#goBack();
					this.requestRender?.();
				},
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: pointerMotionEnabled() });
		this.addChild(panel);
	}

	#showEffortPicker(role: string, selector: string, model: Model): void {
		this.#selectList = renderEffortStep(
			this,
			selector,
			model,
			value => this.#persistRole(role, value),
			() => {
				this.#showModelPicker(role);
				this.requestRender?.();
			},
		);
	}

	#persistRole(role: string, value: string): void {
		if (isDefaultModelSlot(role)) {
			settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, value);
		} else {
			settings.setModelRole(role, value);
		}
		this.onChange();
		this.#goBack();
		this.requestRender?.();
	}

	mouseTarget(): SelectList | ModelSelectorPanel | undefined {
		return this.#selectList ?? this.#pickerPanel();
	}

	#pickerPanel(): ModelSelectorPanel | undefined {
		return this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel);
	}
}

const RULE_LIST_MAX_ROWS = 12;

const BUNDLED_SECTION_ORDER: readonly BuiltinRuleSection[] = Object.keys(BUILTIN_RULE_SECTIONS) as BuiltinRuleSection[];

function ruleSectionRank(rule: Rule): number {
	if (rule._source?.provider === NATIVE_RULES_PROVIDER_ID) return -2;
	if (rule._source?.provider !== BUILTIN_DEFAULTS_PROVIDER_ID) return -1;
	const index = BUNDLED_SECTION_ORDER.indexOf(rule.section as BuiltinRuleSection);
	return index < 0 ? BUNDLED_SECTION_ORDER.length : index;
}

function ruleSectionLabel(rule: Rule): string {
	if (rule._source?.provider === NATIVE_RULES_PROVIDER_ID) {
		return "User created";
	}
	if (rule._source?.provider !== BUILTIN_DEFAULTS_PROVIDER_ID) {
		return rule._source?.provider ? `From ${rule._source.provider}` : "From this project";
	}
	const meta = BUILTIN_RULE_SECTIONS[rule.section as BuiltinRuleSection];
	return meta ? `Built-in · ${meta.label}` : "Built-in";
}

class RulesSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#rules: Rule[] = [];
	#loadError: string | undefined;
	#loaded = false;
	#focused: string | undefined;
	#openSection: string | undefined;
	#focusedSection: string | undefined;

	constructor(
		private readonly cwd: string,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#show();
		void this.#load();
	}

	async #load(): Promise<void> {
		try {
			const result = await loadCapability<Rule>(ruleCapability.id, { cwd: this.cwd });
			const byName = new Map<string, Rule>();
			for (const rule of result.items) if (!byName.has(rule.name)) byName.set(rule.name, rule);
			this.#rules = Array.from(byName.values()).sort(
				(a, b) => ruleSectionRank(a) - ruleSectionRank(b) || a.name.localeCompare(b.name),
			);
		} catch (error) {
			this.#loadError = errorMessage(error);
		}
		this.#loaded = true;
		this.#show();
		this.requestRender?.();
	}

	#disabled(): Set<string> {
		return this.#nameSet("ttsr.disabledRules");
	}

	#enabledExperiments(): Set<string> {
		return this.#nameSet("ttsr.experimentalRules");
	}

	#nameSet(path: "ttsr.disabledRules" | "ttsr.experimentalRules"): Set<string> {
		const stored = settings.get(path);
		const names = Array.isArray(stored) ? stored : [];
		return new Set(names.map(name => String(name).trim()).filter(name => name.length > 0));
	}

	#toggle(name: string): void {
		const rule = this.#rules.find(candidate => candidate.name === name);
		if (rule?.experimental === true) {
			const enabled = this.#enabledExperiments();
			if (enabled.has(name)) enabled.delete(name);
			else enabled.add(name);
			settings.set("ttsr.experimentalRules", Array.from(enabled).sort());
		} else {
			const disabled = this.#disabled();
			if (disabled.has(name)) disabled.delete(name);
			else disabled.add(name);
			settings.set("ttsr.disabledRules", Array.from(disabled).sort());
		}
		this.onChange();
		this.#focused = name;
		this.#show();
		this.requestRender?.();
	}

	#kind(rule: Rule): string {
		if ((rule.condition?.length ?? 0) > 0 || (rule.astCondition?.length ?? 0) > 0) return "on match";
		if (rule.alwaysApply === true) return "always";
		if (rule.description) return "on request";
		return "inert";
	}

	#isOff(rule: Rule, disabled: ReadonlySet<string>, experiments: ReadonlySet<string>, builtinOff: boolean): boolean {
		if (disabled.has(rule.name)) return true;
		if (builtinOff && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return true;
		return rule.experimental === true && !experiments.has(rule.name);
	}

	#sections(): { label: string; rules: Rule[] }[] {
		const sections: { label: string; rules: Rule[] }[] = [];
		for (const rule of this.#rules) {
			const label = ruleSectionLabel(rule);
			const existing = sections.find(section => section.label === label);
			if (existing) existing.rules.push(rule);
			else sections.push({ label, rules: [rule] });
		}
		return sections;
	}

	#sectionSummary(rules: readonly Rule[], off: number): string {
		const total = `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
		if (off === 0) return `${total} · ${theme.fg("success", "all on")}`;
		if (off === rules.length) return `${total} · ${theme.fg("dim", "all off")}`;
		return `${total} · ${theme.fg("dim", `${off} off`)}`;
	}

	#warningComponent(builtinOff: boolean): Component | undefined {
		const warnings: Component[] = [];
		if (settings.get("ttsr.enabled") !== true) {
			warnings.push(new Text(theme.fg("warning", "  Rule matching is off (Stream Interrupts → TTSR)."), 0, 0));
		}
		if (builtinOff) {
			warnings.push(new Text(theme.fg("warning", "  Built-in rules are off, so every bundled rule is."), 0, 0));
		}
		if (warnings.length === 0) return undefined;
		const container = new Container();
		for (let i = 0; i < warnings.length; i++) {
			if (i > 0) container.addChild(new Spacer(1));
			container.addChild(warnings[i]!);
		}
		return container;
	}

	#show(): void {
		this.clear();
		this.#selectList = undefined;
		if (this.#loadError) {
			const container = new Container();
			container.addChild(new Text(theme.fg("error", `  Could not read the rule sources: ${this.#loadError}`), 0, 0));
			this.renderSubmenuFrame({
				title: "Rules",
				description: "Every rule this project loads.",
				body: container,
				footerHint: "  Esc to go back",
			});
			return;
		}
		if (!this.#loaded) {
			const container = new Container();
			container.addChild(new Text(theme.fg("dim", "  Reading rules…"), 0, 0));
			this.renderSubmenuFrame({
				title: "Rules",
				description: "Every rule this project loads.",
				body: container,
			});
			return;
		}
		if (this.#openSection === undefined) this.#showSections();
		else this.#showSection(this.#openSection);
	}

	#showSections(): void {
		const builtinOff = settings.get("ttsr.builtinRules") !== true;
		const disabled = this.#disabled();
		const experiments = this.#enabledExperiments();
		const sections = this.#sections();

		if (sections.length === 0) {
			const container = new Container();
			container.addChild(new Text(theme.fg("dim", "  No rules found."), 0, 0));
			this.renderSubmenuFrame({
				title: "Rules",
				description: "Rules by section. Enter opens one.",
				headerExtra: this.#warningComponent(builtinOff),
				body: container,
				footerHint: "  Esc to go back",
			});
			return;
		}

		const items: SelectItem[] = sections.map(section => {
			const off = section.rules.filter(rule => this.#isOff(rule, disabled, experiments, builtinOff)).length;
			return {
				value: section.label,
				label: section.label,
				description: this.#sectionSummary(section.rules, off),
			};
		});

		const visible = clamp(items.length, 1, RULE_LIST_MAX_ROWS);
		const selectList = new SelectList(items, visible, getSelectListTheme(), {
			minPrimaryColumnWidth: 1,
			maxPrimaryColumnWidth: 32,
		});
		const focusedIndex = this.#focusedSection ? items.findIndex(item => item.value === this.#focusedSection) : -1;
		if (focusedIndex >= 0) selectList.setSelectedIndex(focusedIndex);
		selectList.onSelect = item => {
			this.#openSection = item.value;
			this.#focusedSection = item.value;
			this.#focused = undefined;
			this.#show();
			this.requestRender?.();
		};
		selectList.onCancel = this.onCancel;
		this.#selectList = selectList;

		const filterHint = items.length > visible ? " · type to filter" : "";
		this.renderSubmenuFrame({
			title: "Rules",
			description: "Rules by section. Enter opens one.",
			headerExtra: this.#warningComponent(builtinOff),
			body: selectList,
			footerHint: `  Enter to open${filterHint} · Esc to go back`,
		});
	}

	#showSection(label: string): void {
		const builtinOff = settings.get("ttsr.builtinRules") !== true;
		const section = this.#sections().find(candidate => candidate.label === label);
		if (!section) {
			this.#openSection = undefined;
			this.#showSections();
			return;
		}

		const disabled = this.#disabled();
		const experiments = this.#enabledExperiments();
		const items: SelectItem[] = section.rules.map(rule => {
			const state = this.#isOff(rule, disabled, experiments, builtinOff)
				? theme.fg("dim", "off")
				: theme.fg("success", "on");
			const detail = rule.description ? ` · ${collapseWhitespace(rule.description)}` : "";
			return {
				value: rule.name,
				label: rule.name,
				description: `${state} · ${this.#kind(rule)}${detail}`,
			};
		});

		const visible = clamp(items.length, 1, RULE_LIST_MAX_ROWS);
		const selectList = new SelectList(items, visible, getSelectListTheme(), {
			minPrimaryColumnWidth: 1,
			maxPrimaryColumnWidth: 32,
		});
		const focusedIndex = this.#focused ? items.findIndex(item => item.value === this.#focused) : -1;
		if (focusedIndex >= 0) selectList.setSelectedIndex(focusedIndex);
		selectList.onSelect = item => this.#toggle(item.value);
		selectList.onCancel = () => {
			this.#openSection = undefined;
			this.#show();
			this.requestRender?.();
		};
		this.#selectList = selectList;

		const filterHint = items.length > visible ? " · type to filter" : "";
		this.renderSubmenuFrame({
			title: "Rules",
			description: `${label} — Enter turns a rule off, or back on.`,
			headerExtra: this.#warningComponent(builtinOff),
			body: selectList,
			footerHint: `  Enter to toggle${filterHint} · Esc for sections`,
		});
	}

	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}
}

const AGENT_ROW_OFFERED = "\u0000agent-offered";
const AGENT_ROW_NESTED = "\u0000agent-nested";
const AGENT_ROW_RESET = "\u0000agent-reset";
const AGENT_ROW_MODEL = "\u0000subagent-model";
const AGENT_ROW_EFFORT = "\u0000subagent-effort";

const CUSTOM_AGENT_HINT =
	"Write your own: a markdown file in ~/.veyyon/subagents/. Guide: veyyon.dev/docs/features/subagents-authoring.html";

type SubagentRosterPath = "subagent.agents";

type SubagentEffortScope =
	| { kind: "model"; model: Model }
	| { kind: "unresolved"; pattern: string }
	| { kind: "blanket" };

function effortScopeForPattern(
	models: ReadonlyArray<Model> | undefined,
	head: string | undefined,
	sessionModel: Model | undefined,
): SubagentEffortScope {
	if (!head) return sessionModel ? { kind: "model", model: sessionModel } : { kind: "blanket" };
	const bare = models ? barePickerSelector(head, models as Model<Api>[]) : head;
	const found = models?.find(candidate => `${candidate.provider}/${candidate.id}` === bare);
	return found ? { kind: "model", model: found } : { kind: "unresolved", pattern: head };
}

function subagentEffortOptions(
	scope: SubagentEffortScope,
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

function laneSpawnEnabled(lane: SubagentLaneSettings, depth: number, resolvedMax: number): boolean {
	return lane.enabled ?? canSpawnAtDepth(resolvedMax, depth);
}

function lanePath(name: string, depth: number): string {
	return `subagent.agents.${name}${".subagents".repeat(depth)}`;
}

function pruneLane(lane: SubagentLaneSettings): SubagentLaneSettings | undefined {
	const cleaned: SubagentLaneSettings = {};
	if (lane.enabled !== undefined) cleaned.enabled = lane.enabled;
	if (lane.model !== undefined && (Array.isArray(lane.model) ? lane.model.length > 0 : lane.model.trim().length > 0)) {
		cleaned.model = lane.model;
	}
	if (lane.thinkingLevel !== undefined && lane.thinkingLevel.trim().length > 0) {
		cleaned.thinkingLevel = lane.thinkingLevel;
	}
	const child = lane.subagents === undefined ? undefined : pruneLane(lane.subagents);
	if (child !== undefined) cleaned.subagents = child;
	if (lane.maxNestedSpawnDepth !== undefined && child === undefined) {
		cleaned.maxNestedSpawnDepth = lane.maxNestedSpawnDepth;
	}
	return Object.keys(cleaned).length === 0 ? undefined : cleaned;
}

class SubagentAgentsSubmenu extends MouseRoutedSubmenu {
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
		private readonly onChange: (path: SubagentRosterPath) => void,
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

	#table(): Record<string, SubagentAgentSettings> {
		const stored = settings.get("subagent.agents");
		return stored && typeof stored === "object" ? ({ ...stored } as Record<string, SubagentAgentSettings>) : {};
	}

	#row(name: string): SubagentAgentSettings {
		return { ...subagentSettingsFor(settings, name) };
	}

	#lane(name: string, depth: number): SubagentLaneSettings {
		let lane: SubagentLaneSettings = this.#row(name);
		for (let step = 0; step < depth; step++) lane = lane.subagents ?? {};
		return { ...lane };
	}

	#writeLane(name: string, depth: number, next: SubagentLaneSettings): void {
		const chain: SubagentLaneSettings[] = [];
		let lane: SubagentLaneSettings = this.#row(name);
		for (let step = 0; step < depth; step++) {
			chain.push(lane);
			lane = lane.subagents ?? {};
		}
		let rebuilt = pruneLane(next);
		for (let step = chain.length - 1; step >= 0; step--) {
			rebuilt = pruneLane({ ...chain[step], subagents: rebuilt });
		}
		const table = this.#table();
		if (rebuilt === undefined) delete table[name];
		else table[name] = rebuilt;
		settings.set("subagent.agents", table);
		this.onChange("subagent.agents");
	}

	#modelSummary(agent: AgentDefinition, depth = 0): string {
		const resolved = resolveSubagentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			taskDepth: depth + 1,
		});
		if (resolved.unresolved) return theme.fg("error", `${resolved.unresolved.value} matches no model`);
		const pattern = resolved.patterns[0];
		if (!pattern) return theme.fg("dim", "no model resolved");
		const fallbacks = resolved.patterns.length - 1;
		const summary =
			fallbacks > 0
				? `${formatSelectorSummary(pattern)} ${theme.fg("dim", `+${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`)}`
				: formatSelectorSummary(pattern);
		return resolved.source === "default"
			? theme.fg("dim", `default · ${summary}`)
			: `${summary} ${theme.fg("dim", `· ${subagentModelSourceLabel(resolved.source, agent.name, resolved.depth)}`)}`;
	}

	#laneModelSummary(lane: SubagentLaneSettings, depth: number): string {
		const chain = lane.model;
		if (chain === undefined || (Array.isArray(chain) ? chain.length === 0 : chain.trim().length === 0)) {
			return theme.fg("dim", depth === 0 ? "default · the default model role" : "inherit · the level above");
		}
		const entries = Array.isArray(chain) ? chain : [chain];
		const head = entries[0] ?? "";
		const fallbacks = entries.length - 1;
		return fallbacks > 0
			? `${formatSelectorSummary(head)} ${theme.fg("dim", `+${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`)}`
			: formatSelectorSummary(head);
	}

	#laneEffortSummary(lane: SubagentLaneSettings, depth: number): string {
		const level = lane.thinkingLevel?.trim() ?? "";
		return level.length > 0
			? level
			: theme.fg("dim", depth === 0 ? "default · the default effort" : "inherit · the level above");
	}

	#runsSummary(agent: AgentDefinition, depth = 0): string {
		const model = this.#modelSummary(agent, depth);
		const head = resolveSubagentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			taskDepth: depth + 1,
		}).patterns[0];
		if (head && extractExplicitThinkingSelector(head, settings) !== undefined) return model;
		const effort = resolveSubagentThinkingLevel({
			settings,
			agentName: agent.name,
			agentThinkingLevel: agent.thinkingLevel,
			taskDepth: depth + 1,
		});
		return `${model} ${theme.fg("dim", `· ${effort} effort`)}`;
	}

	#showAgentList(): void {
		this.clear();
		this.#escapeTo = undefined;
		this.#selectList = undefined;

		if (this.#loadError) {
			const container = new Container();
			container.addChild(
				new Text(theme.fg("error", `  Could not read the agent directories: ${this.#loadError}`), 0, 0),
			);
			this.renderSubmenuFrame({
				title: "Subagents",
				description:
					"Which subagent types this session offers, and what each one runs. Model and effort are chosen inside an agent's own page and apply to that agent alone; an agent that names neither runs the profile's default model at medium effort.",
				body: container,
				footerHint: "  Esc to go back",
			});
			return;
		}
		if (!this.#loaded) {
			const container = new Container();
			container.addChild(new Text(theme.fg("dim", "  Reading subagents…"), 0, 0));
			this.renderSubmenuFrame({
				title: "Subagents",
				description:
					"Which subagent types this session offers, and what each one runs. Model and effort are chosen inside an agent's own page and apply to that agent alone; an agent that names neither runs the profile's default model at medium effort.",
				body: container,
			});
			return;
		}

		let headerExtra: Component | undefined;
		const blocked = delegationBlockedNotice(
			resolveDelegation(
				settings,
				this.#agents
					.filter(agent => subagentEnableState(agent, this.#row(agent.name).enabled) === "on")
					.map(agent => agent.name),
			),
		);
		if (blocked) {
			headerExtra = new Text(theme.fg("warning", `  ${blocked}`), 0, 0);
		}

		const items: SelectItem[] = this.#agents.map(agent => ({
			value: agent.name,
			label: agent.name,
			description: `${SUBAGENT_ENABLE_STATE_LABEL[subagentEnableState(agent, this.#row(agent.name).enabled)]} · ${this.#modelSummary(agent)}`,
		}));

		if (items.length === 0) {
			const container = new Container();
			container.addChild(new Text(theme.fg("dim", "  No subagent types found."), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", `  ${CUSTOM_AGENT_HINT}`), 0, 0));
			this.renderSubmenuFrame({
				title: "Subagents",
				description:
					"Which subagent types this session offers, and what each one runs. Model and effort are chosen inside an agent's own page and apply to that agent alone; an agent that names neither runs the profile's default model at medium effort.",
				headerExtra,
				body: container,
				footerHint: "  Esc to go back",
			});
			return;
		}

		const selectList = new SelectList(items, clamp(items.length, 1, 5), getSelectListTheme());
		selectList.onSelect = item => {
			this.#showAgentEditor(item.value);
			this.requestRender?.();
		};
		selectList.onCancel = this.onCancel;
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
			title: "Subagents",
			description:
				"Which subagent types this session offers, and what each one runs. Model and effort are chosen inside an agent's own page and apply to that agent alone; an agent that names neither runs the profile's default model at medium effort.",
			headerExtra,
			body: selectList,
			footerExtra,
			footerHint: "  Enter to configure · Esc to go back",
		});
	}

	#agent(name: string): AgentDefinition | undefined {
		return this.#agents.find(candidate => candidate.name === name);
	}

	#detailText(name: string | undefined): string {
		const description = name ? this.#agent(name)?.description?.trim() : undefined;
		if (!description) return "";
		return theme.fg("muted", `  ${description}`);
	}

	#showAgentEditor(name: string, depth = 0): void {
		const agent = this.#agent(name);
		if (!agent) {
			this.#showAgentList();
			return;
		}
		const lane = this.#lane(name, depth);
		const child = lane.subagents ?? {};
		const resolvedMax = resolveSubagentMaxNestedSpawnDepth(settings, name);
		const spawnAllowed = laneSpawnEnabled(child, depth + 1, resolvedMax);

		this.clear();
		this.#escapeTo = undefined;
		const trail = depth === 0 ? `Subagent: ${name}` : `${name}${" › subagents".repeat(depth)}`;
		const shared = subagentScopeIsShared(settings);

		const headerExtra = new Container();
		headerExtra.addChild(new Text(`  ${theme.fg("muted", "Runs")} ${this.#runsSummary(agent, depth)}`, 0, 0));
		if (shared) {
			headerExtra.addChild(new Spacer(1));
			headerExtra.addChild(new Text(theme.fg("dim", "  Set for every subagent · Subagents → Shared Model"), 0, 0));
		}

		const items: SelectItem[] = [
			{
				value: AGENT_ROW_OFFERED,
				label: "Enabled",
				description:
					depth === 0
						? `${SUBAGENT_ENABLE_STATE_LABEL[subagentEnableState(agent, lane.enabled)]}${
								isSubagentEnableDefaulted(lane.enabled) ? theme.fg("dim", " (default)") : ""
							}`
						: `${laneSpawnEnabled(lane, depth, resolvedMax) ? "on" : "off"}${
								lane.enabled === undefined ? theme.fg("dim", " (default)") : ""
							}`,
			},
			...(shared
				? []
				: [
						{ value: AGENT_ROW_MODEL, label: "Model", description: this.#laneModelSummary(lane, depth) },
						{ value: AGENT_ROW_EFFORT, label: "Effort", description: this.#laneEffortSummary(lane, depth) },
					]),
			{
				value: AGENT_ROW_NESTED,
				label: "Subagents",
				description: spawnAllowed
					? this.#laneModelSummary(child, depth + 1)
					: theme.fg("dim", "off · this lane may not spawn"),
			},
		];
		if (Object.keys(lane).length > 0) {
			items.push({
				value: AGENT_ROW_RESET,
				label: "Reset to defaults",
				description: theme.fg("dim", `clears ${lanePath(name, depth)}`),
			});
		}

		const selectList = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		selectList.onSelect = item => {
			switch (item.value) {
				case AGENT_ROW_OFFERED:
					this.#writeLane(
						name,
						depth,
						depth === 0
							? { ...lane, enabled: nextSubagentEnableValue(agent, lane.enabled) }
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
		};
		selectList.onCancel = () => {
			if (depth === 0) this.#showAgentList();
			else this.#showAgentEditor(name, depth - 1);
			this.requestRender?.();
		};
		this.#selectList = selectList;

		this.renderSubmenuFrame({
			title: trail,
			description:
				depth === 0
					? agent.description || `${agent.source} subagent`
					: `What ${depth === 1 ? name : "this lane"} may spawn. Unset follows the level above.`,
			headerExtra,
			body: selectList,
			footerHint: "  Enter to change · Esc to go back",
		});
	}

	#showLaneModelPicker(name: string, depth: number): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showAgentEditor(name, depth);
		this.#escapeTo = back;
		if (!this.picker) {
			const container = new Container();
			container.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			this.renderSubmenuFrame({
				title: depth === 0 ? `Model · ${name}` : `Model · what ${name} spawns${" (nested)".repeat(depth - 1)}`,
				body: container,
				footerHint: "  Esc to go back",
			});
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
				() => this.onChange("subagent.agents"),
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
		const { options, notice } = subagentEffortOptions(this.#laneEffortScope(name, depth), this.models);
		const description =
			notice === undefined
				? depth === 0
					? `Effort ${name} runs at. Inherit follows the session's effort; a \`:level\` on the model chain still wins.`
					: "Effort this lane runs at. Inherit follows the level above."
				: `Effort this lane runs at. ${notice}`;
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

	#laneEffortScope(name: string, depth: number): SubagentEffortScope {
		const head = resolveSubagentModel({
			settings,
			agentName: name,
			taskDepth: depth + 1,
		}).patterns[0];
		return effortScopeForPattern(this.models, head, this.sessionModel);
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

const ADD_EFFORT_ROW = "\u0000add-effort-row";
const CHAIN_ENTRY_PREFIX = "\u0000chain-entry:";
const CHAIN_ADD_ROW = "\u0000chain-add-row";
const CHAIN_CLEAR_ROW = "\u0000chain-clear-row";

class DefaultEffortSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly models: ReadonlyArray<Model>,
		private readonly registry: ModelRegistry,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showRows();
	}

	#rows(): Record<string, string> {
		return withLegacyDefaultEffort(
			settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
			settings.get("defaultThinkingLevel"),
		);
	}

	#showRows(): void {
		this.clear();
		this.#selectList = undefined;
		const rows = this.#rows();
		const keys = Object.keys(rows).sort((a, b) =>
			a === ANY_MODEL_EFFORT_KEY ? -1 : b === ANY_MODEL_EFFORT_KEY ? 1 : a.localeCompare(b),
		);
		const items: SelectItem[] = keys.map(key => ({
			value: key,
			label: key === ANY_MODEL_EFFORT_KEY ? "any model" : key,
			description: rows[key] ?? "",
		}));
		items.push({ value: ADD_EFFORT_ROW, label: "Add a model…", description: "pick a model, then its effort" });
		items.push({
			value: ANY_MODEL_EFFORT_KEY,
			label: rows[ANY_MODEL_EFFORT_KEY] === undefined ? "Set the any-model effort…" : "Change the any-model effort…",
			description: "applies to every model without its own row",
		});

		const selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		selectList.onSelect = item => {
			if (item.value === ADD_EFFORT_ROW) {
				this.#showModelPicker();
			} else {
				this.#showEffortPicker(item.value);
			}
			this.requestRender?.();
		};
		selectList.onCancel = this.onCancel;
		this.#selectList = selectList;

		this.renderSubmenuFrame({
			title: "Default Effort",
			description:
				"Effort applied when a run does not ask for one. A model's own row wins over the any-model row. Per active profile.",
			body: selectList,
			footerHint: "  Enter to edit · Del removes a row · Esc to go back",
		});
	}

	#showModelPicker(): void {
		this.clear();
		this.#selectList = undefined;
		const panel = new ModelSelectorPanel(
			settings,
			this.registry,
			this.models,
			{
				title: "Default effort for which model",
				description: "Pick the model, then its effort. Already-listed models are edited from the list itself.",
				allowClear: false,
			},
			{
				onPick: model => {
					this.#showEffortPicker(`${model.provider}/${model.id}`, model);
					this.requestRender?.();
				},
				onCancel: () => {
					this.#showRows();
					this.requestRender?.();
				},
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: pointerMotionEnabled() });
		this.addChild(panel);
	}

	#showEffortPicker(key: string, picked?: Model): void {
		const model = picked ?? this.models.find(m => `${m.provider}/${m.id}` === key);
		this.#selectList = renderEffortStep(
			this,
			key === ANY_MODEL_EFFORT_KEY ? "any model" : key,
			key === ANY_MODEL_EFFORT_KEY ? undefined : model,
			value => this.#persist(key, value),
			() => {
				this.#showRows();
				this.requestRender?.();
			},
			key === ANY_MODEL_EFFORT_KEY ? this.models : undefined,
		);
	}

	#persist(key: string, selectorWithEffort: string): void {
		const level = extractExplicitThinkingSelector(selectorWithEffort, settings);
		const rows = { ...this.#rows() };
		if (level === undefined) delete rows[key];
		else rows[key] = level;
		settings.set("defaultEffort", rows);
		this.onChange();
		this.#showRows();
		this.requestRender?.();
	}

	#removeSelectedRow(): void {
		const selected = this.#selectList?.getSelectedItem?.();
		const key = selected?.value;
		if (!key || key === ADD_EFFORT_ROW) return;
		const rows = { ...this.#rows() };
		if (rows[key] === undefined) return;
		delete rows[key];
		settings.set("defaultEffort", rows);
		this.onChange();
		this.#showRows();
		this.requestRender?.();
	}

	mouseTarget(): SelectList | ModelSelectorPanel | undefined {
		return (
			this.#selectList ??
			this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel)
		);
	}

	override handleInput(data: string): void {
		if (this.#selectList && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
			this.#removeSelectedRow();
			return;
		}
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

export interface ModelChainSlot {
	write: (chain: string[] | undefined) => void;
}

export class ModelChainSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#chain: string[];

	constructor(
		private readonly slot: SettingPath | ModelChainSlot,
		private readonly registry: ModelRegistry,
		private readonly models: ReadonlyArray<Model>,
		private readonly title: string,
		current: string | string[] | undefined,
		private readonly done: (value?: string) => void,
		private readonly onChange: (value: string[] | undefined) => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#chain = normalizeModelPatternList(current);
		if (this.#chain.length === 0) this.#showModelPicker(null);
		else this.#showChain();
	}

	#showChain(): void {
		this.clear();
		this.#selectList = undefined;
		const items: SelectItem[] = this.#chain.map((selector, index) => ({
			value: `${CHAIN_ENTRY_PREFIX}${index}`,
			label: `${index + 1}. ${formatSelectorSummary(selector)}`,
			description: index === 0 ? "first choice" : "fallback",
		}));
		items.push({ value: CHAIN_ADD_ROW, label: "Add fallback…", description: "pick a model, then its effort" });
		items.push({ value: CHAIN_CLEAR_ROW, label: "Clear (inherit)", description: "follow the main model" });

		const selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		selectList.onSelect = item => {
			if (item.value === CHAIN_ADD_ROW) this.#showModelPicker(null);
			else if (item.value === CHAIN_CLEAR_ROW) this.#clear();
			else this.#showModelPicker(Number(item.value.slice(CHAIN_ENTRY_PREFIX.length)));
			this.requestRender?.();
		};
		selectList.onCancel = () => this.done(this.#chain.join(","));
		this.#selectList = selectList;

		this.renderSubmenuFrame({
			title: this.title,
			description: "Tried in order. The rest are used when the one above cannot run.",
			body: selectList,
			footerHint: "  Enter edits · Del removes · Esc to go back",
		});
	}

	#removeSelectedRow(): void {
		const value = this.#selectList?.getSelectedItem?.()?.value;
		if (!value?.startsWith(CHAIN_ENTRY_PREFIX)) return;
		const index = Number(value.slice(CHAIN_ENTRY_PREFIX.length));
		if (!Number.isInteger(index) || index < 0 || index >= this.#chain.length) return;
		this.#chain.splice(index, 1);
		this.#persistChain();
	}

	#showModelPicker(index: number | null): void {
		this.clear();
		this.#selectList = undefined;
		const current = index === null ? undefined : this.#chain[index];
		const position =
			index === 0 ? "first choice" : index === null ? `fallback ${this.#chain.length + 1}` : `fallback ${index + 1}`;
		const panel = new ModelSelectorPanel(
			settings,
			this.registry,
			this.models,
			{
				title: this.#chain.length === 0 ? this.title : `${this.title} · ${position}`,
				description:
					index === null ? "Pick a model to append to the chain." : "Pick a replacement for this position.",
				currentSelector: barePickerSelector(current, this.models as Model<Api>[]) || undefined,
				allowClear: true,
				clearLabel:
					index !== null
						? "(remove this position)"
						: this.#chain.length === 0
							? "(inherit main model)"
							: "(cancel adding fallback)",
			},
			{
				onPick: (model, selector) => {
					if (!hasConfigurableThinkingEffort(model)) {
						this.#store(selector, index);
						return;
					}
					this.#showEffortPicker(selector, model, index);
					this.requestRender?.();
				},
				onClear: () => this.#clearPicker(index),
				onCancel: () => {
					if (this.#chain.length === 0) this.done();
					else this.#showChain();
					this.requestRender?.();
				},
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: pointerMotionEnabled() });
		this.addChild(panel);
	}

	#showEffortPicker(selector: string, model: Model, index: number | null): void {
		this.#selectList = renderEffortStep(
			this,
			selector,
			model,
			value => this.#store(value, index),
			() => {
				this.#showModelPicker(index);
				this.requestRender?.();
			},
		);
	}

	#store(value: string, index: number | null): void {
		const next = replaceModelChainEntry(this.#chain, index, value, this.models as Model<Api>[]);
		if (!next) {
			this.#showChain();
			this.requestRender?.();
			return;
		}
		this.#chain = next;
		this.#persistChain();
	}

	#clearPicker(index: number | null): void {
		if (index !== null && Number.isInteger(index) && index >= 0 && index < this.#chain.length) {
			this.#chain.splice(index, 1);
			this.#persistChain();
		} else if (this.#chain.length === 0) {
			this.#clear();
		} else {
			this.#showChain();
			this.requestRender?.();
		}
	}

	#clear(): void {
		this.#chain = [];
		this.#persist(undefined);
		this.onChange(undefined);
		this.done("inherit");
	}

	#persistChain(): void {
		const value = this.#chain.slice();
		this.#persist(value.length === 0 ? undefined : value);
		this.onChange(value.length === 0 ? undefined : value);
		this.#showChain();
		this.requestRender?.();
	}

	#persist(chain: string[] | undefined): void {
		if (typeof this.slot !== "string") {
			this.slot.write(chain);
			return;
		}
		if (chain === undefined) settings.unset(this.slot);
		else settings.set(this.slot, chain as never);
	}

	mouseTarget(): SelectList | ModelSelectorPanel | undefined {
		return (
			this.#selectList ??
			this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel)
		);
	}

	override handleInput(data: string): void {
		if (this.#selectList && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
			this.#removeSelectedRow();
			return;
		}
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

const ADVANCED_TOGGLE_ID_PREFIX = "__advanced:";

function advancedToggleId(tab: SettingTab): string {
	return `${ADVANCED_TOGGLE_ID_PREFIX}${tab}`;
}

function isAdvancedToggleId(id: string): boolean {
	return id.startsWith(ADVANCED_TOGGLE_ID_PREFIX);
}

const SETTINGS_TIPS: readonly string[] = [
	'Tip · Ask the agent: "change theme to titanium" or "what does compact do?"',
	"Tip · Ask the agent to change a setting",
];

const SIDEBAR_GAP_COLS = 3;
const MIN_SETTINGS_CONTENT_WIDTH = 32;

const SETTING_SOURCE_LABELS: Record<SettingSource, string> = {
	default: "default",
	profile: "profile",
	"config-file": "--config file",
	runtime: "runtime override",
	global: "global config",
};

const SETTINGS_SIDEBAR_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down category" },
	{ label: "right/enter settings" },
	{ label: "/ search" },
	{ label: "esc close", clickable: true, id: "close" },
];

const SETTINGS_READ_ONLY_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "read-only" },
	{ label: "left categories" },
	{ label: "/ search" },
	{ label: "esc close", clickable: true, id: "close" },
];

function getSettingsTabs(): Tab[] {
	const entry = (id: string, icon: string, label: string): Tab => ({
		id,
		label: icon ? `${icon} ${label}` : label,
		short: icon || label.charAt(0),
	});
	return [
		...SETTING_TABS.map(id => {
			const meta = TAB_METADATA[id];
			return entry(id, theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]), meta.label);
		}),
		entry("plugins", theme.icon.package, "Plugins"),
	];
}

export interface SettingsRuntimeContext {
	availableThinkingLevels: Effort[];
	thinkingLevel: ThinkingLevel | undefined;
	availableThemes: string[];
	availablePersonalities: string[];
	providers: string[];
	cwd: string;
	model?: Model;
	imageBudget?: ImageBudget;
	requestRender?: () => void;
	modelRegistry?: ModelRegistry;
	availableModels?: ReadonlyArray<Model>;
}

export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	sessionAccent?: boolean;
	compactThinkingLevel?: boolean;
}

export const ROLLBACK_ROW_ID = "__action:rollback";

export const MACHINE_LIMITS_POINTER_ROW_ID = "__pointer:machine-limits";

const MACHINE_LIMITS_POINTER_ROW: SettingItem = {
	id: MACHINE_LIMITS_POINTER_ROW_ID,
	label: "Machine-wide limits",
	currentValue: "Global tab",
	readOnly: true,
	description:
		"Every limit on this tab bounds one session tree — this session, its subagents, and everything they spawn — and is stored in the active profile. The limits that bound every veyyon process on this machine together, across profiles and concurrent instances, are on the Global tab under Machine Limits, stored in ~/.veyyon/config.yml. Session groups are created inside the machine group, so a session limit larger than the machine limit is bounded by it.",
	keywords: ["machine", "global", "all", "everything", "cross-profile", "system", "wide"],
};

export interface SettingsCallbacks {
	onChange: (path: SettingPath, newValue: unknown) => void;
	onThemePreview?: (theme: string) => void | Promise<void>;
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	getStatusLinePreview?: (width?: number) => string;
	onPluginsChanged?: () => void | Promise<void>;
	onCancel: () => void;
	onOpenUrl?: (url: string) => void;
	onRollback?: (version: string) => Promise<void>;
	onError?: (message: string) => void;
}

export interface SettingKindHandler<T extends SettingDef = SettingDef> {
	formatValue?(self: SettingsSelectorComponent, def: T, currentValue: unknown): string;
	labelForValue?(self: SettingsSelectorComponent, def: T): ((value: string) => string) | undefined;
	isChanged?(self: SettingsSelectorComponent, def: T, currentValue: unknown): boolean;
	createSubmenu?(
		self: SettingsSelectorComponent,
		def: T,
		currentValue: string,
		done: (value?: string) => void,
	): Container;
	buildItem?(self: SettingsSelectorComponent, def: T, currentValue: unknown, changed: boolean): SettingItem;
}

/**
 * One handler per setting kind, each receiving the def variant its own key selects.
 *
 * A plain Record over the union hands every handler the whole SettingDef, and the enum, submenu,
 * compactionThreshold and text handlers each reach for fields only their variant carries, so that
 * shape only compiles once the element type is widened to any.
 */
type SettingKindHandlers = {
	[K in SettingDef["type"]]: SettingKindHandler<Extract<SettingDef, { type: K }>>;
};

export const SETTING_KIND_HANDLERS: SettingKindHandlers = {
	boolean: {
		buildItem: (_self, def, currentValue, changed) => ({
			id: def.path,
			label: def.label,
			description: def.description,
			currentValue: currentValue ? "true" : "false",
			values: ["true", "false"],
			changed,
		}),
	},
	enum: {
		formatValue: (_self, _def, currentValue) => String(currentValue ?? ""),
		createSubmenu: (self, def, currentValue, done) => self.createEnumSubmenu(def, currentValue, done),
	},
	submenu: {
		formatValue: (self, def, currentValue) => self.getSubmenuCurrentValue(def.path, currentValue),
		labelForValue: (self, def) => value =>
			self.submenuOptions(def).find(option => option.value === value)?.label ?? value,
		createSubmenu: (self, def, currentValue, done) => self.createSubmenu(def, currentValue, done),
	},
	compactionThreshold: {
		formatValue: (_self, _def, currentValue) =>
			formatThresholdShort(String(currentValue ?? AUTO_COMPACTION_THRESHOLD)),
		createSubmenu: (self, def, _currentValue, done) => self.createCompactionThresholdInput(def, done),
	},
	text: {
		formatValue: (self, def, currentValue) => self.formatTextInputValue(def.path, currentValue),
		labelForValue: () => value => (value.length === 0 ? theme.fg("dim", "(unset)") : value),
		createSubmenu: (self, def, currentValue, done) => self.createTextInput(def, currentValue, done),
	},
	providerLimits: {
		formatValue: (self, _def, currentValue) => self.formatProviderLimitsValue(currentValue),
		createSubmenu: (self, _def, _currentValue, done) => self.createProviderLimitsInput(done),
	},
	modelSelector: {
		formatValue: (self, _def, currentValue) => self.formatModelSelectorValue(currentValue),
		createSubmenu: (self, def, _currentValue, done) => self.createModelSelectorInput(def.path, done),
	},
	defaultEffort: {
		formatValue: self => self.formatDefaultEffortValue(),
		createSubmenu: (self, _def, _currentValue, done) => self.createDefaultEffortInput(done),
	},
	subagentSharedEffort: {
		formatValue: self => self.formatSubagentSharedEffortValue(),
		createSubmenu: (self, _def, _currentValue, done) => self.createSubagentSharedEffortInput(done),
	},
	modelRoles: {
		formatValue: self => self.formatModelRolesValue(),
		createSubmenu: (self, _def, _currentValue, done) => self.createModelRolesInput(done),
	},
	subagentAgents: {
		formatValue: self => self.formatSubagentAgentsValue(),
		createSubmenu: (self, _def, _currentValue, done) => self.createSubagentAgentsInput(done),
	},
	rules: {
		formatValue: self => self.formatRulesValue(),
		createSubmenu: (self, _def, _currentValue, done) => self.createRulesInput(done),
	},
	lsp: {
		formatValue: () => formatLspSummary(),
		isChanged: () => LSP_SETTING_PATHS.some(path => !Object.is(settings.get(path), getDefault(path))),
		createSubmenu: (self, _def, _currentValue, done) => self.createLspInput(done),
	},
	defaultModel: {
		isChanged: (_self, _def, currentValue) => typeof currentValue === "string" && currentValue.trim().length > 0,
		buildItem: (self, def, currentValue, changed) => {
			const active = settings.getModelRole(DEFAULT_MODEL_SLOT);
			const source = settings.getModelRoleSource(DEFAULT_MODEL_SLOT);
			const overridden =
				(source === "config-file" || source === "runtime") &&
				typeof active === "string" &&
				active.trim() !== currentValue;
			if (overridden) self.expandId(def.path);
			return {
				id: def.path,
				label: overridden ? `${def.label} · ${source}` : def.label,
				description: overridden
					? `${def.description} Active ${self.formatModelSelectorValue(active)} comes from ${SETTING_SOURCE_LABELS[source]}; this row changes the saved profile default.`
					: def.description,
				currentValue: overridden
					? `${self.formatCompactModelSelectorValue(currentValue)} → ${self.formatCompactModelSelectorValue(active)}`
					: self.formatModelSelectorValue(currentValue),
				submenu: (_cv, done) => self.createDefaultModelInput(done),
				changed,
			};
		},
	},
	advisorModel: {
		formatValue: (self, _def, currentValue) => self.formatModelSelectorValue(currentValue),
		isChanged: (_self, _def, currentValue) => typeof currentValue === "string" && currentValue.trim().length > 0,
		createSubmenu: (self, _def, _currentValue, done) => self.createAdvisorModelInput(done),
	},
};

/**
 * The map is keyed by the same discriminant that narrows the def, so whatever sits at `def.type`
 * accepts this def. TypeScript cannot correlate an indexed access with the value that produced the
 * key, so the correspondence is stated here once instead of widening every handler to the union.
 */
function handlerFor<D extends SettingDef>(def: D): SettingKindHandler<D> | undefined {
	return SETTING_KIND_HANDLERS[def.type] as SettingKindHandler<D> | undefined;
}

export function assertAllSettingKindsHandled(): void {
	const expected: SettingDef["type"][] = [
		"boolean",
		"enum",
		"submenu",
		"compactionThreshold",
		"text",
		"providerLimits",
		"modelSelector",
		"defaultEffort",
		"subagentSharedEffort",
		"modelRoles",
		"subagentAgents",
		"rules",
		"lsp",
		"defaultModel",
		"advisorModel",
	];
	for (const kind of expected) {
		if (!SETTING_KIND_HANDLERS[kind]) {
			throw new Error(`Missing handler for setting kind: ${kind}`);
		}
	}
}

export class SettingsSelectorComponent implements Component {
	#tabBar: TabBar;
	#currentList: SettingsList | null = null;
	#searchList: SettingsList | null = null;
	#pluginComponent: PluginSettingsComponent | null = null;
	#currentTabId: SettingTab | "plugins" = "appearance";
	#preSearchTabId: SettingTab | "plugins" = "appearance";
	#searchQuery = "";
	#searchInput = new Input();
	#searchMatchCount = 0;
	#searchFirstMatch = new Map<string, string>();
	#textInputActive = false;
	#showAdvanced = new Map<SettingTab, boolean>();
	#selectedSettingByTab = new Map<SettingTab, string>();
	#lspPanelFocusPath: SettingPath | undefined;
	#tabRowStart = 0;
	#tabRowCount = 0;
	#contentRowStart = 0;
	#contentRowCount = 0;
	#frameLeft = 0;
	#sidebarCols = 0;
	#sidebarWidthCache: number | undefined;
	#shellGeometry: ModalShellGeometry | null = null;
	#viewportTooSmall = false;
	#hoveredShortcutId: string | null = null;
	#expandedIds = new Set<string>();
	#sidebarFocused = false;

	static readonly MODAL_MAX_WIDTH = MODAL_SIZING_SETTINGS.maxWidth;

	constructor(
		private readonly context: SettingsRuntimeContext,
		private readonly callbacks: SettingsCallbacks,
		initialItemId?: string,
	) {
		assertAllSettingKindsHandled();
		this.#tabBar = new TabBar("", getSettingsTabs(), getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.setHoverMotion({
			requestRender: () => this.context.requestRender?.(),
			enabled: pointerMotionEnabled(),
		});
		this.#tabBar.onTabChange = () => {
			const tabId = this.#tabBar.getActiveTab().id as SettingTab | "plugins";
			if (this.#searchList) {
				const firstId = this.#searchFirstMatch.get(tabId);
				if (firstId) this.#searchList.selectItem(firstId);
				return;
			}
			this.#switchToTab(tabId);
		};

		this.#switchToTab("appearance");
		if (initialItemId) this.#currentList?.selectItem(initialItemId);
	}

	expandId(id: string): void {
		this.#expandedIds.add(id);
	}

	dispose(): void {
		this.#tabBar.disposeHoverMotion();
		this.#currentList?.disposeHoverMotion();
		this.#searchList?.disposeHoverMotion();
	}

	getSelectedSettingId(): string | undefined {
		return (this.#searchList ?? this.#currentList)?.getSelectedItem()?.id;
	}

	selectSetting(path: string): boolean {
		return (this.#searchList ?? this.#currentList)?.selectItem(path) ?? false;
	}

	openTab(tabId: SettingTab | "plugins"): void {
		this.#tabBar.setActiveById(tabId);
		if (this.#currentTabId !== tabId) this.#switchToTab(tabId);
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#currentList?.invalidate();
		this.#searchList?.invalidate();
		this.#pluginComponent?.invalidate();
	}

	openLspPanel(focusPath?: SettingPath): void {
		this.#lspPanelFocusPath = focusPath;
		this.openTab("files");
		const list = this.#currentList;
		if (!list) return;
		const lspDef = getSettingDef("lsp.enabled");
		if (lspDef && list.selectItem(lspDef.path)) {
			list.activateSelected();
		}
	}

	#rememberCurrentSelection(): void {
		if (this.#currentTabId === "plugins") return;
		const selected = this.#currentList?.getSelectedItem()?.id;
		if (selected) this.#selectedSettingByTab.set(this.#currentTabId, selected);
	}

	#restoreRememberedSelection(tabId: SettingTab, remembered: string | undefined): void {
		if (!remembered) return;
		if (this.#currentList?.selectItem(remembered)) return;

		const defs = getSettingsForTab(tabId);
		const rememberedIndex = defs.findIndex(def => def.path === remembered);
		if (rememberedIndex !== -1) {
			for (let offset = 1; offset < defs.length; offset++) {
				const before = defs[rememberedIndex - offset];
				if (before && this.#currentList?.selectItem(before.path)) {
					this.#selectedSettingByTab.set(tabId, before.path);
					return;
				}
				const after = defs[rememberedIndex + offset];
				if (after && this.#currentList?.selectItem(after.path)) {
					this.#selectedSettingByTab.set(tabId, after.path);
					return;
				}
			}
		}
		this.#selectedSettingByTab.delete(tabId);
	}

	#setContent(build: () => void): void {
		this.#currentList?.disposeHoverMotion();
		this.#searchList?.disposeHoverMotion();
		this.#currentList = null;
		this.#searchList = null;
		this.#pluginComponent = null;
		build();
	}

	#switchToTab(tabId: SettingTab | "plugins"): void {
		this.#rememberCurrentSelection();
		this.#currentTabId = tabId;
		this.#setContent(() => {
			if (tabId === "plugins") {
				this.#showPluginsTab();
			} else {
				this.#showSettingsTab(tabId);
				this.#restoreRememberedSelection(tabId, this.#selectedSettingByTab.get(tabId));
			}
		});
	}

	#settingsShortcuts(): readonly ModalShortcut[] {
		if (this.#searchList) return SETTINGS_FILTER_SHORTCUTS;
		if (this.#currentList?.hasOpenSubmenu()) return SETTINGS_SUBPANE_SHORTCUTS;
		if (this.#sidebarFocused) return SETTINGS_SIDEBAR_SHORTCUTS;
		if (this.#pluginComponent) return this.#pluginComponent.shortcuts();
		if (this.#currentList?.getSelectedItem()?.readOnly) return SETTINGS_READ_ONLY_SHORTCUTS;
		return SETTINGS_BROWSE_SHORTCUTS;
	}

	#renderSearchBanner(width: number): string {
		const icon = theme.symbol("icon.search");
		const countText = this.#searchMatchCount === 1 ? "1 match" : `${this.#searchMatchCount} matches`;
		const rightWidth = visibleWidth(countText) + 1;
		const prefix = ` ${theme.fg("accent", icon)} `;
		const inputWidth = Math.max(4, width - visibleWidth(prefix) - rightWidth - 1);
		const inputLine = this.#searchInput.render(inputWidth)[0] ?? "";
		const count = theme.fg(this.#searchMatchCount > 0 ? "dim" : "warning", countText);
		return truncateToWidth(`${prefix}${theme.bold(inputLine)} ${count} `, width);
	}

	#searchChromeLine(width: number): string {
		if (this.#searchList) return this.#renderSearchBanner(width);
		const icon = theme.symbol("icon.search");
		return truncateToWidth(` ${theme.fg("dim", icon)} ${theme.fg("dim", "/ search settings")}`, width);
	}

	#sidebarWidth(contentWidth: number): number {
		if (this.#sidebarWidthCache === undefined) {
			let labelWidth = 0;
			for (const tab of getSettingsTabs()) {
				labelWidth = Math.max(labelWidth, visibleWidth(tab.label));
			}
			this.#sidebarWidthCache = labelWidth + 2 + 5;
		}
		return Math.min(this.#sidebarWidthCache, Math.max(10, Math.floor(contentWidth / 3)));
	}

	#renderTooSmall(width: number, termHeight: number): readonly string[] {
		this.#viewportTooSmall = true;
		this.#shellGeometry = null;
		this.#contentRowCount = 0;
		const lines = Array.from({ length: termHeight }, () => padding(width));
		const messages =
			width >= 40
				? ["Settings needs a larger terminal · resize or press Esc to close"]
				: ["Settings needs more room", "Resize · Esc closes"];
		const firstRow = Math.max(0, Math.floor((termHeight - messages.length) / 2));
		for (const [offset, message] of messages.entries()) {
			const text = truncateToWidth(message, width);
			const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
			lines[firstRow + offset] = `${padding(left)}${text}`;
		}
		return lines;
	}

	render(width: number): readonly string[] {
		const termHeight = Math.max(1, process.stdout.rows || 40);
		const sizing = sizingForArea(MODAL_SIZING_SETTINGS, termHeight);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims || dims.contentWidth < MIN_SETTINGS_CONTENT_WIDTH) return this.#renderTooSmall(width, termHeight);
		this.#viewportTooSmall = false;

		const contentWidth = dims.contentWidth;
		const settingsShortcuts = this.#settingsShortcuts();
		const maxBodyRows = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth,
			shortcuts: settingsShortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			tipCandidates: SETTINGS_TIPS,
			hasSearch: true,
		}).maxBodyRows;
		if (maxBodyRows < 1) return this.#renderTooSmall(width, termHeight);

		const sidebarWidth = this.#sidebarWidth(contentWidth);
		const paneWidth = Math.max(1, contentWidth - sidebarWidth - SIDEBAR_GAP_COLS);
		const sidebarCursor = this.#sidebarFocused ? `${theme.fg("accent", theme.nav.cursor)} ` : `${theme.nav.cursor} `;
		const sidebarLines = this.#tabBar.renderVertical(sidebarWidth, sidebarCursor);
		const searching = this.#searchList !== null;
		const showPreview = !searching && this.#currentTabId === "appearance" && paneWidth >= 40;
		const requestedPreviewLines = showPreview
			? [
					"",
					theme.fg("muted", "Preview:"),
					...this.#getStatusPreviewString(paneWidth)
						.split("\n")
						.map(line => truncateToWidth(line, paneWidth, Ellipsis.Omit)),
				]
			: [];

		const estimatedBody = maxBodyRows;
		const previewLines = estimatedBody >= 8 ? requestedPreviewLines : [];
		const list = this.#searchList ?? this.#currentList;
		let listLines: readonly string[] = [];
		if (list) {
			list.setMaxVisible(Math.max(1, estimatedBody - previewLines.length));
			list.setOptions({
				descriptionMode: "expand",
				expandedIds: this.#expandedIds,
				layout: "flat",
			});
			listLines = list.render(paneWidth);
		} else if (this.#pluginComponent) {
			listLines = this.#pluginComponent.render(paneWidth);
		}

		const paneLines: string[] = listLines.concat(previewLines);
		const bar = theme.fg("borderAccent", theme.boxSharp.vertical);
		const bodyRows = Math.max(sidebarLines.length, paneLines.length);
		const body: string[] = [];
		for (let r = 0; r < bodyRows; r++) {
			const side = sidebarLines[r] ?? padding(sidebarWidth);
			body.push(`${side}${bar}  ${paneLines[r] ?? ""}`);
		}

		const openSubmenuLabel = list?.hasOpenSubmenu() ? list.getOpenSubmenuLabel() : undefined;
		const breadcrumb = openSubmenuLabel ? ` ${theme.nav.cursor} ${openSubmenuLabel}` : undefined;

		const shell = renderModalShell({
			title: "Settings",
			breadcrumb,
			breadcrumbClickable: true,
			breadcrumbHovered: this.#hoveredShortcutId === BREADCRUMB_HOVER_ID,
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body,
			searchLine: this.#searchChromeLine(contentWidth),
			tipCandidates: SETTINGS_TIPS,
			shortcuts: settingsShortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});

		this.#shellGeometry = shell.geometry;
		this.#frameLeft = shell.geometry?.leftPad ?? 0;
		this.#tabRowStart = shell.geometry?.bodyRowStart ?? 0;
		this.#tabRowCount = Math.min(sidebarLines.length, shell.geometry?.bodyRowCount ?? 0);
		this.#contentRowStart = this.#tabRowStart;
		this.#contentRowCount = shell.geometry?.bodyRowCount ?? 0;
		this.#sidebarCols = sidebarWidth;
		return shell.lines;
	}

	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
	}

	#cancelOpenSubmenu(): void {
		const list = this.#searchList ?? this.#currentList;
		if (list?.hasOpenSubmenu()) list.handleInput("\x1b");
	}

	#close(): void {
		this.#cancelOpenSubmenu();
		this.callbacks.onCancel();
	}

	#stepBack(): void {
		if (this.#pluginComponent) {
			this.#pluginComponent.handleInput("\x1b");
			return;
		}
		(this.#searchList ?? this.#currentList)?.handleInput("\x1b");
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (
			consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
				this.#hoveredShortcutId = id;
				this.context.requestRender?.();
			})
		) {
			return true;
		}
		if (chrome.kind === "close" || chrome.kind === "outside") {
			this.#close();
			return true;
		}
		if (chrome.kind === "breadcrumb") {
			this.#stepBack();
			return true;
		}
		if (chrome.kind === "shortcut") {
			if (chrome.id === "close") {
				this.#close();
				return true;
			}
			if (chrome.id === "clear-filter") {
				this.#endSearch(true);
				return true;
			}
			if (chrome.id === "back") {
				this.#stepBack();
				return true;
			}
		}

		const list = this.#searchList ?? this.#currentList;
		const contentColInset = 2 + this.#frameLeft;
		const innerCol = event.col - contentColInset;
		const bodyLine = event.row - this.#contentRowStart;
		const overBody = bodyLine >= 0 && bodyLine < this.#contentRowCount;
		const overSidebar = overBody && innerCol >= 0 && innerCol < this.#sidebarCols && bodyLine < this.#tabRowCount;
		const paneCol = innerCol - (this.#sidebarCols + SIDEBAR_GAP_COLS);
		const overPane = overBody && paneCol >= 0;

		if (event.wheel !== null) {
			if (overPane) {
				this.#sidebarFocused = false;
				if (list) routeSettingsListPointer(list, event, bodyLine, paneCol);
				else this.#pluginComponent?.routeMouse(event, bodyLine, paneCol);
			}
			return true;
		}

		if (event.motion) {
			const hovered = overSidebar ? this.#tabBar.tabAt(bodyLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hovered && !hovered.muted ? hovered.id : null);
			if (!list) {
				if (overPane) this.#pluginComponent?.routeMouse(event, bodyLine, paneCol);
			} else if (list.hasOpenSubmenu()) {
				if (overPane) routeSettingsListPointer(list, event, bodyLine, paneCol);
			} else {
				list.setHoverItem(overPane ? (list.hoverTest(bodyLine, paneCol) ?? null) : null);
			}
			return true;
		}
		if (!event.leftClick) return true;

		if (overSidebar) {
			this.#cancelOpenSubmenu();
			const tab = this.#tabBar.tabAt(bodyLine, innerCol);
			if (tab) {
				this.#tabBar.selectTab(tab.id);
				this.#sidebarFocused = false;
			}
			return true;
		}
		if (!list) {
			if (overPane) this.#pluginComponent?.routeMouse(event, bodyLine, paneCol);
			return true;
		}
		if (list.hasOpenSubmenu()) {
			routeSettingsListPointer(list, event, bodyLine, paneCol);
			return true;
		}
		if (overPane && routeSettingsListPointer(list, event, bodyLine, paneCol)) {
			this.#sidebarFocused = false;
		}
		return true;
	}

	#startSearch(initialQuery: string): void {
		this.#rememberCurrentSelection();
		this.#sidebarFocused = false;
		this.#preSearchTabId = this.#currentTabId;
		this.#searchInput = new Input();
		this.#searchInput.prompt = "";
		this.#searchInput.setValue(initialQuery);
		const list = new SettingsList(
			[],
			10,
			getSettingsListTheme(),
			(id, newValue) => this.#onSearchSettingChange(id as SettingPath, newValue),
			() => this.#close(),
			{
				layout: "flat",
				typeToSearch: false,
				emptyText: "No matching settings",
				hint: "",
			},
		);
		list.setHoverMotion({
			requestRender: () => this.context.requestRender?.(),
			enabled: pointerMotionEnabled(),
		});
		list.onSelectionChange = item => this.#syncTabBarToSelection(item);
		this.#setContent(() => {
			this.#searchList = list;
		});
		this.#setSearchQuery(initialQuery);
	}

	#setSearchQuery(query: string): void {
		if (!this.#searchList) return;
		if (query.trim().length === 0) {
			this.#endSearch(false);
			return;
		}
		this.#searchQuery = query;

		const counts = new Map<SettingTab, number>();
		const items: SettingItem[] = [];
		const tabResults: { tab: SettingTab; matched: SettingItem[]; bestScore: number; order: number }[] = [];
		this.#searchFirstMatch.clear();
		let total = 0;
		for (const tab of SETTING_TABS) {
			const candidates: SettingItem[] = [];
			for (const def of getSettingsForTab(tab)) {
				const item = this.#defToItem(def);
				if (item) candidates.push(item);
			}
			const ranked = rankSettingItems(candidates, query);
			const matched = ranked.map(result => result.item);
			counts.set(tab, matched.length);
			if (matched.length === 0) continue;
			total += matched.length;
			tabResults.push({
				tab,
				matched,
				bestScore: ranked[0]?.score ?? 0,
				order: SETTING_TABS.indexOf(tab),
			});
		}

		tabResults.sort((a, b) => a.bestScore - b.bestScore || a.order - b.order);
		for (const result of tabResults) {
			const meta = TAB_METADATA[result.tab];
			items.push({
				id: `__tab:${result.tab}`,
				label: `${theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0])} ${meta.label}`,
				currentValue: "",
				heading: true,
			});
			this.#searchFirstMatch.set(result.tab, result.matched[0]?.id ?? "");
			for (const item of result.matched) items.push(item);
		}

		this.#searchMatchCount = total;
		const matchedOrder = tabResults.map(r => r.tab);
		this.#tabBar.setTabs(this.#buildSearchTabs(counts, matchedOrder));
		this.#searchList.setItems(items);
	}

	#endSearch(jumpToSelection: boolean): void {
		if (!this.#searchList) return;
		const selectedItem = jumpToSelection ? this.#searchList.getSelectedItem() : undefined;
		const selectedDef = selectedItem ? getSettingDef(selectedItem.id as SettingPath) : undefined;
		const targetTab = selectedDef ? selectedDef.tab : this.#preSearchTabId;

		if (selectedDef?.advanced && targetTab !== "plugins") {
			this.#showAdvanced.set(targetTab, true);
		}

		this.#searchQuery = "";
		this.#searchFirstMatch.clear();
		this.#searchMatchCount = 0;
		this.#tabBar.setTabs(getSettingsTabs(), targetTab);
		this.#switchToTab(targetTab);
		if (selectedDef) {
			const landOn = settingsSearchLandingPath(selectedDef.path);
			this.#currentList?.selectItem(landOn);
			this.#selectedSettingByTab.set(selectedDef.tab, landOn);
			if (isNestedLspKnob(selectedDef.path)) {
				this.#lspPanelFocusPath = selectedDef.path;
				this.#currentList?.activateSelected();
			}
		}
	}

	#buildSearchTabs(counts: Map<SettingTab, number>, matchedTabOrder: readonly SettingTab[]): Tab[] {
		const matched: Tab[] = [];
		const empty: Tab[] = [];
		const matchedIds = new Set<SettingTab>(matchedTabOrder);
		for (const id of matchedTabOrder) {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			const count = counts.get(id) ?? 0;
			if (count > 0) {
				matched.push({ id, label: `${icon} ${meta.label} (${count})`, short: `${icon} ${count}` });
			}
		}
		for (const id of SETTING_TABS) {
			if (matchedIds.has(id)) continue;
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			empty.push({ id, label: `${icon} ${meta.label}`, short: icon, muted: true });
		}
		empty.push({
			id: "plugins",
			label: withIcon(theme.icon.package, "Plugins"),
			short: theme.icon.package,
			muted: true,
		});
		return matched.concat(empty);
	}

	#syncTabBarToSelection(item: SettingItem | undefined): void {
		if (!this.#searchList || !item) return;
		const def = getSettingDef(item.id as SettingPath);
		if (def) this.#tabBar.setActiveById(def.tab);
	}

	#onSearchSettingChange(path: SettingPath, newValue: string): void {
		const def = getSettingDef(path);
		if (!def) return;
		if (def.type === "boolean") {
			const boolValue = newValue === "true";
			settings.set(path, boolValue as never);
			this.callbacks.onChange(path, boolValue);
		} else if (def.type === "enum") {
			settings.set(path, newValue as never);
			this.callbacks.onChange(path, newValue);
		}
		if (def.tab === "appearance") {
			this.#triggerStatusLinePreview();
		}
		this.#setSearchQuery(this.#searchQuery);
	}

	#defToItem(def: SettingDef): SettingItem | null {
		const item = this.#defToItemBase(def);
		if (!item) return null;
		const searchable = { ...item, group: def.group, keywords: def.keywords };
		if (def.type === "defaultModel") return searchable;

		const source = settings.getSource(def.path);
		if (source !== "config-file" && source !== "runtime") return searchable;
		const sourceLabel = SETTING_SOURCE_LABELS[source];
		const shownValue = searchable.labelForValue?.(searchable.currentValue) ?? searchable.currentValue;
		return {
			...searchable,
			readOnly: true,
			currentValue: `${sourceLabel} · ${shownValue}`,
			labelForValue: undefined,
			description: `${searchable.description ?? def.label}. Effective value comes from ${sourceLabel}; this profile control is read-only.`,
			values: undefined,
			submenu: undefined,
		};
	}

	#defToItemBase(def: SettingDef): SettingItem | null {
		if (def.condition && !def.condition()) {
			return null;
		}

		const currentValue = this.#getCurrentValue(def);
		const handler = handlerFor(def);
		if (!handler) {
			throw new Error(`Unhandled setting kind: ${def.type}`);
		}

		const changed = handler.isChanged
			? handler.isChanged(this, def, currentValue)
			: !Object.is(currentValue, getDefault(def.path));

		if (handler.buildItem) {
			return handler.buildItem(this, def, currentValue, changed);
		}

		const formattedValue = handler.formatValue
			? handler.formatValue(this, def, currentValue)
			: String(currentValue ?? "");
		const item: SettingItem = {
			id: def.path,
			label: def.label,
			description: def.description,
			currentValue: formattedValue,
			changed,
		};
		if (handler.labelForValue) {
			item.labelForValue = handler.labelForValue(this, def);
		}
		if (handler.createSubmenu) {
			item.submenu = (cv, done) => handler.createSubmenu!(this, def, cv, done);
		}
		return item;
	}

	#getCurrentValue(def: SettingDef): unknown {
		if (def.type === "defaultModel") return settings.getPersistedModelRole(DEFAULT_MODEL_SLOT);
		if (def.type === "advisorModel") return settings.getModelRole(ADVISOR_MODEL_SLOT);
		return settings.get(def.path);
	}

	getSubmenuCurrentValue(path: SettingPath, value: unknown): string {
		const rawValue = String(value ?? "");
		if (isUnsetNumberPath(path) && (value === undefined || rawValue === String(UNSET_NUMBER) || rawValue === "")) {
			return UNSET_NUMBER_OPTION_VALUE;
		}
		return rawValue;
	}

	createEnumSubmenu(
		def: SettingDef & { type: "enum" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		const options: SelectItem[] = def.values.map(value => ({ value, label: value }));
		return new SelectSubmenu(
			def.label,
			def.description,
			options,
			currentValue,
			value => done(value),
			() => done(),
		);
	}

	submenuOptions(def: SettingDef & { type: "submenu" }): OptionList {
		if (def.path === "theme.dark" || def.path === "theme.light") {
			return this.context.availableThemes.map(name => ({ value: name, label: name }));
		}
		if (def.path === "personality") {
			return [
				...this.context.availablePersonalities.map(name => ({
					value: name,
					label: name.charAt(0).toUpperCase() + name.slice(1),
					description: BUILTIN_PERSONALITY_DESCRIPTIONS[name],
				})),
				{ value: NONE_PERSONALITY, label: "None", description: "Omit the personality block entirely" },
			];
		}
		return def.options;
	}

	createSubmenu(
		def: SettingDef & { type: "submenu" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		const options = this.submenuOptions(def);
		const description = def.description;

		let onPreview: ((value: string) => void | Promise<void>) | undefined;
		let onPreviewCancel: (() => void) | undefined;
		const footer: Component | undefined = undefined;

		const activeThemeBeforePreview = getCurrentThemeName() ?? currentValue;
		if (def.path === "theme.dark" || def.path === "theme.light") {
			onPreview = value => this.callbacks.onThemePreview?.(value);
			onPreviewCancel = () => this.callbacks.onThemePreview?.(activeThemeBeforePreview);
		} else if (def.path === "statusLine.preset") {
			onPreview = value => {
				const presetDef = getPreset(
					value as "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom",
				);
				this.callbacks.onStatusLinePreview?.({
					preset: value as StatusLinePreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
				});
			};
			onPreviewCancel = () => {
				const currentPreset = settings.get("statusLine.preset");
				const presetDef = getPreset(currentPreset);
				this.callbacks.onStatusLinePreview?.({
					preset: currentPreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
				});
			};
		}

		const isThemeSetting = def.path === "theme.dark" || def.path === "theme.light";
		const getPreview = isThemeSetting ? this.callbacks.getStatusLinePreview : undefined;

		return new SelectSubmenu(
			def.label,
			description,
			options,
			currentValue,
			value => {
				this.#setSettingValue(def.path, value);
				this.callbacks.onChange(def.path, value);
				done(value);
			},
			() => {
				onPreviewCancel?.();
				done();
			},
			onPreview,
			getPreview,
			footer,
		);
	}

	createTextInput(
		def: SettingDef & { type: "text" },
		_currentValue: string,
		done: (value?: string) => void,
	): Container {
		this.#textInputActive = true;
		const wrappedDone = (value?: string) => {
			this.#textInputActive = false;
			done(value);
		};
		return new TextInputSubmenu(
			def.label,
			def.description,
			this.#formatTextInputEditValue(def.path, settings.get(def.path)),
			value => {
				this.#setSettingValue(def.path, value);
				this.callbacks.onChange(def.path, settings.get(def.path));
				wrappedDone(this.formatTextInputValue(def.path, settings.get(def.path)));
			},
			() => wrappedDone(),
		);
	}

	createProviderLimitsInput(done: (value?: string) => void): Container {
		return new ProviderLimitsSubmenu(
			this.context.providers,
			value => {
				this.callbacks.onChange("providers.maxInFlightRequests", value);
				done(this.formatProviderLimitsValue(value));
			},
			() => done(),
			this.context.requestRender,
		);
	}

	#requireModelPickerContext(): { registry: ModelRegistry; models: ReadonlyArray<Model> } | undefined {
		const registry = this.context.modelRegistry;
		const models = this.context.availableModels;
		if (!registry || !models) return undefined;
		return { registry, models };
	}

	formatModelSelectorValue(value: unknown): string {
		const selectors =
			typeof value === "string" || Array.isArray(value) ? normalizeModelPatternList(value as string | string[]) : [];
		const primary = selectors[0];
		if (!primary) return "inherit";
		const fallbacks = selectors.length - 1;
		return fallbacks > 0
			? `${formatSelectorSummary(primary)} +${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`
			: formatSelectorSummary(primary);
	}

	formatCompactModelSelectorValue(value: unknown): string {
		const summary = this.formatModelSelectorValue(value);
		const providerSlash = summary.indexOf("/");
		return providerSlash >= 0 ? summary.slice(providerSlash + 1) : summary;
	}

	formatModelRolesValue(): string {
		const roles = settings.getModelRoles();
		let assigned = 0;
		for (const role of SELECTABLE_MODEL_ROLE_IDS) {
			if (roles[role]?.trim()) assigned++;
		}
		if (assigned === 0) return "all inherit";
		return `${assigned} assigned`;
	}

	createModelSelectorInput(path: SettingPath, done: (value?: string) => void): Container {
		const ctx = this.#requireModelPickerContext();
		if (!ctx) return this.#modelPickerFallback(done);
		const current: unknown = settings.get(path);
		let rawCurrent: string | string[] | undefined;
		if (typeof current === "string") {
			rawCurrent = current;
		} else if (Array.isArray(current) && current.every(value => typeof value === "string")) {
			rawCurrent = current;
		}
		const label = path === "compaction.model" ? "Compaction Model" : String(path);
		return new ModelChainSubmenu(
			path,
			ctx.registry,
			ctx.models,
			label,
			rawCurrent,
			done,
			value => this.callbacks.onChange(path, value),
			this.context.requestRender,
		);
	}

	formatCompactionThresholdValue(): string {
		return formatThresholdShort(String(settings.get("compaction.threshold") ?? AUTO_COMPACTION_THRESHOLD));
	}

	createCompactionThresholdInput(
		def: SettingDef & { type: "compactionThreshold" },
		done: (value?: string) => void,
	): Container {
		return new CompactionThresholdSubmenu(
			def.options,
			() => {
				this.callbacks.onChange("compaction.threshold", settings.get("compaction.threshold"));
			},
			() => done(this.formatCompactionThresholdValue()),
			this.context.requestRender,
		);
	}

	formatDefaultEffortValue(): string {
		const rows = withLegacyDefaultEffort(
			settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
			settings.get("defaultThinkingLevel"),
		);
		const any = rows[ANY_MODEL_EFFORT_KEY];
		const perModel = Object.keys(rows).filter(key => key !== ANY_MODEL_EFFORT_KEY).length;
		const parts: string[] = [];
		parts.push(any ? `any model · ${any}` : "model defaults");
		if (perModel > 0) parts.push(`${perModel} model${perModel === 1 ? "" : "s"}`);
		return parts.join(", ");
	}

	createDefaultEffortInput(done: (value?: string) => void): Container {
		const ctx = this.#requireModelPickerContext();
		if (!ctx) return this.#modelPickerFallback(done);
		return new DefaultEffortSubmenu(
			ctx.models,
			ctx.registry,
			() => {
				this.callbacks.onChange("defaultEffort", settings.get("defaultEffort"));
			},
			() => done(this.formatDefaultEffortValue()),
			this.context.requestRender,
		);
	}

	formatSubagentSharedEffortValue(): string {
		const stored: unknown = settings.get("subagent.thinkingLevel");
		const level = typeof stored === "string" ? stored.trim() : "";
		return level.length > 0 ? level : "Inherit";
	}

	createSubagentSharedEffortInput(done: (value?: string) => void): Container {
		const chain: unknown = settings.get("subagent.model");
		const head = Array.isArray(chain) ? chain.find((entry): entry is string => typeof entry === "string") : chain;
		const scope = effortScopeForPattern(
			this.context.availableModels,
			typeof head === "string" && head.trim().length > 0 ? head : undefined,
			this.context.model,
		);
		const { options, notice } = subagentEffortOptions(scope, this.context.availableModels);
		const stored: unknown = settings.get("subagent.thinkingLevel");
		return new SelectSubmenu(
			"Shared Effort",
			notice === undefined
				? "The effort every subagent runs at. A `:level` on the model chain still wins."
				: `The effort every subagent runs at. ${notice}`,
			options,
			typeof stored === "string" ? stored.trim() : "",
			value => {
				if (value === INHERIT_EFFORT_OPTION_VALUE) settings.set("subagent.thinkingLevel", undefined);
				else settings.set("subagent.thinkingLevel", value);
				this.callbacks.onChange("subagent.thinkingLevel", settings.get("subagent.thinkingLevel"));
				done(this.formatSubagentSharedEffortValue());
			},
			() => done(this.formatSubagentSharedEffortValue()),
		);
	}

	formatSubagentAgentsValue(): string {
		const stored = settings.get("subagent.agents");
		const table = stored && typeof stored === "object" ? (stored as Record<string, SubagentAgentSettings>) : {};
		const rows = Object.values(table);
		if (rows.length === 0) return "defaults";
		const blocked = rows.filter(row => row?.enabled === false).length;
		const parts = [`${rows.length} configured`];
		if (blocked > 0) parts.push(`${blocked} blocked`);
		return parts.join(", ");
	}

	createSubagentAgentsInput(done: (value?: string) => void): Container {
		return new SubagentAgentsSubmenu(
			this.context.cwd,
			this.context.model,
			this.context.availableModels,
			this.#requireModelPickerContext(),
			path => {
				this.callbacks.onChange(path, settings.get(path));
			},
			() => done(this.formatSubagentAgentsValue()),
			this.context.requestRender,
		);
	}

	formatRulesValue(): string {
		const stored = settings.get("ttsr.disabledRules");
		const off = Array.isArray(stored) ? stored.filter(name => String(name).trim().length > 0).length : 0;
		const enabledRaw = settings.get("ttsr.experimentalRules");
		const experiments = Array.isArray(enabledRaw)
			? enabledRaw.filter(name => String(name).trim().length > 0).length
			: 0;
		const experimentSuffix = experiments === 0 ? "" : `, ${experiments} experimental on`;
		if (settings.get("ttsr.builtinRules") !== true) {
			return (off === 0 ? "built-ins off" : `built-ins off, ${off} more off`) + experimentSuffix;
		}
		if (off === 0) return experiments === 0 ? "all on" : `all on${experimentSuffix}`;
		return `${off} off${experimentSuffix}`;
	}

	createRulesInput(done: (value?: string) => void): Container {
		return new RulesSubmenu(
			this.context.cwd,
			() => {
				this.callbacks.onChange("ttsr.disabledRules", settings.get("ttsr.disabledRules"));
			},
			() => done(this.formatRulesValue()),
			this.context.requestRender,
		);
	}

	createLspInput(done: (value?: string) => void): Container {
		const focus = this.#lspPanelFocusPath;
		this.#lspPanelFocusPath = undefined;
		return new LspSubmenu(
			(path, value) => this.callbacks.onChange(path, value),
			() => done(formatLspSummary()),
			this.context.requestRender,
			focus,
		);
	}

	#modelPickerFallback(done: (value?: string) => void): Container {
		class FallbackContainer extends Container {
			handleInput(data: string): void {
				if (matchesKey(data, "escape") || data === "\x1b") done();
			}
		}
		const fallback = new FallbackContainer();
		fallback.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
		fallback.addChild(new Spacer(1));
		fallback.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
		return fallback;
	}

	#createRoleModelInput(
		role: string | undefined,
		settingId: SettingPath | undefined,
		formatDone: () => string,
		done: (value?: string) => void,
	): Container {
		const ctx = this.#requireModelPickerContext();
		if (!ctx) return this.#modelPickerFallback(done);
		return new ModelRolesSubmenu(
			ctx.models,
			ctx.registry,
			() => {
				if (settingId) {
					this.callbacks.onChange(
						settingId,
						(isDefaultModelSlot(role ?? "")
							? settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)
							: settings.getModelRole(role!)) ?? "",
					);
				} else {
					this.callbacks.onChange("modelRoles", settings.getModelRoles());
				}
			},
			() => done(formatDone()),
			this.context.requestRender,
			role,
		);
	}

	createModelRolesInput(done: (value?: string) => void): Container {
		return this.#createRoleModelInput(undefined, undefined, () => this.formatModelRolesValue(), done);
	}

	createAdvisorModelInput(done: (value?: string) => void): Container {
		return this.#createRoleModelInput(
			ADVISOR_MODEL_SLOT,
			ADVISOR_MODEL_SETTING_ID,
			() => this.formatModelSelectorValue(settings.getModelRole(ADVISOR_MODEL_SLOT)),
			done,
		);
	}

	createDefaultModelInput(done: (value?: string) => void): Container {
		return this.#createRoleModelInput(
			DEFAULT_MODEL_SLOT,
			DEFAULT_MODEL_SETTING_ID as SettingPath,
			() => this.formatModelSelectorValue(settings.getModelRole(DEFAULT_MODEL_SLOT)),
			done,
		);
	}

	formatProviderLimitsValue(value: unknown): string {
		const limits = normalizeProviderMaxInFlightRequests(value);
		const entries = Object.entries(limits).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return "Unlimited";
		return entries.map(([provider, limit]) => `${provider}: ${limit}`).join(", ");
	}

	formatTextInputValue(path: SettingPath, value: unknown): string {
		if (path === "providers.maxInFlightRequests") return this.formatProviderLimitsValue(value);
		return this.#formatTextInputEditValue(path, value);
	}

	#formatTextInputEditValue(_path: SettingPath, value: unknown): string {
		if (value === undefined || value === null) return "";
		if (Array.isArray(value)) {
			return value.every(item => typeof item === "string") ? value.join(", ") : JSON.stringify(value);
		}
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	#setSettingValue(path: SettingPath, value: string): void {
		const currentValue = settings.get(path);
		const schemaType = getType(path);
		if (isUnsetNumberPath(path) && value === UNSET_NUMBER_OPTION_VALUE) {
			settings.unset(path);
		} else if (schemaType === "record") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value || "{}");
			} catch {
				throw new Error(`Invalid record JSON for ${path}`);
			}
			if (!isRecord(parsed)) {
				throw new Error(`Invalid record JSON for ${path}`);
			}
			if (path === "providers.maxInFlightRequests") {
				parsed = validateProviderMaxInFlightRequests(parsed);
			}
			settings.set(path, parsed as never);
		} else if (schemaType === "array") {
			const trimmed = value.trim();
			let arr: unknown[];
			if (trimmed === "") {
				arr = [];
			} else if (trimmed.startsWith("[")) {
				let json: unknown;
				try {
					json = JSON.parse(trimmed);
				} catch {
					throw new Error(`Invalid JSON array for ${path}`);
				}
				if (!Array.isArray(json)) throw new Error(`Expected a JSON array for ${path}`);
				arr = json;
			} else {
				arr = trimmed
					.split(",")
					.map(entry => entry.trim())
					.filter(entry => entry.length > 0);
			}
			settings.set(path, arr as never);
		} else if (schemaType === "number") {
			const next = parseNumberSetting(path, value);
			if (next === UNSET_NUMBER_INPUT) settings.unset(path);
			else settings.set(path, next as never);
		} else if (typeof currentValue === "boolean") {
			settings.set(path, (value === "true") as never);
		} else {
			settings.set(path, value as never);
		}
	}

	#showSettingsTab(tabId: SettingTab): void {
		const defs = getSettingsForTab(tabId);
		const items = this.#buildItemsForDefs(defs, tabId);

		this.#currentList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				if (isAdvancedToggleId(id)) {
					this.#toggleAdvanced(tabId);
					this.#refreshCurrentTabItems(defs);
					return;
				}

				const def = defs.find(d => d.path === id);
				if (!def) return;

				const path = def.path;

				if (def.type === "boolean") {
					const boolValue = newValue === "true";
					settings.set(path, boolValue as never);
					this.callbacks.onChange(path, boolValue);

					if (tabId === "appearance") {
						this.#triggerStatusLinePreview();
					}
				} else if (def.type === "enum") {
					settings.set(path, newValue as never);
					this.callbacks.onChange(path, newValue);
				}
				this.#refreshCurrentTabItems(defs);
			},
			() => this.#close(),
			{ typeToSearch: false, hint: "", layout: "flat", descriptionMode: "expand", expandedIds: this.#expandedIds },
		);
		this.#currentList.setHoverMotion({
			requestRender: () => this.context.requestRender?.(),
			enabled: pointerMotionEnabled(),
		});
	}

	#isAdvancedExpanded(tab: SettingTab): boolean {
		return this.#showAdvanced.get(tab) === true;
	}

	#toggleAdvanced(tab: SettingTab): void {
		this.#showAdvanced.set(tab, !this.#isAdvancedExpanded(tab));
	}

	#buildItemsForDefs(defs: SettingDef[], tabId: SettingTab): SettingItem[] {
		const items: SettingItem[] = [];
		const advancedItems: Array<{ group: string | undefined; item: SettingItem }> = [];
		let lastGroup: string | undefined;
		let advancedTotal = 0;
		if (tabId === "resources") items.push(MACHINE_LIMITS_POINTER_ROW);
		for (const def of defs) {
			if (isNestedLspKnob(def.path)) continue;
			const item = this.#defToItem(def);
			if (!item) continue;
			if (def.advanced) {
				advancedTotal++;
				advancedItems.push({ group: def.group, item });
				continue;
			}
			if (def.group && def.group !== lastGroup) {
				items.push({ id: `__heading:${def.group}`, label: def.group, currentValue: "", heading: true });
				lastGroup = def.group;
			}
			items.push(item);
			const rollbackRow = this.#rollbackRow(def);
			if (rollbackRow) items.push(rollbackRow);
		}

		if (advancedTotal > 0) {
			const expanded = this.#isAdvancedExpanded(tabId);
			const arrow = expanded ? theme.nav.collapse : theme.nav.expand;
			items.push({
				id: advancedToggleId(tabId),
				label: `${arrow} Advanced (${advancedTotal})`,
				currentValue: "",
				values: ["toggle"],
			});
			let lastAdvancedGroup: string | undefined;
			for (const { group, item } of advancedItems) {
				if (!expanded && !item.changed) continue;
				if (group && group !== lastAdvancedGroup) {
					items.push({
						id: `__heading:advanced:${group}`,
						label: `Advanced · ${group}`,
						currentValue: "",
						heading: true,
					});
					lastAdvancedGroup = group;
				}
				items.push(item);
			}
		}

		return items;
	}

	#rollbackRow(def: SettingDef): SettingItem | null {
		if (def.path !== "startup.autoUpdate") return null;
		const rollback = this.callbacks.onRollback;
		if (!rollback) return null;
		return {
			id: ROLLBACK_ROW_ID,
			label: "Roll back version",
			description: "Move this install to another published version. Takes effect on restart.",
			currentValue: VERSION,
			group: def.group,
			keywords: ["downgrade", "revert", "version", "previous", "older"],
			submenu: (_cv, done) =>
				new RollbackPanelComponent({
					currentVersion: VERSION,
					openUrl: url => this.callbacks.onOpenUrl?.(url),
					rollback,
					reportError: message => this.callbacks.onError?.(message),
					requestRender: () => this.context.requestRender?.(),
					done: () => done(),
				}),
		};
	}

	#refreshCurrentTabItems(defs: SettingDef[]): void {
		const tabId = this.#currentTabId;
		if (tabId === "plugins" || !this.#currentList) return;
		this.#currentList.setItems(this.#buildItemsForDefs(defs, tabId));
	}

	#getStatusPreviewString(width?: number): string {
		if (this.callbacks.getStatusLinePreview) {
			return this.callbacks.getStatusLinePreview(width);
		}
		return theme.fg("dim", "(preview not available)");
	}

	#triggerStatusLinePreview(): void {
		const statusLineSettings: StatusLinePreviewSettings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			sessionAccent: settings.get("statusLine.sessionAccent"),
		};
		this.callbacks.onStatusLinePreview?.(statusLineSettings);
	}

	#showPluginsTab(): void {
		this.#pluginComponent = new PluginSettingsComponent(this.context.cwd, {
			onClose: () => this.#close(),
			onPluginChanged: () => this.callbacks.onPluginsChanged?.(),
		});
	}

	#stepCategory(delta: -1 | 1): void {
		const tabs = getSettingsTabs();
		const index = tabs.findIndex(tab => tab.id === this.#tabBar.getActiveTab().id);
		if (index === -1) return;
		const next = Math.min(tabs.length - 1, Math.max(0, index + delta));
		const target = tabs[next];
		if (next !== index && target) this.#tabBar.selectTab(target.id);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		if (this.#viewportTooSmall) {
			if (matchesKey(data, "escape") || data === "\x1b") this.#close();
			return;
		}

		if (this.#textInputActive) {
			(this.#searchList ?? this.#currentList)?.handleInput(data);
			return;
		}

		const activeList = this.#searchList ?? this.#currentList;

		if (activeList?.hasOpenSubmenu()) {
			activeList.handleInput(data);
			return;
		}

		if (this.#searchList) {
			this.#handleSearchModeInput(data, this.#searchList);
			return;
		}

		if (this.#sidebarFocused) {
			if (matchesKey(data, "up")) {
				this.#stepCategory(-1);
				return;
			}
			if (matchesKey(data, "down")) {
				this.#stepCategory(1);
				return;
			}
			if (
				matchesKey(data, "right") ||
				getKeybindings().matches(data, "tui.select.confirm") ||
				matchesKey(data, "tab")
			) {
				this.#sidebarFocused = false;
				return;
			}
			if (matchesKey(data, "escape") || data === "\x1b") {
				this.#close();
				return;
			}
			const printable = extractPrintableText(data);
			if (printable !== undefined && printable.trim().length > 0) {
				this.#startSearch(printable);
				return;
			}
			return;
		}

		if (matchesKey(data, "left")) {
			this.#sidebarFocused = true;
			return;
		}

		if (matchesKey(data, "tab")) {
			this.#tabBar.nextTab();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.#tabBar.prevTab();
			return;
		}

		if (this.#currentTabId === "plugins" && this.#pluginComponent) {
			this.#pluginComponent.handleInput(data);
			return;
		}

		if (this.#currentList) {
			const selected = this.#currentList.getSelectedItem();
			if (selected?.id && selected.description && (matchesKey(data, "right") || data === "l")) {
				if (this.#expandedIds.has(selected.id)) {
					this.#expandedIds.delete(selected.id);
				} else {
					this.#expandedIds.add(selected.id);
				}
				this.#currentList.setOptions({ expandedIds: this.#expandedIds });
				return;
			}
		}

		if (this.#currentTabId !== "plugins") {
			const printable = extractPrintableText(data);
			if (printable !== undefined && printable.trim().length > 0) {
				this.#startSearch(printable);
				return;
			}
		}

		this.#currentList?.handleInput(data);
	}

	#handleSearchModeInput(data: string, list: SettingsList): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.#endSearch(true);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#tabBar.handleInput(data);
			return;
		}
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.select.pageDown") ||
			kb.matches(data, "tui.select.confirm") ||
			data === "\n"
		) {
			list.handleInput(data);
			return;
		}
		this.#searchInput.handleInput(data);
		const value = this.#searchInput.getValue();
		if (value !== this.#searchQuery) this.#setSearchQuery(value);
	}
}
