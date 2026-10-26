/**
 * Shared transcript rendering for interactive chat and read-only viewers.
 * `rebuild` reconstructs persisted history; `append` consumes new persisted entries.
 * Live `appendMessage` excludes tool mounting, which the event controller performs.
 */
import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import type { ImageContent, Usage } from "@veyyon/ai";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import type { SnapshotStore } from "@veyyon/hashline";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import { type Component, Text, type TUI } from "@veyyon/tui";
import { formatCount, TimeSlice } from "@veyyon/utils";
import type { BlockId, CustomBlock, HookBlock, TranscriptBlock } from "@veyyon/wire/presentation";
import type { ArgotSession } from "argot/session";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import type { Settings } from "../../../../config/settings";
import { settings } from "../../../../config/settings-instance";
import type { AssistantThinkingRenderer, MessageRenderer } from "../../../../extensibility/extensions/types";
import { warmDisplaySchema } from "../../../../presentation/display-arguments";
import {
	resolveAssistantErrorPresentation,
	toAssistantMessageView,
	toTranscriptBlock,
	toUserMessageView,
} from "../../../../presentation/transcript-builder";
import type { CustomMessage } from "../../../../session/messages";
import { type HighlightRequest, prefetchHighlights } from "../../../../theme/highlight";
import { theme } from "../../../../theme/theme-binding";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../../../../tools/core/streamed-tool-args";
import { isLiveBackgroundTask } from "../../utils/async-tool-state";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildFileMentionBlock,
	ledgerMarkerLine,
	normalizeToolArgs,
	splitAssistantMessageToolTimeline,
} from "../../utils/transcript-render-helpers";
import { AssistantMessageComponent } from "./assistant-message";
import { BashExecutionComponent } from "./bash-execution";
import { detectCacheInvalidation, usesExplicitPromptCache } from "./cache-invalidation-marker";
import type { ChatBlockHost } from "./chat-block";
import { BranchSummaryMessageComponent, CompactionSummaryMessageComponent } from "./compaction-summary-message";
import { CustomMessageComponent, createSpecializedCustomComponent } from "./custom-message";
import { EvalExecutionComponent } from "./eval-execution";
import { HookMessageComponent } from "./hook-message";
import type { CustomRenderCapability } from "./message-frame";
import { ReadToolGroupComponent, readArgsHaveTarget, readArgsTargetInternalUrl } from "./read-tool-group";
import {
	ToolExecutionComponent,
	type ToolExecutionHandle,
	type TranscriptLiveRegionProbe,
	turnFailedToolResult,
} from "./tool-execution";
import { TranscriptBlockComponent, type TranscriptBlockComponentOptions } from "./transcript-block-component";
import { TranscriptContainer } from "./transcript-container";
import { createUsageRowBlock } from "./usage-row";
import { UserMessageComponent } from "./user-message";
export interface ChatTranscriptBuilderDeps {
	ui: TUI;
	container?: TranscriptContainer | (() => TranscriptContainer);
	pendingTools?: Map<string, ToolExecutionHandle> | (() => Map<string, ToolExecutionHandle>);
	settledToolCalls?: Set<string> | (() => Set<string>);
	getSettings?: () => Pick<Settings, "get">;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	getCustomRenderer?: (block: CustomBlock | HookBlock) => CustomRenderCapability | undefined;
	getThinkingRenderers?: () => AssistantThinkingRenderer[] | undefined;
	getSnapshots?: () => SnapshotStore | undefined;
	getArgotSession?: () => ArgotSession | undefined;
	cwd: string | (() => string);
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	requestRender: () => void;
	resolveImageLinks?: (
		message: Extract<AgentMessage, { role: "developer" | "user" }>,
	) => readonly (string | undefined)[] | undefined;
	onPopulateHistory?: (text: string) => void;
	onInheritDisplaceableTodo?: (component: ToolExecutionComponent) => void;
	isStreaming?: () => boolean;
	retryAttempt?: () => number;
	getLastAssistantUsage?: () => Usage | undefined;
	setLastAssistantUsage?: (usage: Usage | undefined) => void;
	/** Group projected file-read entries; defaults to true. */
	groupReadEntries?: boolean;
	initialExpanded?: boolean;
	indentFileMentions?: number;
}

function isExpandable(component: unknown): component is { setExpanded(expanded: boolean): void } {
	return (
		typeof component === "object" &&
		component !== null &&
		"setExpanded" in component &&
		typeof (component as { setExpanded?: unknown }).setExpanded === "function"
	);
}

function extractMessagesAndCacheMiss(
	input: SessionContext | readonly SessionMessageEntry[] | readonly AgentMessage[],
): { messages: readonly AgentMessage[]; cacheMissExplainedAt?: boolean[] } {
	if ("messages" in input) {
		return { messages: input.messages, cacheMissExplainedAt: input.cacheMissExplainedAt };
	}
	return { messages: input.map(item => ("message" in item ? item.message : item)) };
}

/** Rebuilt rows a {@link ChatTranscriptBuilder.rebuildInSlices} draws per batch before it checks the slice. */
const WARM_BATCH = 16;

/** A {@link ChatTranscriptBuilder.rebuildInSlices} that has not mounted its rows yet. */
interface SlicedRebuild {
	/** Detached container the rows are built in; never drawn by the screen. */
	readonly staging: TranscriptContainer;
	readonly messages: readonly AgentMessage[];
	/** Message count when the rebuild started, so a message persisted mid-rebuild arrives live, once. */
	readonly end: number;
	readonly cacheMissExplainedAt: readonly boolean[] | undefined;
	readonly populateHistory: boolean | undefined;
	/** Whether the session was streaming when the rebuild started, which is what its transcript reflects. */
	readonly streaming: boolean;
	readonly mount: (transcript: readonly Component[]) => void;
	/** Next message to append. */
	next: number;
	finalized: boolean;
	/** Next built row to highlight and draw. */
	warmed: number;
	/** Tools whose display schema this rebuild has built, so each is built once and alone. */
	readonly warmedTools: Set<string>;
}

export class ChatTranscriptBuilder {
	#ownContainer: TranscriptContainer | undefined;
	#ownPendingTools: Map<string, ToolExecutionHandle> | undefined;
	#ownSettledToolCalls: Set<string> | undefined;
	readonly #blocksById = new Map<
		BlockId,
		{ block: TranscriptBlock; component: TranscriptBlockComponent | ReadToolGroupComponent; readToolCallId?: string }
	>();
	readonly #readArgs = new Map<string, Record<string, unknown>>();
	readonly #readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	readonly #liveBackgroundCalls = new Set<string>();
	#readGroup: ReadToolGroupComponent | null = null;
	#pendingUsage: Usage | undefined;
	#pendingUsageDuration: number | undefined;
	#pendingUsageTtft: number | undefined;
	#lastAssistantUsage: Usage | undefined;
	#waitingPoll: ToolExecutionComponent | null = null;
	#todoSnapshot: ToolExecutionComponent | null = null;
	#expandables: Array<{ setExpanded(expanded: boolean): void }> = [];
	#expanded = false;
	/** One repaint callback and one scoped-repaint host for every assistant component this builder
	 *  creates; both read `deps` at call time. */
	readonly #requestRender = (): void => this.deps.requestRender();
	readonly #renderHost: ChatBlockHost = {
		requestComponentRender: component => this.deps.ui.requestComponentRender(component),
	};
	#sliced: SlicedRebuild | undefined;
	/** Live-region probe for the cards this builds: asks whichever container holds them now. */
	readonly #liveRegion: TranscriptLiveRegionProbe = {
		isBlockInLiveRegion: component => this.#container.isBlockInLiveRegion(component),
	};

	constructor(private readonly deps: ChatTranscriptBuilderDeps) {
		this.#expanded = deps.initialExpanded ?? false;
		this.#lastAssistantUsage = deps.getLastAssistantUsage?.();
	}

	get container(): TranscriptContainer {
		if (typeof this.deps.container === "function") return this.deps.container();
		if (this.deps.container) return this.deps.container;
		this.#ownContainer ??= new TranscriptContainer();
		return this.#ownContainer;
	}

	/** Where rows are built: the staging container while a sliced rebuild runs, else {@link container}. */
	get #container(): TranscriptContainer {
		return this.#sliced?.staging ?? this.container;
	}

	get #pendingTools(): Map<string, ToolExecutionHandle> {
		if (typeof this.deps.pendingTools === "function") return this.deps.pendingTools();
		if (this.deps.pendingTools) return this.deps.pendingTools;
		this.#ownPendingTools ??= new Map();
		return this.#ownPendingTools;
	}

	get #settledToolCalls(): Set<string> {
		if (typeof this.deps.settledToolCalls === "function") return this.deps.settledToolCalls();
		if (this.deps.settledToolCalls) return this.deps.settledToolCalls;
		this.#ownSettledToolCalls ??= new Set();
		return this.#ownSettledToolCalls;
	}

	get #cwd(): string {
		return typeof this.deps.cwd === "function" ? this.deps.cwd() : this.deps.cwd;
	}
	get #settings(): Pick<Settings, "get"> {
		return this.deps.getSettings?.() ?? settings;
	}

	/** Whether the transcript currently holds any rendered rows. */
	get isEmpty(): boolean {
		return this.container.children.length === 0;
	}
	/** Discard all components and rebuild the whole transcript from `input`. */
	rebuild(
		input: SessionContext | readonly SessionMessageEntry[] | readonly AgentMessage[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.reset();
		const { messages, cacheMissExplainedAt } = extractMessagesAndCacheMiss(input);
		const count = messages.length;
		for (let i = 0; i < count; i++) {
			const message = messages[i]!;
			this.#appendPersistedMessage(message, {
				populateHistory: options.populateHistory,
				cacheMissExplained: cacheMissExplainedAt?.[i] ?? false,
			});
		}
		this.#finalizeRebuild();
	}

	/**
	 * {@link rebuild} without blocking input. Rows are built in a detached container, one
	 * {@link TimeSlice} at a time with input and frames running between slices, then highlighted and
	 * drawn at the terminal width so the frame that shows them reuses every row. The first slice runs
	 * in an event-loop turn of its own, never in the caller's, so it does not extend whatever work the
	 * caller's turn already holds. `mount` receives the rows once, in order; until then
	 * {@link container} keeps what it showed. Every other call that reads or changes the transcript
	 * first finishes the remaining work synchronously ({@link settle}), so it observes the transcript
	 * {@link rebuild} would have left.
	 */
	async rebuildInSlices(
		input: SessionContext,
		options: { populateHistory?: boolean },
		mount: (transcript: readonly Component[]) => void,
	): Promise<void> {
		this.settle();
		const { messages, cacheMissExplainedAt } = extractMessagesAndCacheMiss(input);
		const job: SlicedRebuild = {
			staging: new TranscriptContainer(),
			messages,
			end: messages.length,
			cacheMissExplainedAt,
			populateHistory: options.populateHistory,
			streaming: this.deps.isStreaming?.() ?? false,
			mount,
			next: 0,
			finalized: false,
			warmed: 0,
			warmedTools: new Set(),
		};
		this.#clearState();
		this.#settledToolCalls.clear();
		this.#sliced = job;
		const slice = new TimeSlice();
		do {
			await slice.yield();
		} while (this.#sliced === job && !this.#advance(job, slice));
	}

	/** Finish a {@link rebuildInSlices} still in progress, synchronously, and mount its rows. */
	settle(): void {
		const job = this.#sliced;
		if (job) this.#advance(job, undefined);
	}

	/** Work `job` forward until `slice` is due, or to the end without one; true once it has mounted. */
	#advance(job: SlicedRebuild, slice: TimeSlice | undefined): boolean {
		while (job.next < job.end) {
			if (slice?.due) return false;
			// A tool's first card builds its ArkType schema, several milliseconds each. Build each tool
			// the next message calls ahead of it with the slice checked after every one, so a message
			// that introduces several tools does not hold one turn for all of them.
			if (slice && this.#warmNextToolSchema(job)) continue;
			const index = job.next++;
			this.#appendPersistedMessage(job.messages[index]!, {
				populateHistory: job.populateHistory,
				cacheMissExplained: job.cacheMissExplainedAt?.[index] ?? false,
			});
		}
		if (!job.finalized) {
			job.finalized = true;
			this.#finalizeRebuildState(job.streaming);
		}
		const rows = job.staging.children;
		if (slice) {
			while (job.warmed < rows.length) {
				if (slice.due) return false;
				job.warmed = this.#warm(rows, job.warmed);
			}
		} else {
			this.#prefetchHighlights(rows, job.warmed);
		}
		if (this.#sliced !== job) return true;
		this.#sliced = undefined;
		job.staging.clear();
		job.mount(rows);
		return true;
	}

	/**
	 * Build the display schema of one tool the next message calls that `job` has not built yet.
	 * Returns whether it took a tool, so the caller checks its slice before the next one.
	 */
	#warmNextToolSchema(job: SlicedRebuild): boolean {
		const message = job.messages[job.next]!;
		if (message.role !== "assistant") return false;
		for (const content of message.content) {
			if (content.type !== "toolCall" || job.warmedTools.has(content.name)) continue;
			job.warmedTools.add(content.name);
			warmDisplaySchema(this.deps.getTool?.(content.name));
			return true;
		}
		return false;
	}

	/**
	 * Highlight and draw the next {@link WARM_BATCH} rebuilt rows at the width the screen draws the
	 * transcript at, so the frame that mounts them reuses each row rather than drawing every one.
	 * Returns the index after the batch.
	 */
	#warm(rows: readonly Component[], from: number): number {
		const end = Math.min(rows.length, from + WARM_BATCH);
		this.#prefetchHighlights(rows, from, end);
		const width = this.deps.ui.terminal.columns;
		for (let index = from; index < end; index++) rows[index]!.render(width);
		return end;
	}

	/** Append newly persisted entries without rebuilding already rendered rows. */
	append(
		input: SessionContext | readonly SessionMessageEntry[] | readonly AgentMessage[],
		options: { populateHistory?: boolean } = {},
	): void {
		this.settle();
		const { messages, cacheMissExplainedAt } = extractMessagesAndCacheMiss(input);
		const count = messages.length;
		for (let i = 0; i < count; i++) {
			const message = messages[i]!;
			this.#appendPersistedMessage(message, {
				populateHistory: options.populateHistory,
				cacheMissExplained: cacheMissExplainedAt?.[i] ?? false,
			});
		}
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
	}

	/** Append a single message to the transcript (live dispatch). */
	appendMessage(
		message: AgentMessage,
		options?: { populateHistory?: boolean; imageLinks?: readonly (string | undefined)[] },
	): Component[] {
		this.settle();
		switch (message.role) {
			case "assistant": {
				const timeline = splitAssistantMessageToolTimeline(message);
				const assistantComponent = this.#createAssistantComponent(timeline.beforeTools);
				this.#container.addChild(assistantComponent);
				return [];
			}
			case "toolResult":
				// Live tool results are rendered inline with tool calls, handled by eventController.
				return [];
			default:
				return this.#appendCommonMessage(message, options);
		}
	}

	/** Toggle tool-output expansion across every expandable component. */
	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		for (const component of this.#expandables) component.setExpanded(expanded);
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	/** Discard rendered rows while retaining the session's completed-call ledger. */
	clearTranscript(): void {
		this.settle();
		this.#clearState();
		this.#container.disposeChildren();
	}

	/** Builder state of the rendered rows, cleared without touching the rows themselves. */
	#clearState(): void {
		if (this.deps.pendingTools === undefined && this.#ownPendingTools) {
			for (const pending of this.#ownPendingTools.values()) pending.seal();
		}
		this.#blocksById.clear();
		this.#pendingTools.clear();
		this.#readArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#liveBackgroundCalls.clear();
		this.#readGroup = null;
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#lastAssistantUsage = undefined;
		this.deps.setLastAssistantUsage?.(undefined);
		this.#waitingPoll = null;
		this.#todoSnapshot = null;
		this.#expandables = [];
	}

	#getTranscriptBlockOptions(): TranscriptBlockComponentOptions {
		return {
			tui: this.deps.ui,
			onRequestRender: () => this.deps.requestRender(),
			expanded: this.#expanded,
			cwd: this.#cwd,
			getCustomRenderer: this.deps.getCustomRenderer,
			getThinkingRenderers: this.deps.getThinkingRenderers,
			hideThinkingBlock: this.deps.hideThinkingBlock,
			proseOnlyThinking: this.deps.proseOnlyThinking,
		};
	}

	setTranscriptBlocks(blocks: readonly TranscriptBlock[]): void {
		this.clearTranscript();
		for (const block of blocks) {
			this.appendTranscriptBlock(block);
		}
	}

	appendTranscriptBlock(block: TranscriptBlock): void {
		this.settle();
		if (this.#blocksById.has(block.id)) {
			this.updateTranscriptBlock(block.id, block);
			return;
		}
		if (
			this.deps.groupReadEntries !== false &&
			block.kind === "tool-execution" &&
			block.display?.readEntry &&
			!readArgsTargetInternalUrl({ path: block.display.readEntry.path })
		) {
			const group = this.#ensureReadGroup();
			group.updateEntry(block.display.readEntry);
			this.#blocksById.set(block.id, {
				block,
				component: group,
				readToolCallId: block.display.readEntry.toolCallId,
			});
			return;
		}

		this.#readGroup?.seal();
		this.#readGroup = null;
		const comp = new TranscriptBlockComponent(block, this.#getTranscriptBlockOptions());
		this.#blocksById.set(block.id, { block, component: comp });
		this.#trackExpandable(comp);
		this.#container.addChild(comp);
	}

	updateTranscriptBlock(id: BlockId, patch: Partial<TranscriptBlock>): void {
		this.settle();
		const record = this.#blocksById.get(id);
		if (!record) return;
		const block = { ...record.block, ...patch, id } as TranscriptBlock;
		record.block = block;
		const existing = record.component;
		if (existing instanceof ReadToolGroupComponent) {
			if (block.kind === "tool-execution" && block.display?.readEntry) {
				existing.updateEntry(block.display.readEntry);
				return;
			}
		}
		if (existing instanceof TranscriptBlockComponent) {
			existing.set(block);
			return;
		}
	}

	removeTranscriptBlock(id: BlockId): boolean {
		this.settle();
		const entry = this.#blocksById.get(id);
		if (!entry || !this.#container.isBlockUncommitted(entry.component)) return false;
		const comp = entry.component;
		this.#blocksById.delete(id);
		if (comp instanceof ReadToolGroupComponent && entry.readToolCallId !== undefined) {
			if (comp.removeEntry(entry.readToolCallId) > 0) return true;
		}
		if (this.#readGroup === comp) this.#readGroup = null;
		this.#container.removeChild(comp);
		const expandableIndex = this.#expandables.indexOf(comp);
		if (expandableIndex !== -1) this.#expandables.splice(expandableIndex, 1);
		comp.dispose?.();
		return true;
	}

	/** Reset session history before rebuilding it from another transcript. */
	reset(): void {
		this.clearTranscript();
		this.#settledToolCalls.clear();
	}
	dispose(): void {
		this.reset();
	}

	#trackExpandable(component: { setExpanded(expanded: boolean): void }): void {
		component.setExpanded(this.#expanded);
		this.#expandables.push(component);
	}

	/** A `job` poll showing all-running is displaced by the next `job` call. */
	#resolveWaitingPoll(nextToolName?: string): void {
		const previous = this.#waitingPoll;
		if (!previous) return;
		this.#waitingPoll = null;
		if (nextToolName === "job" && previous.isDisplaceableBlock() && this.#container.isBlockUncommitted(previous)) {
			this.#container.removeChild(previous);
		}
		previous.seal();
	}

	#resolveTodoSnapshot(nextToolName?: string): void {
		const previous = this.#todoSnapshot;
		if (!previous) return;
		if (!previous.isDisplaceableBlock()) {
			this.#todoSnapshot = null;
			return;
		}
		if (previous.canBeDisplacedBy(nextToolName)) {
			this.#todoSnapshot = null;
			if (this.#container.isBlockUncommitted(previous)) {
				this.#container.removeChild(previous);
			}
			previous.seal();
			return;
		}
		if (nextToolName !== undefined) return;
		this.#todoSnapshot = null;
		previous.seal();
	}

	#ensureReadGroup(): ReadToolGroupComponent {
		if (!this.#readGroup) {
			this.#readGroup = new ReadToolGroupComponent({
				showContentPreview: this.#settings.get("read.toolResultPreview"),
			});
			this.#trackExpandable(this.#readGroup);
			this.#container.addChild(this.#readGroup);
		}
		return this.#readGroup;
	}

	#flushPendingUsage(): void {
		if (!this.#pendingUsage) return;
		this.#readGroup?.seal();
		this.#readGroup = null;
		this.#container.addChild(
			createUsageRowBlock(this.#pendingUsage, this.#pendingUsageDuration, this.#pendingUsageTtft),
		);
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
	}

	#appendPersistedMessage(
		message: AgentMessage,
		options?: {
			populateHistory?: boolean;
			imageLinks?: readonly (string | undefined)[];
			cacheMissExplained?: boolean;
		},
	): void {
		if (message.role !== "toolResult") this.#flushPendingUsage();
		switch (message.role) {
			case "assistant":
				this.#appendAssistantMessage(message, options?.cacheMissExplained ?? false);
				break;
			case "toolResult":
				this.#appendToolResult(message);
				break;
			default:
				this.#appendCommonMessage(message, options);
				break;
		}
	}

	#appendCommonMessage(
		message: AgentMessage,
		options?: {
			populateHistory?: boolean;
			imageLinks?: readonly (string | undefined)[];
		},
	): Component[] {
		switch (message.role) {
			case "user":
			case "developer": {
				if (message.role === "user") {
					this.#resolveWaitingPoll();
					this.#resolveTodoSnapshot();
				}
				const userView = toUserMessageView(message);
				const textContent = userView.text;
				if (textContent) {
					const ledgerMarker = ledgerMarkerLine(textContent);
					if (ledgerMarker !== null) {
						this.#container.addChild(new Text(ledgerMarker, 0, 0));
						return [];
					}
					userView.imageLinks = options?.imageLinks ?? this.deps.resolveImageLinks?.(message);
					const userComponent = new UserMessageComponent(userView);
					this.#container.addChild(userComponent);
					if (options?.populateHistory && message.role === "user" && !userView.synthetic) {
						this.deps.onPopulateHistory?.(textContent);
					}
				}
				return [];
			}
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { meta: message.meta });
				this.#container.addChild(component);
				return [];
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { meta: message.meta });
				this.#container.addChild(component);
				return [];
			}
			case "hookMessage":
			case "custom":
				return this.#appendCustomMessage(message);
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.#container.addChild(component);
				return [];
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.#container.addChild(component);
				return [];
			}
			case "fileMention": {
				const indent = this.deps.indentFileMentions ?? 0;
				const block = buildFileMentionBlock(message.files, indent);
				if (block.children.length > 0) this.#container.addChild(block);
				return [];
			}
			default:
				return [];
		}
	}

	#createAssistantComponent(
		message: Extract<AgentMessage, { role: "assistant" }>,
		retryAttempt = this.deps.retryAttempt?.() ?? 0,
	): AssistantMessageComponent {
		const hideThinkingBlock = this.deps.hideThinkingBlock?.() ?? false;
		const proseOnlyThinking = this.deps.proseOnlyThinking ? this.deps.proseOnlyThinking() : true;
		const thinkingRenderers = this.deps.getThinkingRenderers?.() ?? (this.deps.getMessageRenderer ? undefined : []);
		return new AssistantMessageComponent(
			toAssistantMessageView(message, { retryAttempt }),
			hideThinkingBlock,
			this.#requestRender,
			thinkingRenderers,
			this.deps.ui.imageBudget,
			proseOnlyThinking,
			this.#renderHost,
		);
	}

	#appendAssistantMessage(message: Extract<AgentMessage, { role: "assistant" }>, cacheMissExplained: boolean): void {
		const retryAttempt = this.deps.retryAttempt?.() ?? 0;
		const timeline = splitAssistantMessageToolTimeline(message);
		const assistantComponent = this.#createAssistantComponent(timeline.beforeTools, retryAttempt);
		this.#container.addChild(assistantComponent);

		const usage = message.usage;
		if (this.#settings.get("display.cacheMissMarker") && !cacheMissExplained) {
			const invalidation = detectCacheInvalidation(this.#lastAssistantUsage, usage, undefined, {
				explicitCache: usesExplicitPromptCache(message.api, message.model),
			});
			if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
		}
		if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
			this.#lastAssistantUsage = usage;
			this.deps.setLastAssistantUsage?.(usage);
		}

		const hasVisibleAssistantContent = assistantHasVisibleContent(message);
		if (hasVisibleAssistantContent) {
			this.#readGroup?.seal();
			this.#readGroup = null;
		}

		const errorPresentation = resolveAssistantErrorPresentation(message, retryAttempt);
		const hasErrorStop = errorPresentation.kind === "full";
		const errorMessage = hasErrorStop ? errorPresentation.text : null;
		const appendAssistantSegment = (segment: Extract<AgentMessage, { role: "assistant" }> | undefined) => {
			if (!segment || !assistantHasVisibleContent(segment)) return;
			const component = this.#createAssistantComponent(segment, retryAttempt);
			this.#container.addChild(component);
		};

		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#resolveWaitingPoll(content.name);

			const afterToolSegment = timeline.afterToolCalls.get(content.id);
			if (
				content.name === "read" &&
				readArgsHaveTarget(content.arguments) &&
				!readArgsTargetInternalUrl(content.arguments)
			) {
				if (hasErrorStop && errorMessage) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					group.updateResult(turnFailedToolResult(errorMessage), false, content.id);
					this.#settledToolCalls.add(content.id);
				} else if (afterToolSegment) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					this.#pendingTools.set(content.id, group);
					this.#readToolCallAssistantComponents.set(content.id, assistantComponent);
				} else {
					const normalizedArgs = normalizeToolArgs(content.arguments);
					this.#readArgs.set(content.id, normalizedArgs);
					this.#readToolCallAssistantComponents.set(content.id, assistantComponent);
				}
				appendAssistantSegment(afterToolSegment);
				continue;
			}

			this.#readGroup?.seal();
			this.#readGroup = null;

			const tool = this.deps.getTool?.(content.name);
			const partialJson = getStreamingPartialJson(content);
			const rawInput = content.customWireName !== undefined;
			const renderArgs = partialJson
				? decodeStreamedToolArgs(partialJson, {
						rawInput,
						fullArgs: content.arguments,
						streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
						argot: this.deps.getArgotSession?.(),
					})
				: content.arguments;

			const component = new ToolExecutionComponent(
				content.name,
				renderArgs,
				{
					snapshots: this.deps.getSnapshots?.(),
					showImages: settings.get("terminal.showImages"),
					editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
					editAllowFuzzy: settings.get("edit.fuzzyMatch"),
					liveRegion: this.#liveRegion,
				},
				tool,
				this.deps.ui,
				this.#cwd,
				content.id,
			);
			this.#trackExpandable(component);
			this.#container.addChild(component);

			if (hasErrorStop && errorMessage) {
				component.updateResult(turnFailedToolResult(errorMessage), false, content.id);
				this.#settledToolCalls.add(content.id);
			} else {
				this.#pendingTools.set(content.id, component);
			}
			appendAssistantSegment(afterToolSegment);
		}

		const strippedToolCalls =
			"strippedToolCalls" in message && typeof message.strippedToolCalls === "number"
				? message.strippedToolCalls
				: 0;
		if (strippedToolCalls > 0) {
			this.#container.addChild(
				new Text(
					theme.fg(
						"dim",
						theme.italic(`${formatCount("tool call", strippedToolCalls)} elided — no result on this branch`),
					),
					1,
					0,
				),
			);
		}

		this.#pendingUsage =
			this.#settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage)
				? message.usage
				: undefined;
		this.#pendingUsageDuration = message.duration;
		this.#pendingUsageTtft = message.ttft;
	}

	#appendToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		const backgroundStillRunning = isLiveBackgroundTask(message.toolName, message.details);
		if (backgroundStillRunning) {
			this.#liveBackgroundCalls.add(message.toolCallId);
		} else {
			this.#settledToolCalls.add(message.toolCallId);
		}

		const pending = this.#pendingTools.get(message.toolCallId);
		const isReadGroupResult = message.toolName === "read" && (!pending || pending instanceof ReadToolGroupComponent);
		if (isReadGroupResult) {
			const assistantComponent = this.#readToolCallAssistantComponents.get(message.toolCallId);
			const images: ImageContent[] = message.content.filter(
				(content): content is ImageContent => content.type === "image",
			);
			if (images.length > 0 && assistantComponent && settings.get("terminal.showImages")) {
				assistantComponent.setToolResultImages(message.toolCallId, images);
				const hasText = message.content.some(c => c.type === "text");
				if (!hasText) {
					this.#readArgs.delete(message.toolCallId);
					this.#readToolCallAssistantComponents.delete(message.toolCallId);
					return;
				}
			}

			let component = pending;
			if (!component) {
				const group = this.#ensureReadGroup();
				const args = this.#readArgs.get(message.toolCallId);
				if (args) group.updateArgs(args, message.toolCallId);
				component = group;
				this.#pendingTools.set(message.toolCallId, group);
			}
			component.updateResult(message, false, message.toolCallId);
			this.#pendingTools.delete(message.toolCallId);
			this.#readArgs.delete(message.toolCallId);
			this.#readToolCallAssistantComponents.delete(message.toolCallId);
			return;
		}

		if (!pending) return;
		pending.updateResult(message, backgroundStillRunning, message.toolCallId);
		if (backgroundStillRunning) return;
		this.#pendingTools.delete(message.toolCallId);

		if (message.toolName === "job" && pending instanceof ToolExecutionComponent && pending.isDisplaceableBlock()) {
			this.#waitingPoll = pending;
		} else if (
			message.toolName === "todo" &&
			pending instanceof ToolExecutionComponent &&
			pending.canBeDisplacedBy("todo")
		) {
			this.#resolveTodoSnapshot("todo");
			this.#todoSnapshot = pending;
		}
	}

	#appendCustomMessage(message: Extract<AgentMessage, { role: "custom" | "hookMessage" }>): Component[] {
		if (!message.display) return [];
		const block = toTranscriptBlock(message, { index: this.#container.children.length });

		// Specialized display takes precedence over extension renderers (matching production semantics)
		if (block.kind === "custom" || block.kind === "hook") {
			if (block.display !== undefined) {
				const component = createSpecializedCustomComponent(block.display, () => this.#expanded);
				if (isExpandable(component)) {
					this.#trackExpandable(component);
				}
				this.#container.addChild(component);
				if (block.display.variant === "irc") {
					return [component];
				}
				return [];
			}
		}

		const rawRenderer = this.deps.getMessageRenderer?.(message.customType);
		const renderCustom: CustomRenderCapability | undefined = rawRenderer
			? (opts, uiTheme) => rawRenderer(message as CustomMessage<unknown>, opts, uiTheme)
			: undefined;

		if (block.kind === "hook") {
			const component = new HookMessageComponent(block, renderCustom);
			this.#trackExpandable(component);
			this.#container.addChild(component);
			return [];
		}

		if (block.kind === "custom") {
			const component = new CustomMessageComponent(block, renderCustom);
			this.#trackExpandable(component);
			this.#container.addChild(component);
			return [];
		}

		return [];
	}

	#finalizeRebuild(): void {
		this.#finalizeRebuildState(this.deps.isStreaming?.() ?? false);
		this.#prefetchHighlights(this.#container.children);
		this.deps.requestRender();
	}

	/** Close what the rebuilt history left open: usage, read group, snapshots and unanswered calls. */
	#finalizeRebuildState(isStreaming: boolean): void {
		this.#flushPendingUsage();
		this.#readGroup?.seal();
		this.#resolveWaitingPoll();

		if (this.#todoSnapshot && isStreaming) {
			this.deps.onInheritDisplaceableTodo?.(this.#todoSnapshot);
			this.#todoSnapshot = null;
		} else {
			this.#resolveTodoSnapshot();
		}

		if (isStreaming) {
			for (const [toolCallId, component] of this.#pendingTools) {
				component.setArgsComplete(toolCallId);
			}
		} else {
			for (const [toolCallId, component] of this.#pendingTools) {
				if (this.#liveBackgroundCalls.has(toolCallId)) continue;
				component.seal();
				this.#settledToolCalls.add(toolCallId);
				this.#pendingTools.delete(toolCallId);
			}
		}
	}

	/**
	 * Highlight every source the rebuilt tool cards in `rows[from, end)` draw in one batch before the
	 * frame that draws them. The frame draws every card, and each card otherwise highlights its
	 * sources one after another on the render thread; the batch spreads them across threads.
	 */
	#prefetchHighlights(rows: readonly Component[], from = 0, end = rows.length): void {
		const requests: HighlightRequest[] = [];
		for (let index = from; index < end; index++) {
			const row = rows[index];
			if (row instanceof ToolExecutionComponent) row.highlightRequests(requests);
		}
		prefetchHighlights(requests);
	}
}
