/**
 * Concise markdown transcript serializer for `history://` URLs.
 *
 * Unlike `session-dump-format.ts` (verbose `/dump` export), this emits a
 * compressed transcript: full user/assistant/developer text, tool call +
 * result pairs collapsed to single lines, thinking elided, custom messages
 * as one-liners. No system prompt, no tool catalog, no config sections.
 */
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, VideoContent } from "@veyyon/ai";
// Owners, not the `@veyyon/utils` barrel: 3 modules against 74.
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { contentText } from "@veyyon/utils/content-text";
import { formatCount, truncate } from "@veyyon/utils/format";
import { escapeXmlText } from "@veyyon/utils/sanitize-text";
import { INTENT_FIELD } from "@veyyon/wire";
import type { BashExecutionMessage, PythonExecutionMessage } from "../tools/shell/execution-messages";
import type {
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
	FileMentionMessage,
	HookMessage,
} from "./messages";
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_INDEX_ENTRIES = 100_000;

export interface HistoryFormatOptions {
	/** Optional H1 prepended to the transcript. */
	title?: string;
	/** Render assistant thinking blocks (default: elided). */
	includeThinking?: boolean;
	/** Render tool intent comment before tool call lines. */
	includeToolIntent?: boolean;
	/** Render watched-session roles as inline `**agent**:` / `**user**:` labels (collapsing consecutive same-role messages) instead of `## ` headings, so a primary transcript embedded inside an advisor turn stays visually distinct. */
	watchedRoles?: boolean;
	/**
	 * Expand the primary agent's injected constraint context — plan mode's rules
	 * (`plan-mode-context`) and the approved plan it implements
	 * (`plan-mode-reference`) — verbatim instead of as a truncated one-liner,
	 * wrapped in a `<primary-context>` tag so a reviewer reads it as the primary's
	 * instructions, not its own. The advisor sets this: a truncated rule (plan
	 * mode's "NEVER create files … except the plan file") makes it raise false
	 * blockers. See {@link PRIMARY_CONTEXT_CUSTOM_TYPES}. Other custom messages
	 * still collapse to a one-liner.
	 */
	expandPrimaryContext?: boolean;
	/**
	 * Append the full unified diff (from a tool result's `details.diff`) below
	 * edit/apply_patch tool lines, instead of just the path. The advisor sets
	 * this so it sees what changed without re-reading the file.
	 */
	expandEditDiffs?: boolean;
}

/** Max length of the primary-arg summary inside `→ tool(...)` lines. */
const PRIMARY_ARG_MAX = 120;

/** Per-tool preference order for the most informative scalar argument. */
const PRIMARY_ARG_KEYS = [
	"path",
	"file_path",
	"filePath",
	"command",
	"cmd",
	"pattern",
	"url",
	"query",
	"prompt",
	"assignment",
	"note",
	"message",
	"op",
	"name",
	"id",
] as const;

/** Collapse whitespace runs and truncate to `max` chars with an ellipsis. */
function oneLine(text: string, max = PRIMARY_ARG_MAX): string {
	if (text.length > max * 4) {
		let start = 0;
		const searchLimit = Math.min(text.length, 1024);
		while (start < searchLimit && text.charCodeAt(start) <= 32) {
			start++;
		}
		text = text.slice(start, start + max * 4);
	}
	return truncate(collapseWhitespace(text), max);
}

/** Join the text blocks of a string-or-blocks content field. Images become `[image]`. */
// This view renders image blocks as an "[image]" placeholder rather than
// dropping them, so the reader sees that an image was present.
const contentToText = (content: string | readonly (TextContent | ImageContent | VideoContent)[]): string =>
	contentText(content, { image: "[image]" });

function lineCount(text: string): number {
	if (!text) return 0;
	let count = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) count++;
	}
	return count;
}
async function preflightContentBytes(
	content: unknown,
	maxBytes = MAX_RECORD_BYTES,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	if (typeof content === "string") {
		if (content.length > maxBytes) {
			throw new Error(`Session history formatting exceeded the ${maxBytes} byte output cap`);
		}
	} else if (Array.isArray(content)) {
		let total = 0;
		for (let i = 0; i < content.length; i++) {
			if ((i & 255) === 0) {
				await yieldToEventLoop();
				signal?.throwIfAborted();
			}
			const part = content[i];
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
				total += part.text.length + 1;
				if (total > maxBytes) {
					throw new Error(`Session history formatting exceeded the ${maxBytes} byte output cap`);
				}
			}
		}
	}
}

function* extractFirstLinePreview(text: string, max = PRIMARY_ARG_MAX): Generator<void, string> {
	let start = 0;
	let scanned = 0;
	const CHUNK = 32_768;
	while (start < text.length && text.charCodeAt(start) <= 32) {
		if (text.charCodeAt(start) === 10) break;
		start++;
		scanned++;
		if ((scanned & (CHUNK - 1)) === 0) yield;
	}
	if (start >= text.length || text.charCodeAt(start) === 10) {
		return "";
	}
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 10 && end - start < max * 4) {
		end++;
	}
	return oneLine(text.slice(start, end), max);
}


function* scanTextLines(text: string): Generator<void, number> {
	if (!text) return 0;
	let count = 1;
	const CHUNK_SIZE = 32_768;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) count++;
		if (((i + 1) & (CHUNK_SIZE - 1)) === 0) yield;
	}
	return count;
}

function* summarizeToolResult(
	result: ToolResultMessage,
): Generator<void, { lines: number; firstLine?: string }> {
	const content = result.content;
	if (!content) return { lines: 0 };
	let lines = 1;
	let firstLine: string | undefined;
	const CHUNK_SIZE = 32_768;
	let scanned = 0;

	const rawContent: unknown = result.content;
	if (typeof rawContent === "string") {
		if (result.isError) {
			firstLine = yield* extractFirstLinePreview(rawContent);
		}
		for (let i = 0; i < rawContent.length; i++) {
			if (rawContent.charCodeAt(i) === 10) lines++;
			scanned++;
			if ((scanned & (CHUNK_SIZE - 1)) === 0) yield;
		}
		return { lines, firstLine };
	}

	let firstLineFound = !result.isError;
	for (const block of content) {
		if (block.type === "text") {
			const text = block.text;
			if (!firstLineFound) {
				firstLine = yield* extractFirstLinePreview(text);
				firstLineFound = true;
			}
			for (let i = 0; i < text.length; i++) {
				if (text.charCodeAt(i) === 10) lines++;
				scanned++;
				if ((scanned & (CHUNK_SIZE - 1)) === 0) yield;
			}
		} else if (block.type === "image") {
			if (!firstLineFound) {
				firstLine = "[image]";
				firstLineFound = true;
			}
		}
	}
	return { lines, firstLine };
}

function primaryArgValue(value: unknown, maxChars = PRIMARY_ARG_MAX * 4): string {
	if (typeof value === "string" && value.length > 0) {
		return value.length > maxChars ? value.slice(0, maxChars) : value;
	}
	if (Array.isArray(value) && value.length > 0) {
		let joined = "";
		for (let i = 0; i < value.length && joined.length < maxChars; i++) {
			const item = value[i];
			if (typeof item !== "string") return "";
			const slice = item.length > maxChars ? item.slice(0, maxChars) : item;
			joined = joined ? `${joined}, ${slice}` : slice;
		}
		return joined;
	}
	return "";
}

/** Pick the most informative scalar argument of a tool call. */
function primaryArg(name: string, args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";
	// Advisor note is the most informative summary; preserve severity too.
	if (name === "advise") {
		const note = primaryArgValue(args.note);
		const severity = primaryArgValue(args.severity);
		if (note && severity) return oneLine(`${severity}: ${note}`);
		if (note) return oneLine(note);
		if (severity) return oneLine(severity);
	}
	if (name === "search") {
		const type = primaryArgValue(args.type);
		const input = primaryArgValue(args.input);
		const path = primaryArgValue(args.path);
		if (type && input && path) return oneLine(`${type}: ${input} @ ${path}`);
		if (type && input) return oneLine(`${type}: ${input}`);
		if (input) return oneLine(input);
	}
	for (const key of PRIMARY_ARG_KEYS) {
		const value = args[key];
		const summary = primaryArgValue(value);
		if (summary) return oneLine(summary);
	}
	// Fallback: first non-intent string arg, then a compact JSON of the args.
	const rest: Record<string, unknown> = {};
	let restCount = 0;
	for (const key in args) {
		if (key === INTENT_FIELD) continue;
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return oneLine(primaryArgValue(value));
		if (restCount < 16) {
			rest[key] = typeof value === "string" && value.length > 256 ? value.slice(0, 256) : value;
		}
		restCount++;
		if (restCount > 32) break;
	}
	if (restCount === 0) return "{}";
	try {
		return oneLine(JSON.stringify(rest));
	} catch {
		return oneLine(`{unserializable: ${Object.keys(rest).slice(0, 8).join(", ")}}`);
	}
}

/**
 * Wrap a diff body in a backtick fence sized to outlast the longest backtick
 * run inside it, so a diff that touches markdown (triple backticks) can't break
 * out of the fence. Info string `diff` for syntax highlighting.
 */
function fenceDiff(diff: string): string {
	const longest = diff.match(/`+/g)?.reduce((m, run) => Math.max(m, run.length), 0) ?? 0;
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}diff\n${diff}\n${fence}`;
}

/** One line per tool call: `→ read(src/foo.ts:50-80) ⇒ ok · 31 lines`. */
function* toolCallLine(
	name: string,
	args: Record<string, unknown> | undefined,
	result: ToolResultMessage | undefined,
	includeToolIntent?: boolean,
	expandEditDiffs?: boolean,
): Generator<void, string> {
	const head = `→ ${name}(${primaryArg(name, args)})`;
	let base: string;
	if (!result) {
		base = `${head} ⇒ pending`;
	} else {
		const { lines, firstLine } = yield* summarizeToolResult(result);
		const count = formatCount("line", lines);
		if (result.isError) {
			base = firstLine ? `${head} ⇒ error · ${count} — ${firstLine}` : `${head} ⇒ error · ${count}`;
		} else {
			base = `${head} ⇒ ok · ${count}`;
		}
	}

	if (expandEditDiffs) {
		const diff = (result?.details as { diff?: unknown } | undefined)?.diff;
		if (typeof diff === "string" && diff.trim()) {
			base = `${base}\n${fenceDiff(diff)}`;
		}
	}

	const intent = includeToolIntent ? args?.[INTENT_FIELD] : undefined;
	if (typeof intent === "string" && intent.trim()) {
		const formattedIntent = oneLine(intent, 80);
		return `// ${formattedIntent}\n${base}`;
	}
	return base;
}

/** One line for a user-initiated `!`/`$` execution. */
function* executionLine(
	kind: "bash" | "python",
	source: string,
	msg: BashExecutionMessage | PythonExecutionMessage,
): Generator<void, string> {
	const status = msg.cancelled
		? "cancelled"
		: msg.exitCode !== undefined && msg.exitCode !== 0
			? `error · exit ${msg.exitCode}`
			: "ok";
	const lines = yield* scanTextLines(msg.output);
	return `→ ${kind}! ${oneLine(source)} ⇒ ${status} · ${formatCount("line", lines)}`;
}

/**
 * Hidden custom messages that inject the primary agent's operative *constraints*
 * — plan mode's rules and the approved plan it implements. A reviewer (the
 * advisor) must read these verbatim; truncating them hides load-bearing
 * exceptions (e.g. plan mode permits exactly one plan file). Every other custom
 * type stays a one-liner.
 *
 * Deliberately excludes `goal-mode-context`: its body carries live budget
 * counters (tokens/seconds used) that change every turn, so it can neither be
 * deduped against a prior copy nor expanded each turn without flooding the
 * reviewer — and its constraints don't drive the file-write misreads this
 * targets.
 */
export const PRIMARY_CONTEXT_CUSTOM_TYPES: ReadonlySet<string> = new Set(["plan-mode-context", "plan-mode-reference"]);

/** Hidden non-primary custom messages whose content is needed to understand visible transcript entries. */
const CONTEXTUAL_NON_PRIMARY_HIDDEN_CUSTOM_TYPES: Record<string, true> = {
	"image-attachment-description": true,
};

/** One-liner for custom/hook messages: `[irc] A → B: body…`. */
function customOneLiner(msg: CustomMessage | HookMessage): string {
	const details = (msg.details ?? {}) as Record<string, unknown>;
	const str = (key: string): string => (typeof details[key] === "string" ? (details[key] as string) : "");
	switch (msg.customType) {
		case "irc:incoming":
			return `[irc] ${str("from") || "?"} → me: ${oneLine(str("message"))}`;
		case "irc:relay":
			return `[irc] ${str("from") || "?"} → ${str("to") || "?"}: ${oneLine(str("body"))}`;
		case "async-result": {
			const jobs = Array.isArray(details.jobs) && details.jobs.length > 0 ? details.jobs : [details];
			const labels = jobs
				.map(job => {
					const j = (job ?? {}) as Record<string, unknown>;
					return typeof j.label === "string" && j.label ? j.label : typeof j.jobId === "string" ? j.jobId : "job";
				})
				.join(", ");
			return `[async-result] ${oneLine(labels)}`;
		}
		default:
			return `[${msg.customType}] ${oneLine(contentToText(msg.content))}`;
	}
}

/**
 * Format a session's message array as a concise markdown transcript.
 *
 * `messages` is the session's in-memory message array (or the read-only
 * equivalent loaded from a session file) — the same shapes
 * `session-dump-format.ts` consumes.
 */
function* historyMarkdownSteps(messages: unknown[], opts?: HistoryFormatOptions): Generator<string | void, void> {
	const typed = (messages ?? []) as AgentMessage[];
	if (opts?.title) {
		yield `# ${opts.title}`;
		yield "";
	}

	// Index tool results by call id so each toolCall collapses to one line.
	const resultsByCallId = new Map<string, ToolResultMessage>();
	for (const msg of typed) {
		yield;
		if (msg.role === "toolResult") {
			resultsByCallId.set(msg.toolCallId, msg);
		}
	}
	const consumed = new Set<string>();
	let lastWatchedLabel: string | undefined;

	for (const msg of typed) {
		yield;
		switch (msg.role) {
			case "user":
			case "developer": {
				const text = contentToText(msg.content);
				if (!text.trim()) break;
				if (opts?.watchedRoles) {
					const label = `**${msg.role}**:`;
					if (lastWatchedLabel === label) {
						yield text;
						yield "";
					} else {
						yield label;
						yield text;
						yield "";
						lastWatchedLabel = label;
					}
				} else {
					yield `## ${msg.role}`;
					yield "";
					yield text;
					yield "";
				}
				break;
			}
			case "assistant": {
				const assistantMsg = msg as AssistantMessage;
				let headerEmitted = false;
				for (const block of assistantMsg.content) {
					yield;
					let line: string | undefined;
					if (block.type === "text") {
						if (block.text.trim()) line = block.text;
					} else if (block.type === "toolCall") {
						const result = resultsByCallId.get(block.id);
						if (result) consumed.add(block.id);
						line = yield* toolCallLine(
							block.name,
							block.arguments,
							result,
							opts?.includeToolIntent,
							opts?.expandEditDiffs,
						);
					} else if (opts?.includeThinking && block.type === "thinking" && block.thinking.trim()) {
						line = `_thinking:_ ${block.thinking}`;
					}
					if (line) {
						if (!headerEmitted) {
							headerEmitted = true;
							if (opts?.watchedRoles) {
								const label = "**agent**:";
								if (lastWatchedLabel !== label) {
									yield label;
									lastWatchedLabel = label;
								}
							} else {
								yield "## assistant";
								yield "";
							}
						}
						yield line;
					}
				}
				if (headerEmitted) {
					yield "";
				}
				break;
			}
			case "toolResult": {
				if (consumed.has(msg.toolCallId)) break;
				const line = yield* toolCallLine(msg.toolName, undefined, msg, opts?.includeToolIntent, opts?.expandEditDiffs);
				yield line;
				yield "";
				lastWatchedLabel = undefined;
				break;
			}
			case "bashExecution": {
				const bashMsg = msg as BashExecutionMessage;
				if (bashMsg.excludeFromContext) break;
				const line = yield* executionLine("bash", bashMsg.command, bashMsg);
				yield line;
				yield "";
				lastWatchedLabel = undefined;
				break;
			}
			case "pythonExecution": {
				const pythonMsg = msg as PythonExecutionMessage;
				if (pythonMsg.excludeFromContext) break;
				const line = yield* executionLine("python", pythonMsg.code, pythonMsg);
				yield line;
				yield "";
				lastWatchedLabel = undefined;
				break;
			}
			case "custom":
			case "hookMessage": {
				const custom = msg as CustomMessage | HookMessage;
				if (
					custom.display === false &&
					!PRIMARY_CONTEXT_CUSTOM_TYPES.has(custom.customType) &&
					CONTEXTUAL_NON_PRIMARY_HIDDEN_CUSTOM_TYPES[custom.customType] !== true
				) {
					break;
				}
				if (opts?.expandPrimaryContext && PRIMARY_CONTEXT_CUSTOM_TYPES.has(custom.customType)) {
					const text = contentToText(custom.content).trim();
					if (text) {
						yield `<primary-context kind="${custom.customType}">`;
						yield escapeXmlText(text);
						yield "</primary-context>";
						yield "";
					}
				} else {
					yield customOneLiner(custom);
					yield "";
				}
				lastWatchedLabel = undefined;
				break;
			}
			case "branchSummary": {
				const branchMsg = msg as BranchSummaryMessage;
				yield `[branch] from ${branchMsg.fromId}: ${oneLine(branchMsg.summary)}`;
				yield "";
				lastWatchedLabel = undefined;
				break;
			}
			case "compactionSummary": {
				const compactMsg = msg as CompactionSummaryMessage;
				yield `[compaction] ${oneLine(compactMsg.summary)}`;
				yield "";
				lastWatchedLabel = undefined;
				break;
			}
			case "fileMention": {
				const fileMsg = msg as FileMentionMessage;
				yield `[file-mention] ${oneLine(fileMsg.files.map(f => f.path).join(", "))}`;
				yield "";
				lastWatchedLabel = undefined;
				break;
			}
		}
	}
}

export function formatSessionHistoryMarkdown(messages: unknown[], opts?: HistoryFormatOptions): string {
	const steps = historyMarkdownSteps(messages, opts);
	const lines: string[] = [];
	let step = steps.next();
	while (!step.done) {
		if (typeof step.value === "string") {
			lines.push(step.value);
		}
		step = steps.next();
	}
	return `${lines.join("\n").trim()}\n`;
}

/** Yield between rendering batches so cancellation and deadline timers can run. */
export async function formatSessionHistoryMarkdownAsync(
	messages: unknown[],
	opts?: HistoryFormatOptions,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const rawMessages: unknown = messages;
	let msgCount = 0;
	if (Array.isArray(rawMessages)) {
		msgCount = rawMessages.length;
	} else if (rawMessages && typeof rawMessages === "object" && "length" in rawMessages && typeof rawMessages.length === "number") {
		msgCount = rawMessages.length;
	}
	if (msgCount > MAX_INDEX_ENTRIES) {
		throw new Error(`Session history formatting exceeded the ${MAX_INDEX_ENTRIES} message entry cap`);
	}

	for (let mi = 0; mi < (Array.isArray(messages) ? messages.length : 0); mi++) {
		if ((mi & 255) === 0) {
			await yieldToEventLoop();
			signal?.throwIfAborted();
		}
		const msg = (messages as AgentMessage[])[mi]!;
		if (!msg || typeof msg !== "object") continue;
		if ("content" in msg) {
			await preflightContentBytes(msg.content, MAX_RECORD_BYTES, signal);
		}
		if (msg.role === "assistant" && Array.isArray((msg as AssistantMessage).content)) {
			let totalAssistantText = 0;
			const blocks = (msg as AssistantMessage).content;
			for (let bi = 0; bi < blocks.length; bi++) {
				if ((bi & 255) === 0) {
					await yieldToEventLoop();
					signal?.throwIfAborted();
				}
				const block = blocks[bi];
				if (!block || typeof block !== "object") continue;
				if (block.type === "text" && typeof block.text === "string") {
					totalAssistantText += block.text.length;
				} else if (opts?.includeThinking && block.type === "thinking" && typeof block.thinking === "string") {
					totalAssistantText += block.thinking.length;
				}
				if (totalAssistantText > MAX_RECORD_BYTES) {
					throw new Error(`Session history formatting exceeded the ${MAX_RECORD_BYTES} byte output cap`);
				}
			}
		}
	}
	const steps = historyMarkdownSteps(messages, opts);
	const lines: string[] = [];
	let totalOutputBytes = 0;
	let count = 0;
	let step = steps.next();
	while (!step.done) {
		signal?.throwIfAborted();
		if (typeof step.value === "string") {
			const line = step.value;
			totalOutputBytes += Buffer.byteLength(line, "utf8") + 1;
			if (totalOutputBytes > MAX_RECORD_BYTES) {
				throw new Error(`Session history formatting exceeded the ${MAX_RECORD_BYTES} byte output cap`);
			}
			lines.push(line);
		}
		if (++count % 64 === 0) {
			await yieldToEventLoop();
			signal?.throwIfAborted();
		}
		step = steps.next();
	}
	signal?.throwIfAborted();
	await yieldToEventLoop();
	signal?.throwIfAborted();
	if (totalOutputBytes > MAX_RECORD_BYTES) {
		throw new Error(`Session history formatting exceeded the ${MAX_RECORD_BYTES} byte output cap`);
	}
	return `${lines.join("\n").trim()}\n`;
}
