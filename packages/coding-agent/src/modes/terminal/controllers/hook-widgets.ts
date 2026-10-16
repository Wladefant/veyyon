/**
 * Extension widgets drawn above and below the editor, keyed by the name an extension sets them under. A widget given
 * as lines shows at most {@link MAX_WIDGET_LINES} of them; a widget given as a factory is built against the TUI.
 */
import { Container, Spacer, Text, type TUI } from "@veyyon/tui";
import type { ExtensionUiComponent, ExtensionWidgetOptions } from "../../../extensibility/extensions";
import type { TerminalWidgetContent } from "../../../extensibility/terminal-capability";
import { theme } from "../../../theme/theme-binding";

const MAX_WIDGET_LINES = 10;

function removeHookWidget(widgets: Map<string, ExtensionUiComponent>, key: string): void {
	const existing = widgets.get(key);
	existing?.dispose?.();
	widgets.delete(key);
}

function renderHookWidgetContainer(
	container: Container,
	widgets: Map<string, ExtensionUiComponent>,
	spacerWhenEmpty: boolean,
	leadingSpacer: boolean,
): void {
	container.clear();

	if (widgets.size === 0) {
		if (spacerWhenEmpty) {
			container.addChild(new Spacer(1));
		}
		return;
	}

	if (leadingSpacer) {
		container.addChild(new Spacer(1));
	}
	for (const widget of widgets.values()) {
		container.addChild(widget);
	}
}

/** The containers the widgets render into and the TUI they repaint. */
export interface HookWidgetSurface {
	readonly ui: TUI;
	readonly hookWidgetContainerAbove: Container;
	readonly hookWidgetContainerBelow: Container;
}

export class HookWidgets {
	readonly #surface: HookWidgetSurface;
	readonly #above = new Map<string, ExtensionUiComponent>();
	readonly #below = new Map<string, ExtensionUiComponent>();

	constructor(surface: HookWidgetSurface) {
		this.#surface = surface;
	}

	/** Sets the widget under `key`, replacing (and disposing) any widget already there; `undefined` removes it. */
	set(key: string, content: TerminalWidgetContent, options?: ExtensionWidgetOptions): void {
		const placement = options?.placement ?? "aboveEditor";
		removeHookWidget(this.#above, key);
		removeHookWidget(this.#below, key);

		if (content === undefined) {
			this.#rebuild();
			return;
		}

		const target = placement === "belowEditor" ? this.#below : this.#above;
		target.set(key, this.#create(content));
		this.#rebuild();
	}

	/** Disposes and removes every widget. */
	clear(): void {
		for (const widget of this.#above.values()) {
			widget.dispose?.();
		}
		for (const widget of this.#below.values()) {
			widget.dispose?.();
		}
		this.#above.clear();
		this.#below.clear();
		this.#rebuild();
	}

	#create(content: TerminalWidgetContent): ExtensionUiComponent {
		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) {
				// A whitespace-only Text renders zero rows, so a deliberate blank separator in
				// extension-supplied content needs a Spacer to survive.
				container.addChild(line.trim() === "" ? new Spacer(1) : new Text(line, 1, 0));
			}
			if (content.length > MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			return container;
		}
		if (content === undefined) {
			throw new Error("Widget content missing");
		}
		return content(this.#surface.ui, theme);
	}

	#rebuild(): void {
		renderHookWidgetContainer(this.#surface.hookWidgetContainerAbove, this.#above, true, true);
		renderHookWidgetContainer(this.#surface.hookWidgetContainerBelow, this.#below, false, false);
		this.#surface.ui.requestRender();
	}
}
