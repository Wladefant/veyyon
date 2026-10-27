/**
 * The Esc key over the composer: it stops the topmost running activity and nothing beneath it, and on an idle
 * composer a second press discards the draft or runs `doubleEscapeAction`.
 */
import { abortDetached } from "@veyyon/kernel/session/detached-abort";
import { errorMessage, logger } from "@veyyon/utils";
// The slot leaf, not the 94-module store: this file reads values, it does not fill them.
import { settings } from "../../../config/settings-instance";
import { USER_INTERRUPT_LABEL } from "../../../session/messages";
import { vocalizer } from "../../../speech/tts/vocalizer";
import type { InputControllerContext } from "./input-controller";
import type { QueuedSubmissions } from "./queued-submissions";

/** The context members Esc reads. */
export type ComposerEscapeContext = Pick<
	InputControllerContext,
	| "cancelPendingSubmission"
	| "collabGuest"
	| "editor"
	| "focusedAgentId"
	| "handleBtwEscape"
	| "handleOmfgEscape"
	| "hasActiveBtw"
	| "hasActiveOmfg"
	| "isBashMode"
	| "isPythonMode"
	| "lastEscapeTime"
	| "loadingAnimation"
	| "loopModeEnabled"
	| "pauseLoop"
	| "session"
	| "showTreeSelector"
	| "showUserMessageSelector"
	| "ui"
	| "unfocusSession"
	| "updateEditorBorderColor"
	| "viewSession"
>;

// How long the second Esc has to arrive for a double-press to read as one gesture.
// Both Esc gestures share it: discarding a draft, and `doubleEscapeAction` on an
// empty composer. Two copies of the number is how one gesture grows two feels.
const DOUBLE_ESCAPE_WINDOW_MS = 500;

/** Run a teardown abort that must never throw (Esc / Ctrl+C path). A thrown
 *  error is logged at debug instead of silently swallowed, so a failing abort
 *  stays diagnosable without disturbing teardown ordering. */
function safeAbort(label: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logger.debug(`Failed to abort ${label}`, { error: errorMessage(err) });
	}
}

export class ComposerEscape {
	// When the first Esc over a non-empty composer armed the discard gesture, or 0 when
	// nothing is armed. Held apart from `ctx.lastEscapeTime`, which arms the empty-composer
	// `doubleEscapeAction`, so neither gesture can complete on the other's first press.
	#draftDiscardArmedAt = 0;

	constructor(
		private readonly ctx: ComposerEscapeContext,
		private readonly queue: QueuedSubmissions,
	) {}

	#abortStreamingTurn(): void {
		abortDetached(this.ctx.session, "composer-escape.abortStreamingTurn", USER_INTERRUPT_LABEL);
	}

	/**
	 * Esc stops the topmost activity and nothing beneath it, in this order: a side-channel panel, the view session's
	 * context maintenance, speech playback, loop mode, a focused agent view, a collab guest's host turn, foreground
	 * work, then the draft and the double-Esc action.
	 *
	 * Side-channel panels are the topmost view, so Esc dismisses them before touching loop mode, maintenance, or the
	 * underlying main turn. Active context maintenance owns Esc: auto/manual compaction, handoff generation, and
	 * auto-retry backoff all advertise "(esc to cancel)". Dispatch on live session state instead of swapping onEscape
	 * handlers — interleaved start/end events used to clobber the single saved-handler slot (auto-compaction start →
	 * /compact → auto end → manual finally), leaving Esc wired to a stale no-op closure until restart.
	 *
	 * While an agent is focused, Esc honors the advertised view action ("Esc returns to main") instead of cancelling
	 * maintenance — accidentally killing a focused agent's compaction on the way out was #2819. The auto-maintenance
	 * loaders relabel their hint to match (see EventController). Main-session maintenance still owns Esc and stays
	 * cancellable from the main view (focused submit gates /compact and handoff, so manual maintenance is main-only
	 * anyway).
	 */
	handleEscape(): void {
		if (this.#escapeOverlay()) return;
		if (vocalizer.isSpeaking()) {
			// Playback from the completed response can overlap the next agent
			// turn. Silence it before interrupting any ongoing main-turn work.
			vocalizer.clear();
			this.ctx.lastEscapeTime = 0;
			return;
		}
		if (this.ctx.loopModeEnabled) {
			this.#escapeLoopMode();
			return;
		}
		if (this.ctx.focusedAgentId) {
			this.#escapeFocusedView();
			return;
		}
		const guest = this.ctx.collabGuest;
		if (guest) {
			// The local replica session never streams, so the native abort path below would stop nothing.
			if (guest.state?.isStreaming || this.ctx.loadingAnimation) guest.sendAbort();
			return;
		}
		if (this.#stopForegroundWork()) return;
		if (this.ctx.editor.getText().trim()) this.#escapeDraft();
		else this.#runDoubleEscapeAction();
	}

	/** Dismisses a side-channel panel, else aborts the main view's context maintenance; true when either ran. */
	#escapeOverlay(): boolean {
		if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) return true;
		if (this.ctx.hasActiveOmfg() && this.ctx.handleOmfgEscape()) return true;
		return !this.ctx.focusedAgentId && this.#abortViewMaintenance();
	}

	/** Aborts the view session's compaction, handoff generation and retry backoff; true when any of them ran. */
	#abortViewMaintenance(): boolean {
		const viewSession = this.ctx.viewSession;
		let aborted = false;
		if (viewSession.isCompacting) {
			safeAbort("compaction", () => viewSession.abortCompaction());
			aborted = true;
		}
		if (viewSession.isGeneratingHandoff) {
			safeAbort("handoff", () => viewSession.abortHandoff());
			aborted = true;
		}
		if (viewSession.isRetrying) {
			safeAbort("retry", () => viewSession.abortRetry());
			aborted = true;
		}
		return aborted;
	}

	/** Pauses loop mode and stops its turn: the streaming turn, else the submission waiting to start. */
	#escapeLoopMode(): void {
		this.ctx.pauseLoop();
		if (this.ctx.session.isStreaming) {
			this.#abortStreamingTurn();
		} else {
			this.ctx.cancelPendingSubmission();
		}
	}

	/**
	 * Clears typed text, else returns the view to the main session. Esc never interrupts the focused agent's turn
	 * (an empty steer-flush submit does), and the double-Esc backtrack (/tree, /branch) stays main-only.
	 */
	#escapeFocusedView(): void {
		if (this.ctx.editor.getText().trim()) {
			this.ctx.editor.setText("");
			this.ctx.ui.requestRender();
		} else {
			void this.ctx.unfocusSession();
		}
	}

	/**
	 * Stops the first foreground work that is running: a pending or queued submission, a bash command, an eval, or the
	 * streaming turn; an idle bash or python mode is left instead. False when there is none.
	 */
	#stopForegroundWork(): boolean {
		const { ctx } = this;
		if (ctx.loadingAnimation) {
			if (!ctx.cancelPendingSubmission()) this.queue.restoreToEditor({ abort: true });
		} else if (ctx.session.isBashRunning) {
			ctx.session.abortBash();
		} else if (ctx.isBashMode) {
			ctx.editor.setText("");
			ctx.isBashMode = false;
			ctx.updateEditorBorderColor();
		} else if (ctx.session.isEvalRunning) {
			ctx.session.abortEval();
		} else if (ctx.isPythonMode) {
			ctx.editor.setText("");
			ctx.isPythonMode = false;
			ctx.updateEditorBorderColor();
		} else if (ctx.session.isStreaming) {
			this.#abortStreamingTurn();
		} else {
			return false;
		}
		return true;
	}

	/**
	 * One Esc must not destroy an in-progress draft, so the second one inside the window is what discards it — and
	 * `discardDraft` leaves it on the undo stack, so ctrl+z brings it back. The arming state is not `lastEscapeTime`:
	 * arming here, clearing the draft by hand, then pressing Esc again must not fall through to `doubleEscapeAction`
	 * as if the composer had been empty all along.
	 */
	#escapeDraft(): void {
		const now = Date.now();
		if (now - this.#draftDiscardArmedAt < DOUBLE_ESCAPE_WINDOW_MS) {
			this.ctx.editor.discardDraft();
			this.#draftDiscardArmedAt = 0;
		} else {
			this.#draftDiscardArmedAt = now;
			this.ctx.ui.holdFrameForInput();
		}
		this.ctx.lastEscapeTime = 0;
	}

	/** A second Esc on an empty composer inside the window opens /tree or /branch, as `doubleEscapeAction` sets. */
	#runDoubleEscapeAction(): void {
		this.#draftDiscardArmedAt = 0;
		const action = settings.get("doubleEscapeAction");
		if (action === "none") return;
		const now = Date.now();
		if (now - this.ctx.lastEscapeTime < DOUBLE_ESCAPE_WINDOW_MS) {
			if (action === "tree") {
				this.ctx.showTreeSelector();
			} else {
				this.ctx.showUserMessageSelector();
			}
			this.ctx.ui.resetDisplay();
			this.ctx.lastEscapeTime = 0;
		} else {
			this.ctx.lastEscapeTime = now;
			this.ctx.ui.holdFrameForInput();
		}
	}
}
