/**
 * The tool-specific repairs the cascade in `schema-repair.ts` runs, keyed by canonical tool name.
 *
 * A model-emission mistake that only one tool's contract can recognize is repaired here and nowhere
 * else, so the arguments it produces are the ones validation, approval, the tool, the
 * `tool_execution_*` events and every hook receive. The cascade runs an entry after alias repair and
 * before the strictness and ambiguity guards (see the order in `schema-repair.ts`), and the
 * `VEYYON_REPAIR_DISABLE` switch and a harness profile's `repair: false` turn entries off with the
 * rest of the cascade.
 *
 * An entry is pure, deterministic, bounded by {@link MAX_REPAIR_INPUT_BYTES} and idempotent: its
 * output is never repaired again. It rewrites only the fields it declares, and only when the value
 * the model meant is the one reading of what it sent; otherwise it does not apply and the call
 * continues as sent. It never rewrites code, a command, a path, a pattern or a URL.
 *
 * Not repair, and not here:
 * - Domain parsing a tool owns: `search` ignores a field its selected type does not accept and says
 *   so in its result, and `read` canonicalizes a URL with a collapsed scheme. Those interpret valid
 *   input, and the tool keeps them.
 * - Display tolerance: the task renderer decodes the raw streamed brief with the same function the
 *   `task` entry uses, for the preview only. A renderer never feeds execution.
 */

import { isRecord } from "@veyyon/utils";
import { parseJsonWithRepair } from "@veyyon/utils/json-parse";
import { repairTaskParams } from "../../../task/repair-args";
import type { TaskParams } from "../../../task/types";
import { TOOL } from "../builtin-names";
import { MAX_REPAIR_INPUT_BYTES } from "./limits";

/** What an entry returns when it applies: the repaired arguments and the hint that names the change. */
export interface ToolArgumentRepairResult {
	readonly arguments: Record<string, unknown>;
	readonly hints: readonly string[];
}

/** One registered repair. */
export interface ToolArgumentRepair {
	/**
	 * The argument fields the entry may rewrite: `name` for a top-level field, `name[].field` for a
	 * field of each element of an array argument. Every other value reaches the tool as sent.
	 */
	readonly fields: readonly string[];
	/** The repaired arguments, or `undefined` when the call does not carry the mistake this entry repairs. */
	readonly repair: (args: Readonly<Record<string, unknown>>) => ToolArgumentRepairResult | undefined;
}

/** `task`: a brief or shared context the model JSON-escaped twice. */
const TASK_PROSE: ToolArgumentRepair = {
	fields: ["task", "context", "tasks[].task"],
	repair(args) {
		const repaired = repairTaskParams(args as TaskParams);
		if (repaired === args) return undefined;
		return {
			arguments: repaired as Record<string, unknown>,
			hints: ["Decoded task prose that was JSON-escaped twice."],
		};
	},
};

/** `yield`: the `result` wrapper sent as a JSON string instead of an object. */
const YIELD_RESULT: ToolArgumentRepair = {
	fields: ["result"],
	repair(args) {
		const value = args.result;
		if (typeof value !== "string" || value.length > MAX_REPAIR_INPUT_BYTES) return undefined;
		const text = value.trim();
		if (!text.startsWith("{")) return undefined;
		let parsed: unknown;
		try {
			parsed = parseJsonWithRepair<unknown>(text);
		} catch {
			return undefined;
		}
		if (!isRecord(parsed)) return undefined;
		return {
			arguments: { ...args, result: parsed },
			hints: ["Parsed the `result` wrapper sent as a JSON string into its object."],
		};
	},
};

/** Every tool-specific repair, keyed by canonical tool name. */
export const TOOL_ARGUMENT_REPAIRS: ReadonlyMap<string, ToolArgumentRepair> = new Map([
	[TOOL.task, TASK_PROSE],
	[TOOL.yield, YIELD_RESULT],
]);
