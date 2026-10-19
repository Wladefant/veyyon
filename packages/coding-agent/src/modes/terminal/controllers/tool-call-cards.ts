/**
 * The transcript cards of tool calls: the preview of a call while its
 * arguments stream, the read group consecutive reads collapse into, the card
 * a call settles into when it runs, a background task kept live for later
 * updates, and the assistant prose a provider streams after a call.
 */
import { type AgentTool, toolResultNeverRan } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@veyyon/ai";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import type { Component } from "@veyyon/tui";
import { isRecord } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { settings } from "../../../config/settings-instance";
import { getFileSnapshotStore } from "../../../edit/file-snapshot-store";
import type { PlanApprovalDetails } from "../../../plan-mode/approved-plan";
import type { SessionProjectionEngine } from "../../../presentation/session-projection-engine";
import { toAssistantMessageView } from "../../../presentation/transcript-builder";
import type { AgentSessionEvent } from "../../../session/agent-session-types";
import { setShimmerActivity } from "../../../theme/shimmer";
import type { ResolveToolDetails } from "../../../tools/agent/resolve";
import type { AssistantMessageComponent } from "../components/transcript/assistant-message";
import {
	ReadToolGroupComponent,
	readArgsHaveTarget,
	readArgsTargetInternalUrl,
} from "../components/transcript/read-tool-group";
import { ToolExecutionComponent } from "../components/transcript/tool-execution";
import { interruptHint } from "../shared";
import type { TodoPhase } from "../types";
import { asyncToolState, isLiveBackgroundTask } from "../utils/async-tool-state";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import { assistantHasVisibleContent } from "../utils/transcript-render-helpers";
import type { DisplaceableBlocks } from "./displaceable-blocks";
import type { EventControllerContext } from "./event-controller";
import { streamingStringKeysForTool, type ToolArgsRevealController } from "./tool-args-reveal";
import { ensureWorkingLoaderWhileStreaming } from "./turn-recovery";

type ToolExecutionEndEvent = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

type ToolCallCardsContext = Pick<
	EventControllerContext,
	| "autoCompactionLoader"
	| "chatContainer"
	| "effectiveHideThinkingBlock"
	| "ensureLoadingAnimation"
	| "handlePlanApproval"
	| "pendingTools"
	| "proseOnlyThinking"
	| "retryLoader"
	| "session"
	| "sessionManager"
	| "setTodos"
	| "setWorkingMessage"
	| "settings"
	| "settledToolCalls"
	| "showWarning"
	| "streamingComponent"
	| "toolOutputExpanded"
	| "ui"
	| "viewSession"
>;

/** The event controller's state the cards read and advance. */
export interface ToolCallCardsDeps {
	projection: SessionProjectionEngine;
	toolArgsReveal: ToolArgsRevealController;
	displaceable: DisplaceableBlocks;
	/** The last finished assistant block, which a read issued after it inlines its images into. */
	lastAssistantComponent(): AssistantMessageComponent | undefined;
}

const RAW_PARTIAL_JSON_RENDERERS: Record<string, true> = { bash: true, edit: true, apply_patch: true };

function exposesRawPartialJson(toolName: string, rawInput: boolean, tool: unknown): boolean {
	if (rawInput) return true;
	if (RAW_PARTIAL_JSON_RENDERERS[toolName]) return true;
	if (tool === null || typeof tool !== "object") return false;
	if ("renderCall" in tool && typeof tool.renderCall === "function") return true;
	// Converting a tool's `renderCall` into a `view.renderCall` must not change this answer. Before
	// the conversion the branch above returned true; a tool whose call card is now described rather
	// than drawn reaches the same live preview from the same streamed arguments, so it keeps the same
	// treatment. Without this line a conversion silently narrows what the preview is given.
	const view = "view" in tool ? tool.view : undefined;
	if (view === null || typeof view !== "object") return false;
	return "renderCall" in view && typeof view.renderCall === "function";
}

export class ToolCallCards {
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;
	#lastIntent: string | undefined = undefined;
	#backgroundTaskCallIds = new Set<string>();
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#toolTimelineComponents = new Map<string, Component>();
	#postToolAssistantComponents = new Map<string, AssistantMessageComponent>();

	constructor(
		private ctx: ToolCallCardsContext,
		private deps: ToolCallCardsDeps,
	) {}

	/** Forgets the previous turn's per-call anchors and its stated intent. */
	beginTurn(): void {
		this.#toolTimelineComponents.clear();
		this.#postToolAssistantComponents.clear();
		this.#lastIntent = undefined;
		this.#readToolCallAssistantComponents.clear();
		this.deps.projection.clearTurnToolState();
		this.resetReadGroup();
	}

	/**
	 * Freezes every foreground call still pending when the turn ends and keeps only the live background tasks
	 * pending.
	 */
	endTurn(): void {
		for (const toolCallId of Array.from(this.ctx.pendingTools.keys())) {
			if (!this.#backgroundTaskCallIds.has(toolCallId)) {
				// A foreground tool still pending at turn end never delivered a result;
				// seal it so it freezes (and stops animating) rather than lingering in
				// the transcript live region as a streaming preview until the next thaw.
				const component = this.ctx.pendingTools.get(toolCallId);
				// A foreground read still pending at turn end shares a group component
				// keyed by every read's id; seal it too so a never-delivered read does
				// not keep the group live (and pinning the live region) indefinitely.
				if (component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent) {
					component.seal();
				}
				this.ctx.pendingTools.delete(toolCallId);
				// The card is frozen history now. A late replay of this call's
				// `tool_execution_start` (collab resync, focus re-attach, an
				// aborted-turn placeholder) must not build a fresh live one beside it.
				this.ctx.settledToolCalls.add(toolCallId);
			}
		}
		const filtered = new Set<string>();
		for (const toolCallId of this.#backgroundTaskCallIds) {
			if (this.ctx.pendingTools.has(toolCallId)) filtered.add(toolCallId);
		}
		this.#backgroundTaskCallIds = filtered;
		this.deps.projection.clearTurnToolState();
		this.#readToolCallAssistantComponents.clear();
		this.#toolTimelineComponents.clear();
		this.#postToolAssistantComponents.clear();
		this.resetReadGroup();
	}

	/** Forgets every anchor into the transcript; the transcript is about to show another session. */
	reset(): void {
		this.resetReadGroup();
		this.#lastIntent = undefined;
		this.#toolTimelineComponents.clear();
		this.#postToolAssistantComponents.clear();
		this.#backgroundTaskCallIds.clear();
		this.#readToolCallAssistantComponents.clear();
	}

	/** Drops every per-call anchor to a component no longer in the transcript. */
	releaseDetached(attached: ReadonlySet<Component>): void {
		for (const [toolCallId, component] of this.#toolTimelineComponents) {
			if (!attached.has(component)) this.#toolTimelineComponents.delete(toolCallId);
		}
		for (const [toolCallId, component] of this.#postToolAssistantComponents) {
			if (!attached.has(component)) this.#postToolAssistantComponents.delete(toolCallId);
		}
		for (const [toolCallId, component] of this.#readToolCallAssistantComponents) {
			if (!attached.has(component)) this.#readToolCallAssistantComponents.delete(toolCallId);
		}
	}

	resetReadGroup(): void {
		this.#lastReadGroup?.finalize();
		this.#lastReadGroup = undefined;
	}

	#getReadGroup(): ReadToolGroupComponent {
		if (!this.#lastReadGroup || !this.ctx.chatContainer.children.includes(this.#lastReadGroup)) {
			const group = new ReadToolGroupComponent({
				showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
			});
			group.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(group);
			this.#lastReadGroup = group;
		}
		return this.#lastReadGroup;
	}

	#trackReadToolCall(toolCallId: string, args: unknown): void {
		if (!toolCallId) return;
		this.deps.projection.recordToolCall(toolCallId, "read", isRecord(args) ? args : {});
		const assistantComponent = this.ctx.streamingComponent ?? this.deps.lastAssistantComponent();
		if (assistantComponent) {
			this.#readToolCallAssistantComponents.set(toolCallId, assistantComponent);
		}
	}

	#clearReadToolCall(toolCallId: string): void {
		this.#readToolCallAssistantComponents.delete(toolCallId);
	}
	#inlineReadToolImages(
		toolCallId: string,
		result: { content: Array<{ type: string; data?: string; mimeType?: string }> },
	): boolean {
		if (!settings.get("terminal.showImages")) return false;
		const assistantComponent = this.#readToolCallAssistantComponents.get(toolCallId);
		if (!assistantComponent) return false;
		const images: ImageContent[] = [];
		for (let i = 0; i < result.content.length; i++) {
			const content = result.content[i]!;
			if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") {
				images.push({ type: "image", data: content.data, mimeType: content.mimeType });
			}
		}
		if (images.length === 0) return false;
		assistantComponent.setToolResultImages(toolCallId, images);
		return true;
	}

	#insertAfterTranscriptComponent(anchor: Component | undefined, component: Component): boolean {
		const children = this.ctx.chatContainer.children;
		const anchorIndex = anchor ? children.indexOf(anchor) : -1;
		if (anchorIndex < 0) return false;
		for (let ci = anchorIndex + 1; ci < children.length; ci++) {
			if (!this.ctx.chatContainer.isBlockUncommitted(children[ci]!)) return false;
		}
		this.ctx.chatContainer.addChild(component);
		children.splice(children.length - 1, 1);
		children.splice(anchorIndex + 1, 0, component);
		return true;
	}

	upsertPostToolAssistantSegment(
		toolCallId: string,
		segment: AssistantMessage | undefined,
	): AssistantMessageComponent | undefined {
		if (!segment || !assistantHasVisibleContent(segment)) return undefined;
		const view = toAssistantMessageView(segment);
		const existing = this.#postToolAssistantComponents.get(toolCallId);
		if (existing) {
			existing.updateContent(view);
			return existing;
		}
		const component = createAssistantMessageComponent(this.ctx, view);
		this.#postToolAssistantComponents.set(toolCallId, component);
		if (!this.#insertAfterTranscriptComponent(this.#toolTimelineComponents.get(toolCallId), component)) {
			this.ctx.chatContainer.addChild(component);
		}
		return component;
	}

	#updateWorkingMessageFromIntent(intent: unknown): void {
		if (this.ctx.session.isAborting) return;
		// Streamed JSON can deliver non-string `i` (object, number, boolean) before
		// schema validation; `?.` only guards null/undefined, so guard the type too.
		if (typeof intent !== "string") return;
		const trimmed = intent.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed}${interruptHint()}`);
	}

	/** Mounts or updates the preview of one streamed tool call. */
	previewStreamingToolCall(content: ToolCall, smoothStreaming: boolean, repaintTargets: Set<Component>): void {
		if (content.name === "read" && this.#previewStreamingRead(content, repaintTargets)) return;
		// Preserve the raw partial JSON only for renderers that need to surface fields before the JSON object closes.
		// Bash uses this to show inline env assignments during streaming instead of popping them in at completion.
		// While the JSON is still open, ToolArgsRevealController paces the
		// reveal (write/edit/bash previews grow smoothly when a slow provider
		// delivers large batches); once it closes, the final args render
		// as-is — mirroring how assistant text snaps at message_end.
		const partialJson = getStreamingPartialJson(content);
		const tool = this.ctx.viewSession.getToolByName(content.name);
		let renderArgs: Record<string, unknown> = content.arguments;
		if (partialJson) {
			const rawInput = content.customWireName !== undefined;
			renderArgs = this.deps.toolArgsReveal.setTarget(content.id, partialJson, {
				rawInput,
				exposeRawPartialJson: exposesRawPartialJson(content.name, rawInput, tool),
				streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
				// The preview renders arguments that have NOT reached the tool yet, so
				// they still carry `§handle` fragments; expansion at seam 1 happens
				// just before execution. Without the codec here a streaming write or
				// edit preview shows the handle instead of the text it stands for.
				argot: this.ctx.viewSession.getArgotSession?.(),
			});
		} else {
			this.deps.toolArgsReveal.finish(content.id);
		}
		if (this.ctx.settledToolCalls.has(content.id)) return;
		const pending = this.ctx.pendingTools.get(content.id);
		if (!pending) {
			repaintTargets.add(this.#mountStreamingToolCall(content, renderArgs, tool));
			return;
		}
		pending.updateArgs(renderArgs, content.id);
		this.deps.toolArgsReveal.bind(content.id, pending);
		// Paced args reveal schedules its own component-scoped paints.
		if (!partialJson || !smoothStreaming) repaintTargets.add(pending);
	}

	/**
	 * Routes a streamed `read` call into the read group; false when it targets an internal URL and falls through to a
	 * tool card. A call whose path has not streamed yet waits, since mounting either component now would lock the read
	 * into the wrong shape.
	 */
	#previewStreamingRead(content: ToolCall, repaintTargets: Set<Component>): boolean {
		if (!readArgsHaveTarget(content.arguments)) return true;
		if (readArgsTargetInternalUrl(content.arguments)) return false;
		if (this.ctx.settledToolCalls.has(content.id)) return true;
		if (!this.ctx.pendingTools.has(content.id)) this.deps.displaceable.resolvePoll(content.name);
		this.#trackReadToolCall(content.id, content.arguments);
		const pending = this.ctx.pendingTools.get(content.id);
		if (pending) {
			pending.updateArgs(content.arguments, content.id);
			repaintTargets.add(pending);
			return true;
		}
		const group = this.#getReadGroup();
		group.updateArgs(content.arguments, content.id);
		this.ctx.pendingTools.set(content.id, group);
		this.#toolTimelineComponents.set(content.id, group);
		repaintTargets.add(group);
		return true;
	}

	/** Adds the tool card of a streamed tool call to the transcript. */
	#mountStreamingToolCall(
		content: ToolCall,
		renderArgs: Record<string, unknown>,
		tool: AgentTool | undefined,
	): ToolExecutionComponent {
		this.deps.displaceable.resolvePoll(content.name);
		this.resetReadGroup();
		const component = new ToolExecutionComponent(
			content.name,
			renderArgs,
			{
				snapshots: getFileSnapshotStore(this.ctx.viewSession),
				showImages: settings.get("terminal.showImages"),
				editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
				editAllowFuzzy: settings.get("edit.fuzzyMatch"),
			},
			tool,
			this.ctx.ui,
			this.ctx.sessionManager.getCwd(),
			content.id,
		);
		component.setExpanded(this.ctx.toolOutputExpanded);
		this.ctx.chatContainer.addChild(component);
		this.ctx.pendingTools.set(content.id, component);
		this.#toolTimelineComponents.set(content.id, component);
		this.deps.toolArgsReveal.bind(content.id, component);
		return component;
	}

	/**
	 * Shows the intent of the last streamed tool call that states one. A later call's intent replaces an earlier one's,
	 * so the calls before it are not read.
	 */
	showStreamedIntent(content: AssistantMessage["content"]): void {
		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i]!;
			if (block.type !== "toolCall") continue;
			const intent = this.#streamedToolCallIntent(block);
			if (intent !== undefined) {
				this.#updateWorkingMessageFromIntent(intent);
				return;
			}
		}
	}

	/**
	 * The non-blank intent a streamed tool call states: its intent field when it has one, else what its tool derives
	 * from its arguments.
	 */
	#streamedToolCallIntent(block: ToolCall): string | undefined {
		const args = block.arguments;
		if (!args || typeof args !== "object") return undefined;
		if (INTENT_FIELD in args) {
			const intent: unknown = args[INTENT_FIELD];
			return typeof intent === "string" && intent.trim() ? intent : undefined;
		}
		const tool = this.ctx.viewSession.getToolByName(block.name);
		if (typeof tool?.intent !== "function") return undefined;
		try {
			return tool.intent(args as never)?.trim() || undefined;
		} catch {
			// intent function must never break the UI
			return undefined;
		}
	}

	/**
	 * Settles the tool calls still pending when a turn ends. A completed turn's calls have final arguments. An aborted
	 * or failed turn (abort, error, TTSR rewind) never runs its calls, so each is sealed to stop animating instead of
	 * pinning the live region while a retry streams fresh blocks below it, and the waiting poll freezes in place.
	 * Background task calls keep updating.
	 */
	settlePendingToolCalls(stopReason: AssistantMessage["stopReason"]): void {
		if (stopReason !== "aborted" && stopReason !== "error") {
			for (const [toolCallId, component] of this.ctx.pendingTools.entries()) component.setArgsComplete(toolCallId);
			return;
		}
		for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
			if (!this.#backgroundTaskCallIds.has(toolCallId) && component instanceof ToolExecutionComponent) {
				component.seal();
			}
		}
		this.deps.displaceable.resolvePoll();
	}

	async toolExecutionStarted(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		ensureWorkingLoaderWhileStreaming(this.ctx);
		// Living shimmer: a tool is executing — the head scans back and forth.
		setShimmerActivity("tool");
		this.#updateWorkingMessageFromIntent(event.intent);
		this.deps.displaceable.resolvePoll(event.toolName);
		this.deps.projection.recordToolCall(event.toolCallId, event.toolName, event.args);
		this.deps.projection.markToolCallRunning(event.toolCallId, true);
		if (this.ctx.settledToolCalls.has(event.toolCallId)) return;
		if (!this.ctx.pendingTools.has(event.toolCallId)) {
			if (event.toolName === "read" && readArgsHaveTarget(event.args) && !readArgsTargetInternalUrl(event.args)) {
				this.#trackReadToolCall(event.toolCallId, event.args);
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateArgs(event.args, event.toolCallId);
				} else {
					const group = this.#getReadGroup();
					group.updateArgs(event.args, event.toolCallId);
					this.ctx.pendingTools.set(event.toolCallId, group);
					this.#toolTimelineComponents.set(event.toolCallId, group);
				}
				this.ctx.ui.requestRender();
				return;
			}

			this.resetReadGroup();
			const tool = this.ctx.viewSession.getToolByName(event.toolName);
			const component = new ToolExecutionComponent(
				event.toolName,
				event.args,
				{
					snapshots: getFileSnapshotStore(this.ctx.viewSession),
					showImages: settings.get("terminal.showImages"),
					editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
					editAllowFuzzy: settings.get("edit.fuzzyMatch"),
					liveRegion: this.ctx.chatContainer,
				},
				tool,
				this.ctx.ui,
				this.ctx.sessionManager.getCwd(),
				event.toolCallId,
			);
			component.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(component);
			this.ctx.pendingTools.set(event.toolCallId, component);
			this.#toolTimelineComponents.set(event.toolCallId, component);
			this.ctx.ui.requestRender();
		} else {
			// The tool is about to run, so its arguments are final and validated.
			// A pending component created while args streamed (message_update) may
			// still show a mid-reveal prefix — or, when the closing full-args
			// `message_update` never lands (smooth-streaming off leaving the
			// throttled `arguments` stale, an owned-dialect projector, or a
			// superseded/aborted turn that still executes the call), a stale body
			// the result render then freezes at its `…` placeholder. Reconcile the
			// authoritative args here and drop any live reveal so a late tick can't
			// re-truncate them: tool_execution_start is the one event every
			// execution path emits with the full args immediately before the result.
			this.deps.toolArgsReveal.finish(event.toolCallId);
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component && typeof component.updateArgs === "function") {
				component.updateArgs(event.args, event.toolCallId);
				if (typeof component.setArgsComplete === "function") {
					component.setArgsComplete(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			}
		}
	}

	async toolExecutionUpdated(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): Promise<void> {
		ensureWorkingLoaderWhileStreaming(this.ctx);
		const component = this.ctx.pendingTools.get(event.toolCallId);
		if (component) {
			const asyncState = asyncToolState(event.partialResult.details);
			const isFinalAsyncState = asyncState === "completed" || asyncState === "failed";
			// A final async snapshot is terminal only for a parked background
			// block (the call already returned and was kept alive for its jobs).
			// While the call is still executing — a mixed blocking+async task
			// call whose jobs settle before its blocking subset — treat it as a
			// partial frame: `tool_execution_end` still owns the terminal result.
			const isTerminal = isFinalAsyncState && this.#backgroundTaskCallIds.has(event.toolCallId);
			component.updateResult(
				{ ...event.partialResult, isError: asyncState === "failed" },
				!isTerminal,
				event.toolCallId,
			);
			if (isTerminal) {
				this.ctx.pendingTools.delete(event.toolCallId);
				this.#backgroundTaskCallIds.delete(event.toolCallId);
				this.ctx.settledToolCalls.add(event.toolCallId);
				this.deps.projection.markToolCallRunning(event.toolCallId, false);
				this.deps.projection.markToolCallSettled(event.toolCallId);
			}
			this.ctx.ui.requestRender();
		}
	}

	async toolExecutionEnded(event: ToolExecutionEndEvent): Promise<void> {
		ensureWorkingLoaderWhileStreaming(this.ctx);
		if (this.ctx.settledToolCalls.has(event.toolCallId)) return;
		this.deps.projection.markToolCallRunning(event.toolCallId, false);
		if (event.toolName !== "task" || asyncToolState(event.result.details) !== "running") {
			this.ctx.settledToolCalls.add(event.toolCallId);
			this.deps.projection.markToolCallSettled(event.toolCallId);
		}
		if (event.toolName === "read") this.#endReadToolCall(event);
		else this.#endToolCall(event);
		if (event.toolName === "todo") this.#showTodoOutcome(event);
		else if (event.toolName === "resolve" && !event.isError) {
			await this.#applyResolvedPlan(event.result.details as ResolveToolDetails | undefined);
		}
	}

	/**
	 * Settles a read call. Its images inline into the assistant block that issued it; a call that inlined nothing and
	 * mounted no card of its own lands its result in the read group.
	 */
	#endReadToolCall(event: ToolExecutionEndEvent): void {
		const { toolCallId } = event;
		const inlinedImages = this.#inlineReadToolImages(toolCallId, event.result);
		let component = this.ctx.pendingTools.get(toolCallId);
		if (!component && !inlinedImages) {
			const group = this.#getReadGroup();
			const args = this.deps.projection.findToolCallArgs(toolCallId) as Record<string, unknown> | undefined;
			if (args) group.updateArgs(args, toolCallId);
			component = group;
		}
		component?.updateResult({ ...event.result, isError: event.isError }, false, toolCallId);
		this.ctx.pendingTools.delete(toolCallId);
		this.#clearReadToolCall(toolCallId);
		this.ctx.ui.requestRender();
	}

	/** Settles a non-read call's card; a live background task keeps its card pending for later updates. */
	#endToolCall(event: ToolExecutionEndEvent): void {
		const { toolCallId, toolName } = event;
		const component = this.ctx.pendingTools.get(toolCallId);
		if (!component) return;
		const isBackgroundTask = isLiveBackgroundTask(toolName, event.result.details);
		component.updateResult({ ...event.result, isError: event.isError }, isBackgroundTask, toolCallId);
		if (isBackgroundTask) {
			this.#backgroundTaskCallIds.add(toolCallId);
		} else {
			this.ctx.pendingTools.delete(toolCallId);
			this.#backgroundTaskCallIds.delete(toolCallId);
		}
		if (component instanceof ToolExecutionComponent && component.isDisplaceableBlock()) {
			this.deps.displaceable.track(toolName, component);
		}
		this.ctx.ui.requestRender();
	}

	/** Updates the todo display from a successful todo call, or warns with the first line of a failed one that ran. */
	#showTodoOutcome(event: ToolExecutionEndEvent): void {
		if (!event.isError) {
			const details = event.result.details as { phases?: TodoPhase[] } | undefined;
			if (details?.phases) this.ctx.setTodos(details.phases);
			return;
		}
		// A never-ran placeholder is not a todo failure. The turn died in transport before the call was dispatched,
		// which the error card and the batch ledger already state once; repeating it per `todo` call in the dead batch
		// adds nothing and buries the one message that states the real cause.
		if (toolResultNeverRan(event.result.details)) return;
		// A warning is a notice, not a report. The result text holds the error, the plan's standing and the open
		// work, and the card under this line draws all three; the notice takes the first line and leaves the ledger
		// to the card.
		const text = event.result.content.find((content): content is TextContent => content.type === "text")?.text;
		const headline = text?.split("\n", 1)[0]?.trim();
		this.ctx.showWarning(
			`Todo update failed${headline ? `: ${headline}` : ". Progress may be stale until todo succeeds."}`,
		);
	}

	/** Applies the plan a resolve call approved through plan_approval. */
	async #applyResolvedPlan(details: ResolveToolDetails | undefined): Promise<void> {
		if (details?.sourceToolName !== "plan_approval" || details.action !== "apply") return;
		const planDetails = details.sourceResultDetails as PlanApprovalDetails | undefined;
		if (planDetails) await this.ctx.handlePlanApproval(planDetails);
	}
}
