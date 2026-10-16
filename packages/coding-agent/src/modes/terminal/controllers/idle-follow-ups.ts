/**
 * The work a session does once a turn ends and the prompt stays idle: an idle
 * compaction when the context is past its threshold, and an idle recap line.
 * Both arm a timer at agent end and are cancelled by any activity that
 * supersedes them (a new turn, compaction, a transcript re-point, disposal).
 */
import { clampLow, logger, prompt } from "@veyyon/utils";
import { settings } from "../../../config/settings-instance";
import { sideChannelPrompts } from "../../../prompts/side-channel/rows";
import { theme } from "../../../theme/theme";
import { nextActionableTask } from "../../../tools/agent/todo";
import { previewLine, TRUNCATE_LENGTHS } from "../../../tools/core/render-utils";
import type { EventControllerContext } from "./event-controller";

const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

type IdleFollowUpsContext = Pick<
	EventControllerContext,
	"editor" | "sessionManager" | "showStatus" | "todoPhases" | "viewSession"
>;

export class IdleFollowUps {
	#compactionTimer?: NodeJS.Timeout;
	#recapTimer?: NodeJS.Timeout;
	// In-flight ephemeral recap turn; aborted by cancel() when any activity
	// (new turn, compaction, editor draft) supersedes the idle recap.
	#recapAbort?: AbortController;

	constructor(private ctx: IdleFollowUpsContext) {}

	/** Arms the idle compaction and the idle recap, each only when its settings and the session allow it. */
	schedule(): void {
		this.#scheduleCompaction();
		this.#scheduleRecap();
	}

	/** Disarms both timers and aborts a recap turn already in flight. */
	cancel(): void {
		this.#cancelCompaction();
		this.#cancelRecap();
	}

	#cancelCompaction(): void {
		if (this.#compactionTimer) {
			clearTimeout(this.#compactionTimer);
			this.#compactionTimer = undefined;
		}
	}

	#cancelRecap(): void {
		if (this.#recapTimer) {
			clearTimeout(this.#recapTimer);
			this.#recapTimer = undefined;
		}
		if (this.#recapAbort) {
			this.#recapAbort.abort();
			this.#recapAbort = undefined;
		}
	}

	#scheduleCompaction(): void {
		this.#cancelCompaction();
		// Don't schedule idle work while context maintenance is already running; the
		// maintenance flow may reset the session before this timer fires.
		if (this.ctx.viewSession.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		// Only if input is empty
		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = clampLow(idleSettings.idleTimeoutSeconds, 60, 3600) * 1000;
		this.#compactionTimer = setTimeout(() => {
			this.#compactionTimer = undefined;
			// Re-check conditions before firing. Pruning may have run between arming
			// the timer and now, dropping usage back below the idle threshold.
			if (this.ctx.viewSession.isStreaming) return;
			if (this.ctx.viewSession.isCompacting) return;
			if (this.ctx.editor.getText().trim()) return;
			if (this.#currentContextTokens() < threshold) return;
			void this.ctx.viewSession.runIdleCompaction();
		}, timeoutMs);
		this.#compactionTimer.unref?.();
	}

	#scheduleRecap(): void {
		this.#cancelRecap();
		if (this.ctx.viewSession.isCompacting) return;

		const recapSettings = settings.getGroup("recap");
		if (!recapSettings.enabled) return;
		if (this.ctx.editor.getText().trim()) return;

		const timeoutMs = clampLow(recapSettings.idleSeconds, IDLE_RECAP_MIN_SECONDS, IDLE_RECAP_MAX_SECONDS) * 1000;
		this.#recapTimer = setTimeout(() => {
			this.#recapTimer = undefined;
			void this.#runRecap();
		}, timeoutMs);
		this.#recapTimer.unref?.();
	}

	/**
	 * Generate the idle recap with an ephemeral side-channel turn over the
	 * current conversation (same pipeline as `/btw`) and surface it as a status
	 * line. Live goal/title and the active todo task are passed as anchoring
	 * hints because the snapshot only carries conversation history, not the
	 * controller's todo/goal state. The request is abortable: any activity
	 * cancels it via cancel(), and idle conditions are re-checked after the
	 * reply lands so a stale recap never paints over fresh work.
	 */
	async #runRecap(): Promise<void> {
		if (!this.#idleConditionsHold()) return;
		if (!this.ctx.viewSession.model) return;
		if (this.ctx.viewSession.messages.length === 0) return;

		const promptText = prompt.render(sideChannelPrompts["side-channel/recap-user"].text, {
			goal: this.#recapGoalText() ?? "",
			task: nextActionableTask(this.ctx.todoPhases)?.content ?? "",
		});

		const abort = new AbortController();
		this.#recapAbort = abort;
		try {
			const { replyText } = await this.ctx.viewSession.runEphemeralTurn({ promptText, signal: abort.signal });
			if (this.#recapAbort !== abort || abort.signal.aborted || !this.#idleConditionsHold()) return;
			const recap = previewLine(replyText, TRUNCATE_LENGTHS.RECAP);
			if (!recap) return;
			this.ctx.showStatus(theme.fg("dim", theme.italic(`※ recap: ${recap}`)), { dim: false });
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Idle recap turn failed", { error: String(error) });
		} finally {
			if (this.#recapAbort === abort) this.#recapAbort = undefined;
		}
	}

	/** Idle gate shared by the recap timer fire and its post-reply re-check. */
	#idleConditionsHold(): boolean {
		if (this.ctx.viewSession.isStreaming) return false;
		if (this.ctx.viewSession.isCompacting) return false;
		if (this.ctx.editor.getText().trim()) return false;
		return true;
	}

	#recapGoalText(): string | undefined {
		const goal = this.ctx.viewSession.getGoalModeState?.()?.goal.objective.trim();
		if (goal) return goal;
		const title = this.ctx.sessionManager.getSessionName()?.trim();
		return title || undefined;
	}

	#currentContextTokens(): number {
		return this.ctx.viewSession.getContextUsage()?.tokens ?? 0;
	}
}
