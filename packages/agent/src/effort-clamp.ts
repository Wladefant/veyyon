import type { Model } from "@veyyon/ai";
import type { Effort } from "@veyyon/catalog/effort";
import { clampThinkingLevelForModel } from "@veyyon/catalog/model-thinking";
import { logger } from "@veyyon/utils";

/** Clamps already logged, keyed by pass, model and requested effort. */
const reported = new Set<string>();

/**
 * Clamp the fixed effort an internal pass requests to the efforts the model accepts, and log a move
 * once per process for each pass, model and requested effort.
 *
 * A pass that moves the level without logging hides effort drift. The move is a property of the model
 * row, so a repeated log of it adds nothing: a staged compaction sends one request per segment and logged
 * the same warning once per segment, 133 lines for one compaction of a 146 MB session.
 *
 * `pass` opens the message, as in `"Compaction"` or `"Memory pass"`.
 */
export function clampPassEffort(model: Model, requested: Effort, pass: string): Effort | undefined {
	const clamped = clampThinkingLevelForModel(model, requested);
	if (clamped === requested) return clamped;
	const key = `${pass}\0${model.provider}/${model.id}\0${requested}`;
	if (reported.has(key)) return clamped;
	reported.add(key);
	logger.warn(`${pass} effort is not accepted by the model; using the nearest supported level`, {
		model: `${model.provider}/${model.id}`,
		requested,
		using: clamped ?? "provider default",
	});
	return clamped;
}
