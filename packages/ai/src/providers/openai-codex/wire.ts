/**
 * Codex wire facts both transports read: the debug flag, the turn-state and models-etag response headers
 * a session carries into its next request, the event types that count as stream progress, and the
 * integer coercion for wire indexes.
 */
import { $flag } from "@veyyon/utils/env";
import type { CodexWebSocketSessionState } from "../openai-codex-responses";
import { isOpenAIResponsesProgressEvent } from "../openai-shared";

export const CODEX_DEBUG = $flag("VEYYON_CODEX_DEBUG");

export const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
export const X_MODELS_ETAG_HEADER = "x-models-etag";

const CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES = new Set(["response.done", "response.incomplete"]);

export function isCodexStreamProgressEvent(event: unknown): boolean {
	if (isOpenAIResponsesProgressEvent(event)) return true;
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES.has(type);
}

/** A wire index or sequence number as an integer, or `undefined` when the field is absent or not a finite number. */
export function wireInteger(raw: unknown): number | undefined {
	return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined;
}

export function updateCodexSessionMetadataFromHeaders(
	state: CodexWebSocketSessionState | undefined,
	headers: Headers | Record<string, string> | null | undefined,
): void {
	if (!state || !headers) return;
	const resolvedHeaders = headers instanceof Headers ? headers : new Headers(headers);
	const turnState = resolvedHeaders.get(X_CODEX_TURN_STATE_HEADER);
	if (turnState && turnState.length > 0) {
		state.turnState = turnState;
	}
	const modelsEtag = resolvedHeaders.get(X_MODELS_ETAG_HEADER);
	if (modelsEtag && modelsEtag.length > 0) {
		state.modelsEtag = modelsEtag;
	}
}
