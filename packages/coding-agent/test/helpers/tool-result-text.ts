/**
 * The text of a tool result or tool-result message: its text blocks joined by a
 * newline, image and other blocks dropped. Pass `""` as the separator to
 * concatenate output a tool streamed in chunks.
 *
 * Suites read a result through this instead of a local filter-map-join, so the
 * rule for what counts as result text is `contentText`'s, defined once.
 */

import { contentText } from "@veyyon/utils/content-text";

export function toolResultText(result: { readonly content: unknown }, separator = "\n"): string {
	return contentText(result.content, { separator });
}
