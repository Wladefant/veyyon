import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { RestoredQueuedMessage } from "./agent-session-queue";

export const PENDING_TERMINAL_STEERING = "terminal:pending-steering";
export const WITHDRAWN_TERMINAL_STEERING = "terminal:withdrawn-steering";
const DURABLE_DELIVERY_TAG = /^\[telegram-delivery id=(telegram-[a-f0-9]{64})\]$/;

export function durableTerminalDeliveryId(text: string): string | undefined {
	return DURABLE_DELIVERY_TAG.exec(text.slice(text.lastIndexOf("\n") + 1))?.[1];
}

/** Taking the text back into the editor withdraws the original delivery, not the draft. */
export function withdrawTerminalSteering(journal: SessionManager, messages: readonly RestoredQueuedMessage[]): void {
	for (const { text } of messages) {
		const messageId = durableTerminalDeliveryId(text);
		if (messageId) journal.appendCustomEntry(WITHDRAWN_TERMINAL_STEERING, { sessionId: journal.getSessionId(), messageId });
	}
}
