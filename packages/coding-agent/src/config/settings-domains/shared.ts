import type { ModelTagsSettings } from "../settings-schema";

// Typed defaults for array/record settings — named constants avoid `as` casts
// under `as const` while still letting SettingValue infer the correct element type.
export const EMPTY_STRING_ARRAY: string[] = [];
export const EMPTY_STRING_RECORD: Record<string, string> = {};
export const EMPTY_NUMBER_RECORD: Record<string, number> = {};
export const DEFAULT_CYCLE_ORDER: string[] = ["smol", "slow"];
export const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["job", "irc"];
export const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
export const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];

/**
 * Default for `tools.inlineOutputFloor`, and the compiled fallback
 * `inlineCapForTurn` uses when no caller supplies one.
 *
 * It lives here rather than beside `inlineCapForTurn` because that function is
 * in `session/streaming-output`, which reaches `config/settings` through
 * `tools/render-utils`; importing it from a settings domain would close a cycle
 * back onto the schema. This module is a leaf, so both sides can read the value
 * from one owner instead of writing 0.25 down twice and letting the schema
 * default and the code default drift the first time either is tuned.
 */
export const DEFAULT_INLINE_FLOOR_FRACTION = 0.25;

/** Default for `tools.artifactSpillThreshold`, in KILOBYTES, which is the unit that setting is in. */
export const DEFAULT_ARTIFACT_SPILL_THRESHOLD_KB = 50;

/**
 * The same threshold in BYTES: the compiled inline budget every tool result is
 * priced against when a session has no settings to read.
 *
 * There is one number here, not two settings. "How many bytes of tool output
 * stay in the conversation" was answered twice: `tools.artifactSpillThreshold`
 * governed the centralised spill that runs after a tool returns, while every
 * streaming tool priced itself against a compiled 50KB constant that nothing
 * could reach. Both meant the same thing and both were 50KB, so they agreed
 * only by coincidence, and an operator who lowered the setting moved the
 * centralised path while bash, eval, ssh and the interactive shell carried on at
 * 50KB. `inlineOutputPricing` now reads that one setting for both, and this is
 * its compiled fallback.
 *
 * It lives here beside {@link DEFAULT_INLINE_FLOOR_FRACTION} for the same cycle
 * reason, and because the two are one parameter pair: a result's inline
 * allowance is this budget scaled by the turn curve and held above that floor,
 * which is a SHARE of it. `session/streaming-output`'s `DEFAULT_MAX_BYTES` is
 * this value under the name its callers and the tool docs already use.
 */
export const DEFAULT_INLINE_OUTPUT_MAX_BYTES = DEFAULT_ARTIFACT_SPILL_THRESHOLD_KB * 1024;

/**
 * Default for `mnemopi.embedIdleUnloadMs`, and the window `MnemopiEmbedClient`
 * runs on before anything configures it.
 *
 * It lives here for the same reason as {@link DEFAULT_INLINE_FLOOR_FRACTION}:
 * the client is in `memory/mnemopi`, which a settings domain must not import,
 * and writing 300000 down twice lets the schema default and the compiled
 * default drift the first time either is tuned.
 *
 * Five minutes: the embeddings subprocess pins ~1.25 GB of commit charge for the
 * loaded ONNX model and does nothing between a `retain` and the next `recall`
 * (issue #54), so a conversational burst of memory writes reuses one worker
 * while an idle session stops paying for the model.
 */
export const DEFAULT_EMBED_IDLE_UNLOAD_MS = 300_000;
