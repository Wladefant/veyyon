/**
 * How a turn shows its recovery: the auto-compaction and auto-retry loaders in
 * the status area, the assistant blocks a successful retry marks as recovered,
 * and the pinned banner for a turn-ending error that no retry recovered.
 */
import * as AIError from "@veyyon/ai/error";
import { Loader, type LoaderMessageColorFn } from "@veyyon/tui";
import { settings } from "../../../config/settings-instance";
import type { RecoveredRetryError } from "../../../extensibility/shared-events";
import type { SessionProjectionEngine } from "../../../presentation/session-projection-engine";
import { compactionActionLabel, resolveCompactionKind } from "../../../presentation/summary-builder";
import { resolveAssistantErrorPresentation } from "../../../presentation/transcript-builder";
import type { AgentSessionEvent } from "../../../session/agent-session-types";
import { setShimmerActivity, shimmerText } from "../../../theme/shimmer";
import { getSymbolTheme, theme } from "../../../theme/theme";
import { formatRetryLine } from "../../retry-display";
import type { AssistantMessageComponent } from "../components/transcript/assistant-message";
import type { ComposerPredictionController } from "./composer-prediction-controller";
import type { EventControllerContext } from "./event-controller";
import type { IdleFollowUps } from "./idle-follow-ups";

type TurnRecoveryContext = Pick<
	EventControllerContext,
	| "autoCompactionLoader"
	| "clearPinnedError"
	| "clearWorkingLoader"
	| "ensureLoadingAnimation"
	| "flushCompactionQueue"
	| "focusedAgentId"
	| "lastAssistantUsage"
	| "rebuildChatFromMessages"
	| "refreshComposerShortcuts"
	| "retryLoader"
	| "settings"
	| "showError"
	| "showPinnedError"
	| "showStatus"
	| "showWarning"
	| "statusContainer"
	| "statusLine"
	| "ui"
	| "viewSession"
>;

/** What the recovery loaders quiet or advance while they run, all owned by the event controller. */
export interface TurnRecoveryDeps {
	projection: SessionProjectionEngine;
	idle: IdleFollowUps;
	composerPrediction: ComposerPredictionController;
	setTerminalProgress(active: boolean): void;
}

/**
 * Restore the live "Working…" loader when a streaming event lands after a
 * transient status overlay cleared the container. Focus mode dispatches events
 * for `viewSession`, so key the reconciler on that session, not the main one.
 */
export function ensureWorkingLoaderWhileStreaming(
	ctx: Pick<EventControllerContext, "autoCompactionLoader" | "ensureLoadingAnimation" | "retryLoader" | "viewSession">,
): void {
	if (!ctx.viewSession.isStreaming) return;
	if (ctx.autoCompactionLoader || ctx.retryLoader) return;
	ctx.ensureLoadingAnimation();
}

export class TurnRecovery {
	// Assistant component whose turn-ending error is currently mirrored in the
	// pinned banner. Its inline `Error: …` line is suppressed while pinned and
	// restored when the banner clears at the next `agent_start`.
	#pinnedErrorComponent: AssistantMessageComponent | undefined = undefined;
	#supersededByKey = new Map<string, AssistantMessageComponent>();
	#supersededQueue: AssistantMessageComponent[] = [];

	constructor(
		private ctx: TurnRecoveryContext,
		private deps: TurnRecoveryDeps,
	) {}

	/** Pins a turn-ending error above the editor and suppresses the block's inline copy of it. */
	pinTurnError(component: AssistantMessageComponent, errorMessage: string): void {
		component.setErrorPinned(true);
		this.#pinnedErrorComponent = component;
		this.ctx.showPinnedError(errorMessage);
	}

	/** Clears the banner and restores the inline error, so the error stays in history once the banner is gone. */
	releasePinnedError(): void {
		this.#pinnedErrorComponent?.setErrorPinned(false);
		this.#pinnedErrorComponent = undefined;
		this.ctx.clearPinnedError();
	}

	/** Forgets the pinned block without touching it; the transcript it belonged to is gone. */
	forgetPinnedError(): void {
		this.#pinnedErrorComponent = undefined;
	}

	/** Stops and removes the auto-retry countdown, if one is showing. */
	stopRetryLoader(): void {
		if (!this.ctx.retryLoader) return;
		this.ctx.retryLoader.stop();
		this.ctx.retryLoader = undefined;
		this.ctx.statusContainer.disposeChildren();
	}

	async compactionStarted(event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>): Promise<void> {
		this.deps.idle.cancel();
		this.deps.composerPrediction.cancel();
		this.deps.setTerminalProgress(true);
		this.ctx.clearWorkingLoader();
		this.ctx.statusContainer.disposeChildren();
		const reasonText =
			event.reason === "overflow"
				? "Context overflow detected, "
				: event.reason === "incomplete"
					? "Response incomplete, "
					: event.reason === "idle"
						? "Idle "
						: event.reason === "provider_switch"
							? "Provider switch, "
							: "";
		const actionLabel = compactionActionLabel(true, resolveCompactionKind(this.ctx.viewSession));
		this.ctx.autoCompactionLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${reasonText}${actionLabel}…${this.#escHint()}`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
	}

	async compactionEnded(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		this.deps.idle.cancel();
		this.deps.setTerminalProgress(false);
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		if (event.aborted) {
			this.ctx.showStatus("Auto-compaction cancelled");
		} else if (event.result) {
			this.ctx.lastAssistantUsage = undefined;
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.invalidate();
			// When history collapses behind the summary divider, the frame
			// shrinks far below the committed row count; without clearing, the
			// differential renderer's "duplication, never loss" resync repaints
			// the whole collapsed transcript (welcome box included) BELOW the
			// stale pre-compaction scrollback. Compaction is an intentional
			// transcript replacement. With collapse disabled, the rebuilt transcript
			// keeps the full history, so the resync handles it and scrollback stays.
			if (settings.get("display.collapseCompacted")) {
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			} else {
				this.ctx.ui.requestRender();
			}
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (event.skipped) {
			// Benign skip: no model selected, no candidate models available, or nothing
			// to compact yet. Not a failure, so suppress the warning.
		} else {
			this.ctx.showWarning("Auto-compaction failed; continuing without maintenance");
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		ensureWorkingLoaderWhileStreaming(this.ctx);
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
	}

	/** Shows the retry countdown; `lastAssistant` and the pinned block are the ones a successful retry may recover. */
	async retryStarted(
		event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>,
		lastAssistant: AssistantMessageComponent | undefined,
	): Promise<void> {
		this.#trackSuperseded(lastAssistant);
		this.#trackSuperseded(this.#pinnedErrorComponent);
		this.ctx.clearWorkingLoader();
		setShimmerActivity("error");
		this.ctx.statusContainer.disposeChildren();
		if (AIError.is(event.errorId, AIError.Flag.ThinkingLoop)) {
			this.#pinnedErrorComponent = undefined;
			this.ctx.clearPinnedError();
		}
		this.deps.projection.recordAutoRetryStart(event);
		const living = this.ctx.settings.get("display.shimmer") === "living";
		const retryMessageColor: LoaderMessageColorFn = living
			? Object.assign((text: string) => shimmerText(text, theme), { animated: true as const })
			: (text: string) => theme.fg("muted", text);
		this.ctx.retryLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg(living ? "error" : "warning", spinner),
			retryMessageColor,
			`${formatRetryLine({
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorId: event.errorId,
				errorMessage: event.errorMessage,
				policySource: event.policySource,
				mode: event.mode,
			})}…${this.#escHint()}`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.retryLoader);
		this.ctx.ui.requestRender();
	}

	async retryEnded(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		this.stopRetryLoader();
		setShimmerActivity("thinking");
		const { summary, error } = this.deps.projection.recordAutoRetryEnd(event);
		if (event.success) {
			this.#applyRecoveries(event.recoveredErrors ?? []);
			this.#clearSuperseded();
			if (summary) this.ctx.showStatus(summary);
		} else {
			this.#clearSuperseded();
			if (error) this.ctx.showError(error);
		}
		ensureWorkingLoaderWhileStreaming(this.ctx);
		this.ctx.ui.requestRender();
	}

	/**
	 * Trailing Esc hint for live maintenance loaders. While an agent is
	 * focused, Esc returns to main instead of cancelling its maintenance
	 * (#2819), so the loader drops the hint entirely rather than advertise a
	 * cancel that no longer happens. Includes the leading space so the focused
	 * label carries no dangling whitespace.
	 */
	#escHint(): string {
		return this.ctx.focusedAgentId ? "" : " (esc to cancel)";
	}

	/** Marks each recovered error's superseded block as recovered; any recovery clears the pinned error banner. */
	#applyRecoveries(recoveredErrors: readonly RecoveredRetryError[]): void {
		for (const recovered of recoveredErrors) {
			const component = this.#takeSuperseded(recovered.persistenceKey);
			if (!component) continue;
			component.applyRetryRecovery(resolveAssistantErrorPresentation({ retryRecovery: recovered.retryRecovery }));
			if (this.#pinnedErrorComponent === component) this.#pinnedErrorComponent = undefined;
		}
		if (recoveredErrors.length > 0) this.ctx.clearPinnedError();
	}

	#trackSuperseded(component: AssistantMessageComponent | undefined): void {
		if (!component) return;
		const persistenceKey = component.messagePersistenceKey();
		if (persistenceKey) this.#supersededByKey.set(persistenceKey, component);
		if (!this.#supersededQueue.includes(component)) {
			this.#supersededQueue.push(component);
		}
	}

	#takeSuperseded(persistenceKey: string | undefined): AssistantMessageComponent | undefined {
		if (persistenceKey) {
			const component = this.#supersededByKey.get(persistenceKey);
			if (component) {
				this.#supersededByKey.delete(persistenceKey);
				this.#supersededQueue = this.#supersededQueue.filter(item => item !== component);
				return component;
			}
		}
		while (this.#supersededQueue.length > 0) {
			const component = this.#supersededQueue.shift();
			if (!component) continue;
			const key = component.messagePersistenceKey();
			if (key && this.#supersededByKey.get(key) !== component) continue;
			if (key) this.#supersededByKey.delete(key);
			return component;
		}
		return undefined;
	}

	#clearSuperseded(): void {
		this.#supersededByKey.clear();
		this.#supersededQueue = [];
	}
}
