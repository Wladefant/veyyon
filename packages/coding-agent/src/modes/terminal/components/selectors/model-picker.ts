/**
 * Compact session-model picker (alt+p / `/switch`): a floating ModalShell
 * hosting just a {@link ModelBrowser} — no provider sidebar.
 * Model entries switch the current session only.
 */
import type { Model } from "@veyyon/ai";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import type { Component, TUI } from "@veyyon/tui";
import { errorMessage } from "@veyyon/utils";
import { matchesKey } from "@veyyon/utils/keys";
import { routeSgrMouseInput, type SgrMouseEvent } from "@veyyon/utils/mouse";
import { truncateToWidth } from "@veyyon/utils/width";
import type { ModelRegistry } from "../../../../config/model-registry";
import type { Settings } from "../../../../config/settings";
import { theme } from "../../../../theme/theme-binding";
import { emptyModalArea, layoutModalCard, MODAL_SIZING_MEDIUM } from "../chrome/modal-geometry";
import {
	type ModalShellGeometry,
	planModalChrome,
	pointerMotionEnabled,
	renderModalShell,
} from "../chrome/modal-shell";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	resolveDefaultModelAssignment,
	sortModelItems,
} from "./model-browser";
import type { ScopedModelItem } from "./model-hub";
import { routeModalChrome } from "./select-list-mouse-routing";

export interface ModelPickerCallbacks {
	/** A model was chosen for a session-only switch. `selector` is `provider/id`. */
	onPick: (model: Model, selector: string) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

export interface ModelPickerOptions {
	/** Session token count; models with smaller context windows are disabled. */
	currentContextTokens?: number;
	/** `provider/id` of the session's active model; highlighted and preselected. */
	currentSelector?: string;
	/** Search text the picker opens with, so `/model <query>` lands on the models it names. */
	initialQuery?: string;
}

/** Rows the browser renders around its list window (search + blank, blank + two detail rows). */
const BROWSER_FRAME_ROWS = 5;
/** List rows the picker asks the card for on a short terminal; it sheds its padding before it shows fewer. */
const MIN_VISIBLE = 5;

const STATUS_HINT = "Interactive model — role / agent / compaction slots stay unchanged";
/**
 * The list is only ever as new as the cached catalog. Opening the picker calls
 * `refresh("online-if-uncached")`, which answers from a cache that stays fresh
 * for two hours, so a model a provider shipped this morning is simply absent
 * with nothing on screen saying why. This names the way to look again.
 *
 * The medium card is narrow, and truncating this mid-word ("…from yo…") loses
 * the only part that matters, so it degrades to a shorter whole sentence
 * rather than a clipped long one. The key is in both, since that is the
 * actionable half.
 */
const REFRESH_HINT = "Don't see a model? ctrl+r reloads the catalog from your providers and models.dev";
const REFRESH_HINT_SHORT = "Don't see a model? ctrl+r reloads the catalog";
const REFRESHING_HINT = "Reloading the model catalog…";

/**
 * The alt+p picker. Hosted fullscreen; ModalShell paints a floating medium card
 * with clear underpaint so the transcript stays visible around it.
 */
export class ModelPickerComponent implements Component {
	#tui: TUI;
	#settings: Settings;
	#registry: ModelRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#browser: ModelBrowser;
	#configError: string | undefined;
	#currentSelector: string | undefined;
	#modelItems: ModelBrowserItem[] = [];
	#shellGeometry: ModalShellGeometry | null = null;
	/** Frame row where the browser's first rendered row (its search row) sits. */
	#browserRowStart = 0;
	#hoveredShortcutId: string | null = null;
	#refreshing = false;
	#onCancel: () => void;

	constructor(
		tui: TUI,
		settings: Settings,
		registry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelPickerCallbacks,
		options: ModelPickerOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#currentSelector = options.currentSelector;
		this.#onCancel = callbacks.onCancel;

		this.#browser = new ModelBrowser({
			currentContextTokens: options.currentContextTokens,
			disableOverContext: true,
		});
		this.#browser.onActivate = item => {
			callbacks.onPick(item.model, item.selector);
		};
		this.#browser.onCancel = () => callbacks.onCancel();
		this.#browser.onQueryChange = () => this.#tui.requestRender();
		// The browser paints inside this card's frame and owns no repaint, so its band fades on the
		// card's clock or not at all. Same ambient gate as the open unfold.
		this.#browser.setHoverMotion({
			requestRender: () => this.#tui.requestRender(),
			enabled: pointerMotionEnabled(),
		});

		this.#syncFromRegistryState();
		if (options.initialQuery) {
			this.#browser.setQuery(options.initialQuery);
		}
		if (options.currentSelector) {
			this.#browser.selectSelector(options.currentSelector);
		}

		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = errorMessage(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	/** Settle the browser's pointer band so no timer outlives a dismissed picker. */
	dispose(): void {
		this.#browser.disposeHoverMotion();
	}

	invalidate(): void {}

	#syncFromRegistryState(): void {
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
			this.#configError = undefined;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? errorMessage(loadError) : undefined;
			try {
				models = this.#registry.getAvailable();
			} catch (error) {
				this.#configError = errorMessage(error);
				models = [];
			}
		}

		// The default ranks and marks a listed row, so it resolves against the listed models: the set a
		// session started now resolves `defaultModel` against. The whole catalog is every provider's
		// build, which was most of the picker's first open, and could resolve the default to a model
		// the list does not hold while startup picks a listed one.
		const defaultModel = resolveDefaultModelAssignment(this.#settings, models);
		const storage = AgentStorage.forAgentDir(this.#settings.getAgentDir());
		const mruOrder = storage?.getModelUsageOrder() ?? [];
		this.#modelItems = buildBrowserItems(models);
		sortModelItems(this.#modelItems, { defaultModel, mruOrder });
		this.#browser.setDefaultModel(defaultModel);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(storage?.getModelPerf() ?? new Map());
		this.#browser.setCurrentSelector(this.#currentSelector);
		this.#browser.setItems(this.#modelItems);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}
		// Ahead of the browser, which takes every key it does not claim as query text.
		if (matchesKey(data, "ctrl+r")) {
			this.#refreshCatalog();
			return;
		}
		this.#browser.handleInput(data);
	}

	/**
	 * Re-fetch every provider past the cache TTL. This is the only strategy that
	 * ignores a fresh cache, so it is the difference between "the catalog I was
	 * handed at startup" and "what the providers and models.dev serve now".
	 */
	#refreshCatalog(): void {
		if (this.#refreshing) return;
		this.#refreshing = true;
		this.#configError = undefined;
		this.#tui.requestRender();
		this.#registry
			.refresh("online")
			.then(() => this.#syncFromRegistryState())
			.catch(error => {
				this.#configError = errorMessage(error);
			})
			.finally(() => {
				this.#refreshing = false;
				this.#tui.requestRender();
			});
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const consumed = routeModalChrome({
			shellGeometry: this.#shellGeometry,
			event,
			hoveredShortcutId: this.#hoveredShortcutId,
			onHoverShortcut: id => {
				this.#hoveredShortcutId = id;
				this.#tui.requestRender();
			},
			// The [x] and an outside click are hard closes regardless of query.
			onCancel: () => this.#onCancel(),
			// The esc chip performs exactly what its label promises: the same
			// cancel ladder as the esc key (clear a live query, then close).
			onCloseChip: () => this.#browser.handleCancel(),
			onConfirm: () => this.#browser.handleInput("\n"),
			onShortcut: id => {
				if (id !== "refresh") return false;
				this.#refreshCatalog();
				return true;
			},
		});
		if (consumed) return true;
		// The body is [status, ...browser, hint]: the browser owns the rows
		// between the status line and the trailing hint.
		const line = event.row - this.#browserRowStart;
		if (event.wheel !== null || event.motion || event.leftClick) {
			this.#browser.routeMouse(event, line);
			this.#tui.requestRender();
			return true;
		}
		return true;
	}

	render(width: number): string[] {
		const termRows = this.#tui.terminal?.rows || process.stdout.rows || 40;
		const dims = layoutModalCard(width, termRows, MODAL_SIZING_MEDIUM);
		if (!dims) {
			this.#shellGeometry = null;
			return emptyModalArea(width, termRows);
		}

		const shortcuts = [
			{ label: "up/down models" },
			{ label: "enter use", clickable: true, id: "confirm" },
			{ label: "type to search" },
			{ label: "ctrl+r refresh", clickable: true, id: "refresh" },
			// The esc chip mirrors the browser's cancel ladder: with a live
			// query esc clears the search (close comes on the next press), so
			// the chip must not advertise "close" it will not perform.
			{ label: this.#browser.query.length > 0 ? "esc clear" : "esc close", clickable: true, id: "close" },
		];
		// The body is the status line, the browser, and the refresh hint, so the
		// list gets whatever the card shows minus those. The old `- 8` was right
		// only by accident: the shell reserves 7 at this sizing and the status
		// line was the eighth, three unnamed rows that happened to add up. Change
		// `vPad`, `footerLines`, either bracketing line, or the browser frame and
		// it silently starts dropping the bottom of the list.
		const chrome = planModalChrome(dims, {
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			minBodyRows: 2 + BROWSER_FRAME_ROWS + MIN_VISIBLE,
		});
		// A card too short for both bracketing lines around one list row drops the
		// refresh hint (the ctrl+r chip says the same), then the status line.
		const spareRows = chrome.maxBodyRows - BROWSER_FRAME_ROWS - 1;
		const showStatus = spareRows >= 1;
		const showHint = spareRows >= 2;
		const listBudget = Math.max(1, chrome.maxBodyRows - BROWSER_FRAME_ROWS - Number(showStatus) - Number(showHint));
		this.#browser.setMaxVisible(listBudget);

		const body: string[] = [];
		if (showStatus) {
			body.push(
				this.#configError
					? theme.fg("error", this.#configError)
					: theme.fg("muted", this.#refreshing ? REFRESHING_HINT : STATUS_HINT),
			);
		}
		body.push(...this.#browser.render(dims.contentWidth));
		if (showHint) {
			const hint = REFRESH_HINT.length <= dims.contentWidth ? REFRESH_HINT : REFRESH_HINT_SHORT;
			body.push(theme.fg("muted", truncateToWidth(hint, dims.contentWidth)));
		}
		const shell = renderModalShell(chrome, {
			title: "Switch Model",
			body,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		// The browser starts below the status line when the card shows one.
		this.#browserRowStart = shell.geometry.bodyRowStart + Number(showStatus);
		return shell.lines;
	}
}
