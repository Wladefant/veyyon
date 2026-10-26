/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as path from "node:path";
import { type Agent, type AgentMessage, EventLoopKeepalive, ThinkingLevel } from "@veyyon/agent-core";
import type { CompactionOutcome } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Usage, UsageReport } from "@veyyon/ai";
import type { HostNotifier } from "@veyyon/host";
import type { CompactMode } from "@veyyon/kernel/session/compact-modes";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { getRecentSessions } from "@veyyon/kernel/session/session-listing";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { ShakeMode } from "@veyyon/kernel/session/shake-types";
import {
	type Component,
	Container,
	clearRenderCache,
	type EditorTheme,
	Loader,
	type NativeScrollbackLiveRegion,
	type OverlayOptions,
	ProcessTerminal,
	Spacer,
	setTerminalTextSizing,
	TERMINAL,
	Text,
	TUI,
} from "@veyyon/tui";
import { isInsideTerminalMultiplexer } from "@veyyon/tui/terminal-capabilities";
import { APP_NAME, errorMessage, getProjectDir, logger, postmortem } from "@veyyon/utils";
import type { AutocompleteProvider, SlashCommand } from "@veyyon/utils/autocomplete";
import { matchesKey } from "@veyyon/utils/keys";
import { planPaintGround } from "@veyyon/utils/paint-ground";
import { setTuiTight } from "@veyyon/utils/tight-mode";
import chalk from "chalk";
import type { CollabGuestLink } from "../../collab/guest";
import type { CollabHost } from "../../collab/host";
import { KeybindingsManager } from "../../config/keybindings";
import { recordLaunchFacts } from "../../config/launch-facts";
import {
	isSettingsInitialized,
	type QuarantinedSettingsFile,
	Settings,
	type SettingsSaveFailure,
	settings,
} from "../../config/settings";
import { onStatusLineSessionAccentChanged } from "../../config/settings-signals";
import type {
	AutocompleteProviderFactory,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../../extensibility/extensions";
import type { CompactOptions } from "../../extensibility/extensions/types";
import type { Skill } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../../lsp/startup-events";
import type { MCPManager } from "../../mcp";
import {
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "../../mcp/startup-events";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import { StatusPresentationProducer } from "../../presentation/status-producer";
import { requestsPrompts } from "../../prompts/requests/rows";
import type { AgentRegistry } from "../../registry/agent-registry";
import { formatProviderName } from "../../session/account-format";
import type { AgentSession } from "../../session/agent-session";
import { SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../../session/agent-session-types";
import {
	BackgroundSessions,
	type KeptSession,
	type NextSessionFactory,
	type SessionHostBindings,
} from "../../session/background-sessions";
import { setImageDisplayProbe } from "../../session/image-visibility";
import { isAtRestReadingDeferred, takeHeldAtRestReading, toolSchemaWarmSteps } from "../../session/non-message-tokens";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "../../slash-commands/builtin-declarations";
import { buildTuiBuiltinSlashCommands } from "../../slash-commands/builtin-registry";
import type { SubcommandDef } from "../../slash-commands/types";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../../system-prompt";
import { applyGroundPaint, getDetectedTerminalGround, setDetectedTerminalGround } from "../../theme/ground-tints";
import { setMarkdownMermaidRendering } from "../../theme/markdown-theme";
import { clearMermaidCache } from "../../theme/mermaid-cache";
import {
	getCurrentThemeName,
	getEditorTheme,
	getSymbolTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	type Theme,
	theme,
} from "../../theme/theme";
import type { LspStartupServerInfo } from "../../tools";
import { hasForegroundBashWait, onForegroundBashWaitChange } from "../../tools/shell/bash-foreground-registry";
import type { EventBus } from "../../utils/event-bus";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../utils/session-color";
import { messageHasDisplayableThinking } from "../../utils/thinking-display";
import { popTerminalTitle, pushTerminalTitle, setSessionTerminalTitle } from "../../utils/title-generator";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	describeLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitRuntime,
	parseLoopLimitArgs,
} from "../loop-limit";
import { modalRevealGround, pointerMotionEnabled } from "./components/chrome/modal-shell";
import { renderSunsetField } from "./components/chrome/sun";
import {
	applyComposerChrome,
	COMPOSER_INSET_COLS,
	ComposerHairline,
	computeEditorMaxHeight,
	draftTokenZone,
	mountComposerZone,
	PRISTINE_COMPOSER_ACCENT_STATE,
	QuietZoneLine,
	resolveComposerAccents,
} from "./components/composer/composer-chrome";
import { buildComposerShortcuts, ComposerShortcutsBar } from "./components/composer/composer-shortcuts";
import { CustomEditor } from "./components/composer/custom-editor";
import type { HookEditorComponent } from "./components/dialogs/hook-editor";
import type { HookInputComponent } from "./components/dialogs/hook-input";
import type { HookSelectorComponent, HookSelectorSlider } from "./components/selectors/hook-selector";
import { StatusLineComponent } from "./components/status-line";
import { statusLineSettingsFromConfig } from "./components/status-line/quiet-row";
import type { AssistantMessageComponent } from "./components/transcript/assistant-message";
import type { BashExecutionComponent } from "./components/transcript/bash-execution";
import { ChatBlock, type ChatBlockHost } from "./components/transcript/chat-block";
import { ErrorBannerComponent } from "./components/transcript/error-banner";
import type { EvalExecutionComponent } from "./components/transcript/eval-execution";
import type { ToolExecutionHandle } from "./components/transcript/tool-execution";
import { reportBlock } from "./components/transcript/transcript-block-chrome";
import { TranscriptContainer } from "./components/transcript/transcript-container";
import { AnchoredBlocks } from "./controllers/anchored-blocks";
import { BtwController } from "./controllers/btw-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { GoalModeController } from "./controllers/goal-mode-controller";
import { HomeAnchorLayout } from "./controllers/home-anchor-layout";
import { InputController } from "./controllers/input-controller";
import { OmfgController } from "./controllers/omfg-controller";
import { PlanModeController } from "./controllers/plan-mode-controller";
import type { SelectorController } from "./controllers/selector-controller";
import { SessionFocusController } from "./controllers/session-focus-controller";
import { TranscriptComposer } from "./controllers/transcript-composer";
import { VibeModeController } from "./controllers/vibe-mode-controller";
import { VoiceController } from "./controllers/voice-controller";
import { WelcomeController } from "./controllers/welcome-controller";
import { WorkingLoaderController } from "./controllers/working-loader";
import { TerminalPresentationDriver } from "./driver";
import { type FirstFrame, takeFirstFrame } from "./first-frame";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { countRunningAgentBadgeAgents, getRunningAgentBadgeRegistry } from "./running-agent-badge";
import { SessionObserverRegistry } from "./session-observer-registry";
import { createSessionTeardown, type SessionTeardown } from "./session-teardown";
import { runProviderSetupWizard } from "./setup-wizard/lazy";
import { consumeRelaunchMarker, flushPendingTtyInput, RELAUNCH_MARKER } from "./tty-input-flush";
import type {
	CompactionQueuedMessage,
	InteractiveModeContext,
	InteractiveSelectorDialogOptions,
	PlanReviewDialogOptions,
	SubmittedUserInput,
	TodoItem,
	TodoPhase,
} from "./types";
import { focusEditorSlot } from "./utils/interactive-context-helpers";
import { createSelectionAttemptNotice } from "./utils/selection-notice";
import { UiHelpers } from "./utils/ui-helpers";

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

/**
 * Anchored live-region container for the HUD/status rows between the transcript
 * and the editor (working loader, todo + agent HUDs, transient notification
 * panels). While it has content every row is live: it reports a seam at 0 so the
 * engine never commits these anchored, rebuilt-in-place rows to native
 * scrollback — otherwise stale duplicates pile up above the live copy on short
 * terminals once the loader sits below a tall HUD. The transcript's own seam,
 * when present, sits higher and wins (topmost-seam merge in TUI.render).
 */
class AnchoredLiveContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}
}

/** How long the ctrl+p model cycle chip track lingers above the editor
 *  before it auto-clears, mirroring the todo HUD's auto-clear timer. */
const MODEL_CYCLE_TRACK_CLEAR_MS = 4000;

export class InteractiveMode implements InteractiveModeContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;
	/**
	 * Set by the interactive host at startup. Its absence is what makes `/new`
	 * reset the current session in place instead of handing it off.
	 */
	createNextSession?: NextSessionFactory;

	ui: TUI;
	readonly presentation: TerminalPresentationDriver;
	chatContainer: TranscriptContainer;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	agentContainer: Container;
	btwContainer: Container;
	omfgContainer: Container;
	errorBannerContainer: Container;
	modelCycleContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	composerShortcuts: ComposerShortcutsBar;
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusProducer: StatusPresentationProducer;
	statusLine: StatusLineComponent;
	composerHairline: ComposerHairline;
	capabilityLine: QuietZoneLine;

	isInitialized = false;
	initialChatRendered = false;
	isBashMode = false;
	toolOutputExpanded = false;
	todoExpanded = false;
	get planModeEnabled(): boolean {
		return this.#planMode.enabled;
	}
	set planModeEnabled(value: boolean) {
		this.#planMode.enabled = value;
	}
	get planModePaused(): boolean {
		return this.#planMode.paused;
	}
	set planModePaused(value: boolean) {
		this.#planMode.paused = value;
	}
	get goalModeEnabled(): boolean {
		return this.#goalMode.enabled;
	}
	set goalModeEnabled(value: boolean) {
		this.#goalMode.enabled = value;
	}
	get goalModePaused(): boolean {
		return this.#goalMode.paused;
	}
	set goalModePaused(value: boolean) {
		this.#goalMode.paused = value;
	}
	get vibeModeEnabled(): boolean {
		return this.#vibeMode.enabled;
	}
	set vibeModeEnabled(value: boolean) {
		this.#vibeMode.enabled = value;
	}
	get planModePlanFilePath(): string | undefined {
		return this.#planMode.planFilePath;
	}
	set planModePlanFilePath(value: string | undefined) {
		this.#planMode.planFilePath = value;
	}
	loopModeEnabled = false;
	loopPrompt: string | undefined = undefined;
	loopLimit: LoopLimitRuntime | undefined = undefined;
	#loopAutoSubmitTimer: NodeJS.Timeout | undefined;
	#modelCycleClearTimer: NodeJS.Timeout | undefined;
	todoPhases: TodoPhase[] = [];
	hideThinkingBlock = false;
	#sessionsWithDisplayableThinkingContent = new WeakSet<AgentSession>();
	/** Whether the visible session has produced thinking content the user can reveal. */
	get hasDisplayableThinkingContent(): boolean {
		return this.#sessionsWithDisplayableThinkingContent.has(this.viewSession);
	}
	/** Record received reasoning content so Ctrl+T can reveal it even when model metadata says thinking is off. */
	noteDisplayableThinkingContent(message: AgentMessage): boolean {
		if (this.hasDisplayableThinkingContent || !messageHasDisplayableThinking(message, this.proseOnlyThinking)) {
			return false;
		}
		this.#sessionsWithDisplayableThinkingContent.add(this.viewSession);
		return true;
	}
	/**
	 * Effective thinking-block visibility: hidden when the user's setting is on,
	 * or while thinking is "off" before the session has actually produced
	 * displayable thinking content. Some providers return thinking blocks without
	 * advertising reasoning support, so observed content unlocks the visibility
	 * toggle.
	 */
	get effectiveHideThinkingBlock(): boolean {
		const thinkingOff = (this.viewSession?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		return this.hideThinkingBlock || (thinkingOff && !this.hasDisplayableThinkingContent);
	}
	proseOnlyThinking = true;
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
	settledToolCalls = new Set<string>();
	pendingBashComponents: BashExecutionComponent[] = [];
	bashComponent: BashExecutionComponent | undefined = undefined;
	pendingPythonComponents: EvalExecutionComponent[] = [];
	pythonComponent: EvalExecutionComponent | undefined = undefined;
	isPythonMode = false;
	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;
	lastAssistantUsage: Usage | undefined = undefined;
	get loadingAnimation(): Loader | undefined {
		return this.#workingLoader.loader;
	}
	autoCompactionLoader: Loader | undefined = undefined;
	retryLoader: Loader | undefined = undefined;
	#clockTimer: NodeJS.Timeout | undefined;
	readonly #workingLoader: WorkingLoaderController;
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	// Optimistic-message + local-echo + rebuild state lives in the composer
	// (ARCH-2); these accessors keep the InteractiveModeContext contract.
	get optimisticUserMessageSignature(): string | undefined {
		return this.#transcriptComposer.optimisticSignature;
	}
	get locallySubmittedUserSignatures(): Set<string> {
		return this.#transcriptComposer.localEchoSignatures;
	}
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	/** Whether an edit queued the held at-rest reading for the next committed frame. */
	#atRestReadingQueued = false;
	lastSigintTime = 0;
	lastEscapeTime = 0;
	lastLeftTapTime = 0;
	shutdownRequested = false;
	#isShuttingDown = false;
	#relaunchSpec: { argv: string[]; env?: Record<string, string | undefined> } | undefined;
	/** Unsubscribe for the swallow-everything input gate shutdown() installs. */
	#shutdownInputGateRelease: (() => void) | undefined;
	/** Unsubscribe for the swallow-everything input gate `init()` installs
	 *  across the tty handover. Released once startup completes. */
	#startupInputGateRelease: (() => void) | undefined;
	/** True once `shutdown()` has begun teardown. Surfaced to the input
	 *  controller so a Ctrl+C arriving while teardown is in flight can hard-
	 *  abort the remaining work instead of stacking another no-op call. */
	get isShuttingDown(): boolean {
		return this.#isShuttingDown;
	}
	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, Skill> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;

	#pendingSlashCommands: SlashCommand[] = [];
	/** Built-in editor autocomplete provider, before extension wrapping. */
	#baseAutocompleteProvider: AutocompleteProvider | undefined;
	/** Extension-registered provider factories, applied in registration order (#4919). */
	#autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
	#cleanupUnsubscribe?: () => void;
	#signalTeardown?: SessionTeardown;
	readonly #version: string;
	readonly #planMode: PlanModeController;
	readonly #vibeMode: VibeModeController;
	readonly #anchoredBlocks: AnchoredBlocks;
	readonly lspServers: LspStartupServerInfo[] | undefined = undefined;
	mcpManager?: MCPManager;
	/**
	 * The host bindings of every session this screen has displayed. A session
	 * reclaimed from the background was displayed here before, so attaching it
	 * again finds its bindings without the caller holding them.
	 */
	readonly #hostBindings = new WeakMap<AgentSession, SessionHostBindings>();

	readonly #btwController: BtwController;
	readonly #omfgController: OmfgController;
	readonly #commandController: CommandController;
	readonly #eventController: EventController;
	get eventController(): EventController {
		return this.#eventController;
	}
	get eventBus(): EventBus | undefined {
		return this.#eventBus;
	}
	readonly #extensionUiController: ExtensionUiController;
	readonly #inputController: InputController;
	/**
	 * The selector cards and panels (settings, models, accounts, sessions, dashboards) and the modules
	 * they draw with load when the first one opens, so an idle session holds none of them. Once loaded, a
	 * card opens synchronously, as it did before the load was deferred.
	 */
	#selectorController: SelectorController | undefined;
	#selectorLoad: Promise<SelectorController> | undefined;
	readonly #focusController: SessionFocusController;
	get viewSession(): AgentSession {
		return this.#focusController.target ?? this.session;
	}
	get focusedAgentId(): string | undefined {
		return this.#focusController.focusedAgentId;
	}
	get sessionName(): string | undefined {
		return this.session.sessionName;
	}
	focusAgentSession(id: string): Promise<void> {
		return this.#focusController.focusAgent(id);
	}
	focusParentSession(): Promise<void> {
		return this.#focusController.focusParent();
	}
	unfocusSession(): Promise<void> {
		return this.#focusController.unfocus();
	}
	clearTransientSessionUi(): void {
		this.#workingLoader.abandon();
		if (this.autoCompactionLoader) {
			this.autoCompactionLoader.stop();
			this.autoCompactionLoader = undefined;
		}
		if (this.retryLoader) {
			this.retryLoader.stop();
			this.retryLoader = undefined;
		}
		this.statusContainer.disposeChildren();
		this.pendingMessagesContainer.disposeChildren();
		this.#cancelModelCycleClearTimer();
		this.modelCycleContainer.disposeChildren();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.lastAssistantUsage = undefined;
		this.pendingTools.clear();
		this.settledToolCalls.clear();
		// A pinned error banner belongs to the turn that failed, in ONE session.
		// `resetTranscriptAnchors` already drops the transcript component the
		// banner mirrors, so leaving the container alone left a banner on screen
		// with nothing behind it: the main session's failure stayed pinned above
		// the composer for the whole time the view was inside an agent, and an
		// agent's failure stayed pinned after Esc returned to main.
		this.clearPinnedError();
		// The agent HUD is scoped to the VIEWED session, and every focus
		// attach/detach (both directions, including the registry-driven
		// auto-unfocus when the viewed agent dies) runs through here after the
		// focus controller has already swapped the target. Re-derive the block
		// against the new view, or the focused view keeps the parent's rows and
		// the restored main view keeps the cleared ones until the next spawn
		// event happens to land.
		if (this.agentContainer) this.#anchoredBlocks.renderAgentList();
		// Todos are per-session state (`AgentSession#todoPhases`), and the todo
		// HUD is the loudest block above the composer. Every OTHER session switch
		// (new, resume, branch, handoff, collab welcome) reloads it explicitly;
		// the focus transitions never did, so the focused view kept painting the
		// driving session's board as if the agent owned it. Same choke point, so
		// the surface cannot drift out of step with the HUD beside it.
		if (this.todoContainer) this.#anchoredBlocks.syncTodoSurfaceToView();
		// The running-agent badge counts the same set the HUD lists, one number
		// wide, so it re-scopes here too.
		this.syncRunningAgentBadge({ requestRender: false });
		// The composer chip band advertises keys whose meaning changes with the
		// view: `esc` interrupts in the main session and leaves the view inside an
		// agent, and the dequeue key always drains the DRIVING session's queue.
		// Rebuilt here so a focus transition cannot leave the wrong pair on screen.
		if (this.composerShortcuts) this.#refreshComposerShortcuts();
	}
	readonly #uiHelpers: UiHelpers;
	readonly #voiceController: VoiceController;
	readonly #goalMode: GoalModeController;
	#resizeHandler?: () => void;
	/** Owns the home-screen anchor fills and their sizing (ARCH-2 extraction);
	 *  every fill row on screen is sized in the layout controller, never here.
	 *  Constructed in the constructor (the port closes over `this`). */
	#layout!: HomeAnchorLayout;
	#transcriptComposer!: TranscriptComposer;
	#observerRegistry: SessionObserverRegistry;
	#eventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	#agentRegistryUnsubscribe?: () => void;
	/**
	 * Unsubscribe for the foreground-bash registry. The `ctrl+b background` chip
	 * has to appear the moment a command starts waiting and vanish the moment it
	 * settles, and neither edge coincides with a draft/busy/queue transition, so
	 * the bar cannot be refreshed off those alone.
	 */
	#bashForegroundUnsubscribe?: () => void;
	#backgroundSessionsUnsubscribe?: () => void;
	#agentRegistrySubscriptionTarget?: AgentRegistry;
	#mcpPendingServers = new Set<string>();
	#mcpConnectedServers = new Set<string>();
	#mcpFailedServers = new Map<string, { error: string; foreign: boolean }>();
	/** Owns the startup hero and the full `/welcome` card (ARCH-2 extraction);
	 *  the fill/anchor math stays here, reached through the layout port.
	 *  Constructed in the constructor (the port closes over `this`). */
	#welcomeController!: WelcomeController;
	// Component-scoped: a ChatBlock (e.g. the MCP "Connecting..." spinner) ticks
	// its own animation on a fixed cadence inside a possibly large transcript; a
	// full requestRender() would re-walk that whole tree per tick purely to
	// advance the block's own glyph.
	readonly #chatHost: ChatBlockHost = {
		requestComponentRender: component => this.ui.requestComponentRender(component),
	};

	/**
	 * The screen the launch card was already painted on, when this process
	 * painted one (`first-frame.ts`). Held so `init` can drop the placeholder
	 * rows, remount that same card, and release the input gate the frame
	 * installed. Undefined in every other case, and the mode then builds its
	 * own screen and owns the tty handover itself.
	 */
	readonly #firstFrame: FirstFrame | undefined = takeFirstFrame();

	constructor(
		session: AgentSession,
		version: string,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: LspStartupServerInfo[] | undefined = undefined,
		mcpManager?: MCPManager,
		eventBus?: EventBus,
		setToolNotifier: (notify: HostNotifier) => void = () => {},
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		this.keybindings = this.#firstFrame?.keybindings ?? KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#hostBindings.set(session, { setToolUIContext, setToolNotifier });
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.#eventBus = eventBus;
		this.#planMode = new PlanModeController(this);
		this.#vibeMode = new VibeModeController(this);
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					if (this.settings.get("startup.quiet")) return;
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
			this.#eventBusUnsubscribers.push(
				eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, data => {
					if (!isMcpConnectionStatusEvent(data)) {
						logger.warn("Ignoring malformed mcp:connection-status event", { data });
						return;
					}
					this.#handleMcpConnectionStatusEvent(data);
				}),
			);
		}

		setTuiTight(settings.get("tui.tight"));
		setMarkdownMermaidRendering(settings.get("tui.renderMermaid"));
		// One TUI per process: `terminal.start` puts stdin in raw mode and installs
		// the reader, so the screen the launch card is already on is the screen
		// this mode drives.
		this.ui = this.#firstFrame?.ui ?? new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
		this.ui.setMaxInlineImages(settings.get("tui.maxInlineImages"));
		this.ui.setScrollbackRebuild(settings.get("tui.scrollbackRebuild"));
		this.ui.setScrollIsolation(settings.get("tui.scrollIsolation"));
		// Holding the mouse is what lets the wheel scroll the transcript with the
		// prompt pinned, and it takes plain drag-select away from the terminal. Say
		// so the first time a drag comes back empty, rather than leaving the
		// operator to conclude copy is broken ("i cant copy and paste from the
		// terminal", 2026-07-24). The wording and the once-only policy belong to
		// `selection-notice`.
		this.ui.onSelectionAttempt = createSelectionAttemptNotice(message => this.showStatus(message));
		// OSC 66 text-sizing is Kitty-only; resolve the setting against the terminal's
		// capability (`TERMINAL.textSizing` defaults on for Kitty) so it stays off
		// unless the user opts in, and never emits raw escapes on other terminals.
		setTerminalTextSizing(settings.get("tui.textSizing") && TERMINAL.textSizing);
		// The session states to the model whether a picture reached the screen, and it
		// cannot read a terminal to find out. This is the terminal answering: a
		// graphics protocol means the picture is drawn, and a front end that draws no
		// pictures — a piped `-p` run, an rpc client — installs nothing and the
		// session says so.
		setImageDisplayProbe(() => TERMINAL.imageProtocol !== null);
		this.chatContainer = new TranscriptContainer();
		this.#transcriptComposer = new TranscriptComposer({
			chatContainer: this.chatContainer,
			addMessageToChat: (message, options) => void this.addMessageToChat(message, options),
			renderSessionContext: context => this.renderSessionContext(context),
			buildTranscriptContext: () =>
				// Live display collapses to the compacted transcript tail unless the
				// user opted into the full inline history; export/resume callers
				// choose their own mode.
				this.viewSession.buildTranscriptSessionContext({
					collapseCompactedHistory: settings.get("display.collapseCompacted"),
				}),
			isViewStreaming: () => this.viewSession?.isStreaming === true,
			streamingComponent: () => this.streamingComponent,
			pendingTools: this.pendingTools,
			isKnownSlashCommand: text => this.isKnownSlashCommand(text),
			pendingSubmission: () => this.#pendingSubmittedInput,
		});
		// Both ports read `ui` on every access rather than holding the screen built
		// above: a harness assigns its own `TUI` after construction and before
		// `init`, and the layout must size, and the hero mount on, the screen that
		// paints. A fill sized against the discarded screen's row count is what
		// pushed a 24-row board's phase row into scrollback under a 40-row default.
		const host = this;
		this.#layout = new HomeAnchorLayout({
			get ui() {
				return host.ui;
			},
			transcriptChildCount: () => this.chatContainer.children.length,
			// Resolved lazily: the welcome controller is constructed just below.
			hasHero: () => this.#welcomeController.hasHero,
		});
		this.#welcomeController = new WelcomeController({
			get ui() {
				return host.ui;
			},
			chatContainer: this.chatContainer,
			topFillRows: width => this.#layout.topFillRows(width),
			onHeroDismissed: removedRows => this.#layout.onHeroDismissed(removedRows),
			remeasureAnchor: () => this.#layout.sync(),
		});
		this.pendingMessagesContainer = new AnchoredLiveContainer();
		this.statusContainer = new AnchoredLiveContainer();
		this.todoContainer = new AnchoredLiveContainer();
		this.agentContainer = new AnchoredLiveContainer();
		this.btwContainer = new AnchoredLiveContainer();
		this.omfgContainer = new AnchoredLiveContainer();
		this.errorBannerContainer = new AnchoredLiveContainer();
		this.modelCycleContainer = new AnchoredLiveContainer();
		// Adopted, not built: the launch card already mounted a live composer and
		// the operator may have typed into it. Building a second one here would
		// throw that draft away and remount the input the session is coming up
		// behind. Everything below is wiring the mode adds to whichever editor
		// it ended up with.
		this.editor = this.#firstFrame?.editor ?? new CustomEditor(getEditorTheme());
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.#lendPopupMotion(this.editor);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		this.#syncEditorMaxHeight();
		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
			this.#layout.sync();
			this.ui.requestRender();
		};
		process.stdout.on("resize", this.#resizeHandler);
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
			this.historyStorage.setSessionResolver(() => this.sessionManager.getSessionId());
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.hookWidgetContainerAbove = new Container();
		this.hookWidgetContainerAbove.addChild(new Spacer(1));
		this.hookWidgetContainerBelow = new Container();
		// The launch card's container, when there was one: the zone re-mounts it
		// under the mode's chrome, so the editor inside never leaves its parent
		// and the draft on screen never blinks.
		this.editorContainer = this.#firstFrame?.editorContainer ?? new Container();
		if (!this.#firstFrame) this.editorContainer.addChild(this.editor);
		// Before the composer chip band: the band's contents depend on whether the
		// view is proxied onto an agent, and `focusedAgentId` reads through this
		// controller. Everything else it needs from the host is read lazily.
		this.#focusController = new SessionFocusController(this);
		this.composerShortcuts = new ComposerShortcutsBar();
		// A chip click runs the same action its keybinding runs; the editor owns
		// those callbacks (input-controller assigns them with the full panel,
		// maintenance, and focus logic), so the click just invokes them.
		this.composerShortcuts.onChipClick = id => {
			if (id === "interrupt") this.editor.onEscape?.();
			else if (id === "background") this.editor.onBashBackground?.();
			else if (id === "dequeue") this.editor.onDequeue?.();
		};
		this.#refreshComposerShortcuts();
		this.#bashForegroundUnsubscribe = onForegroundBashWaitChange(() => this.#refreshComposerShortcuts());
		// The repaint hook is what makes the path expansion a travel rather than a jump: the
		// component owns the progress, the shared motion clock owns the frames, and this asks
		// for each one. A caller that only renders (the two-line selector, tests) passes none
		// and gets the hard cut.
		this.statusProducer = new StatusPresentationProducer(session);
		this.statusLine = new StatusLineComponent(this.statusProducer, { requestRender: () => this.ui.requestRender() });
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		// The count has to arrive on the keeper's own events, not on the next
		// repaint that happens for another reason: a handed-off conversation
		// produces no UI activity at all, so a chip refreshed by ambient redraws
		// reads zero for as long as the operator sits still — which is exactly the
		// stretch where an unwatched turn is spending.
		this.statusLine.setBackgroundSessionCount(BackgroundSessions.global().size);
		this.#backgroundSessionsUnsubscribe = BackgroundSessions.global().subscribe(() => {
			this.statusLine.setBackgroundSessionCount(BackgroundSessions.global().size);
			this.ui.requestRender();
		});
		// The borderless composer, per the agreed design mockups: a static
		// near-invisible hairline, the content inset off the terminal edge, and
		// ONE quiet metadata footline below the input — location (path · git)
		// left, capability (model · mode · context · MCP health) right. The
		// chrome is silent; motion belongs to content.
		applyComposerChrome(this.editor, resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE));
		this.composerHairline = new ComposerHairline();
		this.capabilityLine = new QuietZoneLine(width => this.#composerFootline(width), COMPOSER_INSET_COLS);
		// GMI-2b: the goal readout in the footline (the `mode` segment while goal
		// mode is active) is clickable — it opens the same goal detail view as
		// the keyboard path. Hit-testing comes from the footline's own recorded
		// layout, so the target is exactly the pixels the segment occupies.
		// The context gauge is clickable too, and opens the same breakdown panel as
		// `/context`. The footline can only afford one number, and the question
		// behind it ("what is filling my window?") needs the per-category split, so
		// the gauge is the handle for it. It has to be a click rather than a hover:
		// the main screen arms `\x1b[?1000h\x1b[?1006h` (button events) without
		// 1003h motion reporting, so no mouse position arrives until a press.
		this.capabilityLine.onClick = col => {
			const segmentId = this.statusLine.quietSegmentAt(col);
			if (segmentId === "mode" && (this.goalModeEnabled || this.goalModePaused)) {
				void this.openGoalDetail();
				return;
			}
			// A click on either half of the location widens the row and spends the readouts on the
			// right for the room; the next click on the same half puts every one of them back. A
			// long path or branch is the one thing on this line that cannot be read any other way
			// without leaving the screen, and the footline is where the reader already is. The
			// half that was clicked is the one shown whole, so a click on the branch reads the
			// branch rather than re-reading the directory.
			if (segmentId === "path" || segmentId === "git" || segmentId === "pr") {
				this.statusLine.togglePathExpanded(segmentId);
				this.ui.requestRender();
				return;
			}
			if (segmentId === "context_pct" || segmentId === "context_total") {
				this.handleContextCommand();
			}
		};

		this.hideThinkingBlock = settings.get("hideThinkingBlock");
		this.proseOnlyThinking = settings.get("proseOnlyThinking");
		// Seeded from the remembered preference, so a session opens showing tool
		// input and output the way the last one was left rather than resetting to
		// collapsed and making the reader press the toggle again.
		this.toolOutputExpanded = settings.get("display.toolOutputExpanded");

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
			category: "extensions",
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
			category: "custom",
		}));

		// Build skill commands from session.skills (if enabled)
		const skillCommandList: SlashCommand[] = [];
		if (settings.get("skills.enableSkillCommands")) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill);
				skillCommandList.push({ name: commandName, description: skill.description, category: "skills" });
			}
		}

		const builtinCommands = buildTuiBuiltinSlashCommands({ ctx: this });
		// Store pending commands for init() where file commands are loaded async
		this.#pendingSlashCommands = [...builtinCommands, ...hookCommands, ...customCommands, ...skillCommandList];

		this.#uiHelpers = new UiHelpers(this);
		this.presentation = new TerminalPresentationDriver(this.ui.terminal, {
			surface: {
				getTui: () => this.ui,
				getComposer: () => this.editor,
				transcript: this.#uiHelpers.transcript,
				setStatusLine: state => {
					this.statusLine.setSnapshot(state);
				},
			},
		});
		this.#btwController = new BtwController(this);
		this.#omfgController = new OmfgController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#inputController = new InputController(this);
		this.#voiceController = new VoiceController(this);
		this.#goalMode = new GoalModeController(this, {
			isAutoSubmitBlocked: () => this.#isAutoSubmitBlocked(),
			isPlanModeActive: () => this.planModeEnabled || this.planModePaused,
			hasPendingSubmission: () => this.#pendingSubmittedInput !== undefined,
			hasPendingVisibleUserSubmission: () =>
				this.#pendingSubmittedInput !== undefined && !this.#pendingSubmittedInput.customType,
			withProgress: (label, work) => this.#withGuidedGoalProgress(label, work),
		});
		this.#workingLoader = new WorkingLoaderController(this);
		this.#observerRegistry = new SessionObserverRegistry();
		this.#anchoredBlocks = new AnchoredBlocks(this, this.#observerRegistry);
	}

	#handleMcpConnectionStatusEvent(event: McpConnectionStatusEvent): void {
		if (this.settings.get("startup.quiet")) return;
		if (event.type === "connecting") {
			this.#mcpPendingServers.clear();
			this.#mcpConnectedServers.clear();
			this.#mcpFailedServers.clear();
			for (const serverName of event.serverNames) {
				this.#mcpPendingServers.add(serverName);
			}
		} else if (event.type === "connected") {
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpFailedServers.delete(event.serverName);
			this.#mcpConnectedServers.add(event.serverName);
		} else {
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpConnectedServers.delete(event.serverName);
			this.#mcpFailedServers.set(event.serverName, { error: event.error, foreign: event.foreign === true });
		}

		// Boot health lives on the location line's right side (a fixed quiet
		// home), not as a floating transcript status.
		this.ui.requestRender();
	}

	/**
	 * The composer's footline row: standing session state, or just the focus badge when the operator
	 * has turned the row off.
	 *
	 * `statusLine.enabled` ships ON (see its entry in `config/settings-domains/appearance.ts`). Read
	 * per render rather than captured at construction: settings live in memory, so toggling the row
	 * in `/settings` lands on the next frame with no re-mount, and the reads behind the row (git
	 * state, usage, account inventory) never happen at all while it is off.
	 *
	 * The one part that is not configurable is the focus badge. While the view is proxied onto an
	 * agent, Esc means "go back" instead of "clear the line", and the badge is the only persistent
	 * thing that says so; a footline preference must not be able to hide the exit from a view whose
	 * edge is otherwise invisible. So off means "no segments", not "no row ever".
	 */
	#composerFootline(width: number): string | null {
		if (!settings.get("statusLine.enabled")) return this.statusLine.renderFocusBadge(width);
		return this.statusLine.renderQuietLine(width, { locationRight: this.#locationRightZone() });
	}

	/**
	 * The location line's right zone: MCP boot health when it has something to
	 * say, otherwise nothing. The resting sun dome that used to sit here read as
	 * an artificial ornament; the composer's life now lives in the horizon rule
	 * itself (see {@link ComposerHairline}), not a glyph parked at the edge.
	 */
	#locationRightZone(): string | null {
		const zones = [draftTokenZone(this.editor.getText()), this.#mcpZoneText()].filter((z): z is string => z !== null);
		return zones.length > 0 ? zones.join(theme.fg("dim", " · ")) : null;
	}

	/**
	 * MCP boot health for the location line's right side: progress while
	 * servers connect, a failure count once settled. Null when fully healthy —
	 * a healthy system says nothing.
	 */
	#mcpZoneText(): string | null {
		const pending = this.#mcpPendingServers.size;
		const failed = this.#mcpFailedServers.size;
		if (pending > 0) {
			const total = pending + this.#mcpConnectedServers.size + failed;
			return theme.fg("dim", `mcp ${this.#mcpConnectedServers.size}/${total}`);
		}
		if (failed > 0) {
			// Failures of servers veyyon merely borrowed from another tool's
			// config (Claude Code, Codex, …) stay visible but don't alarm —
			// red at first paint is reserved for veyyon's own configuration.
			const allForeign = Array.from(this.#mcpFailedServers.values()).every(f => f.foreign);
			// Route the cross through the theme symbol, not a raw `✗` literal, so it
			// degrades with the symbol preset (nerd ``, ascii `[!!]`) instead of
			// emitting a glyph an ascii terminal cannot render.
			return theme.fg(allForeign ? "dim" : "statusLineDirty", `mcp ${theme.status.error}${failed} · /mcp list`);
		}
		return null;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.keybindings =
			this.#firstFrame?.keybindings ??
			logger.time("InteractiveMode.init:keybindings", () => KeybindingsManager.create());
		this.#refreshComposerShortcuts();

		// Route SIGINT/SIGTERM/SIGHUP/uncaughtException through the same teardown
		// the TUI Ctrl+C keypress path performs: persist the in-progress editor
		// draft for `--resume`, then dispose the session (which emits the extension
		// `session_shutdown` event, cancels the owned async job manager, disposes
		// eval kernels, releases owned browser tabs, and closes the session
		// manager). Without this callback a real kernel signal would drop the
		// draft, skip the `session_shutdown` contract from `shared-events.ts`,
		// and orphan background bash/task processes (issue #4080). The registered
		// callback and `shutdown()` share one promise-memoized teardown, so a
		// signal arriving mid-Ctrl+C no-ops instead of racing a second dispose.
		this.#signalTeardown = createSessionTeardown({
			getDraftText: () => this.editor.getText(),
			beginDispose: () => this.session.beginDispose(),
			saveDraft: text => this.sessionManager.saveDraft(text),
			// Flush pending debounced settings on every exit path (keypress `/exit`,
			// Ctrl+C/Ctrl+D, and the postmortem SIGINT/SIGTERM/SIGHUP/uncaughtException
			// signals all funnel here). Without this a `/settings` change made just
			// before quitting is lost inside the 100ms save debounce.
			flushSettings: () => Settings.instance.flush(),
			disposeSession: reason =>
				this.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS, reason }),
		});
		// Forward the postmortem reason (SIGTERM/SIGHUP/uncaughtException/…) so the
		// persisted `session_exit` diagnostic carries the real trigger. Postmortem
		// runs callbacks in REVERSE registration order — this callback (registered
		// after the AgentSession constructor's `agent-session:<id>` recorder) runs
		// FIRST and its dispose() would otherwise persist the generic "dispose".
		this.#cleanupUnsubscribe = postmortem.register("session-teardown", reason => this.#signalTeardown!(reason));

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
		);

		// Get current model info for welcome screen. Empty (not "Unknown") when no
		// model is configured, so the welcome renders a "/login" call to action
		// instead of a dead "Unknown · Unknown".
		const modelName = this.session.model?.name ?? "";
		const providerName = this.session.model?.provider ?? "";

		// Get recent sessions
		const recentSessions = await logger.time("InteractiveMode.init:recentSessions", () =>
			getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
				sessions.map(s => ({
					name: s.name,
					timeAgo: s.timeAgo,
				})),
			),
		);

		const startupQuiet = this.settings.get("startup.quiet");

		// The launch card is on screen already when the first frame painted one;
		// its placeholder rows come off here, and the card itself is remounted
		// below in the mode's own order.
		this.#firstFrame?.release();

		for (const warning of this.session.configWarnings) {
			this.ui.addChild(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0));
			this.ui.addChild(new Spacer(1));
		}

		// Size the anchor from the children of the frame about to compose: a turn
		// that grows or collapses in place between one frame and the next has no
		// other moment to be measured in. There is no post-commit correction to
		// pair with it — a fill sized from a frame that already composed is a
		// second paint that moves the same rows to a different row, once per
		// chunk of a streaming answer. Bound here, on the screen the fills mount
		// on, rather than in the constructor, whose screen a harness may replace.
		this.ui.onBeforeCompose = () => this.#layout.sync();

		// The flexible top margin mounts above the hero AND the transcript: it
		// centres the hero on the home screen, then (once a conversation starts)
		// takes ALL the anchor slack so the conversation hugs the composer at
		// the viewport bottom. Mounted unconditionally — quiet startups skip the
		// hero, not the anchor.
		this.ui.addChild(this.#layout.topFill);
		if (!startupQuiet) {
			this.#welcomeController.mountHero(
				{ version: this.#version, modelName, providerName, recentSessions },
				this.#firstFrame?.hero,
			);
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.todoContainer);
		this.ui.addChild(this.agentContainer);
		this.ui.addChild(this.btwContainer);
		this.ui.addChild(this.omfgContainer);
		this.ui.addChild(this.errorBannerContainer);
		this.ui.addChild(this.modelCycleContainer);
		// Bottom-anchor fill: on the home screen this expands to sink the whole
		// status + composer block to the viewport bottom (grok placement); it sits
		// above the status loader so they travel down together.
		this.ui.addChild(this.#layout.bottomFill);
		// The whole composer zone (status, hairline, padded card, footline,
		// margin) mounts in its one canonical order via mountComposerZone —
		// the order is a design contract owned and tested in composer-chrome.
		const composerZoneChildren = mountComposerZone(this.ui, {
			statusContainer: this.statusContainer,
			statusLine: this.statusLine,
			hookWidgetsAbove: this.hookWidgetContainerAbove,
			hairline: this.composerHairline,
			editorContainer: this.editorContainer,
			capabilityLine: this.capabilityLine,
			shortcuts: this.composerShortcuts,
			hookWidgetsBelow: this.hookWidgetContainerBelow,
		});
		// Scroll isolation pins the composer zone as the live footer; the
		// engine derives its row span from the compose ledger every frame.
		this.ui.setPinnedFooterChildCount(composerZoneChildren);
		this.ui.setFocus(this.editor);
		// Anchor the composer to the viewport bottom on the launch/home screen.
		// Seeded, not synced: a launch card already on screen leaves a composed
		// frame this layout did not produce.
		this.#layout.seedAfterMount();

		this.#inputController.setupKeyHandlers();
		this.editor.beginEarlySubmissions();
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.syncRunningAgentBadge();
		this.#observerRegistry.onChange(kind => {
			this.#anchoredBlocks.scheduleObserverUiSync(kind);
		});

		// Load initial todos
		this.#anchoredBlocks.syncTodoSurfaceToView();

		// The tty handover, for a mode that started its own screen. When the
		// launch card painted one, `first-frame.ts` owns all of this: it flushed
		// the queue, started the UI, and mounted a live composer that has been
		// taking keystrokes for the whole of session startup, so there is
		// nothing to release and nothing to transplant.
		if (!this.#firstFrame) {
			// This process may be a relaunch (`/profile <name>` respawns the CLI),
			// and between the parent restoring the terminal and the line below
			// resuming stdin nothing is reading fd 0, so the kernel queues
			// everything that arrives in that window. `ui.start()` resumes stdin,
			// and the kernel then delivers that backlog as this session's first
			// input event: it reaches the composer, and a queued carriage return
			// submits a turn the operator never typed.
			//
			// Drop the queue outright first. `tcflush` is the real fix because it
			// is source-agnostic: keystrokes, a terminal's replies to the dying
			// parent's probes, or anything a multiplexer injected all go the same
			// way, and no timing window is involved.
			// This branch discards the queue either way, so the marker only has to
			// be cleared: left set it would reach every child this session spawns,
			// and a veyyon launched from one would read its operator's typing as a
			// dead session's backlog.
			consumeRelaunchMarker();
			const flushed = flushPendingTtyInput();
			// Windows consoles have no termios and an unusual libc may not resolve,
			// so `tcflush` can be unavailable. The documented degrade is to discard
			// whatever gets READ before startup finishes: swallow every input event
			// until the release below runs. Ctrl+C stays live for the same reason
			// the shutdown gate lets it through (issue #2600) — an operator must be
			// able to abort a session that is still coming up.
			this.#startupInputGateRelease ??= this.ui.addInputListener(data =>
				matchesKey(data, "ctrl+c") ? undefined : { consume: true },
			);
			// Start the UI. The first paint always clears the viewport (ED 2), so the
			// welcome frame never appends over the previous run's frame. Erasing the
			// terminal's saved scrollback (ED 3) is a separate, unrecoverable act that
			// also takes whatever the operator had on screen before launch, so it
			// happens only when they asked for it.
			this.ui.start({ clearScrollback: this.settings.get("startup.clearScrollback") });
			// Release on the first check phase after `ui.start()`. The kernel's
			// queued backlog is delivered in the poll phase of that same event-loop
			// iteration, so it is always inside the gate; a keystroke the operator
			// actually meant cannot be, because it requires them to have seen a
			// frame that has not reached the terminal yet. That is the boundary,
			// and it is a loop turn rather than a duration: no sleep to tune, and
			// nothing typed at a live prompt is ever refused.
			setImmediate(() => {
				this.#startupInputGateRelease?.();
				this.#startupInputGateRelease = undefined;
			});
			if (!flushed) {
				logger.debug("No tty input flush available at startup; discarding buffered input until mount completes");
			}
		}
		this.presentation.start();
		// The first paint used an estimated fill (no composed frame existed yet);
		// now the exact composed height is known, so re-anchor precisely. It only
		// re-renders if the estimate was off, so there is usually no visible reflow.
		this.#layout.sync();
		if (this.#layout.bottomFill.render(this.ui.terminal.columns).length > 0) this.ui.requestRender();
		pushTerminalTitle();
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.updateEditorBorderColor();
		// Single side-effect point for title changes: every setSessionName caller
		// (first-input titling, /rename, extension renames, plan seeding, replan
		// refresh) gets the terminal title + accent updates from here. Registered
		// before initHooksAndCustomTools/#reconcileModeFromSession/PlanModeController.enter —
		// all of which can reach setSessionName during init.
		this.#eventBusUnsubscribers.push(
			this.sessionManager.onSessionNameChanged(() => {
				setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
				this.#handleSessionAccentInputsChanged();
			}),
		);
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		// THE HANDOVER IS A DIFF, NOT A REPAINT. A forced render rewrites every row of the viewport,
		// and on a terminal without synchronized output the operator watches 25 rows get erased and
		// redrawn: the branch, the hero and the composer darken for a frame on a screen whose
		// content did not change. Nothing here needs that. The launch card painted through THIS
		// `TUI`, so the rows it left are the window the engine diffs against and a clean handover
		// writes nothing at all; without a card, `ui.start()` above has already claimed the viewport
		// with its own ED 2, so this render only has to put the finished tree over a screen the
		// engine already describes. Either way an ordinary render writes exactly the rows that
		// differ, which is the whole job.
		this.ui.requestRender();

		// Initialize hooks with TUI-based UI context
		await this.initHooksAndCustomTools();

		// Restore mode from session (e.g. plan mode on resume)
		this.session.setSessionSwitchReconciler?.(() => this.#reconcileModeFromSession({ preserveActiveGoal: true }));
		await this.#reconcileModeFromSession();

		// Brand-new sessions optionally start in plan mode when the user has made it
		// the startup default. "Brand-new" means the resolved branch carries no
		// conversation context (buildSessionContext().messages — covers messages,
		// custom messages, branch summaries, and compaction summaries) and the user
		// set no explicit `mode_change` (which #reconcileModeFromSession just
		// restored). SDK startup metadata and extension `custom` state entries are
		// ignored. This way `veyyon --continue` (or auto-resume) that finds no recent
		// session and creates a fresh one still honors the default, while a session
		// with restored context or an explicit mode keeps its reconciled mode. Scoped
		// to launch (not the switch reconciler above) so /new and the plan-approval →
		// execution handoff clear never get dragged back into plan mode. PlanModeController.enter
		// is idempotent and self-guards against an already-active plan/goal mode; it
		// does not check plan.enabled itself.
		const hasConversationContext = this.sessionManager.buildSessionContext().messages.length > 0;
		const hasExplicitMode = this.sessionManager.getEntries().some(entry => entry.type === "mode_change");
		const isFreshSession = !hasConversationContext && !hasExplicitMode;
		if (
			isFreshSession &&
			this.session.settings.get("plan.defaultOnStartup") &&
			this.session.settings.get("plan.enabled")
		) {
			await this.#planMode.enter();
		}

		// Restore unsent editor draft from previous session shutdown (Ctrl+D).
		// One-shot: consumeDraft removes the sidecar after read so the next
		// resume does not re-restore the same text.
		try {
			const draft = await this.sessionManager.consumeDraft();
			if (draft && !this.editor.getText()) {
				this.editor.setText(draft);
				this.updateEditorBorderColor();
				this.ui.requestRender();
			}
		} catch (err) {
			logger.warn("Failed to restore session draft", { error: String(err) });
		}

		// Subscribe to agent events
		this.#subscribeToAgent();

		this.#goalMode.subscribeToSession();

		this.#eventBusUnsubscribers.push(
			// The goal subscription is re-pointed on a session handoff, so dispose
			// whichever one is current rather than capturing today's unsubscriber.
			() => this.#goalMode.unsubscribeFromSession(),
			onStatusLineSessionAccentChanged(() => {
				this.#syncStatusLineSettings();
				this.#handleSessionAccentInputsChanged();
			}),
			// A provider moved to a different account because the one serving could not serve at all.
			// A refused grant moves regardless of `accounts.loadBalancing`; a plan that does not include
			// the model moves only with that setting on. Either way the notice names both accounts, so a
			// second subscription is never spent silently.
			this.session.modelRegistry.authStorage.onCredentialFailover(event => {
				const why =
					event.reason === "model-not-in-plan"
						? `cannot serve this model (${event.cause})`
						: `could not authenticate (${event.cause})`;
				this.showWarning(
					`${formatProviderName(event.provider)}: ${event.from.label} ${why}, now using ${event.to.label}`,
				);
			}),
			// The move that did NOT happen: the account cannot serve, other accounts are idle, and
			// `accounts.loadBalancing` is off. The notice names what is wrong, how many accounts are
			// sitting unused, and the one toggle that would use them. AuthStorage emits this once per
			// exhausted window, or per refused model, so a retrying turn does not repeat it.
			this.session.modelRegistry.authStorage.onUsageLimitWithheld(event => {
				const idle = event.idleSiblings === 1 ? "1 other account is" : `${event.idleSiblings} other accounts are`;
				const problem =
					event.reason === "quota"
						? `is out of quota until ${new Date(event.retryAtMs).toLocaleTimeString()}`
						: `cannot use ${event.modelId} on its plan`;
				this.showWarning(
					`${formatProviderName(event.provider)}: ${event.account.label} ${problem}. ${idle} idle; turn on Account Load Balancing in /settings (Providers) to use them.`,
				);
			}),
		);
		// Set up theme file watcher
		this.#eventBusUnsubscribers.push(
			onThemeChange(event => {
				this.#workingLoader.clearAccentCache();
				clearRenderCache();
				clearMermaidCache();
				this.ui.invalidate();
				this.updateEditorBorderColor();
				if (event.ephemeral || isInsideTerminalMultiplexer()) {
					// Theme previews and multiplexer panes cannot safely replace native
					// scrollback: previews must stay non-destructive, and multiplexers
					// suppress ED3 so a forced replay would duplicate transcript history.
					this.ui.requestRender();
					return;
				}
				// Rows already committed to native scrollback are immutable, so a swap
				// cannot recolor them without ED 3. ED 3 is not selective: it erases the
				// terminal's whole saved history, including everything the operator had
				// on screen before veyyon started, which veyyon never wrote and cannot
				// replay. Recoloring our own transcript is not worth deleting theirs, so
				// the wipe needs the same consent the startup one does. At startup it is
				// worse than a bad trade: the appearance probe resolves a variant before
				// anything is committed, so it recolors nothing and destroys everything.
				// Without consent, force the repaint and leave scrolled-back rows on the
				// old palette.
				this.ui.requestRender(true, { clearScrollback: this.settings.get("startup.clearScrollback") });
				// A committed theme swap changes the ground the terminal should show;
				// preview (ephemeral) swaps returned above so a hover does not flicker
				// the terminal background.
				this.#applyPaintGround();
			}),
		);

		// Subscribe to terminal dark/light appearance changes.
		// The terminal queries background color via OSC 11 at startup and on
		// Mode 2031 notifications, computing luminance to detect dark/light.
		this.ui.terminal.onAppearanceChange(mode => {
			onTerminalAppearanceChange(mode);
		});

		// Re-apply the painted ground when the terminal reports an external
		// background change (a terminal theme switch that clobbered our paint).
		// The terminal suppresses the self-echo of our own paint, so this fires
		// only on genuine external changes. Subscribing also replays the current
		// background to us, applying the initial paint once it is known; the
		// explicit call below covers `always`/`never`, which do not need a report.
		// The background-color capability is optional on the Terminal interface
		// (older custom terminals may lack it); when absent, painting is simply
		// unavailable and both the subscription and the paint calls no-op.
		this.ui.terminal.onBackgroundColorChange?.(hex => {
			this.#applyPaintGround();
			// Feed the ground-relative tint owner (hairline, composer card, card
			// outlines): every derived chrome color re-resolves against the REAL
			// terminal ground the moment it is known or changes.
			setDetectedTerminalGround(hex);
			// And record it, because the NEXT launch's card is painted before this
			// query can be answered. The card seeds its derived chrome from this
			// value; without it the hairline is drawn from the static token and
			// restyled once the report lands, half a second into a settled screen.
			void recordLaunchFacts({ terminalGround: hex });
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});
		// Only when the terminal has actually answered. The card seeds the recorded
		// ground before its first paint, and overwriting that with `undefined` here
		// would drop the chrome back onto the static token at mount -- the same
		// restyle on a settled screen, in the other direction.
		if (this.ui.terminal.backgroundColor !== undefined) {
			setDetectedTerminalGround(this.ui.terminal.backgroundColor);
		}
		this.#applyPaintGround();

		// A checkout, worktree switch or `git switch` changes the branch, and the
		// default-branch, pull-request and `git status` lookups land after the
		// frame that asked for them. All four make the painted row stale, and a
		// resting session has no other reason to repaint.
		this.statusLine.watchGitState(() => {
			this.ui.requestRender();
		});

		this.#inputController.setupEditorSubmitHandler();
		// A picker requested before the first frame opens with the rest of the early input, so its
		// controller is loaded before the queue drains. A failed load is reported by the open itself.
		if (this.editor.hasEarlyActions()) await this.#selectors().catch(() => undefined);
		this.#inputController.drainEarlySubmissions();
	}

	/** Themes already warned about an unhonored `always`, so the log is not repeated. */
	#paintGroundWarnedThemes = new Set<string>();

	/**
	 * Apply the painted-ground policy (`tui.paintGround`): set the terminal
	 * background to the theme's ground color, or inherit the terminal's own,
	 * per the setting and the auto-seam rule ({@link planPaintGround}). Called at
	 * startup, on a committed theme change, and when the terminal reports an
	 * external background change. The paint is reset on exit by the terminal layer
	 * (OSC 111), including after a crash, so this never has to undo it here.
	 *
	 * The ground comes from the tint owner and not from the terminal directly, because the launch
	 * card settles one before this runs: it seeds the ground its terminal reported on the previous
	 * launch, and planning against a terminal that has not answered yet would undo that decision at
	 * mount -- repainting the whole background half a second into a settled screen, which is the
	 * defect the seed exists to remove.
	 */
	#applyPaintGround(): void {
		const plan = planPaintGround(
			this.settings.get("tui.paintGround"),
			theme.getGroundHex(),
			this.ui.terminal.backgroundColor ?? getDetectedTerminalGround(),
		);
		if (plan.unhonoredAlways) {
			// `always` is the one setting the user explicitly asked to paint that a
			// groundless theme cannot honor; say so once per theme rather than
			// silently do nothing (Law 10) or spam the log on every re-apply.
			const name = getCurrentThemeName();
			if (name !== undefined && !this.#paintGroundWarnedThemes.has(name)) {
				this.#paintGroundWarnedThemes.add(name);
				logger.warn(
					'tui.paintGround is "always" but the active theme declares no ground color, so the terminal background is left unpainted',
					{
						theme: name,
						fix: 'Pick a theme that declares a page background, or set tui.paintGround to "auto" or "never". A custom theme can declare one via its "export.pageBg".',
					},
				);
			}
		}
		// Paint and record together: what the policy leaves on screen is the ground
		// every animation resolves a color out of.
		applyGroundPaint(plan, this.ui.terminal);
	}

	/** Reload the title-generation system prompt override for the provided working
	 *  directory and stash it on the session so first-input titling
	 *  ({@link input-controller}) and replan-driven refresh
	 *  ({@link AgentSession.#refreshTitleAfterReplan}) share one source
	 *  ({@link discoverTitleSystemPromptFile}; issue #3734). */
	async refreshTitleSystemPrompt(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const titleSystemPromptSource = discoverTitleSystemPromptFile(basePath);
		const resolved = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		this.session.setTitleSystemPrompt(resolved);
	}

	/** Reload slash commands and autocomplete for the provided working directory. */
	async refreshSlashCommandState(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const fileCommands = await loadSlashCommands({ cwd: basePath });
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
			category: "custom",
		}));
		// Surface discovered prompt templates in the picker. AgentSession.prompt() expands
		// `expandSlashCommand` before `expandPromptTemplate`, and builtin command
		// execution resolves aliases before template expansion. Mirror that command
		// resolution order by skipping templates whose names already appear in any
		// builtin/hook/custom/skill/file command token.
		const reservedNames = new Set<string>();
		for (const command of this.#pendingSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}
		for (const command of fileSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}
		const promptTemplateCommands: SlashCommand[] = this.session.promptTemplates
			.filter(template => !reservedNames.has(template.name))
			.map(template => ({
				name: template.name,
				// `PromptTemplate.description` from `loadTemplatesFromDir` already includes the
				// source suffix (e.g. "Review code (project)"), so pass it through verbatim.
				description: template.description,
				category: "custom",
			}));
		this.#baseAutocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands, ...promptTemplateCommands],
			basePath,
		);
		this.#applyAutocompleteProvider();
		this.session.setSlashCommands(fileCommands);
	}

	/**
	 * Rebuild the editor's autocomplete provider: the built-in provider wrapped
	 * by every extension-registered factory, in registration order. A factory
	 * that throws or returns a malformed provider is skipped so one broken
	 * extension cannot take down core autocomplete.
	 */
	#applyAutocompleteProvider(): void {
		const base = this.#baseAutocompleteProvider;
		if (!base) return;
		let provider = base;
		for (const factory of this.#autocompleteProviderFactories) {
			try {
				const wrapped = factory(provider);
				if (
					wrapped &&
					typeof wrapped.getSuggestions === "function" &&
					typeof wrapped.applyCompletion === "function"
				) {
					provider = wrapped;
				} else {
					logger.warn("Extension autocomplete provider factory returned an invalid provider; skipping it");
				}
			} catch (error) {
				logger.warn("Extension autocomplete provider factory threw; skipping it", { error: String(error) });
			}
		}
		this.editor.setAutocompleteProvider(provider);
	}

	/** Stack extension autocomplete behavior on top of the built-in editor provider (#4919). */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.#autocompleteProviderFactories.push(factory);
		this.#applyAutocompleteProvider();
	}

	/**
	 * Re-point the process and every cwd-derived cache at `newCwd` after the
	 * active session's working directory changed (`/move` relocation or resuming
	 * a session from another project). The SessionManager's cwd MUST already
	 * reflect `newCwd` before this is called.
	 */
	async applyCwdChange(newCwd: string): Promise<void> {
		// The mode-independent half lives on the session, because this is not the
		// only way a session moves. Two paths reach here: resuming a session that
		// belongs to another project, and the `cwd_changed` event, which
		// `AgentSession.setCwd` (`/cd`, the `set_cwd` tool) and
		// `AgentSession.moveToCwd` (`/move`) raise once their transaction is
		// recorded. The resume path goes through neither, so this cannot be dropped
		// in favour of them. Both call the one owner, which skips a repeat of the
		// same destination so the event path does the work once rather than twice.
		//
		// It reloads project settings, reapplies provider globals, clears the plugin
		// root cache, resets capabilities, refreshes the ssh tool, and rebuilds the
		// base system prompt for the destination. The prompt matters most: it carries
		// the discovered context files and the workspace tree, so before this was
		// rebuilt a `/cd` left the model reading the previous project's AGENTS.md
		// while resolving relative paths against the new directory. The path itself
		// is no longer in there — it rides a turn message, so a move inside one
		// project rebuilds to identical bytes and costs no prompt-cache invalidation.
		await this.session.rescopeToCwd(newCwd);
		// What stays here is what only a terminal session has: the title prompt read
		// from the destination, the slash-command picker, and the rendered chrome.
		await this.refreshTitleSystemPrompt(newCwd);
		await this.refreshSlashCommandState(newCwd);
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.statusLine.invalidate();
		this.ui.requestRender();
	}

	async getUserInput(): Promise<SubmittedUserInput> {
		if (this.#goalMode.sessionGoalIsExiting) {
			await this.#goalMode.exitCompletedGoal();
		}
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		this.#scheduleLoopAutoSubmit();
		this.#goalMode.scheduleContinuation();

		using _ = new EventLoopKeepalive();
		return await promise;
	}

	#scheduleLoopAutoSubmit(): void {
		this.#cancelLoopAutoSubmit();
		if (!this.loopModeEnabled || !this.loopPrompt) return;
		const prompt = this.loopPrompt;
		const loopAction = settings.get("loop.mode");
		this.#deferLoopAutoSubmit(() => {
			void this.#runLoopIteration(loopAction, prompt);
		});
	}

	#deferLoopAutoSubmit(callback: () => void): void {
		// Brief delay so the user has a chance to press Esc between iterations.
		this.#loopAutoSubmitTimer = setTimeout(() => {
			this.#loopAutoSubmitTimer = undefined;
			if (!this.loopModeEnabled || !this.onInputCallback) return;
			callback();
		}, 800);
	}

	#cancelLoopAutoSubmit(): void {
		if (this.#loopAutoSubmitTimer) {
			clearTimeout(this.#loopAutoSubmitTimer);
			this.#loopAutoSubmitTimer = undefined;
		}
	}

	#isAutoSubmitBlocked(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.session.hasPostPromptWork;
	}

	#refreshComposerShortcuts(): void {
		const busy = this.#isAutoSubmitBlocked();
		const focused = this.focusedAgentId !== undefined;
		const canBackgroundBash = hasForegroundBashWait();
		const hasQueue = this.session.queuedMessageCount > 0;
		if (!busy && !hasQueue && !canBackgroundBash && this.composerShortcuts.shortcuts.length === 0) {
			return;
		}
		const shortcuts = buildComposerShortcuts(this.keybindings, {
			busy,
			hasDraft: false,
			hasQueue,
			focused,
			canBackgroundBash,
		});
		if (this.composerShortcuts.setShortcuts(shortcuts)) {
			// Live refresh: busy/queue/keybinding transitions call this after init, so the
			// bar needs its own repaint request rather than relying on the initial mount.
			this.ui.requestComponentRender(this.composerShortcuts);
		}
	}

	#submitLoopPromptWhenReady(prompt: string): void {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (isLoopDurationExpired(this.loopLimit)) {
			this.disableLoopMode("Loop time limit reached. Loop mode disabled.");
			return;
		}
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => this.#submitLoopPromptWhenReady(prompt));
			return;
		}
		this.onInputCallback(this.startPendingSubmission({ text: prompt }));
	}

	async #runLoopIteration(action: "prompt" | "compact" | "reset", prompt: string): Promise<void> {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => {
				void this.#runLoopIteration(action, prompt);
			});
			return;
		}

		if (!consumeLoopLimitIteration(this.loopLimit)) {
			this.disableLoopMode("Loop limit reached. Loop mode disabled.");
			return;
		}

		if (action === "compact") {
			await this.handleCompactCommand();
		} else if (action === "reset") {
			await this.handleClearCommand();
		}
		this.#submitLoopPromptWhenReady(prompt);
	}

	disableLoopMode(message = "Loop mode disabled."): void {
		const wasEnabled = this.loopModeEnabled;
		this.loopModeEnabled = false;
		this.loopPrompt = undefined;
		this.loopLimit = undefined;
		this.#cancelLoopAutoSubmit();
		this.statusLine.setLoopModeStatus(undefined);
		this.ui.requestRender();
		if (wasEnabled) {
			this.showStatus(message);
		}
	}

	/**
	 * Pause the loop without exiting it: drops the captured prompt and any
	 * pending auto-resubmit. Loop mode stays enabled — the next prompt the
	 * user submits becomes the new loop prompt and resumes iteration.
	 */
	pauseLoop(): void {
		this.loopPrompt = undefined;
		this.#cancelLoopAutoSubmit();
	}

	async handleLoopCommand(args = ""): Promise<string | undefined> {
		if (this.loopModeEnabled) {
			this.disableLoopMode();
			return undefined;
		}
		const parsed = parseLoopLimitArgs(args);
		if (typeof parsed === "string") {
			this.showError(parsed);
			return undefined;
		}
		this.loopModeEnabled = true;
		this.loopPrompt = undefined;
		this.loopLimit = createLoopLimitRuntime(parsed.limit);
		this.statusLine.setLoopModeStatus({ enabled: true });
		this.ui.requestRender();
		const limitSuffix = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : "";
		const remainingSuffix = this.loopLimit ? ` ${describeLoopLimitRuntime(this.loopLimit)}.` : "";
		const tail = parsed.prompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn.";
		this.showStatus(
			`Loop mode enabled.${limitSuffix}${remainingSuffix} ${tail} Esc cancels the current iteration; /loop again to disable.`,
		);
		// Hand any inline prompt back to the dispatcher so the normal submit flow
		// runs the first iteration — it records the text as the loop prompt and
		// auto-resubmits it after each yield, identical to typing the prompt right
		// after enabling loop mode.
		return parsed.prompt;
	}

	recordLocalSubmission(text: string, imageCount = 0): () => void {
		return this.#transcriptComposer.recordLocalSubmission(text, imageCount);
	}

	async withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T> {
		const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
		try {
			return await fn();
		} catch (err) {
			dispose();
			throw err;
		}
	}
	clearOptimisticUserMessage(): void {
		this.#transcriptComposer.clearOptimistic();
	}

	replaceOptimisticUserMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void {
		this.#transcriptComposer.replaceOptimistic(message, options);
	}

	startPendingSubmission(input: {
		text: string;
		images?: ImageContent[];
		imageLinks?: (string | undefined)[];
		customType?: string;
		display?: boolean;
		streamingBehavior?: "steer" | "followUp";
	}): SubmittedUserInput {
		this.takeAtRestReading();
		const submission: SubmittedUserInput = {
			text: input.text,
			images: input.images,
			imageLinks: input.imageLinks,
			customType: input.customType,
			display: input.display,
			streamingBehavior: input.streamingBehavior,
			cancelled: false,
			started: false,
		};
		this.#pendingSubmittedInput = submission;
		if (!submission.customType) {
			this.#goalMode.noteVisibleUserTurnStarted();
			this.#transcriptComposer.showOptimistic(submission);
		} else {
			this.#transcriptComposer.clearOptimistic();
		}
		this.editor.setText("");
		this.editor.imageLinks = undefined;
		this.ensureLoadingAnimation();
		// As the conversation begins the anchor slack moves ABOVE the transcript
		// (see HomeAnchorLayout.sync): the first message renders directly above
		// the composer at the viewport bottom and climbs as replies land, until
		// content fills the screen and the anchor latches off. Sized here as well
		// as at the top of the next frame so the message is placed by the paint
		// this submit requests rather than the one after it.
		this.#layout.sync();
		this.ui.requestRender();
		return submission;
	}

	cancelPendingSubmission(): boolean {
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.started) {
			return false;
		}

		submission.cancelled = true;
		this.#pendingSubmittedInput = undefined;
		this.clearOptimisticUserMessage();
		this.#workingLoader.clearPendingMessage();
		if (submission.customType === "goal-continuation") {
			this.#goalMode.noteContinuationTurnSettled();
		}
		this.#workingLoader.stop(true);
		if (!submission.customType) {
			this.editor.pendingImages = submission.images ? [...submission.images] : [];
			this.editor.pendingImageLinks = submission.imageLinks ? [...submission.imageLinks] : [];
			this.editor.imageLinks = this.editor.pendingImageLinks;
			this.rebuildChatFromMessages();
			this.#goalMode.noteVisibleUserTurnCancelled();
			this.editor.setText(submission.text);
		}
		this.updateEditorBorderColor();
		this.ui.requestRender();
		return true;
	}

	markPendingSubmissionStarted(input: SubmittedUserInput): boolean {
		if (this.#pendingSubmittedInput !== input || input.cancelled) {
			return false;
		}
		input.started = true;
		return true;
	}

	finishPendingSubmission(input: SubmittedUserInput): void {
		const wasPendingSubmission = this.#pendingSubmittedInput === input;
		if (wasPendingSubmission) {
			this.#pendingSubmittedInput = undefined;
		}
		if (input.customType === "goal-continuation") {
			this.#goalMode.noteContinuationTurnSettled();
		}

		const quiesced = !this.session.isStreaming && !this.streamingComponent;
		this.#transcriptComposer.onSubmissionFinished({ owned: wasPendingSubmission, quiesced });
		if (wasPendingSubmission && quiesced) {
			this.#workingLoader.clearPendingMessage();
			this.#workingLoader.stop(true);
		}
	}

	#computeEditorMaxHeight(): number {
		return computeEditorMaxHeight(this.ui.terminal.rows);
	}

	#syncEditorMaxHeight(): void {
		this.editor.setMaxHeight(this.#computeEditorMaxHeight());
	}

	#syncStatusLineSettings(): void {
		this.statusLine.updateSettings(statusLineSettingsFromConfig());
	}

	#handleSessionAccentInputsChanged(): void {
		this.#workingLoader.clearAccentCache();
		this.statusLine.invalidate();
		this.updateEditorBorderColor();
	}

	updateEditorBorderColor(): void {
		// The accent decision (border color, DS-6 glyph morph, continuation
		// spine) is a pure function in composer-chrome.ts; this method only
		// snapshots the mode/session state and applies the result. The session
		// identity accent needs settings + the session name, so it resolves here.
		const accentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
		const sessionName = accentEnabled ? this.sessionManager.getSessionName() : undefined;
		const hex = sessionName
			? getSessionAccentHex(sessionName, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance)
			: undefined;
		const accents = resolveComposerAccents({
			bypass: this.session.isApprovalBypassed(),
			bashMode: this.isBashMode,
			pythonMode: this.isPythonMode,
			planMode: this.planModeEnabled && !this.planModePaused,
			focusedAgent: this.focusedAgentId !== undefined,
			sessionAccentAnsi: getSessionAccentAnsi(hex),
			thinkingLevel: this.session.thinkingLevel ?? ThinkingLevel.Off,
		});
		applyComposerChrome(this.editor, accents);
		this.ui.requestRender();
	}

	/** Refresh the running-agents status badge from the active local or collab registry. */
	syncRunningAgentBadge(options: { requestRender?: boolean } = {}): void {
		const registry = getRunningAgentBadgeRegistry(this.collabGuest);
		if (this.#agentRegistrySubscriptionTarget !== registry) {
			this.#agentRegistryUnsubscribe?.();
			this.#agentRegistrySubscriptionTarget = registry;
			this.#agentRegistryUnsubscribe = registry.onChange(() => {
				this.syncRunningAgentBadge();
			});
		}
		// The collab guest's mirrored registry has no local scope; the local one is
		// this driving session's conversation and must not count another's spawns.
		//
		// `focusedAgentId` narrows it again while the view is proxied onto an
		// agent. The badge is the one-number summary of the block the HUD lists,
		// and the HUD already shows only the viewed agent's spawns; a badge still
		// counting the whole conversation reported running agents that had no row
		// anywhere in that view, which is the HUD's own defect one number wide.
		const count = countRunningAgentBadgeAgents(
			registry,
			this.collabGuest ? undefined : this.sessionManager.getSessionId(),
			this.focusedAgentId,
		);
		this.statusLine.setAgentCount(count);
		if (options.requestRender !== false) this.ui.requestRender();
	}

	rebuildChatFromMessages(): void {
		// The composer owns the rebuild's live-component preservation (#3656)
		// and the pre-streaming optimistic replay (#2372).
		this.#transcriptComposer.rebuild();
		this.#eventController.releaseDetachedTranscriptAnchors();
	}
	/**
	 * Render the ctrl+p model cycle chip track into its own anchored
	 * container (just above the editor), mirroring the todo HUD: the container is
	 * cleared and rebuilt in place on every cycle, so rapid presses or concurrent
	 * chat activity can never stack duplicate tracks into the scrollback.
	 */
	showModelCycleTrack(track: string): void {
		this.#renderModelCycleTrack(track);
		this.#syncModelCycleClearTimer();
		this.ui.requestRender();
	}

	#renderModelCycleTrack(track: string | null): void {
		this.modelCycleContainer.clear();
		if (!track) return;
		this.modelCycleContainer.addChild(new Spacer(1));
		this.modelCycleContainer.addChild(new Text(track, 1, 0));
	}

	#cancelModelCycleClearTimer(): void {
		if (!this.#modelCycleClearTimer) return;
		clearTimeout(this.#modelCycleClearTimer);
		this.#modelCycleClearTimer = undefined;
	}

	#syncModelCycleClearTimer(): void {
		this.#cancelModelCycleClearTimer();
		this.#modelCycleClearTimer = setTimeout(() => {
			this.#modelCycleClearTimer = undefined;
			this.#renderModelCycleTrack(null);
			this.ui.requestRender();
		}, MODEL_CYCLE_TRACK_CLEAR_MS);
		this.#modelCycleClearTimer.unref?.();
	}

	/** Apply any deferred model switch after the current stream ends. */
	flushPendingModelSwitch(): Promise<void> {
		return this.#planMode.flushPendingModelSwitch();
	}

	async #clearTransientModeState(): Promise<void> {
		await this.#planMode.clearTransientState();
		await this.#goalMode.clearTransientState();
		await this.#vibeMode.clearTransientState();
	}

	/** Reconcile mode state from session entries on resume/switch. */
	async #reconcileModeFromSession(options?: { preserveActiveGoal?: boolean }): Promise<void> {
		await this.#clearTransientModeState();
		const sessionContext = this.sessionManager.buildSessionContext();
		if ((await this.#goalMode.restoreFromSession(sessionContext, options)) === "handled") {
			return;
		}
		this.session.goalRuntime.clearAccounting();
		if (sessionContext.mode === "vibe") {
			await this.#vibeMode.enter();
			return;
		}
		if (!this.session.settings.get("plan.enabled")) {
			// Clear stale plan/plan_paused mode so re-enabling the setting
			// later doesn't unexpectedly restore an old plan session.
			if (sessionContext.mode === "plan" || sessionContext.mode === "plan_paused") {
				this.sessionManager.appendModeChange("none");
			}
			return;
		}
		if (sessionContext.mode === "plan") {
			const planFilePath = sessionContext.modeData?.planFilePath as string | undefined;
			await this.#planMode.enter({ planFilePath });
		} else if (sessionContext.mode === "plan_paused") {
			this.#planMode.restorePaused();
		}
	}

	showPlanReview(
		planContent: string,
		title: string,
		options: string[],
		dialogOptions?: PlanReviewDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		return this.#planMode.showReview(planContent, title, options, dialogOptions, extra);
	}

	handlePlanModeCommand(initialPrompt?: string): Promise<void> {
		return this.#planMode.handleCommand(initialPrompt);
	}

	/** `/vibe` toggle; see {@link VibeModeController}. */
	handleVibeModeCommand(initialPrompt?: string): Promise<void> {
		return this.#vibeMode.handleCommand(initialPrompt);
	}

	handleGoalModeCommand(rest?: string): Promise<void> {
		return this.#goalMode.handleCommand(rest);
	}

	handleGuidedGoalCommand(rest?: string): Promise<void> {
		return this.#goalMode.handleGuidedCommand(rest);
	}

	/**
	 * Open the goal detail/action menu for the current goal (active or paused)
	 * without typing `/goal`. A no-op when no goal is set. This is the target of
	 * the down-arrow status affordance wired in {@link InputController}.
	 */
	openGoalDetail(): Promise<void> {
		return this.#goalMode.openDetail();
	}

	/** Re-open the plan-review overlay on the newest `local://<slug>-plan.md`; bound to `/plan-review`. */
	openPlanReview(): Promise<void> {
		return this.#planMode.openReview();
	}

	handlePlanApproval(details: PlanApprovalDetails): Promise<void> {
		return this.#planMode.handleApproval(details);
	}

	stop(): void {
		this.#freezeFrameProduction();
		this.presentation.stop();
		if (this.#cleanupUnsubscribe) {
			this.#cleanupUnsubscribe();
		}
		this.#shutdownInputGateRelease?.();
		this.#shutdownInputGateRelease = undefined;
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	/**
	 * Disconnect everything that can still turn session state into a frame or
	 * turn a keystroke into session work: the loading/mic/clock animations, the
	 * anchored motion frame, the todo/observer/goal timers, voice input, extension terminal input
	 * listeners and hook widgets, the event bus, the agent/bash subscriptions,
	 * the event controller, the status line, the resize hook, and the session
	 * event subscription. Everything here is idempotent, and the method itself
	 * is guarded, because shutdown() runs it BEFORE the teardown await. A slow
	 * `session.dispose` (the consolidate budget is seconds) must not leave the
	 * dying session painting or accepting work. Meanwhile stop() runs it again at
	 * the end for every path that never went through shutdown().
	 *
	 * What deliberately stays live until stop(): the postmortem registration
	 * (a signal mid-teardown must still reach the memoized teardown), the
	 * shutdown input gate, and the terminal itself.
	 */
	#frameProductionFrozen = false;
	#freezeFrameProduction(): void {
		if (this.#frameProductionFrozen) return;
		this.#frameProductionFrozen = true;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(false);
		}
		this.#voiceController.cleanup();
		if (this.#clockTimer) {
			clearInterval(this.#clockTimer);
			this.#clockTimer = undefined;
		}
		this.#anchoredBlocks.freeze();
		this.#goalMode.cancelContinuation();
		this.#voiceController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#extensionUiController.clearHookWidgets();
		for (const unsubscribe of this.#eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#eventBusUnsubscribers = [];
		this.#observerRegistry.dispose();
		this.#agentRegistryUnsubscribe?.();
		this.#agentRegistryUnsubscribe = undefined;
		this.#agentRegistrySubscriptionTarget = undefined;
		this.#bashForegroundUnsubscribe?.();
		this.#bashForegroundUnsubscribe = undefined;
		this.#backgroundSessionsUnsubscribe?.();
		this.#backgroundSessionsUnsubscribe = undefined;
		this.#eventController.dispose();
		this.statusLine.dispose();
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
	}

	/**
	 * Wait for one committed frame so the closing status is actually on screen
	 * before `#freezeFrameProduction` runs. `showStatus` only SCHEDULES a
	 * paint; without an explicit commit the freeze could win the race and the
	 * operator would stare at a frozen terminal with no explanation for the
	 * teardown pause. Bounded so a stopped or headless UI can never hang
	 * shutdown.
	 */
	#commitClosingFrame(): Promise<void> {
		if (!this.isInitialized) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const previous = this.ui.onFrameComposed;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.ui.onFrameComposed = previous;
			resolve();
		};
		timer = setTimeout(finish, 250);
		this.ui.onFrameComposed = () => {
			try {
				previous?.();
			} finally {
				finish();
			}
		};
		this.ui.requestRender(true);
		return promise;
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;

		// From this moment the session is leaving, so its editor must not take
		// another keystroke. Teardown below can hold the terminal for seconds
		// (the consolidate budget plus the input drain), and every key delivered
		// in that window would otherwise land in the dying session's editor.
		// Swallow it all instead. The one exception is Ctrl+C: the hard-abort
		// ladder for a stuck teardown (issue #2600) lives below the input
		// listeners, so the gate passes it through.
		//
		// This gate covers only what this process still reads. It never covered
		// the relaunch leak it used to claim: once the terminal is released
		// nothing here is reading fd 0, so the kernel queues arriving bytes and
		// hands them to the relaunched child. That window belongs to the child,
		// and `init()` closes it there with `flushPendingTtyInput()`.
		this.#shutdownInputGateRelease ??= this.ui.addInputListener(data =>
			matchesKey(data, "ctrl+c") ? undefined : { consume: true },
		);

		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#focusController.dispose();

		// Surface an explicit "Closing session…" line so the user sees a reason
		// for the pause while `session.dispose()` flushes memory consolidate and
		// other cleanups (issue #3641).
		this.showStatus("Closing session…");

		// Commit the closing frame, then disconnect every frame producer BEFORE
		// the teardown await: the closing frame is the last frame this session
		// paints, and a multi-second dispose can never make the dying session
		// look alive again. (The previous code relied on the teardown await
		// yielding a tick for the status to paint and left every producer live
		// for the whole window.)
		await this.#commitClosingFrame();
		this.#freezeFrameProduction();

		// A session handed off by `/new` is still finishing its turn and owns its
		// own transcript writer, so wait for it before the UI stops. Its turn is
		// already bounded by the agent loop; nothing new can be submitted to it.
		await BackgroundSessions.global().drain();

		// Persist the draft and dispose the session through the shared teardown
		// so a signal that arrives mid-shutdown cannot fire a second dispose.
		// The teardown is a promise-memoized singleton; whichever path calls it
		// first runs the work, the other awaits the same settled promise.
		// The teardown is registered lazily in `init()` — a `/exit` reached
		// before `init()` completed falls back to a direct dispose.
		if (this.#signalTeardown) {
			await this.#signalTeardown();
		} else {
			await this.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
		}

		// Do not force a final render during teardown: disposed session/UI state can
		// collapse to an empty frame, clearing the viewport and leaving the parent
		// shell prompt at row 0. Stop from the last committed frame so the terminal
		// hands Bash the cursor immediately after visible veyyon content.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		popTerminalTitle();
		this.stop();

		// The brand bookend: the sun sets on the session — open with the sunrise,
		// close with the sunset. TTY only; piped exits stay silent.
		if (process.stderr.isTTY) {
			const sunset = renderSunsetField({ cols: 40, rows: 7, time: 0.6, trueColor: TERMINAL.trueColor });
			process.stderr.write(`\n${sunset.join("\n")}\n${chalk.dim("the sun sets on this session")}\n`);
		}

		// Print resumption hint if this is a persisted session
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionId && sessionFile) {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${APP_NAME} --resume ${sessionId}`)}\n`);
		}

		// A requested relaunch (e.g. `/profile <name>`) takes over the restored
		// terminal; the parent lingers only to propagate the child's exit code.
		if (this.#relaunchSpec) {
			const { argv, env } = this.#relaunchSpec;
			const childEnv: Record<string, string> = {};
			for (const [key, value] of Object.entries({ ...process.env, ...env })) {
				if (value !== undefined) childEnv[key] = value;
			}
			// Tell the child that whatever is queued on the tty predates it.
			childEnv[RELAUNCH_MARKER] = "1";
			const child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: childEnv });
			await postmortem.quit(await child.exited);
			return;
		}

		await postmortem.quit(0);
	}

	requestRelaunch(spec: { argv: string[]; env?: Record<string, string | undefined> }): void {
		this.#relaunchSpec = spec;
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#displayedBindings().setToolUIContext(uiContext, hasUI);
	}

	/**
	 * Hand the tool layer this host's out-of-band notification delivery.
	 *
	 * A terminal can reach an operator who is looking at another window, so it
	 * installs one; a host that cannot never calls this, and the capability stays
	 * reported as absent rather than accepted and dropped.
	 */
	setToolNotifier(notify: HostNotifier): void {
		this.#displayedBindings().setToolNotifier(notify);
	}

	#displayedBindings(): SessionHostBindings {
		const bindings = this.#hostBindings.get(this.session);
		if (!bindings) {
			throw new Error(`Session ${this.sessionManager.getSessionId()} was attached without its host bindings`);
		}
		return bindings;
	}

	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#extensionUiController.initializeHookRunner(uiContext, hasUI);
	}

	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void {
		const previousEditor = this.editor;
		const previousText = previousEditor.getText();
		const nextEditor = factory
			? factory(this.ui, getEditorTheme(), this.keybindings)
			: new CustomEditor(getEditorTheme());

		nextEditor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		nextEditor.setAutocompleteMaxVisible(this.settings.get("autocompleteMaxVisible"));
		nextEditor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		nextEditor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.#lendPopupMotion(nextEditor);
		previousEditor.disposeAutocompleteMotion();
		nextEditor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		applyComposerChrome(nextEditor, resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE));
		nextEditor.setMaxHeight(this.#computeEditorMaxHeight());
		if (this.historyStorage) {
			nextEditor.setHistoryStorage(this.historyStorage);
		}
		nextEditor.setText(previousText);
		nextEditor.pendingImages = previousEditor.pendingImages;
		nextEditor.pendingImageLinks = previousEditor.pendingImageLinks;
		nextEditor.imageLinks = previousEditor.imageLinks;

		this.editorContainer.clear();
		this.editor = nextEditor;
		this.editorContainer.addChild(nextEditor);
		this.ui.setFocus(nextEditor);

		this.#inputController.setupKeyHandlers();
		this.presentation.syncComposer();
		if (!nextEditor.adoptEarlySubmissions(previousEditor)) {
			this.#inputController.setupEditorSubmitHandler();
		}

		void this.refreshSlashCommandState().catch(error => {
			logger.warn("Failed to refresh slash command state for custom editor", { error: String(error) });
		});

		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	/**
	 * Lend an editor the frames and the ground its suggestion popup needs to grow
	 * instead of cutting in. Both gates are the overlay ones — a terminal that
	 * skips a card's unfold must not be handed a popup's, and the rows resolve out
	 * of the same ground a card unfolds out of.
	 */
	#lendPopupMotion(editor: CustomEditor): void {
		editor.setAutocompleteMotion({
			requestRender: () => this.ui.requestRender(),
			enabled: pointerMotionEnabled(),
			ground: modalRevealGround(),
		});
	}

	// UI helpers
	present(content: Component | readonly Component[]): void {
		if (Array.isArray(content)) {
			for (const item of content) this.#mountChatChild(item);
		} else {
			this.#mountChatChild(content as Component);
		}
		this.ui.requestRender();
	}
	showReport(title: string, body: string, footer?: string): void {
		this.present(reportBlock(title, body, footer));
	}

	#mountChatChild(item: Component): void {
		this.chatContainer.addChild(item);
		if (item instanceof ChatBlock) {
			item.mount(this.#chatHost);
		}
		// The composer stays anchored to the viewport bottom as the transcript
		// grows; HomeAnchorLayout.sync latches the anchor off for good only once the
		// content first fills the viewport, so a short reply keeps the composer on
		// the bottom edge instead of riding up under it.
		this.#layout.sync();
	}

	resetTranscript(): void {
		this.#uiHelpers.transcript.settle();
		this.chatContainer.dispose();
		this.chatContainer.clear();
	}

	showStatus(message: string, options?: { dim?: boolean }): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.clearOptimisticUserMessage();
		this.#workingLoader.clearPendingMessage();
		this.#workingLoader.stop(true);
		this.#uiHelpers.showError(message);
	}

	showPinnedError(message: string): void {
		this.#planMode.dismissReview();
		this.errorBannerContainer.clear();
		this.errorBannerContainer.addChild(new ErrorBannerComponent(message));
		this.ui.requestRender();
	}

	clearPinnedError(): void {
		if (this.errorBannerContainer.children.length === 0) return;
		this.errorBannerContainer.clear();
		this.ui.requestRender();
	}

	showWarning(message: string): void {
		this.#uiHelpers.showWarning(message);
	}

	#handleLspStartupEvent(event: LspStartupEvent): void {
		// Live surfaces showing warmup state (the /lsp panel, status chrome)
		// must repaint when server states change; without this the pending
		// mark lingers until an unrelated event happens to paint a frame.
		// (Historically this render rode on dead welcome-card LSP plumbing.)
		this.ui.requestRender();
		if (event.type === "failed") {
			this.showWarning(`LSP startup failed: ${event.error}. It will retry lazily on write.`);
			return;
		}

		const failedServers = event.servers.filter(server => server.status === "error");

		if (failedServers.length === 1) {
			const failedServer = failedServers[0];
			const detail = failedServer.error ? `: ${failedServer.error}` : "";
			this.showWarning(`LSP startup failed for ${failedServer.name}${detail}. It will retry lazily on write.`);
			return;
		}

		if (failedServers.length > 1) {
			const failedNames = failedServers.map(server => server.name).join(", ");
			this.showWarning(`LSP startup failed for ${failedNames}. It will retry lazily on write.`);
		}
	}

	/**
	 * Clock heartbeat: once per second WHILE THE MODEL WORKS, refresh the working line's per-task
	 * elapsed and repaint the quiet chrome so the location line's run clock ticks between agent
	 * events. At rest every on-screen time readout is frozen (the run clock shows the completed
	 * "Worked for …", the context bar tip is static), so the first tick that finds the session at
	 * rest disarms the heartbeat, and the next mount of the working loader arms it again. An idle
	 * session wakes for no clock at all, and a session whose frame production is frozen never
	 * re-arms it.
	 */
	#armClock(): void {
		if (this.#frameProductionFrozen) return;
		this.#clockTimer ??= setInterval(() => {
			if (!this.loadingAnimation && !this.session.isStreaming) {
				clearInterval(this.#clockTimer);
				this.#clockTimer = undefined;
				return;
			}
			this.#workingLoader.refreshTaskClock();
			this.ui.requestRender();
		}, 1000);
	}

	ensureLoadingAnimation(): void {
		this.#workingLoader.ensure();
		this.#armClock();
		// The board's motion is owed by the agent moving, and this is the edge
		// where it starts. Nothing else on this path touches the anchored
		// regions, so without it a board that was still when the turn began
		// stays still until some unrelated event redraws it. Every streamed event
		// lands here as well, and a board none of whose inputs moved would draw
		// the same rows again once per delta.
		if (this.#anchoredBlocks.todoBoardInputsMoved()) this.#anchoredBlocks.renderTodoList();
	}

	/**
	 * Run `work` behind a spinner in the status area.
	 *
	 * A guided-goal turn is a one-shot completion that streams nothing and
	 * emits no session events, so the screen between the answer the user typed
	 * and the next question showed no sign that anything was running.
	 */
	async #withGuidedGoalProgress<T>(label: string, work: () => Promise<T>): Promise<T> {
		this.statusContainer.disposeChildren();
		const loader = new Loader(
			this.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${label} (esc to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.statusContainer.addChild(loader);
		this.ui.requestRender();
		try {
			return await work();
		} finally {
			loader.stop();
			this.statusContainer.disposeChildren();
			this.ui.requestRender();
		}
	}

	#stopLoadingAnimation(clearStatusContainer: boolean): void {
		this.#workingLoader.stop(clearStatusContainer);
	}

	/**
	 * ONE owner for clearing the working loader: stop it, UNMOUNT it, and drop the
	 * reference. Controllers that abort a turn outside the normal agent_end path
	 * (fork, compact, handoff, error) call this — never `loadingAnimation.stop()`
	 * directly — so the loader can never be left running while the agent rests.
	 */
	clearWorkingLoader(): boolean {
		if (!this.#workingLoader.clear()) return false;
		// The other edge: the agent has stopped, so the board owes no more
		// frames. Skipped while frame production is frozen, because a frozen mode
		// must not touch its containers on the way out.
		if (!this.#frameProductionFrozen) this.#anchoredBlocks.renderTodoList();
		return true;
	}

	setWorkingMessage(message?: string): void {
		this.#workingLoader.setMessage(message);
	}

	applyPendingWorkingMessage(): void {
		this.#workingLoader.applyPendingMessage();
	}

	showUpdateReadyNotification(newVersion: string, warnings?: readonly string[]): void {
		this.#uiHelpers.showUpdateReadyNotification(newVersion, warnings);
	}

	showUpdateFailedNotification(newVersion: string, error: string): void {
		this.#uiHelpers.showUpdateFailedNotification(newVersion, error);
	}

	showNewVersionNotification(newVersion: string): void {
		this.#uiHelpers.showNewVersionNotification(newVersion);
	}

	showPluginUpdatesNotification(count: number): void {
		this.#uiHelpers.showPluginUpdatesNotification(count);
	}

	showPluginUpdatesInstalledNotification(count: number): void {
		this.#uiHelpers.showPluginUpdatesInstalledNotification(count);
	}

	showUnparseableSettingsNotification(files: readonly QuarantinedSettingsFile[]): void {
		this.#uiHelpers.showUnparseableSettingsNotification(files);
	}

	showSettingsSaveFailureNotification(failure: SettingsSaveFailure): void {
		this.#uiHelpers.showSettingsSaveFailureNotification(failure);
	}

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	refreshComposerShortcuts(): void {
		this.#refreshComposerShortcuts();
	}

	/** Remove the startup welcome card (and its spacers) — the first real
	 *  keystroke ends the hero moment. Idempotent; the bottom anchor stays so
	 *  the composer does not jump until a conversation turn scrolls in. The
	 *  keystroke also begins the prompt that needs the tool schemas the held
	 *  at-rest reading builds, so it queues that reading. */
	dismissWelcome(): void {
		this.#welcomeController.dismiss();
		this.#takeAtRestReadingAfterNextFrame();
	}

	/**
	 * Take the at-rest reading the launch held, after the frame that draws the current edit. The
	 * reading builds every active tool's schema, which the prompt the edit begins needs anyway; taking
	 * it after the frame keeps the build out of the keystroke's echo. The schemas are built one tool
	 * per event-loop turn before the reading is taken, so a key typed while they build is read
	 * between two tools rather than after all of them. A host stopped before the last tool leaves the
	 * reading held for the session's own first turn. A session that is never edited or prompted builds
	 * no schema.
	 */
	#takeAtRestReadingAfterNextFrame(): void {
		if (this.#atRestReadingQueued || !isAtRestReadingDeferred(this.session)) return;
		this.#atRestReadingQueued = true;
		const previous = this.ui.onFrameComposed;
		let fired = false;
		const hook = (): void => {
			if (this.ui.onFrameComposed === hook) this.ui.onFrameComposed = previous;
			previous?.();
			if (fired) return;
			fired = true;
			const steps = toolSchemaWarmSteps(this.session);
			const step = (): void => {
				if (!this.isInitialized) {
					this.#atRestReadingQueued = false;
					return;
				}
				if (isAtRestReadingDeferred(this.session) && !steps.next().done) {
					setImmediate(step);
					return;
				}
				this.#atRestReadingQueued = false;
				this.takeAtRestReading();
			};
			setImmediate(step);
		};
		this.ui.onFrameComposed = hook;
	}

	/**
	 * Take the session's held at-rest reading now and redraw the gauge it measures; a no-op once taken.
	 * A submission calls this before the session appends its message, since the reading is at rest only
	 * before the first one, and redraws the gauge before the turn starts.
	 */
	takeAtRestReading(): void {
		if (takeHeldAtRestReading(this.session)) this.ui.requestRender();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.#uiHelpers.queueCompactionMessage(text, mode, images);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.#uiHelpers.flushCompactionQueue(options);
	}

	flushPendingBashComponents(): void {
		this.#uiHelpers.flushPendingBashComponents();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.#uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(
		message: AgentMessage,
		options?: { populateHistory?: boolean; imageLinks?: readonly (string | undefined)[] },
	): Component[] {
		return this.#uiHelpers.addMessageToChat(message, options);
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void {
		for (const message of sessionContext.messages) {
			this.noteDisplayableThinkingContent(message);
		}
		this.#uiHelpers.renderSessionContext(sessionContext, options);
	}

	renderInitialMessages(options?: { clearTerminalHistory?: boolean }): void {
		this.#uiHelpers.renderInitialMessages(options);
	}

	/**
	 * Replace the startup frame with the session transcript without blocking input (see
	 * {@link UiHelpers.replayInitialMessages}). Session events wait for it, so a turn that starts
	 * while it builds routes against the finished transcript.
	 */
	async replayInitialMessages(options: { clearTerminalHistory?: boolean }): Promise<void> {
		const replay = this.#uiHelpers.replayInitialMessages(options);
		this.#eventController.deferEventsUntil(replay);
		await replay;
	}

	getUserMessageText(message: Message): string {
		return this.#uiHelpers.getUserMessageText(message);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this.#uiHelpers.findLastAssistantMessage();
	}

	extractAssistantText(message: AssistantMessage): string {
		return this.#uiHelpers.extractAssistantText(message);
	}

	// Command handling
	handleExportCommand(text: string): Promise<void> {
		return this.#commandController.handleExportCommand(text);
	}

	async handleDumpCommand(): Promise<void> {
		return this.#commandController.handleDumpCommand();
	}

	handleAdvisorDumpCommand(isRaw?: boolean) {
		return this.#commandController.handleAdvisorDumpCommand(isRaw);
	}

	handleDebugTranscriptCommand(): Promise<void> {
		return this.#commandController.handleDebugTranscriptCommand();
	}

	handleShareCommand(): Promise<void> {
		return this.#commandController.handleShareCommand();
	}

	async handleTodoCommand(args: string): Promise<void> {
		const { TodoCommandController } = await import("./controllers/todo-command-controller");
		await new TodoCommandController(this).handleTodoCommand(args);
	}

	handleSessionCommand(): Promise<void> {
		return this.#commandController.handleSessionCommand();
	}

	handleAdvisorStatusCommand(): Promise<void> {
		return this.#commandController.handleAdvisorStatusCommand();
	}

	handleJobsCommand(): Promise<void> {
		return this.#commandController.handleJobsCommand();
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.#commandController.handleUsageCommand(reports);
	}

	async handleChangelogCommand(): Promise<void> {
		await this.#commandController.handleChangelogCommand();
	}

	handleHotkeysCommand(): void {
		this.#commandController.handleHotkeysCommand();
	}

	handleToolsCommand(): void {
		this.#commandController.handleToolsCommand();
	}

	handleContextCommand(): void {
		this.#commandController.handleContextCommand();
	}

	#prepareSessionSwitch(): void {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.clearPinnedError();
		this.#planMode.hideReview();
	}

	handleClearCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleClearCommand();
	}

	handleFreshCommand(): Promise<void> {
		return this.#commandController.handleFreshCommand();
	}

	handleDropCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleDropCommand();
	}

	handleForkCommand(): Promise<void> {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		return this.#commandController.handleForkCommand();
	}

	handleMoveCommand(targetPath?: string): Promise<void> {
		return this.#commandController.handleMoveCommand(targetPath);
	}

	handleRenameCommand(title: string): Promise<void> {
		return this.#commandController.handleRenameCommand(title);
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#commandController.handleMemoryCommand(text);
	}

	handleSTTToggle(): Promise<void> {
		return this.#voiceController.toggle();
	}

	async showDebugSelector(): Promise<void> {
		await (await this.#selectors()).showDebugSelector();
	}

	resetObserverRegistry(): void {
		this.#observerRegistry.resetSessions();
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
	}

	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handleBashCommand(command, excludeFromContext);
	}

	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handlePythonCommand(code, excludeFromContext);
	}

	async handleMCPCommand(text: string): Promise<void> {
		const { MCPCommandController } = await import("./controllers/mcp-command-controller");
		await new MCPCommandController(this).handle(text);
	}

	async handleSSHCommand(text: string): Promise<void> {
		const { SSHCommandController } = await import("./controllers/ssh-command-controller");
		await new SSHCommandController(this).handle(text);
	}

	handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		internalGuidance?: string,
	): Promise<CompactionOutcome> {
		return this.#commandController.handleCompactCommand(customInstructions, mode, beforeFlush, internalGuidance);
	}

	handleHandoffCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleHandoffCommand(customInstructions);
	}

	handleShakeCommand(mode: ShakeMode): Promise<void> {
		return this.#commandController.handleShakeCommand(mode);
	}

	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome> {
		return this.#commandController.executeCompaction(customInstructionsOrOptions, isAuto);
	}

	openInBrowser(urlOrPath: string): void {
		this.#commandController.openInBrowser(urlOrPath);
	}

	focusActiveEditorArea(): void {
		focusEditorSlot(this);
	}

	/** The selector controller, imported on first use; a failed import is retried on the next open. */
	#selectors(): Promise<SelectorController> {
		if (this.#selectorController) return Promise.resolve(this.#selectorController);
		this.#selectorLoad ??= import("./controllers/selector-controller").then(
			module => {
				this.#selectorController = new module.SelectorController(this);
				return this.#selectorController;
			},
			(error: unknown) => {
				this.#selectorLoad = undefined;
				throw error;
			},
		);
		return this.#selectorLoad;
	}

	/**
	 * Opens a card for a key or command handler that does not wait on it. Synchronous once the controller
	 * is loaded, so input typed after the key reaches the card; the first open reports a failed load.
	 */
	#openSelector(open: (selectors: SelectorController) => void): void {
		if (this.#selectorController) {
			open(this.#selectorController);
			return;
		}
		this.#selectors()
			.then(open)
			.catch((error: unknown) => this.showError(`Could not open the panel: ${errorMessage(error)}`));
	}

	// Selector handling
	async showFullWelcome(): Promise<void> {
		const recentSessions = await getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
			sessions.map(s => ({ name: s.name, timeAgo: s.timeAgo })),
		);
		this.#welcomeController.showFull({
			version: this.#version,
			modelName: this.session.model?.name ?? "",
			providerName: this.session.model?.provider ?? "",
			recentSessions,
		});
	}

	showSettingsSelector(initialItemId?: string): void {
		this.#openSelector(selectors => selectors.showSettingsSelector(initialItemId));
	}

	async showAdvisorConfigure(): Promise<void> {
		await (await this.#selectors()).showAdvisorConfigure();
	}

	showHistorySearch(): void {
		this.#openSelector(selectors => selectors.showHistorySearch());
	}

	showExtensionsDashboard(): void {
		this.#openSelector(selectors => void selectors.showExtensionsDashboard());
	}

	showAgentsDashboard(options?: { requireContent?: boolean }): void {
		this.#openSelector(selectors => selectors.showAgentsDashboard(this.#observerRegistry, options));
	}

	showSecretList(): void {
		this.#commandController.showSecretList();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#openSelector(selectors => selectors.showModelSelector(options));
	}

	showThinkingSelector(): void {
		this.#openSelector(selectors => selectors.showThinkingSelector());
	}

	showSubcommandPicker(
		commandName: string,
		subcommands: readonly SubcommandDef[],
		onSelect: (subcommand: SubcommandDef) => void,
	): void {
		this.#openSelector(selectors => selectors.showSubcommandPicker(commandName, subcommands, onSelect));
	}

	showPluginSelector(mode?: "install" | "uninstall"): void {
		this.#openSelector(selectors => void selectors.showPluginSelector(mode));
	}

	showUserMessageSelector(): void {
		this.#openSelector(selectors => selectors.showUserMessageSelector());
	}

	showCopySelector(): void {
		this.#openSelector(selectors => selectors.showCopySelector());
	}

	showTreeSelector(): void {
		this.#openSelector(selectors => selectors.showTreeSelector());
	}

	showSessionSelector(): void {
		this.#openSelector(selectors => selectors.showSessionSelector());
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.resetObserverRegistry();
		await (await this.#selectors()).handleResumeSession(sessionPath);
	}

	async handleSessionDeleteCommand(): Promise<void> {
		await (await this.#selectors()).handleSessionDeleteCommand();
	}

	async showAccountManager(providerId?: string): Promise<void> {
		await (await this.#selectors()).showAccountManager(providerId);
	}

	async showLogin(providerId?: string): Promise<void> {
		await (await this.#selectors()).showLogin(providerId);
	}

	async showLogout(providerId?: string): Promise<void> {
		await (await this.#selectors()).showLogout(providerId);
	}

	async showResetUsageSelector(): Promise<void> {
		await (await this.#selectors()).showResetUsageSelector();
	}

	showProviderSetup(): Promise<void> {
		return runProviderSetupWizard(this);
	}

	showHookConfirm(title: string, message: string): Promise<boolean> {
		return this.#extensionUiController.showHookConfirm(title, message);
	}

	// Input handling
	handleCtrlC(): void {
		this.#inputController.handleCtrlC();
	}

	handleCtrlD(): void {
		this.#inputController.handleCtrlD();
	}

	handleCtrlZ(): void {
		this.#inputController.handleCtrlZ();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	/** Queue slash-command input behind the active turn. */
	handleQueueCommand(message: string): Promise<void> {
		return this.#inputController.handleQueueCommand(message);
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	/**
	 * Ask for the reply on screen again, in plainer prose. This is an ordinary user turn carrying a
	 * fixed instruction, so the transcript shows exactly what the model was asked, and the reply
	 * lands in the conversation rather than beside it.
	 *
	 * It refuses unless a reply is there to work from. `hasTerminalTextAnswerWithoutQueuedWork`
	 * answers for the conversation and `#isAutoSubmitBlocked` for the runtime: the first is false
	 * mid-answer or after a turn that produced no text, and the second stays true through
	 * compaction and post-turn work, which end on their own and leave the transcript unchanged
	 * while they run. Submitting during either would rephrase a reply the model has not finished
	 * writing, or one the user cannot see yet.
	 */
	handleRephraseCommand(): void {
		this.editor.setText("");
		if (!this.onInputCallback) return;
		if (this.#isAutoSubmitBlocked() || !this.session.hasTerminalTextAnswerWithoutQueuedWork()) {
			this.showWarning("Nothing to rephrase yet — /rephrase needs a finished reply to work from.");
			return;
		}
		this.onInputCallback(this.startPendingSubmission({ text: requestsPrompts["requests/rephrase"].text.trim() }));
	}

	async handleTanCommand(work: string): Promise<void> {
		const { TanCommandController } = await import("./controllers/tan-command-controller");
		await new TanCommandController(this).start(work);
	}

	hasActiveBtw(): boolean {
		return this.#btwController.hasActiveRequest();
	}

	handleBtwEscape(): boolean {
		return this.#btwController.handleEscape();
	}

	canBranchBtw(): boolean {
		return this.#btwController.canBranch();
	}

	handleBtwBranchKey(): Promise<boolean> {
		return this.#btwController.handleBranch();
	}

	canCopyBtw(): boolean {
		return this.#btwController.canCopy();
	}

	handleBtwCopyKey(): Promise<boolean> {
		return this.#btwController.handleCopy();
	}

	async handleBtwBranch(question: string, assistantMessage: AssistantMessage): Promise<void> {
		try {
			const result = await this.session.branchFromBtw(question, assistantMessage);
			if (result.cancelled) {
				this.showStatus("/btw branch cancelled", { dim: true });
				return;
			}
			this.#btwController.dispose();
			this.#omfgController.dispose();
			this.renderInitialMessages({ clearTerminalHistory: true });
			this.updateEditorBorderColor();
			this.showStatus(
				result.sessionFile ? `Branched /btw to ${path.basename(result.sessionFile)}` : "Branched /btw",
			);
		} catch (error) {
			this.showError(`Cannot branch /btw: ${errorMessage(error)}`);
		}
	}

	handleOmfgCommand(complaint: string): Promise<void> {
		return this.#omfgController.start(complaint);
	}

	hasActiveOmfg(): boolean {
		return this.#omfgController.hasActiveRequest();
	}

	handleOmfgEscape(): boolean {
		return this.#omfgController.handleEscape();
	}

	cycleThinkingLevel(): void {
		this.#inputController.cycleThinkingLevel();
	}

	cycleModel(direction?: "forward" | "backward"): Promise<void> {
		return this.#inputController.cycleModel(direction);
	}

	toggleToolOutputExpansion(): void {
		this.#inputController.toggleToolOutputExpansion();
	}

	setToolsExpanded(expanded: boolean): void {
		this.#inputController.setToolsExpanded(expanded);
	}

	toggleThinkingBlockVisibility(): void {
		this.#inputController.toggleThinkingBlockVisibility();
	}

	toggleTodoExpansion(): void {
		this.todoExpanded = !this.todoExpanded;
		this.#anchoredBlocks.renderTodoList();
		this.ui.requestRender();
	}

	setTodos(todos: TodoItem[] | TodoPhase[]): void {
		this.#anchoredBlocks.setTodos(todos);
	}

	async reloadTodos(): Promise<void> {
		this.#anchoredBlocks.syncTodoSurfaceToView();
		this.ui.requestRender();
	}

	openExternalEditor(): void {
		this.#inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.#inputController.registerExtensionShortcuts();
	}

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void> {
		return this.#extensionUiController.initHooksAndCustomTools();
	}

	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		return this.#extensionUiController.emitCustomToolSessionEvent(reason, previousSessionFile);
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		this.#extensionUiController.setHookWidget(key, content, options);
	}

	setHookStatus(key: string, text: string | undefined): void {
		this.#extensionUiController.setHookStatus(key, text);
	}

	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookSelector(title, options, dialogOptions, extra);
	}

	hideHookSelector(): void {
		this.#extensionUiController.hideHookSelector();
	}

	showAskDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		return this.#extensionUiController.showAskDialog(questions, dialogOptions);
	}

	showHookInput(
		title: string,
		placeholder?: string,
		inputOptions?: { mask?: boolean; hint?: string },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookInput(title, placeholder, undefined, inputOptions);
	}

	hideHookInput(): void {
		this.#extensionUiController.hideHookInput();
	}

	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookEditor(title, prefill, dialogOptions, editorOptions);
	}

	hideHookEditor(): void {
		this.#extensionUiController.hideHookEditor();
	}

	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.#extensionUiController.showHookNotify(message, type);
	}

	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean | OverlayOptions },
	): Promise<T> {
		return this.#extensionUiController.showHookCustom(factory, options);
	}

	showExtensionError(extensionPath: string, error: string): void {
		this.#extensionUiController.showExtensionError(extensionPath, error);
	}

	showToolError(toolName: string, error: string): void {
		this.#extensionUiController.showToolError(toolName, error);
	}

	#subscribeToAgent(): void {
		this.#eventController.subscribeToAgent();
	}

	/**
	 * Point the UI at `next` and hand the session it was displaying to the
	 * background keeper, so a turn in flight runs to completion instead of
	 * being aborted.
	 *
	 * `bindings` are required for a session this screen has not displayed
	 * before, and the caller installs this screen's dialogs and extensions
	 * through them afterwards (`initHooksAndCustomTools`). A session reclaimed
	 * from the background keeps the bindings and the UI it was displayed with.
	 *
	 * Every controller reads `ctx.session` dynamically and none caches its own
	 * reference, so reassigning the four session-derived fields re-points the
	 * whole UI at once. The two event subscriptions and the status line are the
	 * only holders of a session reference that must be moved by hand.
	 *
	 * `next` may already be streaming — that is what re-attaching a session
	 * handed off earlier looks like — so the turn state a missed `agent_start`
	 * would have armed is armed here instead.
	 */
	attachMainSession(next: AgentSession, bindings?: SessionHostBindings): KeptSession {
		const previous = this.session;
		// Re-attaching the displayed session hands nothing over, so it must not enter
		// the background set: that set is what the status line counts, and a visible
		// conversation counted there reports off-screen spend to someone watching it.
		if (next === previous) return BackgroundSessions.global().describeAttached(previous);
		if (!bindings && !this.#hostBindings.has(next)) {
			throw new Error(`Session ${next.sessionManager.getSessionId()} was attached without its host bindings`);
		}
		// Registered before the screen moves: an invalid `session.backgroundLimit` throws here and
		// leaves the displayed session where it was, instead of detaching it unregistered.
		const kept = BackgroundSessions.global().keep(previous, previous.settings.get("session.backgroundLimit"));
		if (bindings) this.#hostBindings.set(next, bindings);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.#goalMode.unsubscribeFromSession();
		this.session = next;
		this.sessionManager = next.sessionManager;
		this.settings = next.settings;
		this.agent = next.agent;
		this.#eventController.resetTranscriptAnchors();
		this.#subscribeToAgent();
		this.#goalMode.subscribeToSession();
		this.statusProducer.setSession(next);
		this.statusLine.setSource(this.statusProducer);
		if (next.isStreaming) void this.#eventController.handleEvent({ type: "agent_start" });
		return kept;
	}
}
