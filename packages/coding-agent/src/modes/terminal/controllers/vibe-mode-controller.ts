/**
 * `/vibe`: the director mode that strips the toolset to `read` plus the vibe tools and drives worker
 * sessions. Carved out of `interactive-mode.ts`; the mode keeps `vibeModeEnabled` as an accessor over
 * this controller's state, and its session-switch reconcile calls `clearTransientState` and `enter`.
 */
import { formatCount } from "@veyyon/utils";
import { MAIN_AGENT_ID } from "../../../registry/agent-registry";
import { VibeSessionRegistry } from "../../../session/vibe-runtime";
import type { InteractiveModeContext } from "../types";

/** The slice of the interactive context vibe mode reads and writes. */
export type VibeModeControllerContext = Pick<
	InteractiveModeContext,
	| "goalModeEnabled"
	| "goalModePaused"
	| "lastAssistantUsage"
	| "onInputCallback"
	| "planModeEnabled"
	| "planModePaused"
	| "session"
	| "sessionManager"
	| "showStatus"
	| "showWarning"
	| "startPendingSubmission"
	| "statusLine"
	| "ui"
>;

export class VibeModeController {
	/** Vibe mode is on: the vibe tools are active and the director context is injected. */
	enabled = false;
	/** The tool set active before vibe mode, restored on exit. */
	#previousTools: string[] | undefined;

	constructor(private readonly ctx: VibeModeControllerContext) {}

	/** Leaves vibe mode for a session switch or resume: tools restored, workers killed, no status message. */
	async clearTransientState(): Promise<void> {
		if (!this.enabled) return;
		await this.ctx.session.deactivateVibeTools(this.#previousTools ?? []);
		this.ctx.session.setVibeModeState(undefined);
		this.enabled = false;
		this.#previousTools = undefined;
		await VibeSessionRegistry.global().killAll(
			this.ctx.session.getAgentId() ?? MAIN_AGENT_ID,
			this.ctx.session.asyncJobManager,
		);
		this.#updateStatus();
	}

	#updateStatus(): void {
		this.ctx.statusLine.setVibeModeStatus(this.enabled ? { enabled: true } : undefined);
		this.ctx.ui.requestRender();
	}

	/**
	 * `/vibe` toggle. Entering installs the ephemeral vibe tools, strips the
	 * active toolset down to `read` plus those tools, and injects the director
	 * context. Exiting unregisters them, restores the previous toolset, and kills
	 * every worker session so workers cannot outlive the mode that directs them.
	 */
	async handleCommand(initialPrompt?: string): Promise<void> {
		if (this.enabled) {
			await this.#exit();
			return;
		}
		if (this.ctx.planModeEnabled || this.ctx.planModePaused) {
			this.ctx.showWarning("Exit plan mode first.");
			return;
		}
		if (this.ctx.goalModeEnabled || this.ctx.goalModePaused) {
			this.ctx.showWarning("Exit goal mode first.");
			return;
		}
		await this.enter();
		if (initialPrompt && this.ctx.onInputCallback) {
			this.ctx.onInputCallback(this.ctx.startPendingSubmission({ text: initialPrompt }));
		}
	}

	async enter(): Promise<void> {
		if (this.enabled) {
			return;
		}
		if (this.ctx.planModeEnabled || this.ctx.planModePaused) {
			this.ctx.showWarning("Exit plan mode first.");
			return;
		}
		if (this.ctx.goalModeEnabled || this.ctx.goalModePaused) {
			this.ctx.showWarning("Exit goal mode first.");
			return;
		}

		const previousTools = this.ctx.session.getActiveToolNames();
		await this.ctx.session.activateVibeTools(["read"]);
		this.#previousTools = previousTools;
		this.enabled = true;
		// Suppress cache-miss marker on the next turn: vibe mode changes the
		// injected context, which predictably invalidates the cache.
		this.ctx.lastAssistantUsage = undefined;
		this.ctx.session.setVibeModeState({ enabled: true });
		if (this.ctx.session.isStreaming) {
			await this.ctx.session.sendVibeModeContext({ deliverAs: "steer" });
		}
		this.#updateStatus();
		this.ctx.sessionManager.appendModeChange("vibe");
		this.ctx.showStatus("Vibe mode enabled. You direct fast/good worker sessions; toolset is read + vibe tools.");
	}

	async #exit(): Promise<void> {
		if (!this.enabled) {
			return;
		}
		await this.ctx.session.deactivateVibeTools(this.#previousTools ?? []);
		this.ctx.session.setVibeModeState(undefined);
		this.enabled = false;
		this.#previousTools = undefined;
		this.ctx.lastAssistantUsage = undefined;
		const killed = await VibeSessionRegistry.global().killAll(
			this.ctx.session.getAgentId() ?? MAIN_AGENT_ID,
			this.ctx.session.asyncJobManager,
		);
		this.#updateStatus();
		this.ctx.sessionManager.appendModeChange("none");
		this.ctx.showStatus(
			killed > 0 ? `Vibe mode disabled. Killed ${formatCount("worker session", killed)}.` : "Vibe mode disabled.",
		);
	}
}
