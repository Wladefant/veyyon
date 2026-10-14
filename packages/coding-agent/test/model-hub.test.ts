import { afterEach, beforeAll, describe, expect, type Mock, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { MODAL_SIZING_LARGE } from "@veyyon/coding-agent/modes/terminal/components/chrome/modal-geometry";
import {
	type ModelHubCallbacks,
	ModelHubComponent,
	type ModelHubOptions,
	resetProviderAutoRefreshGuard,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/model-hub";
import { getThemeByName, setThemeInstance, theme } from "@veyyon/coding-agent/theme/theme";
import { configuredThinkingLevelsForModel } from "@veyyon/coding-agent/thinking";
import type { TUI } from "@veyyon/tui";

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

/**
 * The strip row (hint line or an active chip strip) of a rendered frame: the
 * last line of the sidebar|body split. Located dynamically since the ModalShell
 * card floats and is vertically centered.
 *
 * It is NOT the row directly above the divider. ModalShell charges `vPad`
 * TWICE, once above the body and once below it, so up to `MODAL_SIZING_LARGE.vPad`
 * blank card rows sit between the strip and the divider that separates the body
 * from the footer shortcut chips. Reading `dividerIndex - 1` returned one of
 * those pad rows, which is why eleven strip assertions in this file all failed
 * with the same empty `│ … │` line and none of them said anything about the
 * strip. The pad count shrinks on a short card (`renderModalShell` drops vPad
 * before it drops chrome), so this skips blank rows rather than subtracting a
 * fixed two.
 *
 * The climb is bounded and it throws instead of returning a body row: every
 * caller asserts strip CONTENT, so a blank strip is a real failure and must not
 * be papered over by silently walking further up into the model list, which
 * would turn a missing hint into a confusing mismatch against an unrelated row.
 */
function footerLine(lines: readonly string[]): string {
	const stripped = lines.map(line => stripVTControlCharacters(line));
	const dividerIndex = stripped.findIndex(line => {
		const trimmed = line.trim();
		return trimmed.startsWith("├") && trimmed.endsWith("┤");
	});
	if (dividerIndex <= 0) return "";
	for (let skipped = 0; skipped <= MODAL_SIZING_LARGE.vPad; skipped++) {
		const row = stripped[dividerIndex - 1 - skipped] ?? "";
		if (row.replace(/[│\s]/g, "") !== "") return row;
	}
	throw new Error(
		`no strip row within ${MODAL_SIZING_LARGE.vPad} pad rows above the footer divider at line ${dividerIndex}`,
	);
}

function makeModel(provider: string, id: string, contextWindow = 128_000): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelHub tests");
	}
	setThemeInstance(testTheme);
}

interface RegistryOverrides {
	refresh?: (mode: string) => Promise<void>;
	refreshProvider?: (providerId: string, mode: string) => Promise<void>;
	getAvailable?: () => Model[];
	getAll?: () => Model[];
	getDiscoverableProviders?: () => string[];
	getProviderDiscoveryState?: (providerId: string) => unknown;
}

function makeRegistry(models: () => Model[], overrides: RegistryOverrides = {}): ModelRegistry {
	return {
		refresh: overrides.refresh ?? (async () => {}),
		refreshProvider: overrides.refreshProvider ?? (async () => {}),
		getError: () => undefined,
		getAvailable: overrides.getAvailable ?? models,
		getAll: overrides.getAll ?? models,
		getDiscoverableProviders: overrides.getDiscoverableProviders ?? (() => []),
		getProviderDiscoveryState: overrides.getProviderDiscoveryState ?? (() => undefined),
		authStorage: { hasAuth: () => false },
	} as unknown as ModelRegistry;
}

interface HubHarness {
	hub: ModelHubComponent;
	onSetDefault: Mock<ModelHubCallbacks["onSetDefault"]>;
	onClearDefault: Mock<() => void>;
	onLoginRequest: Mock<(providerId: string) => void>;
	onCancel: Mock<() => void>;
	onFallbackChainChange: Mock<(key: string, chain: string[]) => void>;
}

const openHubs: ModelHubComponent[] = [];

function createHub(options: {
	models: Model[] | (() => Model[]);
	scoped?: boolean;
	settings?: Settings;
	registry?: RegistryOverrides;
	hub?: ModelHubOptions;
	callbacks?: Partial<ModelHubCallbacks>;
}): HubHarness {
	installTestTheme();
	const modelsFn = typeof options.models === "function" ? options.models : () => options.models as Model[];
	const settings = options.settings ?? Settings.isolated({});
	const registry = makeRegistry(modelsFn, options.registry);
	const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	// Mirror the controller: persist default and chain edits so the hub's re-read sees them.
	const onSetDefault = vi.fn<ModelHubCallbacks["onSetDefault"]>((_model, thinkingLevel, selector) => {
		const inherits = thinkingLevel === undefined || thinkingLevel === ThinkingLevel.Inherit;
		settings.setDefaultModel(inherits ? selector : `${selector}:${thinkingLevel}`);
	});
	const onClearDefault = vi.fn(() => settings.setDefaultModel(undefined));
	const onLoginRequest = vi.fn((_providerId: string) => {});
	const onCancel = vi.fn(() => {});
	const onFallbackChainChange = vi.fn((key: string, chain: string[]) => {
		const chains = { ...settings.get("retry.fallbackChains") };
		if (chain.length === 0) {
			delete chains[key];
		} else {
			chains[key] = chain;
		}
		settings.override("retry.fallbackChains", chains);
	});
	const hub = new ModelHubComponent(
		ui,
		settings,
		registry,
		options.scoped ? modelsFn().map(model => ({ model })) : [],
		{
			onSetDefault: options.callbacks?.onSetDefault ?? onSetDefault,
			onClearDefault: options.callbacks?.onClearDefault ?? onClearDefault,
			onLoginRequest: options.callbacks?.onLoginRequest ?? onLoginRequest,
			onFallbackChainChange: options.callbacks?.onFallbackChainChange ?? onFallbackChainChange,
			onCancel: options.callbacks?.onCancel ?? onCancel,
		},
		options.hub,
	);
	openHubs.push(hub);
	return { hub, onSetDefault, onClearDefault, onLoginRequest, onCancel, onFallbackChainChange };
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ESC = "\x1b";

describe("ModelHub", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelHub tests");
		}
	});

	afterEach(() => {
		resetProviderAutoRefreshGuard();
		for (const hub of openHubs.splice(0)) {
			hub.dispose();
		}
	});

	describe("hop focus stability", () => {
		test("hopping onto Default & fallbacks keeps provider navigation instead of capturing the arrows", () => {
			const model = makeModel("prov-a", "model-a");
			const { hub } = createHub({ models: [model] });

			hub.handleInput(UP); // All models → Default & fallbacks
			// The chain view shows as a preview, but arrows keep hopping.
			expect(footerLine(hub.render(220))).toContain("→ rows");
			hub.handleInput(DOWN); // continues to All models — not a chain row
			expect(normalize(hub.render(220))).toContain("All available models");
		});

		test("while searching, the hop skips Default & fallbacks", () => {
			const model = makeModel("prov-a", "target-model");
			const { hub } = createHub({ models: [model] });

			for (const ch of "target") hub.handleInput(ch);
			hub.handleInput(UP); // skips Default & fallbacks → wraps to prov-a
			expect(normalize(hub.render(220))).toContain("prov-a ·");
			expect(footerLine(hub.render(220))).not.toContain("→ rows");
		});
	});

	describe("default chip on the detail line", () => {
		test("chips the default model on its own detail line only", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const chip = `${theme.status.enabled}default`;

			const onDefault = createHub({
				models: [a, b],
				scoped: true,
				settings: Settings.isolated({ defaultModel: "test/model-a" }),
			});
			expect(normalize(onDefault.hub.render(220))).toContain(chip);

			// The default ranks first, so step the list cursor onto the other model.
			onDefault.hub.handleInput("\x1b[C"); // focus the model list
			onDefault.hub.handleInput(DOWN);
			expect(normalize(onDefault.hub.render(220))).not.toContain(chip);
		});

		test("an unset default chips no model", () => {
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true });
			expect(normalize(hub.render(220))).not.toContain(`${theme.status.enabled}default`);
		});
	});

	describe("pick strip", () => {
		test("Enter opens the pick strip; default sets the default model and opens the thinking strip", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const settings = Settings.isolated({});
			const { hub } = createHub({ models: [model], scoped: true, settings });

			hub.handleInput("\n");
			// The ModalShell card caps at MODAL_SIZING_LARGE.maxWidth, so the chip
			// row is narrower than the full terminal — the retry-fallback chip
			// (reached via the dedicated overflow test below) may scroll off.
			const strip = footerLine(hub.render(220));
			expect(strip).toContain("[ default ]");
			expect(strip).toContain("fallbacks:gpt-5.5");

			hub.handleInput("\n"); // the first chip sets the default
			expect(settings.get("defaultModel")).toEqual("openai/gpt-5.5");

			// The thinking strip follows immediately, scoped to the model's
			// real ladder: gpt-5.5 tops out at xhigh — no invented max tier.
			const thinking = footerLine(hub.render(220));
			expect(thinking).toContain("inherit");
			expect(thinking).toContain("xhigh");
			expect(thinking).not.toContain("max");
		});

		test("renders max as a real final tier on max-capable models (gpt-5.6)", () => {
			const model = getBundledModel("openai", "gpt-5.6");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.6");
			const { hub } = createHub({ models: [model], scoped: true });

			hub.handleInput("\n");
			hub.handleInput("\n");
			const thinking = footerLine(hub.render(220));
			expect(thinking).toContain("xhigh");
			expect(thinking).toContain("max");
		});

		test("a thinking chip re-saves the default with the picked effort", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const settings = Settings.isolated({});
			const { hub, onSetDefault } = createHub({ models: [model], scoped: true, settings });

			hub.handleInput("\n"); // pick strip
			hub.handleInput("\n"); // default → thinking strip, cursor on the effort the default runs
			hub.handleInput("\x1b[C"); // the next level on the model's ladder
			hub.handleInput("\n");

			expect(onSetDefault).toHaveBeenCalledTimes(2);
			const [picked, level, selector] = onSetDefault.mock.calls[1] ?? [];
			expect([picked, selector]).toEqual([model, "openai/gpt-5.5"]);
			if (level === undefined || level === ThinkingLevel.Inherit) throw new Error("the strip saved no effort");
			expect(configuredThinkingLevelsForModel(model)).toContain(level);
			expect(settings.get("defaultModel")).toEqual(`openai/gpt-5.5:${level}`);
			expect(footerLine(hub.render(220))).not.toContain("inherit"); // the strip closed
		});

		test("Enter on the default chip of the current default clears it", () => {
			const model = makeModel("test", "toggled-model");
			const settings = Settings.isolated({ defaultModel: "test/toggled-model" });
			const { hub } = createHub({ models: [model], scoped: true, settings });

			hub.handleInput("\n"); // pick strip — cursor on the default chip
			hub.handleInput("\n");

			// Cleared, and not re-set by a thinking step.
			expect(settings.get("defaultModel")).toBeUndefined();
			// Clearing closes the strip without a thinking step.
			expect(footerLine(hub.render(220))).not.toContain("inherit");
			expect(normalize(hub.render(220))).not.toContain(`${theme.status.enabled}default`);
		});

		test("retry-fallback chip appends the model to the default chain without a thinking strip", () => {
			const model = makeModel("test", "retry-fallback-model");
			const { hub, onSetDefault, onFallbackChainChange } = createHub({ models: [model], scoped: true });

			hub.handleInput("\n");
			hub.handleInput(LEFT); // wraps to the trailing retry-fallback chip
			hub.handleInput("\n");

			expect(onFallbackChainChange).toHaveBeenCalledWith("default", ["test/retry-fallback-model"]);
			expect(onSetDefault).not.toHaveBeenCalled();
			expect(footerLine(hub.render(220))).not.toContain("inherit");

			// A second registration of the same model is a no-op, not a duplicate.
			hub.handleInput("\n");
			hub.handleInput(LEFT);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenCalledTimes(1);
		});

		test("overflowing pick strip scrolls left so the selected chip stays visible", () => {
			const model = makeModel("test", "narrow-strip-model");
			const { hub } = createHub({ models: [model], scoped: true });

			hub.handleInput("\n"); // open the pick strip
			// The window starts at the first chip, so no *leading* ellipsis
			// appears — the ModalShell card's width cap may still truncate a
			// trailing chip, which the overflow case below covers directly.
			expect(footerLine(hub.render(220)).trimStart().startsWith("…")).toBe(false);

			hub.handleInput(LEFT); // wrap to the trailing retry-fallback chip
			const narrow = footerLine(hub.render(80));
			expect(narrow).toContain("[ retry-fallback ]");
			expect(narrow).toContain("…");

			// Back on the first chip the window resets — no leading ellipsis.
			hub.handleInput("\x1b[C"); // wrap right back to the first chip
			const reset = footerLine(hub.render(80));
			expect(reset).toContain("[ default");
			expect(reset.trimStart().startsWith("…")).toBe(false);
		});
	});

	describe("Default & fallbacks view", () => {
		/** Hop to the Default & fallbacks sidebar entry and dive into its rows. */
		function enterChainView(hub: ModelHubComponent): void {
			hub.handleInput(UP); // All models → Default & fallbacks
			hub.handleInput("\n"); // dive into the rows
		}

		test("an unset default reads as auto-selected on launch; a set one shows the model and its effort", () => {
			const unset = createHub({ models: [makeModel("test", "model-a")], scoped: true });
			enterChainView(unset.hub);
			expect(normalize(unset.hub.render(220))).toContain("default (auto-select on launch)");

			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const set = createHub({
				models: [model],
				scoped: true,
				settings: Settings.isolated({ defaultModel: "openai/gpt-5.5:high" }),
			});
			enterChainView(set.hub);
			const rendered = normalize(set.hub.render(220));
			expect(rendered).toContain("default openai/gpt-5.5");
			expect(rendered).toContain("high");
			expect(rendered).not.toContain("auto-select on launch");
		});

		test("Enter on the default row picks the default from the catalog", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onSetDefault } = createHub({ models: [a, b], scoped: true });

			enterChainView(hub);
			hub.handleInput("\n"); // the cursor starts on the default row
			expect(normalize(hub.render(220))).toContain("Setting the default model");
			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");

			expect(onSetDefault).toHaveBeenCalledWith(b, ThinkingLevel.Inherit, "test/model-b");
			hub.handleInput(ESC); // keep the effort; the strip returns to the chain view
			expect(normalize(hub.render(220))).toContain("default test/model-b");
		});

		test("x on the default row clears it back to auto-selection", () => {
			const a = makeModel("test", "model-a");
			const settings = Settings.isolated({ defaultModel: "test/model-a" });
			const { hub, onClearDefault } = createHub({ models: [a], scoped: true, settings });

			enterChainView(hub);
			hub.handleInput("x");

			expect(onClearDefault).toHaveBeenCalledTimes(1);
			expect(normalize(hub.render(220))).toContain("default (auto-select on launch)");
		});

		test("t on the default row opens its thinking strip, and does nothing with no default", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");

			const set = createHub({
				models: [model],
				scoped: true,
				settings: Settings.isolated({ defaultModel: "openai/gpt-5.5" }),
			});
			enterChainView(set.hub);
			set.hub.handleInput("t");
			expect(footerLine(set.hub.render(220))).toContain("xhigh");

			const unset = createHub({ models: [model], scoped: true });
			enterChainView(unset.hub);
			unset.hub.handleInput("t");
			expect(footerLine(unset.hub.render(220))).not.toContain("xhigh");
		});

		test("renders configured default-chain entries as indented rows under the default", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub } = createHub({ models: [a, b], scoped: true, settings });

			enterChainView(hub);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("↳ test/model-a");
			expect(rendered).toContain("↳ test/model-b");
		});

		test("f on the default row opens fallback assignment and Enter appends the picked model", () => {
			const a = makeModel("test", "model-a");
			const { hub, onFallbackChainChange, onSetDefault } = createHub({ models: [a], scoped: true });

			enterChainView(hub);
			hub.handleInput("f");
			expect(normalize(hub.render(220))).toContain("Adding fallback for the default model");

			hub.handleInput("\n"); // pick the only model
			expect(onFallbackChainChange).toHaveBeenCalledWith("default", ["test/model-a"]);
			expect(onSetDefault).not.toHaveBeenCalled(); // no default change, no thinking strip
			expect(normalize(hub.render(220))).toContain("↳ test/model-a");
		});

		test("x removes a chain entry and Enter on an entry replaces it", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterChainView(hub);
			hub.handleInput(DOWN); // default → its first chain entry (model-a)
			hub.handleInput("\n"); // replace this entry
			expect(normalize(hub.render(220))).toContain("Replacing fallback of");
			for (const ch of "model-b") hub.handleInput(ch); // search: arrows hop scopes in assign mode
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b"]);

			hub.handleInput("x"); // cursor landed on the replaced entry — remove it
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", []);
			expect(normalize(hub.render(220))).not.toContain("↳");
		});

		test("] moves a chain entry later and the cursor follows it", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterChainView(hub);
			hub.handleInput(DOWN); // first chain entry (model-a)
			hub.handleInput("]");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b", "test/model-a"]);

			// Cursor followed the moved entry: x removes model-a, not model-b.
			hub.handleInput("x");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b"]);
		});

		test("clicking a chain row hits the row under the pointer", () => {
			const a = makeModel("test", "model-a");
			const { hub } = createHub({ models: [a], scoped: true });

			hub.handleInput(UP); // All models → Default & fallbacks
			// Derive the pointer row/col from the frame itself: the ModalShell
			// card floats and is centered, so absolute coordinates shift with
			// terminal size — frame index is still the screen row.
			const { row, col } = locate(hub.render(220), "auto-select on launch");
			const sgr = `\x1b[<0;${col + 1};${row + 1}M`; // SGR reports are 1-based
			hub.handleInput(sgr); // select (dive into rows)
			hub.handleInput(sgr); // click-again activates
			expect(normalize(hub.render(220))).toContain("Setting the default model");
		});

		test("fallbacks chip keys a new chain by the selected model", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n"); // open the strip for model-a
			hub.handleInput(LEFT); // retry-fallback
			hub.handleInput(LEFT); // fallbacks:test/*
			hub.handleInput(LEFT); // fallbacks:model-a
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/model-a");

			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/model-a", ["test/model-b"]);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("test/model-a");
			expect(rendered).toContain("↳ test/model-b");
		});

		test("provider chip keys the chain by provider/*", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n");
			hub.handleInput(LEFT); // retry-fallback
			hub.handleInput(LEFT); // fallbacks:test/*
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/*");

			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/*", ["test/model-b"]);
		});

		test("+ New fallback… picks the protected model, then keys the chain via the strip", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			enterChainView(hub);
			hub.handleInput(UP); // wrap to the trailing "+ New fallback…"
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("New fallback chain");

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n"); // pick the protected model
			const strip = footerLine(hub.render(220));
			expect(strip).toContain("for test/model-a");
			expect(strip).toContain("for test/*");

			hub.handleInput("\n"); // key by the exact model
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/model-a");
			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/model-a", ["test/model-b"]);
		});

		test("model-keyed chains render below the separator and x clears the whole chain", () => {
			const a = makeModel("test", "model-a");
			const settings = Settings.isolated({
				"retry.fallbackChains": { "test/*": ["test/model-a"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a], scoped: true, settings });

			enterChainView(hub);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("test/*");
			expect(rendered).toContain("↳ test/model-a");
			expect(rendered).toMatch(/─{10,}/); // the default/model-keyed divider
			// One chain fits the pane at 40 rows, so the trailing row is on screen
			// from the start. Windowing a list that does NOT fit is pinned in
			// `modal-chrome-budget-has-one-owner.test.ts`, which builds enough
			// chains to overflow rather than relying on a card being short.
			expect(rendered).toContain("+ New fallback…");

			hub.handleInput(UP); // wraps to + New fallback…
			expect(normalize(hub.render(220))).toContain("+ New fallback…");
			hub.handleInput(UP); // ↳ test/model-a
			hub.handleInput(UP); // test/* header
			hub.handleInput("x");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/*", []);
			expect(normalize(hub.render(220))).not.toContain("↳ test/model-a");
		});
	});

	test("focuses the scope pane initially", () => {
		const { hub } = createHub({ models: [makeModel("test", "test-model")] });
		const rendered = normalize(hub.render(220));
		expect(rendered).toContain("↑/↓ providers · → models");
	});

	/** Screen row/col (0-based) of the first line containing `needle` (string or pattern). */
	function locate(frame: readonly string[], needle: string | RegExp): { row: number; col: number } {
		const stripped = frame.map(line => stripVTControlCharacters(line));
		const test =
			typeof needle === "string" ? (line: string) => line.includes(needle) : (line: string) => needle.test(line);
		const row = stripped.findIndex(test);
		if (row < 0) throw new Error(`${String(needle)} not found in rendered frame`);
		const match = typeof needle === "string" ? needle : (needle.exec(stripped[row]!)?.[0] ?? "");
		return { row, col: stripped[row]!.indexOf(match) };
	}

	/** Build an SGR wheel report at a 0-based screen row/col (SGR is 1-based). */
	function sgrWheel(direction: "up" | "down", row: number, col: number): string {
		const button = direction === "down" ? 65 : 64;
		return `\x1b[<${button};${col + 1};${row + 1}M`;
	}

	describe("mouse wheel", () => {
		// SGR wheel reports: button 64 = up, 65 = down. Column 3, row 10 is a
		// fixed fallback for cases where geometry isn't derived from the frame.
		const WHEEL_UP_SIDEBAR = "\x1b[<64;3;10M";
		const WHEEL_DOWN_SIDEBAR = "\x1b[<65;3;10M";

		test("wheel pans the model list without moving the selection and clamps at the ends", () => {
			const models = Array.from({ length: 40 }, (_, i) => makeModel("test", `model-${String(i).padStart(2, "0")}`));
			const { hub } = createHub({ models, scoped: true });

			const initialFrame = hub.render(220);
			const before = normalize(initialFrame); // establishes mouse geometry
			// The ModalShell card floats and is centered, so the body pane's
			// screen coordinates shift with sizing — anchor the wheel pointer on
			// the first visible model row rather than a magic row/col.
			const { row, col } = locate(initialFrame, /model-\d\d/);
			const wheelUpBody = sgrWheel("up", row, col);
			const wheelDownBody = sgrWheel("down", row, col);

			// Enter opens the role strip for the selected model — its footer
			// (`<model-id> → …`) identifies the selection.
			hub.handleInput("\n");
			const initialStrip = footerLine(hub.render(220));
			expect(initialStrip).toContain("→");
			hub.handleInput(ESC); // close the strip

			// Panning reveals rows that were below the fold...
			for (let i = 0; i < 8; i++) hub.handleInput(wheelDownBody);
			const panned = normalize(hub.render(220));
			const modelIdsIn = (frame: string) => new Set(Array.from(frame.matchAll(/model-\d\d/g), match => match[0]));
			const beforeIds = modelIdsIn(before);
			const revealed = [...modelIdsIn(panned)].filter(id => !beforeIds.has(id));
			expect(revealed.length).toBeGreaterThan(0);

			// ...but never moves the selection: Enter still opens the same model's strip.
			hub.handleInput("\n");
			expect(footerLine(hub.render(220))).toBe(initialStrip);
			hub.handleInput(ESC);

			// The window clamps at the bottom instead of wrapping back to the top...
			for (let i = 0; i < 500; i++) hub.handleInput(wheelDownBody);
			const saturated = normalize(hub.render(220));
			hub.handleInput(wheelDownBody);
			expect(normalize(hub.render(220))).toBe(saturated);

			// ...and scrolling back up restores the original window exactly.
			for (let i = 0; i < 500; i++) hub.handleInput(wheelUpBody);
			expect(normalize(hub.render(220))).toBe(before);
		});

		test("wheel over the sidebar never changes the active scope or schedules refreshes", () => {
			vi.useFakeTimers();
			try {
				const refreshProvider = vi.fn(async () => {});
				const { hub } = createHub({
					models: [makeModel("prov-a", "model-a"), makeModel("prov-b", "model-b")],
					registry: { refreshProvider },
				});

				expect(normalize(hub.render(220))).toContain("All available models");

				// Two hops under the old wheel-selects behavior would land on a
				// provider scope; the viewport pan must leave the scope alone.
				for (let i = 0; i < 2; i++) hub.handleInput(WHEEL_DOWN_SIDEBAR);
				expect(normalize(hub.render(220))).toContain("All available models");
				for (let i = 0; i < 2; i++) hub.handleInput(WHEEL_UP_SIDEBAR);
				expect(normalize(hub.render(220))).toContain("All available models");

				// No scope change means no provider auto-refresh either.
				vi.advanceTimersByTime(200); // past the 120ms provider-refresh debounce
				expect(refreshProvider).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		test("wheel in the chain view clamps at the top instead of wrapping to the bottom rows", () => {
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true });

			hub.handleInput(UP); // All models → Default & fallbacks
			const frame = hub.render(220); // establish mouse geometry
			const { row, col } = locate(frame, "auto-select on launch");
			const wheelUpBody = sgrWheel("up", row, col);
			for (let i = 0; i < 4; i++) hub.handleInput(wheelUpBody); // cursor stays on the default row
			hub.handleInput("\n"); // dive into the rows
			hub.handleInput("\n"); // activate the cursor row
			expect(normalize(hub.render(220))).toContain("Setting the default model");
		});
	});

	describe("provider scopes and search", () => {
		test("search inside a provider scope keeps that provider's model (#4522)", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			// Scope-hop: All models → custom-provider → openrouter.
			hub.handleInput(DOWN);
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("openrouter ·");

			for (const ch of "glm-5.2") hub.handleInput(ch);
			hub.handleInput("\n");

			// The pick strip opened for the provider-scoped match, not the
			// identically named custom-provider model.
			expect(footerLine(hub.render(220))).toContain("z-ai/glm-5.2 →");
		});

		test("search on All models spans every provider", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			for (const ch of "glm") hub.handleInput(ch);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("openrouter/z-ai/glm-5.2");
			expect(rendered).toContain("custom-provider/glm-5.2");
		});

		test("a provider scope that loses every match falls back to All models", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			hub.handleInput(DOWN);
			hub.handleInput(DOWN); // openrouter scope
			for (const ch of "does-not-exist") hub.handleInput(ch);

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("All available models");
			expect(rendered).toContain("No matching models");
		});

		test("scope hop skips providers without matches while searching", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customOther = makeModel("custom-provider", "different-model");
			const { hub } = createHub({ models: [openrouterGlm, customOther] });
			installTestTheme();

			for (const ch of "z-ai") hub.handleInput(ch);
			hub.handleInput(DOWN); // skips custom-provider (0 matches), lands on openrouter
			expect(normalize(hub.render(220))).toContain("openrouter ·");
		});

		test("providers with matches float to the top of the sidebar while searching", () => {
			const noMatch = makeModel("aaa-provider", "different-model");
			const withMatch = makeModel("zzz-provider", "target-model");
			const { hub } = createHub({ models: [noMatch, withMatch] });
			installTestTheme();

			// Sidebar cell = the first `│`-delimited column of each split row;
			// body rows may also mention provider names, so scope the check.
			const sidebarIndexOf = (provider: string): number =>
				hub
					.render(220)
					.map(line => stripVTControlCharacters(line).split("│")[1] ?? "")
					.findIndex(cell => cell.includes(provider));

			expect(sidebarIndexOf("aaa-provider")).toBeLessThan(sidebarIndexOf("zzz-provider"));

			for (const ch of "target") hub.handleInput(ch);
			expect(sidebarIndexOf("zzz-provider")).toBeLessThan(sidebarIndexOf("aaa-provider"));

			// Clearing the query restores the alphabetical order.
			hub.handleInput("\x1b");
			expect(sidebarIndexOf("aaa-provider")).toBeLessThan(sidebarIndexOf("zzz-provider"));
		});

		test("Escape clears an active query before closing the hub", () => {
			const model = makeModel("test", "escape-model");
			const { hub, onCancel } = createHub({ models: [model] });
			installTestTheme();

			for (const ch of "esc") hub.handleInput(ch);
			hub.handleInput("\x1b");
			expect(onCancel).not.toHaveBeenCalled();
			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		test("left/right arrows switch between the sidebar and the model list", () => {
			const modelA = makeModel("prov-a", "model-a");
			const modelB = makeModel("prov-b", "model-b");
			const { hub } = createHub({ models: [modelA, modelB] });
			installTestTheme();

			// Right enters list mode: Down now moves the model selection, the
			// scope stays on All models.
			hub.handleInput("\x1b[C");
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("All available models");

			// Left returns to the sidebar: Down hops to the first provider.
			hub.handleInput(LEFT);
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("prov-a ·");
		});
	});

	describe("provider refresh lifecycle", () => {
		test("auto-refreshes a provider once per process; F5 forces a re-fetch", async () => {
			const model = makeModel("prov-a", "model-a");
			const refreshProvider = vi.fn(async () => {});
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider },
			});
			installTestTheme();

			// Real waits: the hub debounces provider refreshes with a real
			// 120ms setTimeout (no injection seam), and the fetch completion is
			// a promise chain — fake timers cannot drive the mixed path.
			hub.handleInput(DOWN); // All models → prov-a, schedules the refresh
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider).toHaveBeenCalledWith("prov-a", "online");

			hub.handleInput(UP); // back to All models
			hub.handleInput(DOWN); // revisit prov-a
			await Bun.sleep(140);
			// Lifetime guard: revisiting must not re-fetch.
			expect(refreshProvider).toHaveBeenCalledTimes(1);

			hub.handleInput("\x1b[15~"); // F5
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(2);
		});

		test("shows a refreshing status while the provider fetch is in flight", async () => {
			const model = makeModel("prov-b", "model-b");
			const gate = Promise.withResolvers<void>();
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider: () => gate.promise },
			});
			installTestTheme();

			hub.handleInput(DOWN);
			await Bun.sleep(140);
			expect(normalize(hub.render(220))).toContain("refreshing model list");

			gate.resolve();
			await Bun.sleep(0);
			expect(normalize(hub.render(220))).not.toContain("refreshing model list");
		});
	});

	describe("locked providers", () => {
		test("catalog providers without credentials appear locked and forward to login", () => {
			const anthropicModel = makeModel("anthropic", "claude-locked-test");
			const { hub, onLoginRequest } = createHub({
				models: [anthropicModel],
				registry: { getAvailable: () => [] },
			});
			installTestTheme();

			hub.handleInput(DOWN); // All models → locked anthropic (separator skipped)
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("anthropic has no credentials configured");
			expect(rendered).toContain("claude-locked-test");

			hub.handleInput("\n");
			expect(onLoginRequest).toHaveBeenCalledWith("anthropic");
		});
	});
});
