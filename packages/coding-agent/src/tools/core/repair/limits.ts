/**
 * The bound every tool-call repair step parses within.
 *
 * It sits in a module of its own because three layers read it and none may import another for it:
 * the generic cascade (`schema-repair.ts`), the per-tool registry it runs (`tool-repairs.ts`), and the
 * task prose decoder the registry and the task renderer share (`task/repair-args.ts`).
 */

/**
 * Hard cap, in UTF-16 code units, on the text one repair step parses: a stringified argument object,
 * or one field a registered repair decodes. A longer value is not repaired.
 */
export const MAX_REPAIR_INPUT_BYTES = 1_048_576;
