import type { AssistantMessage } from "@veyyon/ai";
import { type Component, Spacer, TERMINAL, Text } from "@veyyon/tui";
import { escapeTerminalText } from "@veyyon/utils";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../../../config/settings-instance";
import { SessionProjectionEngine } from "../../../presentation/session-projection-engine";
import { toAssistantMessageView } from "../../../presentation/transcript-builder";
import { SECRET_SPEND_NOTICE_SOURCE } from "../../../secrets/notices";
import type { AgentSession } from "../../../session/agent-session";
import type { AgentSessionEvent } from "../../../session/agent-session-types";
import {
	type CustomMessage,
	type HookMessage,
	isSilentAbort,
	readQueueChipText,
	resolveAbortLabel,
} from "../../../session/messages";
import { setShimmerActivity } from "../../../theme/shimmer";
import { theme } from "../../../theme/theme-binding";
import { canonicalizeMessage } from "../../../utils/thinking-display";
import { TodoReminderComponent } from "../components/dashboard/todo-reminder";
import { AssistantMessageComponent } from "../components/transcript/assistant-message";
import { detectCacheInvalidation, usesExplicitPromptCache } from "../components/transcript/cache-invalidation-marker";
import type { ToolExecutionComponent } from "../components/transcript/tool-execution";
import { TtsrNotificationComponent } from "../components/transcript/ttsr-notification";
import { createUsageRowBlock } from "../components/transcript/usage-row";
import { UserMessageComponent } from "../components/transcript/user-message";
import type { InteractiveModeContext } from "../types";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import { assistantUsageIsBilled, splitAssistantMessageToolTimeline } from "../utils/transcript-render-helpers";
import { ComposerPredictionController } from "./composer-prediction-controller";
import { DisplaceableBlocks } from "./displaceable-blocks";
import { IdleFollowUps } from "./idle-follow-ups";
import { IrcCards } from "./irc-cards";
import { StreamingRevealController } from "./streaming-reveal";
import { ToolArgsRevealController } from "./tool-args-reveal";
import { ToolCallCards } from "./tool-call-cards";
import { userEchoSignature } from "./transcript-composer";
import { ensureWorkingLoaderWhileStreaming, TurnRecovery } from "./turn-recovery";
import {
	installSpeechEnhancer,
	vocalizeDelta,
	vocalizeMessageEnd,
	vocalizeTurnEnd,
	vocalizeTurnStart,
} from "./turn-speech";

/**
 * The slice of the interactive context this controller uses: 51 members of the
 * 215 `InteractiveModeContext` requires. See `CollabHostContext` for why the
 * full interface cannot be used as a parameter type: nothing but the real TUI
 * can satisfy it, so every test has to cast a stub into place unchecked.
 */
export type EventControllerContext = Pick<
	InteractiveModeContext,
	| "addMessageToChat"
	| "applyCwdChange"
	| "autoCompactionLoader"
	| "chatContainer"
	| "clearOptimisticUserMessage"
	| "clearPinnedError"
	| "clearTransientSessionUi"
	| "clearWorkingLoader"
	| "editor"
	| "effectiveHideThinkingBlock"
	| "ensureLoadingAnimation"
	| "flushCompactionQueue"
	| "flushPendingModelSwitch"
	| "focusedAgentId"
	| "getUserMessageText"
	| "handlePlanApproval"
	| "init"
	| "isInitialized"
	| "lastAssistantUsage"
	| "loadingAnimation"
	| "locallySubmittedUserSignatures"
	| "noteDisplayableThinkingContent"
	| "optimisticUserMessageSignature"
	| "pendingTools"
	| "settledToolCalls"
	| "present"
	| "proseOnlyThinking"
	| "rebuildChatFromMessages"
	| "refreshComposerShortcuts"
	| "reloadTodos"
	| "renderInitialMessages"
	| "replaceOptimisticUserMessage"
	| "retryLoader"
	| "session"
	| "sessionManager"
	| "setTodos"
	| "setWorkingMessage"
	| "settings"
	| "showError"
	| "showPinnedError"
	| "showStatus"
	| "showWarning"
	| "statusContainer"
	| "statusLine"
	| "streamingComponent"
	| "streamingMessage"
	| "todoPhases"
	| "toolOutputExpanded"
	| "ui"
	| "unsubscribe"
	| "updateEditorBorderColor"
	| "updatePendingMessagesDisplay"
	| "viewSession"
>;

type AgentSessionEventKind = AgentSessionEvent["type"];
type StartedUserMessage = Extract<Extract<AgentSessionEvent, { type: "message_start" }>["message"], { role: "user" }>;

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};

export class EventController {
	// Count of visible assistant content blocks (rendered non-empty text/thinking)
	// already seen in the current streaming message. A newly appearing one breaks
	// the read run: the rendered reasoning/answer is a visual separator, so reads
	// after it start a fresh group. Empty/absent thinking — common when a model
	// emits one read per completion — does not break it, so a run of consecutive
	// reads collapses into one group even across completion boundaries.
	#lastVisibleBlockCount = 0;
	// Content indexes of the streaming message already counted as visible. A
	// block stays visible as it grows, so only the others are read on a delta:
	// reading a streamed block's text flattens it, which costs its whole length.
	#visibleBlocks = new Set<number>();
	#renderedCustomMessages = new Set<string>();
	#projection: SessionProjectionEngine;
	#attachedSession: AgentSession | undefined;
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	#composerPrediction: ComposerPredictionController;
	#idle: IdleFollowUps;
	#ircCards: IrcCards;
	#displaceable: DisplaceableBlocks;
	#cards: ToolCallCards;
	#recovery: TurnRecovery;
	// Most recent TTSR notification block. A new ttsr_triggered event merges its
	// rules into this block while it is still the (live-region) transcript tail.
	#lastTtsrNotification: TtsrNotificationComponent | undefined = undefined;
	#streamingReveal: StreamingRevealController;
	#toolArgsReveal: ToolArgsRevealController;
	#prevHideThinking = false;
	#handlers: AgentSessionEventHandlers;
	#terminalProgressActive = false;
	// How many of the session's recorded system-prompt invalidations have already
	// been named on a cache-miss marker. The record is cumulative, so the entries
	// past this index are the ones that happened since the last marker and are the
	// only ones that can explain the turn now finishing.
	#namedCacheInvalidations = 0;
	// A transcript replay events wait for (see deferEventsUntil); cleared by the first event after it.
	#transcriptReplay: Promise<unknown> | undefined;

	constructor(private ctx: EventControllerContext) {
		this.#composerPrediction = new ComposerPredictionController(ctx);
		installSpeechEnhancer(ctx.session);
		this.#projection = new SessionProjectionEngine({
			getMessages: () => (this.#attachedSession ?? this.ctx.session)?.messages ?? [],
		});
		this.#streamingReveal = new StreamingRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			getHideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			getProseOnlyThinking: () => this.ctx.proseOnlyThinking,
			requestRender: component => this.ctx.ui.requestComponentRender(component),
		});
		this.#toolArgsReveal = new ToolArgsRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			requestRender: component => this.ctx.ui.requestComponentRender(component),
		});
		this.#idle = new IdleFollowUps(ctx);
		this.#ircCards = new IrcCards(ctx);
		this.#displaceable = new DisplaceableBlocks(ctx);
		this.#cards = new ToolCallCards(ctx, {
			projection: this.#projection,
			toolArgsReveal: this.#toolArgsReveal,
			displaceable: this.#displaceable,
			lastAssistantComponent: () => this.#lastAssistantComponent,
		});
		this.#recovery = new TurnRecovery(ctx, {
			projection: this.#projection,
			idle: this.#idle,
			composerPrediction: this.#composerPrediction,
			setTerminalProgress: active => this.#setTerminalProgress(active),
		});
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => vocalizeTurnStart(),
			turn_end: async e => vocalizeTurnEnd(e),
			message_start: e => this.#handleMessageStart(e),
			message_update: e => this.#handleMessageUpdate(e),
			message_end: e => this.#handleMessageEnd(e),
			tool_execution_start: e => this.#cards.toolExecutionStarted(e),
			tool_execution_update: e => this.#cards.toolExecutionUpdated(e),
			tool_execution_end: e => this.#cards.toolExecutionEnded(e),
			auto_compaction_start: e => this.#recovery.compactionStarted(e),
			auto_compaction_end: e => this.#recovery.compactionEnded(e),
			auto_retry_start: e => this.#recovery.retryStarted(e, this.#lastAssistantComponent),
			auto_retry_end: e => this.#recovery.retryEnded(e),
			retry_fallback_applied: e => this.#handleRetryFallbackApplied(e),
			retry_fallback_succeeded: e => this.#handleRetryFallbackSucceeded(e),
			ttsr_triggered: e => this.#handleTtsrTriggered(e),
			todo_reminder: e => this.#handleTodoReminder(e),
			todo_auto_clear: e => this.#handleTodoAutoClear(e),
			irc_message: e => this.#handleIrcMessage(e),
			notice: e => this.#handleNotice(e),
			thinking_level_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				const hideThinking = this.ctx.effectiveHideThinkingBlock;
				// Only do the expensive full resetDisplay when the effective
				// visibility actually changed. Auto-classification (e.g. high→medium)
				// emits thinking_level_changed without changing visibility — a full
				// terminal replay for those would be disruptive.
				if (hideThinking === this.#prevHideThinking) {
					this.ctx.ui.requestRender();
					return;
				}
				this.#prevHideThinking = hideThinking;
				// Propagate visibility to existing rendered messages.
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(hideThinking);
					}
				}
				if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
					this.ctx.streamingComponent.setHideThinkingBlock(hideThinking);
					this.#streamingReveal.resyncVisibility();
				}
				this.ctx.ui.resetDisplay();
			},
			goal_updated: async () => {},
			cwd_changed: async event => {
				// A session-scoped cwd change (`/cwd` or the agent's `set_cwd` tool)
				// already updated SessionManager cwd + `getProjectDir()` inside
				// AgentSession.setCwd. The remaining re-root — reloading project
				// settings, plugins, capabilities, slash commands, the ssh tool, and
				// the system-prompt project framing for the new directory — lives in
				// applyCwdChange, the same path `/move` runs. Without this, tools moved
				// to the new dir but the agent's config and command surface stayed
				// pinned to the old one. applyCwdChange ends with statusLine.invalidate
				// + ui.requestRender, so those are covered here too.
				await this.ctx.applyCwdChange(event.cwd);
			},
		} satisfies AgentSessionEventHandlers;
	}

	dispose(): void {
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
		this.#idle.cancel();
		this.#composerPrediction.cancel();
		this.#setTerminalProgress(false);
		this.#ircCards.clear();
	}

	/** Component-scoped repaints for message_update: avoids a full-tree walk on
	 *  every provider delta while smooth reveal / tool-args reveal pace paints. */
	#repaintMessageUpdateComponents(components: Iterable<Component>): void {
		let scheduled = false;
		for (const component of components) {
			scheduled = true;
			if (typeof this.ctx.ui.requestComponentRender === "function") {
				this.ctx.ui.requestComponentRender(component);
			}
		}
		if (scheduled && typeof this.ctx.ui.requestComponentRender !== "function") {
			this.ctx.ui.requestRender();
		}
	}
	subscribeToAgent(): void {
		this.attachTo(this.ctx.session);
	}

	/**
	 * Subscribe the transcript to `target`, tolerating an attach that lands
	 * mid-turn.
	 *
	 * Orphan-delta guard: attaching while an assistant message is already
	 * streaming means its `message_start` predates the attach. `message_update`
	 * carries the full accumulating message, so synthesize the missing start
	 * before the first orphaned update; every other handler is tolerant of
	 * unknown anchors (guarded by streamingComponent/pendingTools lookups).
	 *
	 * Both re-pointing paths come through here — viewing an agent, and `/new`
	 * or `/resume` swapping the session the UI displays — so neither grows its
	 * own copy of the guard.
	 */
	attachTo(target: AgentSession): void {
		this.#attachedSession = target;
		this.#projection.seedMessages();
		let assistantStreamSynced = false;
		this.ctx.unsubscribe = target.subscribe(async (event: AgentSessionEvent) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				assistantStreamSynced = true;
			} else if (event.type === "message_update" && event.message.role === "assistant" && !assistantStreamSynced) {
				assistantStreamSynced = true;
				await this.handleEvent({ type: "message_start", message: event.message });
			}
			await this.handleEvent(event);
		});
	}

	/**
	 * Clear every transcript-anchored/turn-scoped piece of state. Used by the
	 * session focus proxy when re-pointing the transcript at another session:
	 * components, timers, and stream-reveal state all reference the previous
	 * session's transcript and must not bleed into the new one.
	 */
	resetTranscriptAnchors(): void {
		this.#cards.reset();
		this.#lastVisibleBlockCount = 0;
		this.#visibleBlocks.clear();
		this.#renderedCustomMessages.clear();
		this.#projection.reset();
		this.#lastAssistantComponent = undefined;
		this.#recovery.forgetPinnedError();
		this.#idle.cancel();
		this.#composerPrediction.cancel();
		this.#ircCards.clear();
		this.#displaceable.clear();
		this.#lastTtsrNotification = undefined;
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
	}

	/**
	 * Drop every reference to a transcript component a rebuild detached, and the arguments of the
	 * calls that settled.
	 *
	 * The per-call maps are emptied at agent start and end, so within one agent run they gain an
	 * entry for every tool call. A component no longer in the transcript is never drawn or anchored
	 * after again: the tool-call cards cannot find it, and a read's images inlined
	 * into it would show nowhere instead of in the read group. Without this, a long run kept every
	 * card a compaction collapsed, with its arguments and result text.
	 */
	releaseDetachedTranscriptAnchors(): void {
		const attached = new Set<Component>(this.ctx.chatContainer.children);
		this.#cards.releaseDetached(attached);
		if (this.#lastAssistantComponent && !attached.has(this.#lastAssistantComponent)) {
			this.#lastAssistantComponent = undefined;
		}
		this.#projection.releaseSettledToolCalls();
	}

	/**
	 * Hold session events until `replay` settles. A transcript rebuilt in slices shares the pending
	 * and settled tool-call ledgers with live routing, so an event handled mid-rebuild would route
	 * against a half-built ledger, and the rebuild would seal the card that event opened as history.
	 */
	deferEventsUntil(replay: Promise<void>): void {
		this.#transcriptReplay = replay.catch(() => undefined);
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
		}
		const replay = this.#transcriptReplay;
		if (replay) {
			// Events that arrive while it builds queue on it in order; the first to resume releases it.
			await replay;
			if (this.#transcriptReplay === replay) this.#transcriptReplay = undefined;
		}
		// Each handler explicitly requests a render (or leaves it out, when it
		// changed nothing visible). A blanket pre-render fired on every event —
		// including the ~hundreds of `message_update` deltas per streaming turn —
		// doubled the paint rate: the pre-render's frame fires while the handler
		// is awaiting, then the handler's own final requestRender schedules a
		// second identical frame. Removing it lets the render cadence follow real
		// state changes rather than event volume (issue #4353).
		const run = this.#handlers[event.type] as (e: AgentSessionEvent) => Promise<void>;
		await run(event);
	}

	#setTerminalProgress(active: boolean): void {
		if (active) {
			if (this.#terminalProgressActive || this.ctx.settings?.get("terminal.showProgress") !== true) return;
			this.ctx.ui.terminal.setProgress(true);
			this.#terminalProgressActive = true;
			return;
		}
		if (!this.#terminalProgressActive) return;
		this.ctx.ui.terminal.setProgress(false);
		this.#terminalProgressActive = false;
	}

	/**
	 * The reason for the most recent unreported system-prompt invalidation, or
	 * `undefined` when nothing new was recorded since the last marker.
	 *
	 * The session's record is cumulative and append-only, so the entries past
	 * `#namedCacheInvalidations` are exactly the ones that happened during the turn
	 * that just finished. The LAST of those is reported: when several land in one
	 * turn (a cwd change also refreshes secrets, for instance) the final rebuild is
	 * the one whose bytes the cold request actually carried. The index advances
	 * whether or not a marker renders, so a stale reason can never be attached to a
	 * later, unrelated cold turn.
	 *
	 * Optional access: controller tests build partial ctx mocks with no session.
	 */
	#takeCacheInvalidationCause(): string | undefined {
		const recorded = this.ctx.session?.systemPromptInvalidations?.() ?? [];
		if (recorded.length <= this.#namedCacheInvalidations) {
			this.#namedCacheInvalidations = recorded.length;
			return undefined;
		}
		const fresh = recorded.slice(this.#namedCacheInvalidations);
		this.#namedCacheInvalidations = recorded.length;
		return fresh.at(-1);
	}

	/** The prompt the running turn is working on; it carries the follow's glow
	 *  from agent_start to agent_end (see UserMessageComponent.setWorking). */
	#workingUserMessage: UserMessageComponent | undefined;

	/** Move the working glow to the newest user prompt in the transcript. */
	#armWorkingUserMessage(): void {
		this.#workingUserMessage?.setWorking(false);
		this.#workingUserMessage = undefined;
		// Optional access: controller test harnesses build partial ctx mocks
		// without a chat container; with no transcript there is nothing to glow.
		const children = this.ctx.chatContainer?.children ?? [];
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (child instanceof UserMessageComponent) {
				child.setWorking(true);
				this.#workingUserMessage = child;
				return;
			}
		}
	}

	async #handleAgentStart(_event: Extract<AgentSessionEvent, { type: "agent_start" }>): Promise<void> {
		this.#armWorkingUserMessage();
		this.#cards.beginTurn();
		this.#projection.clearRetryTrace();
		this.#displaceable.sealTodo();
		this.#lastAssistantComponent = undefined;
		this.#recovery.releasePinnedError();
		this.#recovery.stopRetryLoader();
		this.#idle.cancel();
		this.#composerPrediction.cancel();
		this.ctx.statusLine.markActivityStart();
		this.#setTerminalProgress(true);
		// The turn opens with the model reasoning before any token streams.
		setShimmerActivity("thinking");
		this.ctx.ensureLoadingAnimation();
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		ensureWorkingLoaderWhileStreaming(this.ctx);
		const { message } = event;
		if (message.role === "hookMessage" || message.role === "custom") {
			this.#startCustomMessage(message);
		} else if (message.role === "user") {
			this.#startUserMessage(message);
		} else if (message.role === "fileMention") {
			this.#cards.resetReadGroup();
			this.ctx.addMessageToChat(message);
			this.ctx.ui.requestRender();
		} else if (message.role === "assistant") {
			this.#startAssistantMessage(message);
		}
	}

	/**
	 * Claims a custom message's transcript slot: its signature the first time the message starts, undefined once it
	 * has been shown.
	 */
	#claimCustomMessage(message: CustomMessage | HookMessage): string | undefined {
		const signature = `${message.role}:${message.customType}:${message.timestamp}`;
		if (this.#renderedCustomMessages.has(signature)) return undefined;
		this.#renderedCustomMessages.add(signature);
		return signature;
	}

	#startCustomMessage(message: CustomMessage | HookMessage): void {
		if (this.#claimCustomMessage(message) === undefined) return;
		this.#cards.resetReadGroup();
		this.ctx.addMessageToChat(message);
		// Queued custom-message chips are derived from the agent queue; refresh the pending bar when the queued custom
		// message is consumed so the chip disappears immediately.
		if (message.role === "custom" && readQueueChipText(message.details)) this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	#startUserMessage(message: StartedUserMessage): void {
		const signature = userEchoSignature(this.ctx.getUserMessageText(message), countInlineImages(message.content));
		this.#cards.resetReadGroup();
		this.#displaceable.resolvePoll();
		this.#displaceable.sealTodo();
		const wasLocallySubmitted = this.#settleSubmittedEcho(message, signature);
		if (!message.synthetic) {
			// Clear the editor only when the submission did not originate from a local submission (optimistic or
			// queued-while-streaming). Both local paths already cleared the editor at submit time; clearing again here
			// would race with the next prompt being typed while the previous large redraw lands and erase the
			// in-progress draft (#783).
			if (!wasLocallySubmitted) this.ctx.editor.setText("");
			this.ctx.updatePendingMessagesDisplay();
			// A prompt landing mid-turn (queued while streaming) becomes the one being worked: move the glow so it
			// always sits on the newest prompt.
			if (this.ctx.session?.isStreaming) this.#armWorkingUserMessage();
		}
		this.ctx.ui.requestRender();
	}

	/**
	 * Settles a user message against what this client drew at submit time and returns whether the message came from
	 * a local submission. A matching optimistic echo stays, an unmatched one gives way to the message, and a message
	 * from elsewhere is appended.
	 */
	#settleSubmittedEcho(message: StartedUserMessage, signature: string): boolean {
		const optimisticSignature = this.ctx.optimisticUserMessageSignature;
		const matchedLocalSubmission = this.ctx.locallySubmittedUserSignatures.delete(signature);
		if (optimisticSignature === signature) {
			this.ctx.clearOptimisticUserMessage();
			return true;
		}
		if (optimisticSignature !== undefined && !matchedLocalSubmission) {
			this.ctx.replaceOptimisticUserMessage(message);
			return true;
		}
		// Append synchronously: #emit dispatches to this listener fire-and-forget (see AgentSession.#emit), so any
		// await between the user message_start and addMessageToChat lets later events (assistant message_start, tool
		// execution start/end) append their components first and scramble transcript order / live-region block
		// boundaries. addMessageToChat materializes clickable image links via the synchronous putBlobSync fallback, so
		// no await is needed here.
		this.ctx.addMessageToChat(message);
		return matchedLocalSubmission;
	}

	#startAssistantMessage(message: AssistantMessage): void {
		this.#lastVisibleBlockCount = 0;
		this.#visibleBlocks.clear();
		this.#projection.recordAssistantMessageToolCalls(message);
		const component = createAssistantMessageComponent(this.ctx);
		this.ctx.streamingComponent = component;
		this.ctx.streamingMessage = message;
		this.ctx.chatContainer.addChild(component);
		const timeline = splitAssistantMessageToolTimeline(message);
		this.#streamingReveal.begin(component, toAssistantMessageView(timeline.beforeTools));
		this.ctx.ui.requestRender();
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		const signature = this.#claimCustomMessage(event.message);
		if (signature === undefined) return;
		this.#cards.resetReadGroup();
		const components = this.ctx.addMessageToChat(event.message);
		this.#ircCards.track(signature, components);
		this.ctx.ui.requestRender();
	}

	/**
	 * Adopt a rebuilt-tail todo snapshot as the tracked live snapshot, so the next same-turn `todo` update replaces it
	 * instead of stacking another panel. See {@link DisplaceableBlocks.inheritTodo}.
	 */
	inheritDisplaceableTodo(component: ToolExecutionComponent | null | undefined): void {
		this.#displaceable.inheritTodo(component);
	}

	async #handleNotice(event: Extract<AgentSessionEvent, { type: "notice" }>): Promise<void> {
		if (event.source === SECRET_SPEND_NOTICE_SOURCE) {
			// Its own block rather than `showStatus`, which COALESCES consecutive status lines: one
			// assistant message can issue several tool calls, every block for them is already in the
			// transcript before the first one executes, so nothing is appended between two spends and
			// the second line would overwrite the first — three credentials spent, one named. A
			// credential per line is the whole point. The message already reads as a sentence, so it
			// skips the generic `source: text` prefix.
			this.ctx.present([new Spacer(1), new Text(theme.fg("dim", escapeTerminalText(event.message)), 1, 0)]);
			this.ctx.ui.requestRender();
			return;
		}
		const message = event.source ? `${event.source}: ${event.message}` : event.message;
		if (event.level === "error") {
			this.ctx.showError(message);
		} else if (event.level === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		ensureWorkingLoaderWhileStreaming(this.ctx);
		// Living shimmer: a text delta means the model is writing (streaming
		// comet); a thinking delta means it is reasoning (ponder breath). Not
		// every message_update carries a delta (e.g. a toolCall-finalize update),
		// so guard — those leave the activity as-is.
		const streamDelta = event.assistantMessageEvent;
		if (streamDelta?.type === "text_delta") setShimmerActivity("streaming");
		else if (streamDelta?.type === "thinking_delta") setShimmerActivity("thinking");
		vocalizeDelta(event);
		const { message } = event;
		const streamingComponent = this.ctx.streamingComponent;
		if (streamingComponent && message.role === "assistant")
			this.#updateStreamingAssistant(streamingComponent, message);
	}

	/** Projects one streamed snapshot of the assistant message: its prose, its tool-call previews and the working message. */
	#updateStreamingAssistant(streamingComponent: AssistantMessageComponent, message: AssistantMessage): void {
		this.#projection.recordAssistantMessageToolCalls(message);
		const smoothStreaming = this.ctx.settings.get("display.smoothStreaming");
		const repaintTargets = new Set<Component>();
		if (this.ctx.noteDisplayableThinkingContent(message)) {
			streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
			this.#streamingReveal.resyncVisibility();
			repaintTargets.add(streamingComponent);
		}
		this.ctx.streamingMessage = message;
		const timeline = splitAssistantMessageToolTimeline(message);
		this.#streamingReveal.setTarget(toAssistantMessageView(timeline.beforeTools));
		this.#noteVisibleBlocks(message, smoothStreaming, streamingComponent, repaintTargets);

		// Content blocks stream sequentially: a toolCall block can only begin
		// after every preceding thinking/text block has closed, and the
		// reveal's setTarget above force-completes the visible text for
		// toolCall messages. Finalize the assistant block now instead of at
		// message_end so the transcript's commit-safe run can extend through
		// it into the streaming tool preview below — otherwise a long args
		// stream (a big write/edit/eval) sits below a still-live block and
		// can never reach native scrollback: the head of the preview is
		// neither committed nor on screen and the transcript reads as cut.
		if (message.content.some(content => content.type === "toolCall")) {
			streamingComponent.markTranscriptBlockFinalized();
			repaintTargets.add(streamingComponent);
		}
		for (const content of message.content) {
			if (content.type === "toolCall")
				this.#cards.previewStreamingToolCall(content, smoothStreaming, repaintTargets);
		}
		for (const [toolCallId, segment] of timeline.afterToolCalls) {
			const segmentComponent = this.#cards.upsertPostToolAssistantSegment(toolCallId, segment);
			if (segmentComponent) repaintTargets.add(segmentComponent);
		}
		this.#cards.showStreamedIntent(message.content);

		// Smooth assistant reveal paints on its own 30fps timer; repainting the
		// streaming block on every provider delta duplicated full-tree walks
		// while the revealed prefix was unchanged between ticks (issue #4377).
		if (!smoothStreaming) repaintTargets.add(streamingComponent);
		this.#repaintMessageUpdateComponents(repaintTargets);
	}

	/**
	 * Counts the streaming message's visible blocks. A newly visible block breaks the read run, and repaints the
	 * streaming block unless it is the first one: a new visible block after the first (e.g. thinking closed, next text
	 * block) changes the transcript layout, while the first block's growth is paced by the reveal timer when smooth
	 * streaming is on.
	 */
	#noteVisibleBlocks(
		message: AssistantMessage,
		smoothStreaming: boolean,
		streamingComponent: AssistantMessageComponent,
		repaintTargets: Set<Component>,
	): void {
		const visibleBlockCount = this.#countVisibleBlocks(message.content);
		if (visibleBlockCount <= this.#lastVisibleBlockCount) return;
		if (!smoothStreaming || this.#lastVisibleBlockCount >= 1) repaintTargets.add(streamingComponent);
		this.#cards.resetReadGroup();
		this.#lastVisibleBlockCount = visibleBlockCount;
	}

	/** Visible (non-placeholder) text and thinking blocks of the streaming message seen so far. */
	#countVisibleBlocks(content: AssistantMessage["content"]): number {
		for (let i = 0; i < content.length; i++) {
			if (this.#visibleBlocks.has(i)) continue;
			const block = content[i]!;
			if (
				(block.type === "text" && canonicalizeMessage(block.text)) ||
				(block.type === "thinking" && canonicalizeMessage(block.thinking))
			) {
				this.#visibleBlocks.add(i);
			}
		}
		return this.#visibleBlocks.size;
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		const { message } = event;
		if (message.role === "user") return;
		if (message.role === "assistant") this.#endAssistantMessage(message);
		this.ctx.ui.requestRender();
	}

	#endAssistantMessage(message: AssistantMessage): void {
		if (this.ctx.noteDisplayableThinkingContent(message) && this.ctx.streamingComponent) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
			this.#streamingReveal.resyncVisibility();
		}
		vocalizeMessageEnd(message);
		const streamingComponent = this.ctx.streamingComponent;
		if (streamingComponent) {
			this.#finalizeStreamingAssistant(streamingComponent, message);
		} else if (endsInShownError(message)) {
			// The turn died before any streaming began (the provider rejected the request at setup: unsupported
			// thinking effort, bad model id, auth), so there is no streaming component to hold an inline error row.
			// Without this branch the submitted prompt vanished with no working line, no banner, and no clue. Pin the
			// error above the editor exactly like a mid-stream failure; the next turn's agent_start clears it.
			this.ctx.showPinnedError(message.errorMessage);
		}
	}

	/** Freezes the streamed assistant block at the message's final content and releases the streaming slot. */
	#finalizeStreamingAssistant(component: AssistantMessageComponent, message: AssistantMessage): void {
		this.ctx.streamingMessage = message;
		this.#streamingReveal.stop();
		this.#toolArgsReveal.flushAll();
		const timeline = splitAssistantMessageToolTimeline(this.#displayedEndOfTurn(message));
		component.updateContent(toAssistantMessageView(timeline.beforeTools));
		this.#cards.settlePendingToolCalls(message.stopReason);
		this.#noteTurnUsage(component, message);
		component.markTranscriptBlockFinalized();
		let lastSegmentComponent: AssistantMessageComponent | undefined;
		for (const [toolCallId, segment] of timeline.afterToolCalls) {
			const segmentComponent = this.#cards.upsertPostToolAssistantSegment(toolCallId, segment);
			if (!segmentComponent) continue;
			segmentComponent.markTranscriptBlockFinalized();
			lastSegmentComponent = segmentComponent;
		}
		this.#lastAssistantComponent = lastSegmentComponent ?? component;
		if (settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage)) {
			this.ctx.chatContainer.addChild(createUsageRowBlock(message.usage, message.duration, message.ttft));
		}
		this.ctx.streamingComponent = undefined;
		this.ctx.streamingMessage = undefined;
		// Pin a turn-ending provider error (e.g. Anthropic content-filter block) above the editor so it survives
		// transcript scroll; the next turn's agent_start clears it. The turn's stop reason is on its HEAD segment, so
		// the streamed block, not a post-tool segment, is the one whose inline `Error: …` line the banner suppresses:
		// post-tool segments have no stop reason, and pinning one left the head's inline error under a banner already
		// showing it.
		if (endsInShownError(message)) this.#recovery.pinTurnError(component, message.errorMessage);
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
	}

	/**
	 * The ended message as the transcript draws it. A silent abort (an internal transition) or an abort a TTSR rewind
	 * replaces renders as a clean stop, for display only: the persisted stop reason stays, and the marker on
	 * `errorMessage` drives replay-side suppression. Any other abort is stamped with its operator-facing label.
	 */
	#displayedEndOfTurn(message: AssistantMessage): AssistantMessage {
		if (message.stopReason !== "aborted") return message;
		if (isSilentAbort(message) || this.ctx.viewSession.isTtsrAbortPending) return { ...message, stopReason: "stop" };
		// A user interrupt (Esc) holds USER_INTERRUPT_LABEL on errorMessage, threaded through the AbortController, and
		// keeps it verbatim; any other abort with no threaded reason falls back to the retry-aware generic label.
		// AgentSession.#handleAgentEvent already stamped SILENT_ABORT_MARKER for the plan-compact transition before
		// this controller ran, so an abort reaching this line is not a silent internal transition.
		message.errorMessage = resolveAbortLabel(message, this.ctx.viewSession.retryAttempt);
		return message;
	}

	/**
	 * Records the turn's usage and flags a prompt-cache invalidation: when the previous turn cached a meaningful prefix
	 * and this request read none of it back, the block is marked with the cause the session recorded, if any. A bare
	 * token count shows the conversation was re-read at full price without stating what caused it.
	 */
	#noteTurnUsage(component: AssistantMessageComponent, message: AssistantMessage): void {
		const { usage } = message;
		if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
			if (settings.get("display.cacheMissMarker")) {
				const invalidation = detectCacheInvalidation(
					this.ctx.lastAssistantUsage,
					usage,
					this.#takeCacheInvalidationCause(),
					{ explicitCache: usesExplicitPromptCache(message.api, message.model) },
				);
				if (invalidation) component.setCacheInvalidation(invalidation);
			}
			this.ctx.lastAssistantUsage = usage;
		}
	}

	async #handleAgentEnd(_event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		// A superseded agent_end: the agent is already streaming a fresh turn, so
		// this event belongs to a turn that has already been replaced. The session
		// dispatches to listeners fire-and-forget across an async extension-emit hop
		// (#emitSessionEvent), so an interrupted turn's agent_end can land AFTER the
		// resumed turn's agent_start (e.g. any post-turn agent.continue()). Running
		// the turn-end teardown now would stop the loader the live turn just created,
		// leaving "Working…" gone while the agent keeps running. The live turn owns
		// the loader and finalizes it at its own agent_end (isStreaming === false by
		// then). Mirrors the collab guest's !isStreaming loader reconciler.
		if (this.ctx.session.isStreaming) return;

		await this.#finishAgentEnd();
	}

	async #finishAgentEnd(): Promise<void> {
		this.#workingUserMessage?.setWorking(false);
		this.#workingUserMessage = undefined;
		this.#setTerminalProgress(false);
		// Living shimmer: the turn is over — return to the resting state so the
		// next turn opens fresh from `thinking` rather than mid-motion.
		setShimmerActivity("idle");
		this.ctx.statusLine.markActivityEnd();
		// The turn's tools may have moved the tree; the marker is otherwise up to GIT_STATUS_MAX_AGE_MS old.
		this.ctx.statusLine.refreshGitStatus();
		this.#streamingReveal.stop();
		this.#toolArgsReveal.flushAll();
		if (this.ctx.clearWorkingLoader()) {
			this.ctx.statusContainer.disposeChildren();
		}
		if (this.ctx.streamingComponent) {
			this.ctx.chatContainer.removeChild(this.ctx.streamingComponent);
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
		}
		await this.ctx.flushPendingModelSwitch();
		this.#cards.endTurn();
		// The turn is over: nothing else lands this turn, so the waiting poll is
		// final history — seal it instead of letting its spinner tick while idle.
		this.#displaceable.resolvePoll();
		this.#displaceable.sealTodo();
		this.#lastAssistantComponent = undefined;
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
		this.#idle.schedule();
		void this.#composerPrediction.request();
		this.sendCompletionNotification();
	}

	async #handleRetryFallbackApplied(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>,
	): Promise<void> {
		this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}`);
	}

	async #handleRetryFallbackSucceeded(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>,
	): Promise<void> {
		this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
	}

	async #handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): Promise<void> {
		// Consecutive notifications (e.g. per-tool matches from one assistant
		// message) merge into the previous block instead of stacking. Mutating an
		// existing block is only safe while none of its rows have entered native
		// scrollback — committed rows are immutable visual history and a grown
		// block would shift them.
		const previous = this.#lastTtsrNotification;
		if (
			previous &&
			this.ctx.chatContainer.children.at(-1) === previous &&
			this.ctx.chatContainer.isBlockUncommitted(previous)
		) {
			previous.addRules(event.rules);
			this.ctx.ui.requestRender();
			return;
		}
		const component = new TtsrNotificationComponent(event.rules);
		component.setExpanded(this.ctx.toolOutputExpanded);
		this.ctx.present(component);
		this.#lastTtsrNotification = component;
	}

	async #handleTodoReminder(event: Extract<AgentSessionEvent, { type: "todo_reminder" }>): Promise<void> {
		const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
		this.ctx.present(component);
	}

	async #handleTodoAutoClear(_event: Extract<AgentSessionEvent, { type: "todo_auto_clear" }>): Promise<void> {
		await this.ctx.reloadTodos();
	}

	sendCompletionNotification(): void {
		const notify = settings.get("completion.notify");
		if (notify === "off") return;

		// Skip when the turn was aborted (e.g. ask cancelled with Ctrl+C) or
		// errored — those are not "Task complete" events. Mirrors the gate
		// already used by #currentContextTokens, #handleMessageEnd, and the
		// retry / TTSR / compaction skip paths across agent-session.ts.
		const last = this.ctx.viewSession.getLastAssistantMessage?.();
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		TERMINAL.sendNotification({
			title: sessionName || "Veyyon",
			body: "Complete",
			type: "completion",
			actions: "focus",
		});
	}
}

/** Whether a message ended in an error to show: an error stop with a message, not suppressed by the silent-abort marker. */
function endsInShownError(message: AssistantMessage): message is AssistantMessage & { errorMessage: string } {
	return message.stopReason === "error" && !!message.errorMessage && !isSilentAbort(message);
}

/** The image blocks with inline data in a user message, the count the local-echo signature records. */
function countInlineImages(content: StartedUserMessage["content"]): number {
	if (typeof content === "string") return 0;
	let count = 0;
	for (const block of content) {
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") count++;
	}
	return count;
}
