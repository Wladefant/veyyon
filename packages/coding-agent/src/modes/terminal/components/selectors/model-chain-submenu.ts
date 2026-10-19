/**
 * The ordered model-chain picker for a model settings slot (`agent.model`, `compaction.model`, a
 * per-agent lane), and the selector helpers it edits a chain with.
 */
import type { Api, Model } from "@veyyon/ai";
import type { SelectItem, SelectList } from "@veyyon/tui";
import { normalizeModelPatternList } from "../../../../config/model-pattern-list";
import type { ModelRegistry } from "../../../../config/model-registry";
import { resolveModelSelectorValue } from "../../../../config/model-resolver";
import { settings } from "../../../../config/settings";
import type { SettingPath } from "../../../../config/settings-schema";
import { hasConfigurableThinkingEffort } from "../../../../thinking";
import { formatSelectorSummary, renderEffortStep } from "./effort-picker";
import type { ModelSelectorPanel } from "./model-selector";
import { MouseRoutedSubmenu } from "./select-list-mouse-routing";
import {
	createFocusedSelectList,
	handleRowDeleteKey,
	renderModelSelectorPanel,
	selectListOrModelPickerTarget,
} from "./settings-submenus";

export function barePickerSelector(raw: string | undefined, models: ReadonlyArray<Model<Api>>): string | undefined {
	if (!raw) return undefined;
	const resolved = resolveModelSelectorValue(raw, models).model;
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

const CHAIN_ENTRY_PREFIX = "\u0000chain-entry:";

const CHAIN_ADD_ROW = "\u0000chain-add-row";

const CHAIN_CLEAR_ROW = "\u0000chain-clear-row";

/**
 * Where a chain the picker edits actually lives, when it is not a settings key.
 *
 * `agent.model` and `compaction.model` are keys, and `settings.set` addresses
 * them directly. A per-agent lane is a field inside the `agent.agents`
 * record, whose owner rebuilds and prunes the whole chain of lanes above it on
 * every write, so the picker hands the value over instead of storing it: two
 * writers for one record is how an empty lane comes to persist as `{}` and read
 * as configuration nobody entered.
 */
export interface ModelChainSlot {
	write: (chain: string[] | undefined) => void;
}

/**
 * Ordered-chain picker for a model settings slot (`compaction.model`,
 * `agent.model`).
 *
 * Both slots have always accepted a CHAIN rather than one model: the stored
 * value goes through {@link normalizeModelPatternList}, which splits on commas,
 * and each consumer tries the entries in order until one works (compaction skips
 * a candidate that is unauthenticated or whose window is too small; an agent
 * retries on the next entry when its model errors). Only the picker was
 * single-slot, so the feature existed and was unreachable.
 *
 * The list is the chain, in order. Entry one is the choice; the rest are
 * fallbacks. Adding an entry runs the same two steps as before, pick a model
 * then pick a thinking effort, and the effort rides the stored selector as a
 * `:level` suffix (via {@link renderEffortStep}), which is the encoding the
 * compaction candidate resolver and the agent spawner already parse back out.
 * Models with no supported efforts skip the second step and store the bare
 * selector.
 *
 * Persisted as a string array so the ordered choices survive YAML save/reload
 * without being reparsed from a display-oriented comma string.
 */
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
		public requestRender?: () => void,
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

		const selectList = createFocusedSelectList(items, items.length, undefined, {
			onSelect: item => {
				if (item.value === CHAIN_ADD_ROW) this.#showModelPicker(null);
				else if (item.value === CHAIN_CLEAR_ROW) this.#clear();
				else this.#showModelPicker(Number(item.value.slice(CHAIN_ENTRY_PREFIX.length)));
				this.requestRender?.();
			},
			onCancel: () => this.done(this.#chain.join(",")),
		});
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
		this.#removeIndex(Number(value.slice(CHAIN_ENTRY_PREFIX.length)));
	}

	#removeIndex(index: number | null): boolean {
		if (index !== null && Number.isInteger(index) && index >= 0 && index < this.#chain.length) {
			this.#chain.splice(index, 1);
			this.#persistChain();
			return true;
		}
		return false;
	}

	#showModelPicker(index: number | null): void {
		this.#selectList = undefined;
		const current = index === null ? undefined : this.#chain[index];
		const position =
			index === 0 ? "first choice" : index === null ? `fallback ${this.#chain.length + 1}` : `fallback ${index + 1}`;
		renderModelSelectorPanel(
			this,
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
		if (this.#removeIndex(index)) return;
		if (this.#chain.length === 0) {
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
		return selectListOrModelPickerTarget(this.#selectList, this);
	}

	override handleInput(data: string): void {
		if (handleRowDeleteKey(data, this.#selectList, () => this.#removeSelectedRow())) return;
		super.handleInput(data);
	}
}
