/**
 * The text of a tool result or tool-result message: its text blocks joined by a
 * newline, image and other blocks dropped. Pass `""` as the separator to
 * concatenate output a tool streamed in chunks.
 *
 * Suites read a result through this instead of a local filter-map-join, so the
 * rule for what counts as result text is `contentText`'s, defined once.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import { contentText } from "@veyyon/utils/content-text";

export function toolResultText(result: { readonly content: unknown }, separator = "\n"): string {
	return contentText(result.content, { separator });
}

/**
 * The text of any agent message, its blocks joined by a newline. Arms of the
 * `AgentMessage` union that hold no `content` read as `""`.
 */
export function messageText(message: AgentMessage): string {
	return "content" in message ? contentText(message.content) : "";
}

/** The first text block of a tool result, or `""` when it has none. */
export function firstToolResultText(result: {
	readonly content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}
