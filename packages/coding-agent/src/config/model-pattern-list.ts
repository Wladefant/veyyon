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
