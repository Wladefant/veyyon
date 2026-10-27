/**
 * Plan mode: the read-only planning tool set and model, the plan-review overlay, and approval into an
 * execution turn. Carved out of `interactive-mode.ts`. The mode keeps `planModeEnabled`,
 * `planModePaused` and `planModePlanFilePath` as accessors over this controller's state, and its
 * public plan methods delegate here. The review, approval, clear and compact steps this controller
 * starts are called through the mode, so a caller that replaces one of those mode methods sees it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError, type AgentToolResult } from "@veyyon/agent-core";
import type { CompactionOutcome } from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import { modelsAreEqual } from "@veyyon/catalog/models";
import type { OverlayHandle } from "@veyyon/tui";
import { errorMessage, formatNumber, isEnoent, prompt } from "@veyyon/utils";
import type { ContextUsage } from "../../../extensibility/extensions";
import { copyLocalRoot, listLocalPlanFileUrls, resolveLocalUrlToPath } from "../../../internal-urls/local-protocol";
import {
	humanizePlanTitle,
	type PlanApprovalDetails,
	resolveApprovedPlan,
	resolvePlanTitle,
} from "../../../plan-mode/approved-plan";
import { DEFAULT_PLAN_FILE_URL } from "../../../plan-mode/plan-file-url";
import { resolvePlanFilePath } from "../../../plan-mode/plan-path";
import { planModePrompts } from "../../../prompts/plan-mode/rows";
import { helperSettingPath } from "../../../task/helper-settings";
import type { ConfiguredThinkingLevel } from "../../../thinking";
import { type ResolveParams, type ResolveToolDetails, runResolveInvocation } from "../../../tools/agent/resolve";
import { ToolError } from "../../../tools/core/tool-errors";
import { copyToClipboard } from "../../../utils/clipboard";
import { editInTerminal, getEditorCommand, NO_EDITOR_CONFIGURED } from "../../../utils/external-editor";
import { PlanReviewOverlay } from "../components/dialogs/plan-review-overlay";
import type { HookSelectorSlider } from "../components/selectors/hook-selector";
import type { InteractiveModeContext, PlanReviewDialogOptions } from "../types";

const PLAN_KEEP_CONTEXT_OPTION_INDEX = 2;
const PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;

function formatContextTokenCount(value: number): string {
	return formatNumber(Math.max(0, Math.round(value))).toLowerCase();
}

/** A model the plan-approval slider offers to execute the plan: the default model or the plan helper's. */
interface PlanExecutionModel {
	/** `default` or `plan`; also the session-log slot the switch is recorded under. */
	label: "default" | "plan";
	model: Model;
	/** The effort that choice names, or undefined to keep the model's own. */
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** The slice of the interactive context plan mode reads, writes and calls back into. */
export type PlanModeControllerContext = Pick<
	InteractiveModeContext,
	| "goalModeEnabled"
	| "goalModePaused"
	| "handleClearCommand"
	| "handleCompactCommand"
	| "handlePlanApproval"
	| "keybindings"
	| "lastAssistantUsage"
	| "onInputCallback"
	| "session"
	| "sessionManager"
	| "showError"
	| "showHookConfirm"
	| "showPlanReview"
	| "showStatus"
	| "showWarning"
	| "startPendingSubmission"
	| "statusLine"
	| "ui"
	| "updateEditorBorderColor"
	| "vibeModeEnabled"
>;

export class PlanModeController {
	/** Plan mode is on: the plan tool set, the plan model and the approval handler are installed. */
	enabled = false;
	/** Plan mode was left without an approved plan; `/plan` with a prompt resumes it. */
	paused = false;
	/** The plan file the current plan-mode run drafts into. */
	planFilePath: string | undefined = undefined;
	/** The tool set active before plan mode, restored on exit and on approval. */
	#previousTools: string[] | undefined;
	/** The model and effort active before plan mode switched to the plan helper's. */
	#previousModelState: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	/** A model switch requested while a turn was streaming, applied when it ends. */
	#pendingModelSwitch: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	/** Plan mode has been entered in this session, so a later entry is a re-entry. */
	#hasEntered = false;
	#planReviewOverlay: PlanReviewOverlay | undefined;
	#planReviewOverlayHandle: OverlayHandle | undefined;
	#planReviewCancel: (() => void) | undefined;

	constructor(private readonly ctx: PlanModeControllerContext) {}

	/** Leaves plan mode for a session switch or resume: tools restored, no status message, model left as is. */
	async clearTransientState(): Promise<void> {
		if (!this.enabled && !this.paused) return;
		this.enabled = false;
		this.paused = false;
		this.#pendingModelSwitch = undefined;
		if (this.#previousTools !== undefined) {
			await this.ctx.session.setActiveToolsByName(this.#previousTools);
		}
		this.ctx.session.setStandingResolveHandler?.(null);
		this.ctx.session.setPlanModeState(undefined);
		this.enabled = false;
		this.paused = false;
		this.planFilePath = undefined;
		this.#previousTools = undefined;
		this.#previousModelState = undefined;
		this.#pendingModelSwitch = undefined;
		this.#hasEntered = false;
		this.#updateStatus();
	}

	/** Restores a paused plan mode the session recorded: tools and model were already restored when it paused. */
	restorePaused(): void {
		this.paused = true;
		this.#hasEntered = true;
		this.#updateStatus();
	}

	async #getPlanFilePath(): Promise<string> {
		return this.ctx.session.getPlanReferencePath() || DEFAULT_PLAN_FILE_URL;
	}

	#resolvePlanFilePath(planFilePath: string): string {
		return resolvePlanFilePath(planFilePath, {
			localProtocol: {
				getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
				getSessionId: () => this.ctx.sessionManager.getSessionId(),
			},
			cwd: this.ctx.sessionManager.getCwd(),
		});
	}

	#updateStatus(): void {
		const status =
			this.enabled || this.paused
				? {
						enabled: this.enabled,
						paused: this.paused,
					}
				: undefined;
		this.ctx.statusLine.setPlanModeStatus(status);
		// The composer gutter morphs to `◈` while planning (DS-6): re-derive it
		// at the same choke point every plan enable/disable/pause flows through.
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
	}

	async #applyPlanModeModel(): Promise<void> {
		const resolved = this.ctx.session.resolveHelperModel("plan");
		if (!resolved) {
			this.ctx.showWarning(
				`${helperSettingPath("plan", "model")} matches no available model; plan mode stays on the current model.`,
			);
			return;
		}

		const currentModel = this.ctx.session.model;
		const sameModel = modelsAreEqual(currentModel, resolved.model);
		const planThinkingLevel = resolved.thinkingLevel;

		this.#previousModelState = currentModel
			? { model: currentModel, thinkingLevel: this.ctx.session.configuredThinkingLevel() }
			: undefined;

		if (!sameModel) {
			if (this.ctx.session.isStreaming) {
				this.#pendingModelSwitch = { model: resolved.model, thinkingLevel: planThinkingLevel };
				return;
			}
			try {
				await this.ctx.session.setModelTemporary(resolved.model, planThinkingLevel);
			} catch (error) {
				this.ctx.showWarning(`Failed to switch to plan model for plan mode: ${errorMessage(error)}`);
			}
		} else if (planThinkingLevel) {
			this.ctx.session.setThinkingLevel(planThinkingLevel);
		}
	}

	/** Apply any deferred model switch after the current stream ends. */
	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModelSwitch;
		if (!pending) return;
		this.#pendingModelSwitch = undefined;
		try {
			await this.ctx.session.setModelTemporary(pending.model, pending.thinkingLevel);
		} catch (error) {
			this.ctx.showWarning(`Failed to switch model after streaming: ${errorMessage(error)}`);
		}
	}

	/** Reconcile a live plan-role reassignment without changing the exit restore target. */
	onHelperModelsChanged(): void {
		if (!this.enabled || this.paused) return;

		const resolved = this.ctx.session.resolveHelperModel("plan");
		this.#pendingModelSwitch = undefined;
		if (!resolved) {
			this.ctx.showWarning(
				`${helperSettingPath("plan", "model")} matches no available model; plan mode stays on the current model.`,
			);
			return;
		}

		const currentModel = this.ctx.session.model;
		if (modelsAreEqual(currentModel, resolved.model)) {
			if (resolved.thinkingLevel) this.ctx.session.setThinkingLevel(resolved.thinkingLevel);
			return;
		}

		if (this.ctx.session.isStreaming) {
			this.#pendingModelSwitch = { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
			return;
		}

		void this.ctx.session.setModelTemporary(resolved.model, resolved.thinkingLevel).catch(error => {
			this.ctx.showWarning(`Failed to switch to plan model for plan mode: ${errorMessage(error)}`);
		});
	}

	async enter(options?: { planFilePath?: string; workflow?: "parallel" | "iterative" }): Promise<void> {
		if (this.enabled) {
			return;
		}
		if (this.ctx.goalModeEnabled || this.ctx.goalModePaused) {
			this.ctx.showWarning("Exit goal mode first.");
			return;
		}
		if (this.ctx.vibeModeEnabled) {
			this.ctx.showWarning("Exit vibe mode first.");
			return;
		}

		this.paused = false;

		const planFilePath = options?.planFilePath ?? (await this.#getPlanFilePath());
		const previousTools = this.ctx.session.getActiveToolNames();
		// `plan-mode-active.md` instructs the agent to draft the plan file with
		// `write` and refine it with `edit`. Both must be in the active set or the
		// agent falls back to `edit` on a non-existent file and stalls. `edit` is an
		// essential built-in so it survives `tools.discoveryMode === "all"`, but
		// `write` has `loadMode: "discoverable"` and is hidden behind
		// `search_tool_bm25` — re-activate it here only when the current registry
		// entry is the built-in write tool (issue #3165). A shadowing extension
		// tool named `write` must stay inactive because plan mode's read-only
		// guarantee relies on the built-in write/edit guard. `resolve` is hidden
		// too; the standing handler below consumes plan-approval calls through it.
		const planAugmentations = ["resolve"];
		if (this.ctx.session.hasBuiltInTool("write")) {
			planAugmentations.push("write");
		}
		const uniquePlanTools = Array.from(
			new Set(previousTools.filter(name => name !== "goal").concat(planAugmentations)),
		);

		this.#previousTools = previousTools;
		this.planFilePath = planFilePath;
		this.enabled = true;
		// Suppress cache-miss marker on the next turn: plan mode changes the system
		// prompt, which predictably invalidates the cache.
		this.ctx.lastAssistantUsage = undefined;

		await this.ctx.session.setActiveToolsByName(uniquePlanTools);
		this.ctx.session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#hasEntered,
		});
		this.ctx.session.setStandingResolveHandler?.(input => this.#runPlanApprovalResolve(input));
		if (this.ctx.session.isStreaming) {
			await this.ctx.session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#hasEntered = true;
		await this.#applyPlanModeModel();
		this.#updateStatus();
		this.ctx.sessionManager.appendModeChange("plan", { planFilePath });
		this.ctx.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	/** Standing resolve dispatcher registered while plan mode is active. The agent
	 *  submits the finalized plan by calling `resolve { action: "apply", extra: { title } }`;
	 *  this handler validates the plan file exists, normalizes the title, and shapes the
	 *  payload that `event-controller` forwards to `handlePlanApproval`. */
	#runPlanApprovalResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		return runResolveInvocation(input as ResolveParams, {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				const state = this.ctx.session.getPlanModeState?.();
				if (!state?.enabled) {
					throw new ToolError("Plan mode is not active.");
				}
				const { planFilePath, title } = await resolveApprovedPlan({
					suppliedTitle: extra?.title,
					statePlanFilePath: state.planFilePath,
					readPlan: url => this.#readPlanFile(url),
					listPlanFiles: () => this.#listLocalPlanFiles(),
				});
				const details: PlanApprovalDetails = {
					planFilePath,
					title,
					planExists: true,
				};
				return {
					content: [{ type: "text" as const, text: "Plan ready for approval." }],
					details,
				};
			},
		});
	}

	async #restorePlanPreviousModel(prev: { model: Model; thinkingLevel?: ConfiguredThinkingLevel }): Promise<void> {
		if (modelsAreEqual(this.ctx.session.model, prev.model)) {
			// Same model — only thinking level may differ. Avoid setModelTemporary()
			// which would reset provider-side sessions and break continuity.
			this.ctx.session.setThinkingLevel(prev.thinkingLevel);
		} else if (this.ctx.session.isStreaming) {
			this.#pendingModelSwitch = { model: prev.model, thinkingLevel: prev.thinkingLevel };
		} else {
			await this.ctx.session.setModelTemporary(prev.model, prev.thinkingLevel);
		}
	}
	/**
	 * Idempotent post-compaction model transition for the plan-approval compact
	 * path. The deferred pre-plan state is consumed on first application, so a
	 * second call (the before-flush hook vs. the short-circuit fallback) is a
	 * no-op. "failed" intentionally stays on the plan model — the context is
	 * intact and we dispatch best-effort.
	 */
	async #applyDeferredPlanModelTransition(
		outcome: CompactionOutcome | undefined,
		executionModel: PlanExecutionModel | undefined,
	): Promise<void> {
		const deferredPrev = this.#previousModelState;
		if (deferredPrev === undefined || outcome === "failed") return;
		this.#previousModelState = undefined;
		if (executionModel) {
			await this.#applyPlanExecutionModel(executionModel);
		} else {
			await this.#restorePlanPreviousModel(deferredPrev);
		}
	}

	async #exitPlanMode(options?: { silent?: boolean; paused?: boolean; deferModelRestore?: boolean }): Promise<void> {
		if (!this.enabled) {
			return;
		}

		// Close the event boundary before awaiting tool restoration so a helper update
		// cannot enqueue work after plan mode has started exiting.
		this.enabled = false;
		// Drop any helper-model switch before the restore can enqueue the pre-plan model.
		this.#pendingModelSwitch = undefined;
		const previousTools = this.#previousTools;
		if (previousTools && previousTools.length > 0) {
			await this.ctx.session.setActiveToolsByName(previousTools);
		}
		if (this.#previousModelState) {
			if (!options?.deferModelRestore) {
				await this.#restorePlanPreviousModel(this.#previousModelState);
			}
		}
		this.ctx.session.setStandingResolveHandler?.(null);
		this.ctx.session.setPlanModeState(undefined);
		this.enabled = false;
		// Suppress cache-miss marker on the next turn: plan exit changes the system
		// prompt, which predictably invalidates the cache.
		this.ctx.lastAssistantUsage = undefined;
		this.paused = options?.paused ?? false;
		this.planFilePath = undefined;
		this.#previousTools = undefined;
		if (!options?.deferModelRestore) this.#previousModelState = undefined;
		this.#updateStatus();
		const paused = options?.paused ?? false;
		this.ctx.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
		if (!options?.silent) {
			this.ctx.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	async #hasPlanModeDraftContent(planFilePath: string): Promise<boolean> {
		const candidates = new Set<string>([planFilePath, ...(await this.#listLocalPlanFiles())]);
		for (const candidate of candidates) {
			const content = await this.#readPlanFile(candidate);
			if (content !== null && content.trim().length > 0) return true;
		}
		return false;
	}

	/** `local://` URLs of plan files in the session-local root, newest first.
	 *  A fallback for `resolveApprovedPlan` when the agent dropped `extra.title`,
	 *  so the plan it wrote is still found by scanning recent `*-plan.md` files. */
	async #listLocalPlanFiles(): Promise<string[]> {
		return listLocalPlanFileUrls(this.#resolvePlanFilePath("local://"));
	}

	showReview(
		planContent: string,
		title: string,
		options: string[],
		dialogOptions?: PlanReviewDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		this.hideReview();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		const finish = (choice: string | undefined): void => {
			if (settled) return;
			settled = true;
			this.hideReview();
			this.ctx.ui.requestRender();
			resolve(choice);
		};
		this.#planReviewCancel = () => finish(undefined);
		const overlay = new PlanReviewOverlay(
			planContent,
			{
				promptTitle: title,
				options,
				disabledIndices: dialogOptions?.disabledIndices,
				helpText: dialogOptions?.helpText,
				initialIndex: dialogOptions?.initialIndex,
				slider: extra?.slider,
				externalEditorLabel: this.ctx.keybindings.getDisplayString("app.editor.external") || undefined,
				requestRender: () => this.ctx.ui.requestRender(),
			},
			{
				onPick: choice => finish(choice),
				onCancel: () => finish(undefined),
				onCopyPlan: content => void this.#copyPlanToClipboard(content),
				onExternalEditor: dialogOptions?.onExternalEditor,
				onAnnotationExternalEditor: (draft, commit) => void this.#openPlanAnnotationInExternalEditor(draft, commit),
				onPlanEdited: dialogOptions?.onPlanEdited,
				onFeedbackChange: dialogOptions?.onFeedbackChange,
			},
		);
		this.#planReviewOverlay = overlay;
		this.#planReviewOverlayHandle = this.ctx.ui.showOverlay(overlay, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(overlay);
		this.ctx.ui.requestRender();
		return promise;
	}

	hideReview(): void {
		this.#planReviewCancel = undefined;
		this.#planReviewOverlayHandle?.hide();
		this.#planReviewOverlayHandle = undefined;
		this.#planReviewOverlay = undefined;
	}

	dismissReview(): void {
		const cancel = this.#planReviewCancel;
		this.#planReviewCancel = undefined;
		cancel?.();
		this.hideReview();
	}

	#getPlanApprovalContextUsage(): ContextUsage | undefined {
		const executionModel = this.#previousModelState?.model ?? this.ctx.session.model;
		const contextWindow = executionModel?.contextWindow;
		if (typeof contextWindow === "number") {
			return this.ctx.session.getContextUsage({ contextWindow });
		}
		return this.ctx.session.getContextUsage();
	}

	async #copyPlanToClipboard(content: string): Promise<void> {
		try {
			await copyToClipboard(content);
			this.ctx.showStatus("Copied plan to clipboard");
		} catch (error) {
			this.ctx.showWarning(`Failed to copy plan to clipboard: ${errorMessage(error)}`);
		}
	}

	async #openPlanInExternalEditor(planFilePath: string): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning(NO_EDITOR_CONFIGURED);
			return;
		}

		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		let currentText: string;
		try {
			currentText = await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				this.ctx.showError(`Plan file not found at ${planFilePath}`);
				return;
			}
			this.ctx.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
			return;
		}

		try {
			const result = await editInTerminal(this.ctx.ui, editorCmd, currentText, {
				extension: path.extname(resolvedPath) || ".md",
				trimTrailingNewline: false,
			});
			if (result !== null) {
				await Bun.write(resolvedPath, result);
				this.#planReviewOverlay?.setPlanContent(result);
				this.ctx.showStatus("Plan updated in external editor.");
			}
		} catch (error) {
			this.ctx.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
		}
	}

	async #openPlanAnnotationInExternalEditor(draft: string, commit: (text: string | null) => void): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning(NO_EDITOR_CONFIGURED);
			return;
		}

		try {
			const result = await editInTerminal(this.ctx.ui, editorCmd, draft, { extension: ".md" });
			if (result !== null) {
				commit(result);
			}
		} catch (error) {
			this.ctx.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
		}
	}

	async #applyPlanExecutionModel(entry: PlanExecutionModel | undefined): Promise<void> {
		if (!entry) return;
		try {
			await this.ctx.session.setModel(entry.model, entry.label, { thinkingLevel: entry.thinkingLevel });
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			this.ctx.showStatus(`Continuing with ${entry.label}: ${entry.model.name || entry.model.id}`);
		} catch (error) {
			this.ctx.showWarning(`Could not switch to the ${entry.label} model: ${errorMessage(error)}`);
		}
	}

	/**
	 * The models the plan-approval slider offers, default first: the configured
	 * default model (the pre-plan model when none is configured) and the plan
	 * helper's model. A plan entry on the default entry's model is dropped when
	 * it names the same effort or none, since it would run the same turn.
	 */
	#planExecutionChoices(): PlanExecutionModel[] {
		const choices: PlanExecutionModel[] = [];
		const defaultModel = this.ctx.session.resolveDefaultModel() ?? this.#previousModelState;
		if (defaultModel) choices.push({ label: "default", ...defaultModel });
		const plan = this.ctx.session.resolveHelperModel("plan");
		if (
			plan &&
			!choices.some(
				entry =>
					modelsAreEqual(entry.model, plan.model) &&
					(plan.thinkingLevel === undefined || entry.thinkingLevel === plan.thinkingLevel),
			)
		) {
			choices.push({ label: "plan", model: plan.model, thinkingLevel: plan.thinkingLevel });
		}
		return choices;
	}

	#resolveLocalRoot(): string {
		return resolveLocalUrlToPath("local://", {
			getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
			getSessionId: () => this.ctx.sessionManager.getSessionId(),
		});
	}

	async #approvePlan(
		planContent: string,
		options: {
			planFilePath: string;
			title: string;
			preserveContext?: boolean;
			compactBeforeExecute?: boolean;
			executionModel?: PlanExecutionModel;
		},
	): Promise<void> {
		const previousTools = this.#previousTools ?? this.ctx.session.getActiveToolNames();

		// Mark the pending abort caused by the plan-mode → compaction transition as
		// silent BEFORE #exitPlanMode raises it. The `finally` below clears the
		// flag on every terminal compaction outcome (ok / cancelled / failed /
		// throw) so a leaked flag cannot silence a later unrelated abort.
		// Branchless mark+clear when !compactBeforeExecute: mark is gated; clear
		// is unconditional and idempotent.
		if (options.compactBeforeExecute) {
			this.ctx.session.markPlanInternalAbortPending();
		}
		let compactOutcome: CompactionOutcome | undefined;
		try {
			await this.#exitPlanMode({
				silent: true,
				paused: false,
				deferModelRestore: options.compactBeforeExecute === true,
			});

			if (!options.preserveContext) {
				const oldLocalRoot = this.#resolveLocalRoot();
				await this.ctx.handleClearCommand();
				const newLocalRoot = this.#resolveLocalRoot();
				await copyLocalRoot(oldLocalRoot, newLocalRoot);
				const newLocalPath = resolveLocalUrlToPath(options.planFilePath, {
					getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
					getSessionId: () => this.ctx.sessionManager.getSessionId(),
				});
				await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
				await fs.writeFile(newLocalPath, planContent);
			} else if (options.compactBeforeExecute) {
				// Distill the plan-mode transcript before the execution turn is queued so
				// the plan-approved synthetic prompt lands as a fresh cache anchor.
				// Outcome is consumed after tool-restoration and plan-reference-path
				// bookkeeping below; `markPlanReferenceSent` is intentionally deferred
				// past the cancel guard — see the comment at the cancel branch.
				// Cancellation skips the synthetic-prompt dispatch (the explicit
				// abort is honored); failure proceeds best-effort — approval intent stands.
				const compactionPrompt = prompt.render(planModePrompts["plan-mode/compact-instructions"].text, {
					planFilePath: options.planFilePath,
				});
				// Pin the plan reference path BEFORE compaction so any user messages
				// queued during the compaction await (which `handleCompactCommand`
				// flushes via `flushCompactionQueue` before returning) see the
				// approved plan in `#buildPlanReferenceMessage`. Reassignment after
				// the try/finally is idempotent and kept for the !compactBeforeExecute
				// branch.
				this.ctx.session.setPlanReferencePath(options.planFilePath);
				// Ride the plan-mode distillation prompt through as `internalGuidance`
				// so it reaches native summarization without leaking into the public
				// `customInstructions` channel on `session_before_compact` — extensions
				// there treat that field as user focus and would query-bias the
				// summary toward the plan boilerplate (issue #4359).
				compactOutcome = await this.ctx.handleCompactCommand(
					undefined,
					undefined,
					outcome => this.#applyDeferredPlanModelTransition(outcome, options.executionModel),
					compactionPrompt,
				);
			}
		} finally {
			// Unconditional clear. Idempotent: a no-op when the flag was never set
			// (i.e., the !compactBeforeExecute branch), and a no-op when the flag
			// was already consumed by AgentSession.#handleAgentEvent's aborted
			// message_end stamping. Guarantees the flag is dead at every exit.
			this.ctx.session.clearPlanInternalAbortPending();
		}

		// Restore the execution tool set, but force-enable `read`: approved-plan
		// prompts now require loading the durable local:// plan file before work.
		const executionTools = previousTools.includes("read") ? previousTools : previousTools.concat(["read"]);
		await this.ctx.session.setActiveToolsByName(executionTools);
		this.ctx.session.setPlanReferencePath(options.planFilePath);

		// Resolve the deferred plan-approval model transition. On the compact path
		// the before-flush hook passed to handleCompactCommand already ran this (so
		// any input queued during compaction executed on the post-compaction
		// model); the re-run here is idempotent and covers the short-circuit where
		// compaction never executed. It runs for "cancelled" too — the operator
		// aborted only the compaction, not the approval — so the next turn no longer
		// lands on the plan model. "failed" stays on the plan model (context
		// intact) and dispatches best-effort.
		if (options.compactBeforeExecute) {
			await this.#applyDeferredPlanModelTransition(compactOutcome, options.executionModel);
		} else {
			await this.#applyPlanExecutionModel(options.executionModel);
		}

		if (compactOutcome === "cancelled") {
			// Explicit abort: honor it. `executeCompaction` already surfaced
			// `showError("Compaction cancelled")`; we add the deferred-dispatch
			// warning and exit without dispatching the synthetic plan-approved
			// prompt. `markPlanReferenceSent` stays unset so
			// `AgentSession.#buildPlanReferenceMessage` injects the plan reference
			// on the operator's next `prompt()` call.
			this.ctx.showWarning(
				"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
			);
			return;
		}

		// Approved plans land in a fresh (or compacted) session whose first user-visible
		// turn is the synthetic plan-approved prompt — that path bypasses the
		// input-controller's title generation. Seed an auto-name from the plan title
		// so the session is not left unnamed. `setSessionName("auto")` is a no-op
		// when the user has already chosen a name (preserveContext paths).
		const seededName = humanizePlanTitle(options.title);
		if (seededName && !this.ctx.sessionManager.getSessionName()) {
			await this.ctx.sessionManager.setSessionName(seededName, "auto");
		}

		// markPlanReferenceSent fires only on the dispatch path so the synthetic
		// plan-approved prompt is the source of the reference injection.
		this.ctx.session.markPlanReferenceSent();
		const planModePrompt = prompt.render(planModePrompts["plan-mode/approved"].text, {
			planFilePath: options.planFilePath,
			contextPreserved: options.preserveContext === true,
		});
		// A user turn queued during compaction was already fired by
		// `flushCompactionQueue` before we returned from `handleCompactCommand`; the
		// old abort-then-prompt path would have discarded that operator turn AND
		// still surfaced `AgentBusyError` when the queued turn kicked off in the
		// synchronous gap. Preserve the in-flight work and queue the hidden
		// execution directive behind it as a synthetic follow-up. If `isStreaming`
		// flips true between the check and dispatch (the same fire-and-forget race
		// noted below), catch `AgentBusyError` and fall back to the same queue.
		if (this.ctx.session.isStreaming) {
			await this.ctx.session.followUp(planModePrompt, undefined, { synthetic: true });
			return;
		}
		try {
			await this.ctx.session.prompt(planModePrompt, { synthetic: true });
		} catch (error) {
			if (!(error instanceof AgentBusyError)) throw error;
			await this.ctx.session.followUp(planModePrompt, undefined, { synthetic: true });
		}
	}
	async #abortPlanApprovalTurnSilently(): Promise<void> {
		this.ctx.session.markPlanInternalAbortPending();
		try {
			// Machinery closing its own turn, not the operator stopping the work: an
			// abort that defaults to `interrupted` would pause an active goal for a
			// reason the operator never gave. Plan mode and goal mode are mutually
			// exclusive today, so this classifies the abort rather than fixing a live
			// stall — the vocabulary is only worth having if every site uses it.
			await this.ctx.session.abort({ goalReason: "internal" });
		} finally {
			this.ctx.session.clearPlanInternalAbortPending();
		}
	}

	async handleCommand(initialPrompt?: string): Promise<void> {
		if (this.ctx.goalModeEnabled || this.ctx.goalModePaused) {
			this.ctx.showWarning("Exit goal mode first.");
			return;
		}
		if (this.ctx.vibeModeEnabled) {
			this.ctx.showWarning("Exit vibe mode first.");
			return;
		}
		if (this.enabled) {
			const planFilePath = this.planFilePath ?? (await this.#getPlanFilePath());
			if (await this.#hasPlanModeDraftContent(planFilePath)) {
				const confirmed = await this.ctx.showHookConfirm(
					"Exit plan mode?",
					"This exits plan mode without approving a plan.",
				);
				if (!confirmed) return;
			}
			await this.#exitPlanMode({ paused: true });
			return;
		}
		if (this.paused && !initialPrompt) {
			// No-arg third toggle: paused → off. Tools, model, and plan state were
			// already restored by the prior #exitPlanMode({ paused: true }); only the
			// paused flag, the reentry marker, and the session mode entry remain.
			// Prompted /plan invocations fall through to enter below so the
			// supplied prompt is still submitted as the first plan-mode turn.
			this.paused = false;
			this.#hasEntered = false;
			this.#updateStatus();
			this.ctx.sessionManager.appendModeChange("none");
			this.ctx.showStatus("Plan mode disabled.");
			return;
		}
		if (!this.ctx.session.settings.get("plan.enabled")) {
			this.ctx.showWarning("Plan mode is disabled. Enable it in settings (plan.enabled).");
			return;
		}
		await this.enter();
		if (initialPrompt && this.ctx.onInputCallback) {
			this.ctx.onInputCallback(this.ctx.startPendingSubmission({ text: initialPrompt }));
		}
	}

	/** Manually (re-)open the plan-review overlay — bound to `/plan-review`. Lets
	 *  the operator pull the review back up after dismissing it, or review a plan
	 *  the agent wrote without calling `resolve`. There is no fixed plan filename:
	 *  `getPlanReferencePath()` is empty until a plan is actually approved (and does
	 *  not survive a restart), so this drives off the newest `local://<slug>-plan.md`
	 *  the agent wrote — the files persist in the session artifacts dir, so the scan
	 *  works before any review and across restarts. */
	async openReview(): Promise<void> {
		if (!this.enabled) {
			this.ctx.showWarning("Plan mode is not active.");
			return;
		}
		const noPlan = "No plan to review yet — write one to a local://<slug>-plan.md file first.";
		const [planFilePath] = await this.#listLocalPlanFiles();
		if (!planFilePath) {
			this.ctx.showWarning(noPlan);
			return;
		}
		const planContent = await this.#readPlanFile(planFilePath);
		if (planContent === null) {
			this.ctx.showWarning(noPlan);
			return;
		}
		const { title } = resolvePlanTitle({ planContent, planFilePath });
		await this.ctx.handlePlanApproval({ planFilePath, title, planExists: true });
	}

	async handleApproval(details: PlanApprovalDetails): Promise<void> {
		if (!this.enabled) {
			this.ctx.showWarning("Plan mode is not active.");
			return;
		}

		// Abort the agent to prevent it from continuing (e.g., re-submitting the
		// plan) while the popup is showing. The event listener fires asynchronously
		// (agent's #emit is fire-and-forget), so without this the model sees
		// "Plan ready for approval." and immediately re-invokes `resolve` in a loop.
		// This abort is an internal UI transition, not operator cancellation.
		await this.#abortPlanApprovalTurnSilently();

		const planFilePath = details.planFilePath || this.planFilePath || (await this.#getPlanFilePath());
		this.planFilePath = planFilePath;
		const planContent = await this.#readPlanFile(planFilePath);
		if (!planContent) {
			this.ctx.showError(`Plan file not found at ${planFilePath}`);
			return;
		}

		const contextUsage = this.#getPlanApprovalContextUsage();
		const keepContextLabel = formatKeepContextLabel(contextUsage);
		const keepContextDisabled = isKeepContextDisabled(contextUsage);

		// Model slider: the operator picks which model executes the approved plan,
		// the default model or the plan helper's. It starts on the default model so
		// execution runs it no matter which model drove the planning conversation,
		// and is hidden when both resolve to the same model and effort.
		const choices = this.#planExecutionChoices();
		let selectedTierIndex = 0;
		const slider: HookSelectorSlider | undefined =
			choices.length > 1
				? {
						caption: "continue with",
						index: 0,
						segments: choices.map(entry => ({
							label: entry.label,
							detail: entry.model.name || entry.model.id,
						})),
						onChange: index => {
							selectedTierIndex = index;
						},
					}
				: undefined;
		// The overlay now owns the dynamic, focus-aware help line; the caller only
		// supplies the trailing cancel hint.
		const helpText = "esc cancel";
		// In-overlay edits (section deletes/undo) and section annotations. Deletes
		// update `editedContent` (and mirror to disk); annotations build `feedback`
		// that the Refine branch re-prompts the model with.
		let editedContent: string | undefined;
		let feedback = "";

		const choice = await this.ctx.showPlanReview(
			planContent,
			"Plan mode - next step",
			["Approve and execute", "Approve and compact context", keepContextLabel, "Refine plan"],
			{
				helpText,
				onExternalEditor: () => void this.#openPlanInExternalEditor(planFilePath),
				onPlanEdited: content => {
					editedContent = content;
					void Bun.write(this.#resolvePlanFilePath(planFilePath), content);
				},
				onFeedbackChange: value => {
					feedback = value;
				},
				disabledIndices: keepContextDisabled ? [PLAN_KEEP_CONTEXT_OPTION_INDEX] : undefined,
			},
			{ slider },
		);

		if (choice === "Approve and execute" || choice === "Approve and compact context" || choice === keepContextLabel) {
			try {
				// Prefer in-overlay edits (already in memory) over a disk re-read. The
				// overlay mirrors edits as they happen, and approval awaits one final
				// write so the durable plan file and synthetic prompt carry the same text.
				const latestPlanContent = editedContent ?? (await this.#readPlanFile(planFilePath));
				if (editedContent !== undefined) {
					await Bun.write(this.#resolvePlanFilePath(planFilePath), editedContent);
				}
				if (!latestPlanContent) {
					this.ctx.showError(`Plan file not found at ${planFilePath}`);
					return;
				}
				// Capture the operator's choice and hand it to #approvePlan, which
				// applies it AFTER #exitPlanMode. #exitPlanMode normally restores
				// #previousModelState (the model from before plan mode), so
				// applying the slider choice any earlier would be silently reverted.
				// Pass executionModel only when the slider was shown: with no slider
				// the operator made no selection and the restore stands.
				// Treat the choice as implicit only when applying it would land on the
				// same end state as the restore — same model AND the same effective
				// thinking level. A choice with an explicit thinking level that differs
				// from the restored one must still switch, otherwise approving on the
				// same model silently keeps the pre-plan level.
				const restoredState = this.#previousModelState;
				const restoredIndex = restoredState
					? choices.findIndex(entry => {
							if (!modelsAreEqual(entry.model, restoredState.model)) return false;
							if (entry.thinkingLevel === undefined) return true;
							return entry.thinkingLevel === restoredState.thinkingLevel;
						})
					: -1;
				const executionModel =
					slider && selectedTierIndex !== restoredIndex ? choices[selectedTierIndex] : undefined;
				await this.#approvePlan(latestPlanContent, {
					planFilePath,
					title: details.title,
					preserveContext: choice !== "Approve and execute",
					compactBeforeExecute: choice === "Approve and compact context",
					executionModel,
				});
			} catch (error) {
				this.ctx.showError(`Failed to finalize approved plan: ${errorMessage(error)}`);
			}
			return;
		}

		if (choice === "Refine plan") {
			const refinement = feedback.trim();
			try {
				if (refinement) {
					if (this.ctx.onInputCallback) {
						this.ctx.onInputCallback(this.ctx.startPendingSubmission({ text: feedback }));
					} else {
						await this.ctx.session.prompt(feedback);
					}
				} else {
					this.ctx.showStatus("Refine plan: enter a follow-up prompt.");
				}
			} catch (error) {
				this.ctx.showError(`Failed to refine plan: ${errorMessage(error)}`);
			}
			return;
		}
	}
}

function formatKeepContextLabel(contextUsage: ContextUsage | undefined): string {
	if (!contextUsage) {
		return "Approve and keep context";
	}
	const tokens = formatContextTokenCount(contextUsage.tokens);
	const contextWindow = formatContextTokenCount(contextUsage.contextWindow);
	return `Approve and keep context (~${tokens} / ${contextWindow})`;
}

function isKeepContextDisabled(contextUsage: ContextUsage | undefined): boolean {
	return contextUsage !== undefined && contextUsage.percent > PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT;
}
