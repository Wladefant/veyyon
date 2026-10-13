/**
 * Refusal of a read whose output the model can still see.
 *
 * A read is refused when every row it would display is already displayed, byte for byte under the
 * same section header, by an earlier `read` result that is still in the agent's live context. The
 * header's snapshot tag is a 16-bit index of whitespace-normalized text, not the file's identity, so
 * the rows themselves are the proof: a tag collision or a trailing-whitespace edit that changes a
 * requested line changes its row and the read is delivered. The check reads the live messages at call
 * time and keeps no history of its own: a result that was pruned, shaken out, deduplicated or
 * summarized away by compaction no longer carries its numbered rows, so it stops counting the moment
 * the model stops seeing it.
 *
 * The refusal is appended as a new short result. Nothing earlier in the conversation is rewritten,
 * so the cached prompt prefix is untouched, and compaction's supersede pruning does not treat the
 * refusal as a newer read of the file (`supersedeTargets` in `@veyyon/agent-core/compaction`).
 */
import type { AgentMessage, AgentToolResult } from "@veyyon/agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@veyyon/ai";
import { HASHLINE_LINE_PREFIX } from "../../edit/file-snapshot-store";
import type { ToolSession } from "../../sdk";
import { resolveToCwd, splitPathAndSel } from "../core/path-utils";
import { toolResult } from "../core/tool-result";
import type { ReadToolDetails } from "./read-types";

/** A hashline section header on its own line: `[name#1A2B]`. */
const SECTION_HEADER = /^\[[^\]\n]+#[0-9A-F]{4}\]$/;

/**
 * The numbered rows each hashline section of `text` displays, keyed by its header line.
 *
 * A section is its header and the non-empty lines that follow it. Every row a hashline body
 * displays is non-empty (an empty file line renders as `N:`), and a delimited read joins its parts
 * with a blank line, so a section ends at the first empty line and a later `:raw` part can never
 * lend its rows to the section before it. Lines without a row prefix (truncation and continuation
 * notices) are not rows.
 */
function displayedRowsBySection(text: string): Map<string, Set<string>> {
	const sections = new Map<string, Set<string>>();
	let rows: Set<string> | undefined;
	for (const line of text.split("\n")) {
		if (SECTION_HEADER.test(line)) {
			rows = sections.get(line);
			if (!rows) {
				rows = new Set();
				sections.set(line, rows);
			}
		} else if (line.length === 0) {
			rows = undefined;
		} else if (rows && HASHLINE_LINE_PREFIX.test(line)) {
			rows.add(line);
		}
	}
	return sections;
}

function resultText(content: readonly (TextContent | ImageContent)[]): string {
	let text = "";
	for (const block of content) {
		if (block.type !== "text") continue;
		text = text.length > 0 ? `${text}\n\n${block.text}` : block.text;
	}
	return text;
}

/** Whether an earlier read result displayed `absolutePath`: its own source, or one of its delimited targets. */
function resultReadsPath(details: ReadToolDetails | undefined, absolutePath: string, cwd: string): boolean {
	if (!details) return false;
	const source = details.meta?.source;
	if (source?.type === "path") return source.value === absolutePath;
	for (const target of details.displayReadTargets ?? []) {
		try {
			if (resolveToCwd(splitPathAndSel(target).path, cwd) === absolutePath) return true;
		} catch {
			// An internal URL or a malformed entry names no file on disk.
		}
	}
	return false;
}

function isLiveReadResult(message: AgentMessage): message is ToolResultMessage<ReadToolDetails> {
	return (
		message.role === "toolResult" &&
		message.toolName === "read" &&
		message.isError !== true &&
		message.prunedAt === undefined
	);
}

/** The rows visible read results of `absolutePath` display under `header`. */
function rowsStillInContext(
	messages: readonly AgentMessage[],
	absolutePath: string,
	header: string,
	cwd: string,
): Set<string> {
	const visible = new Set<string>();
	for (const message of messages) {
		if (!isLiveReadResult(message) || !resultReadsPath(message.details, absolutePath, cwd)) continue;
		const rows = displayedRowsBySection(resultText(message.content)).get(header);
		if (rows) for (const row of rows) visible.add(row);
	}
	return visible;
}

/**
 * The refusal for `result` when every row it displays is still in context, or
 * `undefined` to deliver `result` as read.
 *
 * `result` is a finished single-file read of `absolutePath`. A read with no hashline header (raw,
 * binary, an image, line-number or plain display mode) carries no snapshot tag to prove the file is
 * unchanged, and is never refused.
 */
export function refuseReadStillInContext(
	session: ToolSession,
	result: AgentToolResult<ReadToolDetails>,
	absolutePath: string,
	requestedPath: string,
): AgentToolResult<ReadToolDetails> | undefined {
	const messages = session.getLiveMessages?.();
	if (!messages || messages.length === 0) return undefined;
	const sections = displayedRowsBySection(resultText(result.content));
	if (sections.size !== 1) return undefined;
	const [[header, requested]] = sections;
	if (requested.size === 0) return undefined;
	const visible = rowsStillInContext(messages, absolutePath, header, session.cwd);
	for (const row of requested) if (!visible.has(row)) return undefined;

	const details: ReadToolDetails = { resolvedPath: absolutePath, inContextRefusal: true };
	if (result.details?.suffixResolution) details.suffixResolution = result.details.suffixResolution;
	return toolResult<ReadToolDetails>(details)
		.text(
			`${header}\nRead refused: \`${requestedPath}\` is unchanged since an earlier read whose output is still in your context. Work from that output; its line numbers and tag are current.`,
		)
		.sourcePath(absolutePath)
		.done();
}
