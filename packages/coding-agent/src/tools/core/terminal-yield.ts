import { TOOL } from "./builtin-names";

/** The fields of a tool result that decide whether it ended the run. */
export interface YieldToolResult {
	toolName: string;
	isError?: boolean;
	result?: { details?: unknown };
}

/**
 * Whether a tool result ends the run: a `yield` that did not fail, unless its details hold
 * `status: "success"` with a non-empty `type` list of strings.
 */
export function isTerminalYieldToolResult(event: YieldToolResult): boolean {
	if (event.toolName !== TOOL.yield || event.isError) return false;
	const details = event.result?.details;
	if (!details || typeof details !== "object") return true;
	const record = details as Record<string, unknown>;
	return !(
		record.status === "success" &&
		Array.isArray(record.type) &&
		record.type.length > 0 &&
		record.type.every(item => typeof item === "string")
	);
}
