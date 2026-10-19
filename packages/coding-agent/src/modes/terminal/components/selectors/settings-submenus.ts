/**
 * Pieces the settings card's submenus share: the focused select list, the row delete key, the
 * model-picker panel and status frame, the model-chain summary, and the plain select submenu.
 */
import type { Model } from "@veyyon/ai";
import { type Component, Container, type SelectItem, SelectList, Text } from "@veyyon/tui";
import { clamp, formatCount } from "@veyyon/utils";
import { matchesKey } from "@veyyon/utils/keys";
import type { ModelRegistry } from "../../../../config/model-registry";
import { getSelectListTheme, theme } from "../../../../theme/theme";
import { pointerMotionEnabled } from "../chrome/modal-shell";
import { formatSelectorSummary } from "./effort-picker";
import { ModelSelectorPanel } from "./model-selector";
import { MouseRoutedSubmenu } from "./select-list-mouse-routing";

export const MODEL_CATALOG_UNAVAILABLE = "Model catalog unavailable in this context";

export function formatModelSummaryWithFallbacks(primarySelector: string, fallbackCount: number, dim = false): string {
	const summary = formatSelectorSummary(primarySelector);
	if (fallbackCount <= 0) return summary;
	const text = `+${formatCount("fallback", fallbackCount)}`;
	return `${summary} ${dim ? theme.fg("dim", text) : text}`;
}

export function selectListOrModelPickerTarget(
	selectList: SelectList | undefined,
	container: Container,
): SelectList | ModelSelectorPanel | undefined {
	return (
		selectList ?? container.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel)
	);
}

export function createFocusedSelectList(
	items: ReadonlyArray<SelectItem>,
	visibleRows: number,
	focusedValue?: string,
	options?: {
		onSelect?: (item: SelectItem) => void;
		onCancel?: () => void;
		onSelectionChange?: (item: SelectItem) => void;
		minPrimaryColumnWidth?: number;
		maxPrimaryColumnWidth?: number;
	},
): SelectList {
	const columnWidths =
		options?.minPrimaryColumnWidth !== undefined || options?.maxPrimaryColumnWidth !== undefined
			? {
					minPrimaryColumnWidth: options.minPrimaryColumnWidth,
					maxPrimaryColumnWidth: options.maxPrimaryColumnWidth,
				}
			: undefined;
	const list = new SelectList(items, clamp(visibleRows, 1, 12), getSelectListTheme(), columnWidths);
	if (focusedValue !== undefined) {
		const index = items.findIndex(item => item.value === focusedValue);
		if (index >= 0) list.setSelectedIndex(index);
	}
	if (options?.onSelect) list.onSelect = options.onSelect;
	if (options?.onCancel) list.onCancel = options.onCancel;
	if (options?.onSelectionChange) list.onSelectionChange = options.onSelectionChange;
	return list;
}

export function handleRowDeleteKey(data: string, list: SelectList | undefined, onRemove: () => void): boolean {
	if (list && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
		onRemove();
		return true;
	}
	return false;
}

export function renderAsyncStatusFrame(
	submenu: MouseRoutedSubmenu,
	title: string,
	description: string,
	loaded: boolean,
	loadError: string | undefined,
	loadingText: string,
	errorPrefix: string,
): boolean {
	if (loadError) {
		const container = new Container();
		container.addChild(new Text(theme.fg("error", `  ${errorPrefix}: ${loadError}`), 0, 0));
		submenu.renderSubmenuFrame({ title, description, body: container, footerHint: "  Esc to go back" });
		return true;
	}
	if (!loaded) {
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", `  ${loadingText}`), 0, 0));
		submenu.renderSubmenuFrame({ title, description, body: container });
		return true;
	}
	return false;
}

export function renderModelSelectorPanel(
	container: MouseRoutedSubmenu & { requestRender?: () => void },
	registry: ModelRegistry,
	models: ReadonlyArray<Model>,
	options: ConstructorParameters<typeof ModelSelectorPanel>[2],
	callbacks: ConstructorParameters<typeof ModelSelectorPanel>[3],
): void {
	container.clear();
	const panel = new ModelSelectorPanel(registry, models, options, callbacks);
	panel.setHoverMotion({
		requestRender: () => container.requestRender?.(),
		enabled: pointerMotionEnabled(),
	});
	container.addChild(panel);
}

export class SelectSubmenu extends MouseRoutedSubmenu {
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
		const selectList = createFocusedSelectList(options, Math.min(options.length, 10), currentValue, {
			onSelect: item => onSelect(item.value),
			onCancel,
		});

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

export function marker(active: boolean): string {
	return active ? `${theme.fg("success", theme.status.enabled)} ` : "  ";
}
