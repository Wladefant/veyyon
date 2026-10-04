import type { Component } from "@veyyon/tui";
import { getSegmenter } from "@veyyon/utils/width";
import type { AssistantMessageView, AssistantSegment } from "@veyyon/wire/presentation";
import { LRUCache } from "lru-cache/raw";
import { formatThinkingForDisplay, hasDisplayableThinking } from "../../../utils/thinking-display";
import type { AssistantMessageComponent } from "../components/transcript/assistant-message";

export const STREAMING_REVEAL_FRAME_MS = 1000 / 30;
export const MIN_STEP = 3;
export const CATCHUP_FRAMES = 8;

/** The concrete streaming-reveal target is an {@link AssistantMessageComponent}; the
 *  Component intersection is what lets the reveal request component-scoped renders
 *  through {@link TUI.requestComponentRender} instead of forcing a full-tree walk. */
type StreamingRevealComponent = Pick<AssistantMessageComponent, "updateContent"> & Component;
type GraphemeSlicer = (index: number, text: string, units: number) => string;

type StreamingRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	getHideThinkingBlock(): boolean;
	getProseOnlyThinking(): boolean;
	/** Called after each reveal tick with the component whose subtree changed;
	 *  callers scope the render to that subtree (a full tree walk here at 30fps
	 *  costs 5% of CPU on its own and drives the Box/Container overhead that
	 *  cascades into another ~15% — see issue #4377). */
	requestRender(component: Component): void;
};

const graphemeCountCache = new LRUCache<string, number>({ max: 128 });

function countGraphemes(text: string): number {
	if (text.length === 0) return 0;
	const cached = graphemeCountCache.get(text);
	if (cached !== undefined) return cached;
	const count = walkGraphemes(text, 0, Number.POSITIVE_INFINITY).count;
	graphemeCountCache.set(text, count);
	return count;
}

/** Clusters walked by {@link walkGraphemes}: how many, where the last one starts, and where it ends. */
interface GraphemeWalk {
	count: number;
	lastStart: number;
	end: number;
}

/** Whether a cluster boundary falls between code units `at - 1` and `at`: two ASCII units always
 *  break apart except CR LF. Every unit an earlier character can join onto (a combining mark, a
 *  joiner, a variation selector) and every Prepend character is outside ASCII. */
function asciiBoundaryAt(text: string, at: number): boolean {
	const before = text.charCodeAt(at - 1);
	const after = text.charCodeAt(at);
	return before < 0x80 && after < 0x80 && !(before === 0x0d && after === 0x0a);
}

/**
 * Walk up to `limit` grapheme clusters of `text` from code-unit offset `start`, which must be a
 * cluster boundary. A run of ASCII is one cluster per unit and is walked without the segmenter;
 * the segmenter reads only the stretches around non-ASCII units, each cut at a boundary
 * {@link asciiBoundaryAt} proves, so every cluster comes out as a segmentation of the whole text
 * would draw it. Streamed prose is mostly ASCII, and segmenting all of it cost a reveal tick
 * 0.1ms per 3,000 characters.
 */
function walkGraphemes(text: string, start: number, limit: number): GraphemeWalk {
	const length = text.length;
	let count = 0;
	let lastStart = start;
	let end = start;
	let at = start;
	while (at < length && count < limit) {
		const unit = text.charCodeAt(at);
		if (unit < 0x80 && (at + 1 === length || asciiBoundaryAt(text, at + 1))) {
			count += 1;
			lastStart = at;
			at += 1;
			end = at;
			continue;
		}
		if (unit === 0x0d && text.charCodeAt(at + 1) === 0x0a && (at + 2 === length || asciiBoundaryAt(text, at + 2))) {
			count += 1;
			lastStart = at;
			at += 2;
			end = at;
			continue;
		}
		let stop = at + 1;
		while (stop < length && !asciiBoundaryAt(text, stop)) stop += 1;
		for (const seg of getSegmenter().segment(text.slice(at, stop))) {
			count += 1;
			lastStart = at + seg.index;
			end = lastStart + seg.segment.length;
			if (count >= limit) return { count, lastStart, end };
		}
		at = stop;
	}
	return { count, lastStart, end };
}

/** Memoizes per-block grapheme counts across reveal ticks. Streaming blocks only
 *  grow by appending, and an append can only alter the final grapheme cluster of
 *  the previous text, so only the suffix from that cluster needs re-segmenting. */
export class BlockUnitCounter {
	/** `base` is the text this entry extended, verified as its prefix when the entry was stored. */
	#entries = new Map<number, { text: string; count: number; lastStart: number; base: string | undefined }>();
	#sliceEntries = new Map<number, { text: string; units: number; end: number; lastStart: number }>();

	count(index: number, text: string): number {
		const entry = this.#entries.get(index);
		if (entry !== undefined) {
			if (entry.text === text) return entry.count;
			if (entry.count > 0 && text.length > entry.text.length && text.startsWith(entry.text)) {
				const tail = walkGraphemes(text, entry.lastStart, Number.POSITIVE_INFINITY);
				const next = { text, count: entry.count - 1 + tail.count, lastStart: tail.lastStart, base: entry.text };
				this.#entries.set(index, next);
				return next.count;
			}
		}
		const full = walkGraphemes(text, 0, Number.POSITIVE_INFINITY);
		this.#entries.set(index, { text, count: full.count, lastStart: full.lastStart, base: undefined });
		return full.count;
	}

	reset(): void {
		this.#entries.clear();
		this.#sliceEntries.clear();
	}
	/** Slice `text` to its first `units` graphemes. Memoized across reveal ticks:
	 *  streaming blocks grow only by appending and the reveal target advances
	 *  monotonically, so a previously sliced prefix is reused and only the suffix
	 *  from the boundary cluster is re-segmented. Only an exact (text, units) hit
	 *  skips segmentation entirely — an append can extend the boundary cluster, so
	 *  the incremental path still re-segments from that cluster's start. */
	slice(index: number, text: string, units: number): string {
		if (units <= 0 || text.length === 0) return "";
		const entry = this.#sliceEntries.get(index);
		if (entry !== undefined && entry.text === text && entry.units === units) {
			return entry.end >= text.length ? text : text.slice(0, entry.end);
		}
		if (entry !== undefined && units >= entry.units && this.#extends(index, entry.text, text)) {
			const extra = units - entry.units + 1;
			const seg = walkGraphemes(text, entry.lastStart, extra);
			this.#sliceEntries.set(index, { text, units, end: seg.end, lastStart: seg.lastStart });
			return seg.end >= text.length ? text : text.slice(0, seg.end);
		}
		const seg = walkGraphemes(text, 0, units);
		this.#sliceEntries.set(index, { text, units, end: seg.end, lastStart: seg.lastStart });
		return seg.end >= text.length ? text : text.slice(0, seg.end);
	}

	/** Whether `text` begins with `prefix`. A streamed block is counted before it is sliced, so the
	 *  count's own prefix check usually answers this without comparing the whole text again. */
	#extends(index: number, prefix: string, text: string): boolean {
		if (prefix === text) return true;
		const counted = this.#entries.get(index);
		if (counted !== undefined && counted.text === text && counted.base === prefix) return true;
		return text.startsWith(prefix);
	}
}

function sliceGraphemes(text: string, units: number): string {
	if (units <= 0 || text.length === 0) return "";
	const end = walkGraphemes(text, 0, units).end;
	return end >= text.length ? text : text.slice(0, end);
}

export function visibleUnits(message: AssistantMessageView, hideThinking: boolean, proseOnly = true): number {
	let total = 0;
	for (const segment of message.segments) {
		if (segment.kind === "text") {
			total += countGraphemes(segment.text);
		} else if (segment.kind === "thinking" && !hideThinking && !segment.redacted) {
			const rawThinking = segment.rawThinking ?? segment.text;
			const formatted = formatThinkingForDisplay(rawThinking, proseOnly);
			if (hasDisplayableThinking(rawThinking, formatted)) {
				total += countGraphemes(formatted);
			}
		}
	}
	return total;
}

function revealSegment<S extends Extract<AssistantSegment, { text: string }>>(
	segment: S,
	remaining: number,
	units: number,
	index: number,
	sliceOf: GraphemeSlicer,
): S {
	if (remaining <= 0) return segment.text.length === 0 ? segment : { ...segment, text: "" };
	if (remaining >= units) return segment;
	return { ...segment, text: sliceOf(index, segment.text, remaining) };
}

export function buildDisplayMessage(
	target: AssistantMessageView,
	revealed: number,
	hideThinking: boolean,
	proseOnly = true,
	countOf: (index: number, text: string) => number = (_index, text) => countGraphemes(text),
	sliceOf: GraphemeSlicer = (_index, text, units) => sliceGraphemes(text, units),
): AssistantMessageView {
	let remaining = Math.max(0, Math.floor(revealed));
	const segments: AssistantSegment[] = [];
	for (let i = 0; i < target.segments.length; i++) {
		const segment = target.segments[i]!;
		if (segment.kind === "text") {
			const units = countOf(i, segment.text);
			segments.push(revealSegment(segment, remaining, units, i, sliceOf));
			remaining = Math.max(0, remaining - units);
		} else if (segment.kind === "thinking" && !hideThinking && !segment.redacted) {
			const rawThinking = segment.rawThinking ?? segment.text;
			const formatted = formatThinkingForDisplay(rawThinking, proseOnly);
			if (hasDisplayableThinking(rawThinking, formatted)) {
				const units = countOf(i, formatted);
				const displaySegment: Extract<AssistantSegment, { kind: "thinking" }> = {
					...segment,
					text: formatted,
					rawThinking,
				};
				segments.push(revealSegment(displaySegment, remaining, units, i, sliceOf));
				remaining = Math.max(0, remaining - units);
			} else {
				segments.push(segment);
			}
		} else {
			segments.push(segment);
		}
	}
	return { ...target, segments };
}

export function nextStep(backlog: number): number {
	return Math.max(MIN_STEP, Math.ceil(Math.max(0, backlog) / CATCHUP_FRAMES));
}

export class StreamingRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #getHideThinkingBlock: () => boolean;
	readonly #getProseOnlyThinking: () => boolean;
	readonly #requestRender: (component: Component) => void;
	#target: AssistantMessageView | undefined;
	#component: StreamingRevealComponent | undefined;
	#timer: NodeJS.Timeout | undefined;
	#revealed = 0;
	/** The target changed since the component last rendered it. */
	#pending = false;
	#hideThinkingBlock = false;
	#proseOnlyThinking = true;
	#smoothStreaming = true;
	readonly #unitCounter = new BlockUnitCounter();
	readonly #countOf = (index: number, text: string): number => this.#unitCounter.count(index, text);
	readonly #sliceOf = (index: number, text: string, units: number): string =>
		this.#unitCounter.slice(index, text, units);

	constructor(options: StreamingRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#getHideThinkingBlock = options.getHideThinkingBlock;
		this.#getProseOnlyThinking = options.getProseOnlyThinking;
		this.#requestRender = options.requestRender;
	}
	#build(target: AssistantMessageView, revealed: number): AssistantMessageView {
		return buildDisplayMessage(
			target,
			revealed,
			this.#hideThinkingBlock,
			this.#proseOnlyThinking,
			this.#countOf,
			this.#sliceOf,
		);
	}

	begin(component: StreamingRevealComponent, message: AssistantMessageView): void {
		this.stop();
		this.#component = component;
		this.#target = message;
		this.#revealed = 0;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#smoothStreaming) {
			const total = this.#visibleUnits(message);
			component.updateContent(this.#build(message, total), { transient: true });
			return;
		}
		const total = this.#visibleUnits(message);
		if (message.segments.some(block => block.kind === "tool-call")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = total;
			component.updateContent(this.#build(message, this.#revealed), {
				transient: true,
			});
			return;
		}
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	setTarget(message: AssistantMessageView): void {
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#component) return;
		if (!this.#smoothStreaming) {
			const total = this.#visibleUnits(message);
			this.#pending = false;
			this.#component.updateContent(this.#build(message, total), { transient: true });
			return;
		}
		if (message.segments.some(block => block.kind === "tool-call")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = this.#visibleUnits(message);
			this.#pending = false;
			this.#stopTimer();
			this.#component.updateContent(this.#build(message, this.#revealed), {
				transient: true,
			});
			return;
		}
		// The revealed prefix only moves on a tick, so the next tick renders the
		// new target. Counting, slicing and rendering it here would repeat that
		// work for every provider delta between two frames.
		this.#pending = true;
		this.#startTimer();
	}

	stop(): void {
		this.#stopTimer();
		this.#target = undefined;
		this.#component = undefined;
		this.#revealed = 0;
		this.#pending = false;
		this.#unitCounter.reset();
	}

	/**
	 * Re-read cached visibility flags (hideThinkingBlock, proseOnlyThinking)
	 * and re-render the current target. Called when the thinking level changes
	 * mid-stream so the reveal controller doesn't keep rendering with stale values.
	 */
	resyncVisibility(): void {
		if (!this.#target || !this.#component) return;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		// Recalculate visible units — hiding thinking blocks may reduce the total,
		// and the reveal position may now exceed it.
		const total = this.#visibleUnits(this.#target);
		this.#revealed = Math.min(this.#revealed, total);
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	/** Total reveal units of `message`, memoized per block across ticks. */
	#visibleUnits(message: AssistantMessageView): number {
		let total = 0;
		for (let i = 0; i < message.segments.length; i++) {
			const segment = message.segments[i]!;
			if (segment.kind === "text") {
				total += this.#unitCounter.count(i, segment.text);
			} else if (segment.kind === "thinking" && !this.#hideThinkingBlock && !segment.redacted) {
				const rawThinking = segment.rawThinking ?? segment.text;
				const formatted = formatThinkingForDisplay(rawThinking, this.#proseOnlyThinking);
				if (hasDisplayableThinking(rawThinking, formatted)) {
					total += this.#unitCounter.count(i, formatted);
				}
			}
		}
		return total;
	}

	#renderCurrent(): void {
		if (!this.#target || !this.#component) return;
		// Every controller render is an in-flight streaming snapshot, even when
		// smooth reveal has temporarily caught up to the current target. The
		// message_end handler performs the only stable non-transient render.
		this.#pending = false;
		this.#component.updateContent(this.#build(this.#target, this.#revealed), { transient: true });
	}

	#syncTimer(total = this.#target ? this.#visibleUnits(this.#target) : 0): void {
		if (!this.#target || !this.#component || this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		this.#startTimer();
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick();
		}, STREAMING_REVEAL_FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		const target = this.#target;
		const component = this.#component;
		if (!target || !component) {
			this.stop();
			return;
		}
		const total = this.#visibleUnits(target);
		const advanced = this.#revealed < total;
		if (advanced) {
			this.#revealed = Math.min(total, this.#revealed + nextStep(total - this.#revealed));
		} else {
			// A target that shrank below the revealed prefix shows all of itself.
			this.#revealed = total;
		}
		if (advanced || this.#pending) {
			this.#pending = false;
			component.updateContent(this.#build(target, this.#revealed), {
				transient: true,
			});
			// A target that changed without revealing more is rendered for its
			// metadata and left to the next paint, as an in-place update would be.
			if (advanced) this.#requestRender(component);
		}
		if (this.#revealed >= total) {
			this.#stopTimer();
		}
	}
}
