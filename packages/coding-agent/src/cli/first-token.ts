import type { AssistantMessageEvent } from "@veyyon/ai";

/**
 * Whether `event` is the first one that carries model output, the instant `veyyon bench` and
 * `veyyon dry-balance` stop the time-to-first-token clock.
 *
 * A delta counts only when it is non-empty, and an end event counts only when its block holds content, so a
 * provider that opens a block with an empty delta does not stop the clock early. Tool-call arguments count as
 * output; a `start` event or a usage update does not.
 */
export function isFirstTokenEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		default:
			return false;
	}
}
