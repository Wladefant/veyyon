/**
 * Refusal of a read whose output the model can still see.
 *
 * A read is refused when the file's snapshot tag is unchanged and every line the read would display
 * is already displayed by an earlier `read` result that is still in the agent's live context. The
 * check reads the live messages at call time and keeps no history of its own: a result that was
 * pruned, shaken out, deduplicated or summarized away by compaction no longer carries its numbered
 * rows, so it stops counting the moment the model stops seeing it.
 *
 * The refusal is appended as a new short result. Nothing earlier in the conversation is rewritten,
 * so the cached prompt prefix is untouched, and compaction's supersede pruning does not treat the
 * refusal as a newer read of the file (`supersedeTargets` in `@veyyon/agent-core/compaction`).
 */
import type { AgentMessage, AgentToolResult } from "@veyyon/agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@veyyon/ai";
import { parseSeenLinesFromHashlineBody } from "../../edit/file-snapshot-store";
import type { ToolSession } from "../../sdk";
import { resolveOutputMaxColumns } from "../core/output-meta";
import { resolveToCwd, splitPathAndSel } from "../core/path-utils";
import { toolResult } from "../core/tool-result";
import type { ReadToolDetails } from "./read-types";

/** A hashline section header on its own line: `[name#1A2B]`. */
const SECTION_HEADER = /^\[[^\]\n]+#[0-9A-F]{4}\]$/;

/**
 * The lines each hashline section of `text` displays, keyed by its header line.
 *
 * A section is its header and the non-empty lines that follow it. Every row a hashline body
 * displays is non-empty (an empty file line renders as `N:`), and a delimited read joins its parts
 * with a blank line, so a section ends at the first empty line and a later `:raw` part can never
 * lend its lines to the section before it.
 */
function displayedLinesBySection(text: string): Map<string, Set<number>> {
	const sections = new Map<string, Set<number>>();
	let header: string | undefined;
	let rows: string[] = [];
	const flush = (): void => {
		if (header === undefined) return;
		let lines = sections.get(header);
		if (!lines) {
			lines = new Set();
			sections.set(header, lines);
		}
		for (const line of parseSeenLinesFromHashlineBody(rows.join("\n"))) lines.add(line);
		header = undefined;
		rows = [];
	};
	for (const line of text.split("\n")) {
		if (SECTION_HEADER.test(line)) {
			flush();
			header = line;
		} else if (line.length === 0) {
			flush();
		} else if (header !== undefined) {
			rows.push(line);
		}
	}
	flush();
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

/** The lines visible read results of `absolutePath` display under `header`. */
function linesStillInContext(
	messages: readonly AgentMessage[],
	absolutePath: string,
	header: string,
	cwd: string,
	maxColumns: number,
): Set<number> {
	const visible = new Set<number>();
	for (const message of messages) {
		if (!isLiveReadResult(message)) continue;
		const details = message.details;
		// A row cut at the column cap showed only its prefix. A read at that same cap cuts it
		// identically; a read at any other cap shows different bytes.
		const clippedAt = details?.meta?.limits?.columnTruncated?.maxColumn;
		if (clippedAt !== undefined && clippedAt !== maxColumns) continue;
		if (!resultReadsPath(details, absolutePath, cwd)) continue;
		const lines = displayedLinesBySection(resultText(message.content)).get(header);
		if (lines) for (const line of lines) visible.add(line);
	}
	return visible;
}

/**
 * The refusal for `result` when every line it displays is unchanged and still in context, or
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
	const sections = displayedLinesBySection(resultText(result.content));
	if (sections.size !== 1) return undefined;
	const [[header, requested]] = sections;
	if (requested.size === 0) return undefined;
	const visible = linesStillInContext(
		messages,
		absolutePath,
		header,
		session.cwd,
		resolveOutputMaxColumns(session.settings),
	);
	for (const line of requested) if (!visible.has(line)) return undefined;

	const details: ReadToolDetails = { resolvedPath: absolutePath, inContextRefusal: true };
	if (result.details?.suffixResolution) details.suffixResolution = result.details.suffixResolution;
	return toolResult<ReadToolDetails>(details)
		.text(
			`${header}\nRead refused: \`${requestedPath}\` is unchanged since an earlier read whose output is still in your context. Work from that output; its line numbers and tag are current.`,
		)
		.sourcePath(absolutePath)
		.done();
}
