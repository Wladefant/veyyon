import { type Component, Container, type Input, type SelectList, type SettingsList, Spacer, Text } from "@veyyon/tui";
import { matchesKey } from "@veyyon/utils/keys";
import { routeSelectListMouse, type SgrMouseEvent } from "@veyyon/utils/mouse";
import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import { theme } from "../../../../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../../utils/keybinding-matchers";
import { consumeModalChipHover, hitTestModalChrome, type ModalShellGeometry } from "../chrome/modal-shell";
import type { ModalSelectListComponent } from "./modal-select-list";

interface RoutableSelectList {
	routeMouse?: (event: SgrMouseEvent, line: number, col: number) => void;
	handleWheel(delta: -1 | 1): void;
	hitTest(line: number): number | undefined;
	setHoverIndex(index: number | null): void;
	clickItem(index: number): void;
}

/**
 * Render a Container's children exactly like Container.render (plain
 * concatenation), recording the 0-based line `tracked` starts at. Pair with
 * {@link routeTrackedMouse}: the offset is meaningless without the route and
 * the route is wrong without the offset, so the two are one pattern with one
 * owner — a submenu that re-implements either half by hand is how mouse
 * support silently breaks on one screen while working everywhere else.
 */
export function renderTrackingChild(
	container: Container,
	tracked: Component | undefined,
	width: number,
): { lines: string[]; trackedLineOffset: number } {
	const lines: string[] = [];
	let trackedLineOffset = 0;
	for (const child of container.children) {
		const childLines = child.render(Math.max(1, width));
		if (child === tracked) trackedLineOffset = lines.length;
		lines.push(...childLines);
	}
	return { lines, trackedLineOffset };
}

/**
 * Route a mouse event to the interactive child {@link renderTrackingChild}
 * tracked: a SelectList gets wheel/hover/click via the shared
 * {@link routeSelectListMouse}, a SettingsList gets the pane semantics in
 * {@link routeSettingsListPointer}, and any other MouseRoutable child gets the
 * event forwarded at its own offset. Undefined target (a state with nothing
 * interactive, e.g. a text input) consumes the event silently, matching the
 * settings-list contract for submenus without a route.
 */
export function routeTrackedMouse(
	target: TrackedMouseTarget | undefined,
	event: SgrMouseEvent,
	line: number,
	trackedLineOffset: number,
	col: number,
): void {
	if (!target) return;
	const localLine = line - trackedLineOffset;
	if ("isValueColumnHit" in target) {
		routeSettingsListPointer(target as SettingsList, event, localLine, col);
		return;
	}
	if ("hitTest" in target && "clickItem" in target) {
		routeSelectListMouse(target as SelectList, event, localLine);
		return;
	}
	target.routeMouse?.(event, localLine, col);
}

/** The interactive child a {@link MouseRoutedSubmenu} can point at. */
export type TrackedMouseTarget =
	| SelectList
	| SettingsList
	| Input
	| (Component & { routeMouse?: (event: SgrMouseEvent, line: number, col: number) => void });

/**
 * Base for settings submenus whose interactive child is a SelectList or a
 * MouseRoutable panel: render records where that child lands, routeMouse
 * forwards at the recorded offset. The subclass supplies only `mouseTarget()`;
 * the offset/route pair itself lives here once, so no submenu can grow a
 * second spelling that drifts off the host's coordinates.
 */
export abstract class MouseRoutedSubmenu extends Container {
	#mouseTargetLineOffset = 0;

	/** The child pointer events belong to in the current state, or undefined. */
	abstract mouseTarget(): TrackedMouseTarget | undefined;

	override render(width: number): readonly string[] {
		const { lines, trackedLineOffset } = renderTrackingChild(this, this.mouseTarget(), width);
		this.#mouseTargetLineOffset = trackedLineOffset;
		return lines;
	}

	override clear(): void {
		this.dispose();
		super.clear();
	}

	/** Mouse routed from the host: wheel steps, hover lights, click confirms. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeTrackedMouse(this.mouseTarget(), event, line, this.#mouseTargetLineOffset, col);
	}
	renderSubmenuFrame(options: {
		title: string;
		description?: string;
		headerExtra?: Component;
		body: Component;
		footerHint?: string;
		footerExtra?: Component;
	}): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 0, 0));
		if (options.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", options.description), 0, 0));
		}
		if (options.headerExtra) {
			this.addChild(new Spacer(1));
			this.addChild(options.headerExtra);
		}
		this.addChild(new Spacer(1));
		this.addChild(options.body);
		if (options.footerExtra) {
			this.addChild(new Spacer(1));
			this.addChild(options.footerExtra);
		}
		if (options.footerHint) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", options.footerHint), 0, 0));
		}
	}

	handleInput(data: string): void {
		const target = this.mouseTarget();
		if (target && "handleInput" in target && typeof target.handleInput === "function") {
			target.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

export interface SubmenuChromeOptions {
	title: string;
	description?: string;
	headerExtra?: Component;
	body: Component;
	mouseTarget?: TrackedMouseTarget;
	errorWidth?: number;
	footerHint?: string;
	footerExtra?: Component;
	handleInput?: (data: string) => boolean | void;
}

/**
 * Parameterized owner for submenu chrome.
 * Builds header, description, spacers, body, error line and footer from data.
 */
export class DeclarativeSubmenu extends MouseRoutedSubmenu {
	#body: Component;
	#customMouseTarget?: TrackedMouseTarget;
	#customHandleInput?: (data: string) => boolean | void;
	#errorText: Text | null = null;
	#errorWidth: number;

	constructor(options: SubmenuChromeOptions) {
		super();
		this.#body = options.body;
		this.#customMouseTarget = options.mouseTarget;
		this.#customHandleInput = options.handleInput;
		this.#errorWidth = options.errorWidth ?? 100;

		this.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 0, 0));
		if (options.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", options.description), 0, 0));
		}
		if (options.headerExtra) {
			this.addChild(new Spacer(1));
			this.addChild(options.headerExtra);
		}
		this.addChild(new Spacer(1));
		this.addChild(options.body);

		if (options.errorWidth !== undefined) {
			this.addChild(new Spacer(1));
			this.#errorText = new Text("", 0, 0);
			this.addChild(this.#errorText);
		}

		if (options.footerHint) {
			if (options.errorWidth === undefined) {
				this.addChild(new Spacer(1));
			}
			this.addChild(new Text(theme.fg("dim", options.footerHint), 0, 0));
		}
		if (options.footerExtra) {
			this.addChild(new Spacer(1));
			this.addChild(options.footerExtra);
		}
	}

	setError(message: string): void {
		if (this.#errorText) {
			const sanitized = truncateToWidth(replaceTabs(message).replace(/[\r\n]+/g, " "), this.#errorWidth);
			this.#errorText.setText(theme.fg("error", sanitized));
		}
	}

	clearError(): void {
		this.#errorText?.setText("");
	}

	mouseTarget(): TrackedMouseTarget | undefined {
		if (this.#customMouseTarget !== undefined) return this.#customMouseTarget;
		if ("routeMouse" in this.#body || "handleWheel" in this.#body) {
			return this.#body as TrackedMouseTarget;
		}
		return undefined;
	}

	override handleInput(data: string): void {
		if (this.#customHandleInput) {
			const handled = this.#customHandleInput(data);
			if (handled) return;
		}
		super.handleInput(data);
	}
}

export function routeSelectListMouseWithTopBorder(
	selectList: SelectList,
	event: SgrMouseEvent,
	line: number,
	col: number,
): void {
	const localLine = line - 1;
	const target = selectList as RoutableSelectList;
	if (typeof target.routeMouse === "function") {
		target.routeMouse(event, localLine, col);
		return;
	}
	if (event.wheel !== null) {
		target.handleWheel(event.wheel);
		return;
	}
	const index = target.hitTest(localLine);
	if (event.motion) {
		target.setHoverIndex(index ?? null);
		return;
	}
	if (event.leftClick && index !== undefined) {
		target.clickItem(index);
	}
}

export function routeSettingsListPointer(list: SettingsList, event: SgrMouseEvent, line: number, col: number): boolean {
	if (list.hasOpenSubmenu()) {
		list.routeSubmenuMouse(event, line, col);
		return false;
	}
	if (event.wheel !== null) {
		list.handleWheelAt(event.wheel, line, col);
		return false;
	}
	if (event.motion) {
		list.setHoverItem(list.hoverTest(line, col) ?? null);
		return false;
	}
	if (!event.leftClick) return false;
	const id = list.hitTest(line, col);
	if (id === undefined) return false;
	const wasSelected = list.getSelectedItem()?.id === id;
	const onValueColumn = list.isValueColumnHit(line, col);
	list.selectItem(id);
	if (wasSelected || onValueColumn) list.handleInput("\n");
	return true;
}

export interface RouteModalCardMouseOptions {
	shellGeometry: ModalShellGeometry | null;
	event: SgrMouseEvent;
	hoveredShortcutId: string | null;
	onHoverShortcut?: (id: string | null) => void;
	onCancel: () => void;
	onConfirm?: () => void;
	onWheel?: (delta: -1 | 1) => void;
	listRowStart?: number;
	hitRows?: readonly (number | undefined)[];
	onHoverRow?: (index: number | null) => void;
	onClickRow?: (index: number) => void;
}

export function routeModalCardMouse(options: RouteModalCardMouseOptions): boolean {
	const {
		shellGeometry,
		event,
		hoveredShortcutId,
		onHoverShortcut,
		onCancel,
		onConfirm,
		onWheel,
		listRowStart,
		hitRows,
		onHoverRow,
		onClickRow,
	} = options;
	const chrome = hitTestModalChrome(shellGeometry, event.row, event.col, {
		motion: event.motion,
		leftClick: event.leftClick,
	});

	if (
		consumeModalChipHover(chrome, hoveredShortcutId, id => {
			onHoverShortcut?.(id);
		})
	) {
		return true;
	}

	if (chrome.kind === "close" || chrome.kind === "outside" || (chrome.kind === "shortcut" && chrome.id === "close")) {
		onCancel();
		return true;
	}

	if (chrome.kind === "shortcut" && chrome.id === "confirm") {
		onConfirm?.();
		return true;
	}

	if (event.wheel !== null && onWheel) {
		onWheel(event.wheel);
		return true;
	}

	if (listRowStart !== undefined) {
		const line = event.row - listRowStart;
		if (event.motion && onHoverRow) {
			const index = hitRows ? (hitRows[line] ?? null) : line >= 0 ? line : null;
			onHoverRow(index);
			return true;
		}
		if (event.leftClick && onClickRow) {
			const index = hitRows ? hitRows[line] : line >= 0 ? line : undefined;
			if (index !== undefined) {
				onClickRow(index);
			}
			return true;
		}
	}

	return true;
}

export interface ListNavigationOptions {
	selectedIndex: number;
	totalItems: number;
	pageSize?: number;
	wrap?: boolean;
	onMove: (index: number) => void;
	onSelect?: (index: number) => void;
	onCancel?: () => void;
}

export function handleListNavigationKey(data: string, options: ListNavigationOptions): boolean {
	const { selectedIndex, totalItems, pageSize = 10, wrap = true, onMove, onSelect, onCancel } = options;
	if (totalItems <= 0) {
		if (matchesSelectCancel(data)) {
			onCancel?.();
			return true;
		}
		return false;
	}

	if (matchesSelectCancel(data)) {
		onCancel?.();
		return true;
	}

	if (matchesSelectUp(data)) {
		const next = selectedIndex === 0 ? (wrap ? totalItems - 1 : 0) : selectedIndex - 1;
		onMove(next);
		return true;
	}

	if (matchesSelectDown(data)) {
		const next = selectedIndex === totalItems - 1 ? (wrap ? 0 : totalItems - 1) : selectedIndex + 1;
		onMove(next);
		return true;
	}

	if (matchesSelectPageUp(data) || matchesKey(data, "pageUp")) {
		const next = Math.max(0, selectedIndex - pageSize);
		onMove(next);
		return true;
	}

	if (matchesSelectPageDown(data) || matchesKey(data, "pageDown")) {
		const next = Math.min(totalItems - 1, selectedIndex + pageSize);
		onMove(next);
		return true;
	}

	if (matchesKey(data, "home")) {
		onMove(0);
		return true;
	}

	if (matchesKey(data, "end")) {
		onMove(totalItems - 1);
		return true;
	}

	if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
		onSelect?.(selectedIndex);
		return true;
	}

	return false;
}

export abstract class ModalSelectWrapper implements Component {
	inner: ModalSelectListComponent;

	constructor(inner: ModalSelectListComponent) {
		this.inner = inner;
	}

	setOnRequestRender(cb: () => void): void {
		this.inner.setOnRequestRender(cb);
	}

	getSelectList(): SelectList {
		return this.inner.getSelectList();
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.inner.getSelectList().routeMouse(event, line - 1, col);
	}

	handleInput(data: string): void {
		this.inner.handleInput(data);
	}

	render(width: number): string[] {
		return this.inner.render(width);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	dispose(): void {
		this.inner.dispose?.();
	}
}
