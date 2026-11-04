import { clampLow } from "./math";

/** Pattern character to its slot in the match-mask table, plus one; 0 for a character the pattern lacks. Cleared after each call. */
const patternSlot = new Int32Array(0x10000);
/** Match masks followed by the vertical delta words, reused across calls and grown on demand. */
let scratch = new Int32Array(1024);

/**
 * Levenshtein edit distance over UTF-16 code units.
 *
 * Bit-parallel (Myers 1999, Hyyrö's block form): the shorter string is the pattern, held as
 * 32-row words, and each character of the longer string advances every word in one step, so the
 * cost is O(n * ceil(m / 32)) rather than the O(n * m) of the cell-by-cell table.
 *
 * Code-unit granularity means an astral character (emoji, surrogate pair)
 * counts as two units; for typo detection and fuzzy text matching this is the
 * right speed/precision trade — hot paths (edit-tool fuzzy match) call this in
 * tight loops.
 */
export function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	let pattern = a;
	let text = b;
	if (pattern.length > text.length) {
		pattern = b;
		text = a;
	}
	const m = pattern.length;
	const n = text.length;
	if (m === 0) return n;

	let alphabet = 0;
	for (let i = 0; i < m; i++) {
		const code = pattern.charCodeAt(i);
		if (patternSlot[code] === 0) patternSlot[code] = ++alphabet;
	}
	const words = (m + 31) >>> 5;
	const masks = alphabet * words;
	const needed = masks + 2 * words;
	if (scratch.length < needed) scratch = new Int32Array(Math.max(needed, scratch.length * 2));
	const table = scratch;
	table.fill(0, 0, masks);
	for (let i = 0; i < m; i++) {
		table[(patternSlot[pattern.charCodeAt(i)] - 1) * words + (i >>> 5)] |= 1 << (i & 31);
	}
	// Vertical deltas of each word: +1 rows in `pv`, -1 rows in `mv`. Column 0 is 0..m, all +1.
	const pvAt = masks;
	const mvAt = masks + words;
	table.fill(-1, pvAt, mvAt);
	table.fill(0, mvAt, mvAt + words);
	const lastHigh = 1 << ((m - 1) & 31);

	let score = m;
	for (let j = 0; j < n; j++) {
		const slot = patternSlot[text.charCodeAt(j)] - 1;
		const eqAt = slot * words;
		// Row 0 is 0..n, so the horizontal delta entering the first word is always +1.
		let hin = 1;
		for (let w = 0; w < words; w++) {
			const pv = table[pvAt + w];
			const mv = table[mvAt + w];
			let eq = slot < 0 ? 0 : table[eqAt + w];
			const xv = eq | mv;
			if (hin < 0) eq |= 1;
			const xh = (((eq & pv) + pv) ^ pv) | eq;
			let ph = mv | ~(xh | pv);
			let mh = pv & xh;
			// The row whose horizontal delta leaves the word: its top bit, or row m-1 in the last word.
			// Bits above row m-1 hold no pattern row; every operation here carries only upward, so
			// they never reach it.
			const high = w === words - 1 ? lastHigh : -0x80000000;
			const hout = (ph & high) !== 0 ? 1 : (mh & high) !== 0 ? -1 : 0;
			ph <<= 1;
			mh <<= 1;
			if (hin < 0) mh |= 1;
			else if (hin > 0) ph |= 1;
			table[pvAt + w] = mh | ~(xv | ph);
			table[mvAt + w] = ph & xv;
			hin = hout;
		}
		score += hin;
	}

	for (let i = 0; i < m; i++) patternSlot[pattern.charCodeAt(i)] = 0;
	return score;
}

/**
 * Edit distance that counts a transposition as ONE edit (Damerau-Levenshtein).
 *
 * The metric for typo suggestion, and the reason it is separate from
 * {@link levenshteinDistance}: the typos a person makes are overwhelmingly
 * transpositions (`raed` for `read`, `wriet` for `write`), and plain
 * Levenshtein charges a swap two edits, which puts it outside any budget tight
 * enough to be useful on a short name. Suggestion quality collapses without
 * this.
 *
 * The two metrics are both kept on purpose. {@link levenshteinDistance} is the
 * edit tool's fuzzy-match hot path, where the number feeds an acceptance
 * threshold rather than a message, and it runs bit-parallel in O(n * ceil(m / 32)).
 * This one allocates a full matrix, because the adjacent-transposition rule
 * needs to look two rows back. Do not merge them: one is a matching decision,
 * the other is a suggestion.
 */
export function damerauLevenshteinDistance(a: string, b: string): number {
	const rows: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
	for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, rows[i - 2]![j - 2]! + 1);
			}
			rows[i]![j] = best;
		}
	}
	return rows[a.length]![b.length]!;
}

/**
 * Candidate names close enough to `typed` to be worth suggesting, best first.
 *
 * The one owner of "what did they probably mean?". Every surface that rejects a
 * name a human typed wants to answer that question, and each one deriving its
 * own threshold is how they disagree: a key that earns a suggestion from the
 * config CLI and silence from a rule loader, for no reason anyone chose.
 *
 * Matching is case-insensitive and runs in three tiers, so a certain answer is
 * never buried under a merely plausible one: an exact match, then a substring
 * containment, then edit distance. Within the distance tier, closer wins and
 * ties break alphabetically, so the same input always produces the same list.
 *
 * Distance is {@link damerauLevenshteinDistance}, so a transposition costs one
 * edit rather than two. That matters more than it sounds: `raed` for `read` is
 * the single most common way a short name is mistyped, and under plain
 * Levenshtein it sits outside every budget tight enough to be useful.
 *
 * The distance budget scales with the input. One edit in a four-character name
 * is a typo; one edit in a thirty-character path could be a genuinely different
 * name, so longer inputs get a little more room and never more than three,
 * which is the point where suggestions become noise a reader has to filter.
 *
 * Returns at most `limit` names, deduplicated across tiers.
 */
export function nearestNames(typed: string, candidates: Iterable<string>, limit = 5): string[] {
	const needle = typed.trim().toLowerCase();
	if (needle.length === 0) return [];

	const all = Array.from(candidates);
	const out: string[] = [];
	const seen = new Set<string>();
	const take = (names: readonly string[]): void => {
		for (const name of names) {
			if (out.length >= limit) return;
			if (seen.has(name)) continue;
			seen.add(name);
			out.push(name);
		}
	};

	take(all.filter(name => name.toLowerCase() === needle));
	take(all.filter(name => name.toLowerCase().includes(needle)));
	const budget = clampLow(Math.floor(needle.length / 4), 1, 3);
	take(
		all
			.map(name => ({ name, distance: damerauLevenshteinDistance(needle, name.toLowerCase()) }))
			.filter(entry => entry.distance <= budget)
			.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
			.map(entry => entry.name),
	);
	return out;
}
