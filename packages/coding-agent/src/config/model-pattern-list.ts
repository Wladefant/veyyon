/**
 * Split a configured model value into its ordered chain of patterns.
 *
 * `"opus,sonnet"` and `["opus", "sonnet"]` are the same chain. This is the ONE
 * splitter: the settings chain picker reads and writes through it, so what the
 * picker shows as entry two is exactly what compaction and the agent spawner
 * try second.
 */
export function normalizeModelPatternList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	const patterns = Array.isArray(value) ? value.flatMap(pattern => pattern.split(",")) : value.split(",");
	return patterns.map(pattern => pattern.trim()).filter(Boolean);
}

/**
 * The model value that runs an agent or helper on the session's live model, at
 * whatever that session is running when the call starts. It is also what an
 * agent runs when no settings layer names a model; a layer states it to
 * override a model named by a layer below it.
 */
export const INHERIT_AGENT_MODEL = "inherit";

/** Whether a configured model value is {@link INHERIT_AGENT_MODEL}. */
export function namesInheritedModel(value: string | readonly string[] | undefined): boolean {
	const head = typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;
	return head?.trim().toLowerCase() === INHERIT_AGENT_MODEL;
}
