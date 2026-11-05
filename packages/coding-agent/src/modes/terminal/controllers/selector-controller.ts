import { ThinkingLevel } from "@veyyon/agent-core";
import { type Component, Loader, type OverlayHandle, Spacer } from "@veyyon/tui";
import { errorMessage, getProjectDir } from "@veyyon/utils";
import {
	type AdvisorConfigScope,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
	type WatchdogConfigDoc,
} from "../../../advisor";
import { isRollbackSupported, rollbackToVersion } from "../../../cli/update-cli";
import { formatModelSelectorValue, formatModelStringWithRouting } from "../../../config/model-resolver";
import { resolveAvailablePersonalities } from "../../../config/personality-resolver";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../../../config/settings-instance";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../../discovery/helpers";
import type { SubcommandDef } from "../../../slash-commands/types";
import { frozenGateNotice } from "../../../system-prompt-builder/gate-registry";
import { getAvailableThemes, getSymbolTheme, previewTheme, theme } from "../../../theme/theme";
import { hasConfigurableThinkingEffort } from "../../../thinking";
import { copyToClipboard } from "../../../utils/clipboard";
import { openPath } from "../../../utils/open";
import { HistorySearchComponent } from "../components/composer/history-search";
import { AgentDashboard } from "../components/dashboard/agent-dashboard";
import { AdvisorConfigOverlayComponent } from "../components/dialogs/advisor-config";
import { ExtensionDashboard } from "../components/extensions";
import { CopySelectorComponent } from "../components/selectors/copy-selector";
import { ModelHubComponent } from "../components/selectors/model-hub";
import { ModelPickerComponent } from "../components/selectors/model-picker";
import { SettingsSelectorComponent } from "../components/selectors/settings-selector";
import { SubcommandPickerComponent } from "../components/selectors/subcommand-picker";
import { ThinkingSelectorComponent } from "../components/selectors/thinking-selector";
import { TreeSelectorComponent } from "../components/selectors/tree-selector";
import { UserMessageSelectorComponent } from "../components/selectors/user-message-selector";
import { statusLineSettingsFromConfig } from "../components/status-line/quiet-row";
import type { SessionObserverRegistry } from "../session-observer-registry";
import type { InteractiveModeContext } from "../types";
import { buildCopyTargets } from "../utils/copy-targets";
import { focusEditorSlot } from "../utils/interactive-context-helpers";
import { AccountFlows } from "./account-flows";
import { SessionFlows } from "./session-flows";
import { settingEffect } from "./setting-effects";

/**
 * The slice of the interactive context this uses: 33 members of the 215
 * `InteractiveModeContext` requires. Still a slice, and naming it is what lets a
 * test construct one without the `as unknown as InteractiveModeContext` cast the
 * full interface forces (see `CollabHostContext`).
 */
export type SelectorControllerContext = Pick<
	InteractiveModeContext,
	| "applyCwdChange"
	| "attachMainSession"
	| "chatContainer"
	| "clearTransientSessionUi"
	| "collabGuest"
	| "editor"
	| "editorContainer"
	| "effectiveHideThinkingBlock"
	| "focusAgentSession"
	| "handleDebugTranscriptCommand"
	| "handleUsageCommand"
	| "hideThinkingBlock"
	| "historyStorage"
	| "keybindings"
	| "mcpManager"
	| "oauthManualInput"
	| "planModeEnabled"
	| "present"
	| "proseOnlyThinking"
	| "rebuildChatFromMessages"
	| "refreshSlashCommandState"
	| "reloadTodos"
	| "renderInitialMessages"
	| "session"
	| "sessionManager"
	| "settings"
	| "showDebugSelector"
	| "showError"
	| "showHookConfirm"
	| "showHookEditor"
	| "showHookSelector"
	| "showStatus"
	| "showWarning"
	| "shutdown"
	| "statusContainer"
	| "statusLine"
	| "toolOutputExpanded"
	| "ui"
	| "updateEditorBorderColor"
>;

export class SelectorController {
	readonly #accounts: AccountFlows;
	readonly #sessions: SessionFlows;

	constructor(private ctx: SelectorControllerContext) {
		this.#accounts = new AccountFlows(ctx, this);
		this.#sessions = new SessionFlows(ctx, this);
	}

	/** Restore keyboard focus to the editor slot's current owner; see {@link focusEditorSlot}. */
	focusActiveEditorArea(): void {
		focusEditorSlot(this.ctx);
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		// Re-entrant guard: a selection path and a cancel path may both call
		// `done()` (or a component may fire both), so the editor is restored
		// exactly once instead of clearing and re-adding it twice.
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	/**
	 * Shows a floating ModalShell picker as a fullscreen overlay (clear underpaint).
	 * Prefer this over {@link showSelector} for structure-system pickers.
	 */
	showModalSelector(
		create: (done: () => void) => {
			component: Component & { setOnRequestRender?: (cb: () => void) => void; dispose?: () => void };
			focus: Component;
		},
	): void {
		let overlayHandle: OverlayHandle | undefined;
		// Re-entrant guard + early-close handling. `done()` may fire more than
		// once (a select path and a cancel path can race), so the overlay must
		// hide exactly once. It may also fire synchronously inside `create()`,
		// before `showOverlay` has returned a handle to hide; in that case we
		// record the request and run the teardown right after the handle exists,
		// so the overlay never gets stranded open (Law 10: no silent no-op).
		let closed = false;
		let closeRequestedEarly = false;
		// Assigned by `create` below, and read by a `done` that can outlive this
		// call: the card is what registered with the shared clock, so it is what
		// has to be told the card is gone.
		let card: { dispose?: () => void } | undefined;
		const done = () => {
			if (closed) return;
			if (!overlayHandle) {
				closeRequestedEarly = true;
				return;
			}
			closed = true;
			overlayHandle.hide();
			// Everything the card registered with the shared clock goes with it: a
			// pointer band still travelling when Escape landed is ticking against a
			// component nobody will paint again.
			card?.dispose?.();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const { component, focus } = create(done);
		card = component;
		component.setOnRequestRender?.(() => this.ctx.ui.requestRender());
		overlayHandle = this.ctx.ui.showOverlay(component, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		if (closeRequestedEarly) {
			done();
			return;
		}
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	showSettingsSelector(initialItemId?: string): void {
		Promise.all([
			getAvailableThemes(),
			resolveAvailablePersonalities({ cwd: getProjectDir() }),
			// Asked BEFORE the panel is built: the rollback row is offered only on
			// an install that can actually perform one, and a source checkout
			// cannot. Showing it there would put a row in front of the operator
			// whose only outcome is a refusal.
			isRollbackSupported(),
		]).then(([availableThemes, availablePersonalities, rollbackSupported]) => {
			// Fullscreen settings editor on the alternate screen: the overlay
			// enables mouse tracking (click/hover/wheel) for its lifetime and
			// the transcript stays untouched underneath.
			let overlayHandle: OverlayHandle | undefined;
			// Declared before `done` closes over it: the card is constructed with
			// callbacks that can reach `done`, so a `const` below this point would
			// be a temporal-dead-zone throw on a close that races construction.
			let selector: SettingsSelectorComponent | undefined;
			const done = () => {
				overlayHandle?.hide();
				// Everything the card registered with the shared clock goes with it.
				selector?.dispose();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: this.ctx.session.getAvailableThinkingLevels().slice(),
					thinkingLevel: this.ctx.session.thinkingLevel,
					availableThemes,
					availablePersonalities,
					providers: Array.from(new Set(this.ctx.session.getAvailableModels().map(model => model.provider))).sort(
						(a, b) => a.localeCompare(b),
					),
					cwd: getProjectDir(),
					model: this.ctx.session.model,
					imageBudget: this.ctx.ui.imageBudget,
					requestRender: () => this.ctx.ui.requestRender(),
					modelRegistry: this.ctx.session.modelRegistry,
					availableModels: this.ctx.session.getAvailableModels(),
				},
				{
					onChange: (id, value) => this.handleSettingChange(id, value),
					onOpenUrl: url => openPath(url),
					// Supplying this is what makes the "Roll back version" row appear.
					// The install runs AFTER the overlay is torn down, because it
					// prints progress and can fail with a message worth reading, none
					// of which survives painting under a screen about to be restored.
					onRollback: rollbackSupported ? version => rollbackToVersion(version) : undefined,
					onError: message => this.ctx.showWarning(message),
					onThemePreview: async themeName => {
						const result = await previewTheme(themeName);
						if (result.success) {
							this.ctx.statusLine.invalidate();
							this.ctx.ui.invalidate();
							this.ctx.ui.requestRender();
						}
					},
					onStatusLinePreview: previewSettings => {
						this.ctx.statusLine.updateSettings({ ...statusLineSettingsFromConfig(), ...previewSettings });
						this.ctx.ui.requestRender();
					},
					getStatusLinePreview: (previewWidth?: number) => {
						// Preview the quiet composer zones (what the operator actually sees),
						// two rows: location above, capability below.
						const width =
							previewWidth ?? this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
						const { locationLine, capabilityLine } = this.ctx.statusLine.renderQuietLines(width);
						return `${locationLine}\n${capabilityLine}`;
					},
					onPluginsChanged: async () => {
						const projectPath = await resolveActiveProjectRegistryPath(this.ctx.sessionManager.getCwd());
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await this.ctx.refreshSlashCommandState();
						await this.ctx.session.refreshSshTool({ activateIfAvailable: true });
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						this.ctx.statusLine.updateSettings(statusLineSettingsFromConfig());
						this.ctx.ui.requestRender();
					},
				},
				initialItemId,
			);
			overlayHandle = this.ctx.ui.showOverlay(selector, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(selector);
			this.ctx.ui.requestRender();
		});
	}

	/**
	 * Fullscreen `/advisor configure` overlay: edit a `WATCHDOG.yml` advisor roster
	 * and apply it to the session already on screen.
	 *
	 * The overlay owns scope switching, so the host seeds the project doc and answers
	 * `loadDoc` when the user moves between project and user level. `save` writes the
	 * one file that was edited, then re-discovers the MERGED project+user roster and
	 * hands it to `applyAdvisorConfigs`, so an edit lands in the running conversation
	 * rather than at the next launch, and a project advisor that shadows a user one of
	 * the same slug keeps shadowing it after the write.
	 */
	async showAdvisorConfigure(): Promise<void> {
		const dirs = {
			projectDir: this.ctx.sessionManager.getCwd(),
			agentDir: this.ctx.settings.getAgentDir(),
		};
		const loadDoc = async (scope: AdvisorConfigScope): Promise<WatchdogConfigDoc> =>
			loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs));
		let doc: WatchdogConfigDoc;
		try {
			doc = await loadDoc("project");
		} catch (err) {
			this.ctx.showError(`Failed to read the advisor configuration: ${errorMessage(err)}`);
			return;
		}
		let availableToolNames: string[];
		try {
			availableToolNames = await this.ctx.session.getAdvisorAvailableToolNames();
		} catch (err) {
			this.ctx.showError(`Failed to build the advisor tools: ${errorMessage(err)}`);
			return;
		}
		const advisorHelper = this.ctx.session.resolveHelperModel("advisor");
		let overlay: OverlayHandle | undefined;
		const component = new AdvisorConfigOverlayComponent(
			this.ctx.ui,
			{
				modelRegistry: this.ctx.session.modelRegistry,
				settings: this.ctx.settings,
				scopedModels: this.ctx.session.scopedModels,
				availableToolNames,
				defaultModelLabel: advisorHelper
					? formatModelSelectorValue(
							formatModelStringWithRouting(advisorHelper.model),
							advisorHelper.thinkingLevel,
						)
					: undefined,
			},
			"project",
			doc,
			{
				loadDoc,
				save: async (scope, next) => {
					await saveWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs), next);
					const merged = await discoverAdvisorConfigs(dirs.projectDir, dirs.agentDir);
					const live = this.ctx.session.applyAdvisorConfigs(merged.advisors, merged.sharedInstructions);
					this.ctx.showStatus(
						this.ctx.session.isAdvisorEnabled()
							? `Advisor configuration saved — ${live} advisor${live === 1 ? "" : "s"} running.`
							: "Advisor configuration saved. The advisor is off; turn it on with /advisor on.",
					);
				},
				close: () => {
					overlay?.hide();
					this.focusActiveEditorArea();
					this.ctx.ui.requestRender();
				},
				requestRender: () => {
					this.ctx.ui.requestRender();
				},
				notify: message => {
					this.ctx.showStatus(message);
				},
			},
		);
		overlay = this.ctx.ui.showOverlay(component, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(component);
		this.ctx.ui.requestRender();
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showModalSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	/**
	 * Thinking-effort picker for the interactive session.
	 *
	 * The control follows the active model's valid variant list, including
	 * narrower families such as low/high-only models.
	 */
	showThinkingSelector(): void {
		const model = this.ctx.session.model;
		if (!hasConfigurableThinkingEffort(model)) {
			this.ctx.showStatus("This model does not expose configurable reasoning effort.");
			return;
		}
		const currentLevel = this.ctx.session.sessionThinkingOverride;
		this.showModalSelector(done => {
			const component = new ThinkingSelectorComponent(
				currentLevel,
				model,
				level => {
					this.ctx.session.setThinkingLevel(level);
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorBorderColor();
					done();
				},
				() => done(),
			);
			return { component, focus: component };
		});
	}

	/**
	 * The subcommand picker a bare `/cmd` opens.
	 *
	 * `done()` runs BEFORE `onSelect`, so the card is gone by the time the chosen subcommand runs.
	 * A subcommand may open a screen of its own (`/account manager`) or prefill the editor, and
	 * both would be drawn underneath a picker that was still up.
	 */
	showSubcommandPicker(
		commandName: string,
		subcommands: readonly SubcommandDef[],
		onSelect: (subcommand: SubcommandDef) => void,
	): void {
		this.showModalSelector(done => {
			const component = new SubcommandPickerComponent(
				commandName,
				subcommands,
				subcommand => {
					done();
					onSelect(subcommand);
				},
				() => done(),
			);
			return { component, focus: component };
		});
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows);
		// Fullscreen dashboard on the alternate screen (the /settings idiom): the
		// overlay borrows the terminal's alt buffer and enables mouse tracking for
		// its lifetime, leaving the transcript untouched underneath.
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		dashboard.onClose = () => {
			overlay.hide();
			// The list band and the tab band live on the shared clock; hiding the overlay does not
			// tell them that.
			dashboard.dispose();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.setOnRequestRender(() => {
			this.ctx.ui.requestRender();
		});
	}

	/**
	 * Show the agent dashboard: the ONE agent surface.
	 *
	 * Every entry point lands here — `/agents`, `/cockpit` (alias `/hub`), the
	 * `app.agents.hub` and `app.session.observe` keys, and the editor's `←←`
	 * gesture — because they were three separate rosters that could disagree
	 * about what was running.
	 *
	 * `requireContent` is the gesture's gate: `←←` on an empty editor must stay
	 * inert until there is an agent to look at, while an explicit key still
	 * opens the empty roster. Agents persisted by earlier runs register
	 * asynchronously, so the gate waits for that scan rather than treating the
	 * initial roster as the answer.
	 *
	 * The card is always scoped to the conversation on screen. A conversation
	 * this process is still running off-screen is counted by the status line,
	 * and its roster is not reachable from here.
	 */
	showAgentsDashboard(observers: SessionObserverRegistry, options?: { requireContent?: boolean }): void {
		const dashboard = new AgentDashboard({
			terminalHeight: this.ctx.ui.terminal.rows,
			// The comms stream expands a folded message with the same key the
			// transcript expands a truncated tool result with.
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
			hubKeys: [
				...this.ctx.keybindings.getKeys("app.agents.hub"),
				...this.ctx.keybindings.getKeys("app.session.observe"),
			],
			registry: this.ctx.collabGuest?.agentRegistry,
			remote: this.ctx.collabGuest?.agentRemote,
			observers,
			showModelBadge: settings.get("agent.showResolvedModelBadge"),
			sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
			// The roster is this conversation's, not the process's. Without it a
			// session resumed with `/resume` listed the agents of every
			// conversation the process had driven before it.
			scope: this.ctx.sessionManager.getSessionId(),
			focusAgent: id => this.ctx.focusAgentSession(id),
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
		});
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};

		const show = () => {
			// Fullscreen dashboard on the alternate screen (the /settings idiom): the
			// overlay borrows the terminal's alt buffer and enables mouse tracking for
			// its lifetime, leaving the transcript untouched underneath. The card
			// itself floats within this via ModalShell LARGE (see agent-dashboard.ts).
			const overlay = this.ctx.ui.showOverlay(dashboard, {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				margin: 0,
				fullscreen: true,
			});
			dashboard.onClose = () => {
				// The card subscribes to the process-global registry and bus; without
				// this it would keep rebuilding a layout nobody is looking at, once per
				// agent event and once per message, for the rest of the session.
				dashboard.dispose();
				overlay.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			this.ctx.ui.requestRender();
		};

		if (options?.requireContent && dashboard.isEmpty) {
			void dashboard.persistedAgentsReady.then(() => {
				if (dashboard.isEmpty) {
					dashboard.dispose();
					return;
				}
				show();
			});
			return;
		}
		show();
	}

	/**
	 * Apply the live side effect of a settings-UI flip. The selector has already stored the value;
	 * `setting-effects.ts` holds what each setting needs beyond that.
	 */
	handleSettingChange(id: string, value: unknown): void | Promise<void> {
		// A prompt gate this session captured at startup cannot follow the flip. The settings UI
		// shows the new value either way, so without this notice an applied change and one that
		// did nothing look the same.
		//
		// THE REBUILD ITSELF IS NOT TRIGGERED HERE. It follows the WRITE, in `AgentSession`'s
		// effective-setting listener, which asks the same registry
		// (`system-prompt-builder/gate-registry.ts`), so a write from a slash command, an SDK or
		// ACP host or a plugin rebuilds the prompt as this UI does.
		const frozen = frozenGateNotice(id);
		if (frozen !== undefined) this.ctx.showWarning(frozen);
		return settingEffect(id)?.(this.ctx, value);
	}

	showModelSelector(options?: { temporaryOnly?: boolean; query?: string }): void {
		this.#showModelPicker(options?.temporaryOnly === true, options?.query);
	}

	/**
	 * Compact session model picker (alt+p / `/switch` / `/model`): a floating
	 * bottom-anchored overlay over the transcript. `query` seeds its search,
	 * which is how `/model <query>` reaches the models it names.
	 */
	#showModelPicker(temporaryOnly: boolean, query?: string): void {
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		const current = this.ctx.session.model;
		this.showModalSelector(done => {
			const picker = new ModelPickerComponent(
				this.ctx.ui,
				this.ctx.settings,
				this.ctx.session.modelRegistry,
				this.ctx.session.scopedModels,
				{
					onPick: async (model, selector) => {
						try {
							const selectedThinking = this.ctx.session.resolveTemporaryModelThinkingLevel(model);
							if (temporaryOnly) {
								await this.ctx.session.setModelTemporary(model, selectedThinking);
								this.ctx.showStatus(`Session-only model: ${selector}`);
							} else {
								await this.ctx.session.setModel(model, "default", {
									selector,
									thinkingLevel: selectedThinking,
									persist: true,
									currentContextTokens,
								});
								this.ctx.showStatus(`Model: ${selector}`);
							}
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							done();
						} catch (error) {
							this.ctx.showError(errorMessage(error));
						}
					},
					onCancel: done,
				},
				{
					currentContextTokens,
					currentSelector: current ? `${current.provider}/${current.id}` : undefined,
					initialQuery: query,
				},
			);
			return { component: picker, focus: picker };
		});
	}

	/**
	 * Fullscreen model hub on the alternate screen (the /settings idiom): the
	 * overlay enables mouse tracking for its lifetime and the transcript stays
	 * untouched underneath. `initialProviderId` preselects a provider's sidebar
	 * entry — used when reopening the hub after a /login round-trip.
	 */
	#showModelHub(hubOptions: { initialProviderId?: string }): void {
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		let overlayHandle: OverlayHandle | undefined;
		let hub: ModelHubComponent | undefined;
		let closed = false;
		const done = () => {
			// Re-entrant guard: cancel paths (Esc, login forward) may race;
			// the overlay must hide exactly once.
			if (closed) return;
			closed = true;
			hub?.dispose();
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		hub = new ModelHubComponent(
			this.ctx.ui,
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onSetDefault: async (model, thinkingLevel, selector) => {
					const selectedThinking =
						thinkingLevel === undefined || thinkingLevel === ThinkingLevel.Inherit ? undefined : thinkingLevel;
					try {
						const { switched } = await this.ctx.session.setModel(model, "default", {
							selector,
							thinkingLevel: selectedThinking,
							persist: true,
							currentContextTokens,
						});
						if (switched) {
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
						}
						this.ctx.showStatus(`Default model: ${selector}`);
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					}
				},
				onClearDefault: () => {
					try {
						this.ctx.settings.setDefaultModel(undefined);
						this.ctx.showStatus("Default model cleared — launch auto-selects a model");
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					}
				},
				onFallbackChainChange: (key, chain) => {
					try {
						const chains = { ...this.ctx.settings.get("retry.fallbackChains") };
						if (chain.length === 0) {
							delete chains[key];
						} else {
							chains[key] = chain;
						}
						this.ctx.settings.set("retry.fallbackChains", chains);
						const label = key === "default" ? "Default model" : key;
						this.ctx.showStatus(
							chain.length > 0 ? `${label} fallbacks: ${chain.join(" → ")}` : `${label} fallbacks cleared`,
						);
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					}
				},
				onLoginRequest: providerId => {
					done();
					void this.#loginThenReopenModelHub(providerId);
				},
				onCancel: () => done(),
			},
			{
				initialProviderId: hubOptions.initialProviderId,
			},
		);
		overlayHandle = this.ctx.ui.showOverlay(hub, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(hub);
		this.ctx.ui.requestRender();
	}

	/** /login round-trip for a locked provider; reopen the hub on that provider only after a successful login. */
	async #loginThenReopenModelHub(providerId: string): Promise<void> {
		// The hub replaces the screen, so it opens only on a login that has
		// something new to show. A failure leaves its error readable instead.
		if ((await this.#accounts.login(providerId)) === "stored") {
			this.#showModelHub({ initialProviderId: providerId });
		}
	}

	async showPluginSelector(_mode: "install" | "uninstall" = "install"): Promise<void> {
		this.ctx.showStatus("Marketplace plugins were removed. Use `veyyon plugin install` for npm/git/local plugins.");
	}

	showUserMessageSelector(): void {
		const userMessages = this.ctx.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		this.showModalSelector(done => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map(m => ({ id: m.entryId, text: m.text })),
				async entryId => {
					const result = await this.ctx.session.branch(entryId);
					if (result.cancelled) {
						// Hook cancelled the branch
						done();
						this.ctx.ui.requestRender();
						return;
					}

					this.ctx.renderInitialMessages({ clearTerminalHistory: true });
					this.ctx.editor.setText(result.selectedText);
					done();
					this.ctx.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	showCopySelector(): void {
		const targets = buildCopyTargets(this.ctx.session);
		if (targets.length === 0) {
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}

		this.showModalSelector(done => {
			const selector = new CopySelectorComponent(targets, {
				onPick: target => {
					done();
					if (target.content === undefined) return;
					void copyToClipboard(target.content);
					this.ctx.showStatus(target.copyMessage ?? "Copied to clipboard");
				},
				onCancel: done,
			});
			return { component: selector, focus: selector };
		});
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.showModalSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				async entryId => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.ctx.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						const result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

						// Update UI — rebuild the display transcript for the new leaf (the
						// context from navigateTree is the LLM context, not the transcript).
						this.ctx.renderInitialMessages({ clearTerminalHistory: true });
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setText(result.editorText);
						}
						this.ctx.showStatus("Navigated to selected point");
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.disposeChildren();
						}
						this.ctx.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	showSessionSelector(): Promise<void> {
		return this.#sessions.showSessionSelector();
	}

	handleResumeSession(sessionPath: string): Promise<void> {
		return this.#sessions.handleResumeSession(sessionPath);
	}

	handleSessionDeleteCommand(): Promise<void> {
		return this.#sessions.handleSessionDeleteCommand();
	}

	/** `/login` and `/account login`; see {@link AccountFlows.showLogin}. */
	showLogin(providerId?: string): Promise<void> {
		return this.#accounts.showLogin(providerId);
	}

	/** `/logout` and `/account logout`; see {@link AccountFlows.showLogout}. */
	showLogout(providerId?: string): Promise<void> {
		return this.#accounts.showLogout(providerId);
	}

	showAccountManager(providerId?: string): Promise<void> {
		return this.#accounts.showAccountManager(providerId);
	}

	showResetUsageSelector(): Promise<void> {
		return this.#accounts.showResetUsageSelector();
	}

	async showDebugSelector(): Promise<void> {
		const { DebugSelectorComponent } = await import("../../../debug");
		this.showModalSelector(done => {
			const selector = new DebugSelectorComponent(this.ctx, done);
			return { component: selector, focus: selector };
		});
	}
}
