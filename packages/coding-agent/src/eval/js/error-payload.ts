// Subpath imports, NOT the `@veyyon/utils` barrel: the barrel loads dotenv at import time, and
// this module is reachable from the JS eval process entry, which must not read a `.env` before
// profile bootstrap (pinned by `eval/__tests__/process-entry-import.test.ts`).
import { isAbortError } from "@veyyon/utils/abortable";
import { errorMessage } from "@veyyon/utils/type-guards";
import { ToolAbortError, ToolError } from "../../tools/core/tool-errors";
import type { EvalRunErrorPayload } from "./worker-protocol";

/**
 * Flatten an error for the eval worker channel. The host encodes a failed tool call this way for
 * the worker, and the worker encodes a failed cell this way for the host.
 */
export function toErrorPayload(error: unknown): EvalRunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: isAbortError(error),
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { message: errorMessage(error) };
}

/** Rebuild an error from {@link toErrorPayload}, keeping its abort and tool-error identity. */
export function errorFromPayload(payload: EvalRunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Execution aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}
