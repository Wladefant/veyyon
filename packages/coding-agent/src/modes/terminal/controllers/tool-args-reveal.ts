import type { Component } from "@veyyon/tui";
import type { ArgotSession } from "argot";
import {
	clampSliceEnd,
	createStringExtractor,
	displayArgsForPrefix,
	initialDisplayArgs,
	resetDisplayState,
	type StreamingJsonStringExtractor,
	sameStringKeys,
} from "../../../tools/core/streamed-tool-args";
import { RevealFrameClock, RevealPacer } from "./streaming-reveal";

/** Minimal component surface the reveal pushes frames into. */
type ToolArgsRevealComponent = Component & {
	updateArgs(args: unknown, toolCallId?: string): void;
};

// Top-level string args a renderer reads mid-stream. The streamed-args decode
// reads these fields incrementally between throttled full-JSON parses so a
// long payload updates preview args at reveal cadence instead of stalling for
// STREAMING_JSON_PARSE_MIN_GROWTH bytes at a time. Nested-array modes (edit
// patch/replace `edits[].diff`) still fall through to the throttled parse.
// A tool with no entry previews its arguments from the throttled parse alone:
// past the first STREAMING_JSON_PARSE_MIN_GROWTH bytes an `ssh` command or a
// `browser` script advances in steps of that many bytes rather than per frame.
// `a-string-argument-the-preview-shows-streams-as-it-arrives.test.ts` builds
// every registered tool, renders its pending preview, and fails on a string
// argument the preview shows that no entry here decodes.
// `path`/`file_path` are here for two reasons that happen to want the same
// thing. A preview's TITLE is the path, and it arrived only when the throttled
// full parse first recovered it, so a long payload drew an untitled block for
// its opening bytes; `edit/renderer.ts` still carries a regex fallback that
// slices the path straight out of the raw buffer for exactly that window. And
// the extractor's values are argot-expanded while that raw slice is not, so a
// path carrying a handle rendered as the handle until the parse caught up.
// KEYED BY TOOL NAME, USED BY RENDERER. `tools/renderers.ts` binds one renderer
// object to several tool names, so a list written for one name silently leaves
// its siblings on the throttled parse and on the raw slice. `apply_patch` shares
// `editToolRenderer` with `edit` and was missing exactly that way: same renderer,
// same title path, same handle in the preview, no entry. The shared list is one
// const referenced twice rather than two lists that agree today, and
// `tool-args-reveal-keys-follow-the-renderer.test.ts` walks the renderer table and
// fails if any two names sharing a renderer stop sharing their keys.
const EDIT_RENDERER_STREAMING_KEYS: readonly string[] = ["path", "file_path", "input", "_input"];

export const STREAMING_STRING_KEYS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
	apply_patch: EDIT_RENDERER_STREAMING_KEYS,
	argot_load: ["folder_path"],
	argot_unload: ["folder_path"],
	bash: ["command", "cwd"],
	browser: ["name", "url", "code", "context", "storage_state"],
	checkpoint: ["goal"],
	debug: ["program"],
	edit: EDIT_RENDERER_STREAMING_KEYS,
	eval: ["code", "title"],
	github: ["repo", "pr", "branch", "run", "query"],
	goal: ["objective"],
	inspect_image: ["path", "question"],
	irc: ["to", "message", "from"],
	launch: ["op", "name", "application", "text", "pattern", "signal", "grep"],
	learn: ["memory", "context"],
	lsp: ["file", "query", "new_name"],
	manage_skill: ["name", "description", "body"],
	memory_edit: ["id", "content", "replacement_id"],
	read: ["path"],
	recall: ["query"],
	reflect: ["query"],
	report_finding: ["title"],
	report_tool_issue: ["tool", "report"],
	resolve: ["reason"],
	rewind: ["report"],
	search: ["input", "path"],
	search_tool_bm25: ["query"],
	set_cwd: ["path"],
	ssh: ["host", "command"],
	task: ["task", "name"],
	todo: ["task", "phase"],
	vibe_kill: ["session"],
	vibe_send: ["session", "message"],
	vibe_spawn: ["prompt", "name"],
	web_search: ["query"],
	write: ["path", "file_path", "content"],
	yield: ["type"],
};

/** String fields the streamed-args decode reads incrementally for `toolName`. */
export function streamingStringKeysForTool(toolName: string, rawInput: boolean): readonly string[] | undefined {
	if (rawInput) return undefined;
	return STREAMING_STRING_KEYS_BY_TOOL[toolName];
}
type ToolArgsRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	/** Called after each reveal tick with the component whose subtree changed;
	 *  callers scope the render to that subtree instead of forcing a full-tree
	 *  walk at 30fps (issue #4377). */
	requestRender(component: Component): void;
};

type RevealEntry = {
	component: ToolArgsRevealComponent | undefined;
	/** Latest raw streamed argument text (JSON for function tools, raw text for custom tools). */
	target: string;
	/** Revealed UTF-16 code units of `target`. */
	revealed: number;
	/** Paces `revealed` toward `target` at the rate the stream arrives. */
	pacer: RevealPacer;
	/** Custom-tool raw input: display args are `{ input: prefix }`, never parsed as JSON. */
	rawInput: boolean;
	/** Whether the renderer observes fresh raw JSON prefixes directly. */
	exposeRawPartialJson: boolean;
	/** Last parsed JSON args from the revealed prefix. */
	parsedArgs: Record<string, unknown>;
	/** Prefix length covered by `parsedArgs`. */
	parsedLen: number;
	/** Last object handed to a component; reused when visible args have not changed. */
	displayArgs: Record<string, unknown>;
	/** Raw prefix carried by `displayArgs.__partialJson`. */
	displayPrefix: string;
	/** JSON string fields decoded incrementally between full JSON parses. */
	streamingStringKeys: readonly string[];
	stringExtractor: StreamingJsonStringExtractor | undefined;
	/** The session's argot codec, when one is armed. See {@link StreamedToolArgsSource.argot}. */
	argot: ArgotSession | undefined;
};

export type ToolArgsRevealTarget = {
	rawInput: boolean;
	exposeRawPartialJson: boolean;
	streamingStringKeys?: readonly string[];
	/** The session's argot codec, when one is armed. See {@link StreamedToolArgsSource.argot}. */
	argot?: ArgotSession;
};

/**
 * Paces streamed tool-call arguments the same way StreamingRevealController
 * paces assistant text: providers that deliver `partialJson` in large batches
 * (or throttle their partial parses) would otherwise make write/edit/bash
 * streaming previews jump in chunks. Each pending tool call reveals its raw
 * argument stream at the shared 30fps cadence through its own {@link RevealPacer}.
 * JSON prefixes are parsed only when enough new bytes arrive to
 * change renderer-visible fields, while raw-prefix consumers still receive
 * fresh `__partialJson` on every reveal frame.
 *
 * Reveal units are UTF-16 code units of the raw stream, not graphemes —
 * the prefix goes through a JSON parser rather than straight to the screen,
 * so only surrogate-pair integrity matters (see {@link clampSliceEnd}).
 */
export class ToolArgsRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #requestRender: (component: Component) => void;
	readonly #entries = new Map<string, RevealEntry>();
	readonly #clock = new RevealFrameClock(() => this.#tick());

	constructor(options: ToolArgsRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#requestRender = options.requestRender;
	}

	/**
	 * Record the latest streamed argument text for a tool call and return the
	 * args to render right now. With smoothing disabled nothing is paced — the
	 * full received buffer decodes in one step — but the entry still runs the
	 * incremental string decoder + parse throttle, so streamed text fields
	 * (write `content`, edit bodies, eval `code`) stay fresh between the
	 * provider's own throttled full-JSON parses instead of lagging up to
	 * STREAMING_JSON_PARSE_MIN_GROWTH bytes behind.
	 */
	setTarget(id: string, partialJson: string, target: ToolArgsRevealTarget): Record<string, unknown> {
		const { rawInput, exposeRawPartialJson, streamingStringKeys, argot } = target;
		const now = performance.now();
		let entry = this.#entries.get(id);
		if (!entry) {
			entry = {
				component: undefined,
				target: partialJson,
				revealed: clampSliceEnd(partialJson, partialJson.length),
				pacer: new RevealPacer(),
				rawInput,
				exposeRawPartialJson,
				parsedArgs: {},
				parsedLen: 0,
				displayArgs: initialDisplayArgs(),
				displayPrefix: "",
				streamingStringKeys: streamingStringKeys ?? [],
				stringExtractor: createStringExtractor(streamingStringKeys),
				argot,
			};
			this.#entries.set(id, entry);
		} else {
			if (
				entry.rawInput !== rawInput ||
				entry.exposeRawPartialJson !== exposeRawPartialJson ||
				!sameStringKeys(entry.streamingStringKeys, streamingStringKeys)
			) {
				entry.rawInput = rawInput;
				entry.exposeRawPartialJson = exposeRawPartialJson;
				resetDisplayState(entry);
				entry.streamingStringKeys = streamingStringKeys ?? [];
				entry.stringExtractor = createStringExtractor(streamingStringKeys);
			}
			// The codec is armed once per session but the entry outlives a settings
			// change, so it is refreshed rather than captured at creation.
			entry.argot = argot;
			// Streams only append; a non-prefix target means a rewind — snap into range.
			if (!partialJson.startsWith(entry.target)) {
				entry.revealed = Math.min(entry.revealed, partialJson.length);
				resetDisplayState(entry);
			}
			entry.target = partialJson;
		}
		entry.pacer.arrive(now, partialJson.length, entry.revealed);
		// Toggle may flip mid-call: snap the reveal to everything received so
		// pacing stops (and never restarts while the toggle stays off).
		if (!this.#getSmoothStreaming()) entry.revealed = entry.target.length;
		entry.revealed = clampSliceEnd(entry.target, entry.revealed);
		this.#syncTimer();
		return displayArgsForPrefix(entry, entry.target.slice(0, entry.revealed)).args;
	}

	/** Attach the component future ticks push frames into. */
	bind(id: string, component: ToolArgsRevealComponent): void {
		const entry = this.#entries.get(id);
		if (entry) entry.component = component;
	}

	/** Final arguments arrived (the JSON closed): drop the reveal so the
	 *  caller's final-args render wins immediately, mirroring how assistant
	 *  text snaps to the full message at message_end. */
	finish(id: string): void {
		this.#entries.delete(id);
		if (this.#entries.size === 0) this.#clock.stop();
	}

	/** Snap every live entry to its full received stream and clear. Used at
	 *  message_end (abort/error mid-stream) so sealed components freeze showing
	 *  everything that arrived rather than a mid-reveal prefix. */
	flushAll(): void {
		for (const [id, entry] of this.#entries) {
			if (entry.component && entry.revealed < entry.target.length) {
				entry.component.updateArgs(displayArgsForPrefix(entry, entry.target, true).args, id);
			}
		}
		this.#entries.clear();
		this.#clock.stop();
	}

	/** Clear without pushing (teardown). */
	stop(): void {
		this.#entries.clear();
		this.#clock.stop();
	}

	#syncTimer(): void {
		for (const entry of this.#entries.values()) {
			if (entry.revealed < entry.target.length) {
				this.#clock.start();
				return;
			}
		}
		this.#clock.stop();
	}

	#tick(): void {
		const now = performance.now();
		let backlogged = false;
		// Collect components with changed display args; render each subtree once
		// per tick even when multiple entries share a component (they don't
		// today, but the API contract doesn't prevent it).
		const rendered = new Set<ToolArgsRevealComponent>();
		for (const [id, entry] of this.#entries) {
			const backlog = entry.target.length - entry.revealed;
			if (backlog <= 0 || !entry.component) continue;
			const step = entry.pacer.step(now, backlog);
			if (step > 0) {
				entry.revealed = clampSliceEnd(entry.target, entry.revealed + step);
				const display = displayArgsForPrefix(entry, entry.target.slice(0, entry.revealed));
				if (display.changed) {
					entry.component.updateArgs(display.args, id);
					rendered.add(entry.component);
				}
			}
			if (entry.revealed < entry.target.length) backlogged = true;
		}
		for (const component of rendered) this.#requestRender(component);
		// Every entry caught up (or unbound); setTarget restarts on growth.
		if (!backlogged) this.#clock.stop();
	}
}
