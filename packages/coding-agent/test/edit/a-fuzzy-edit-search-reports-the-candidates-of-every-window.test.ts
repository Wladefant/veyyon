/**
 * The replace-mode fuzzy search slides the edit's old text over every window of the file and keeps
 * three facts: the best window, how many windows reach the threshold, and the second best score.
 * The last two decide whether a fuzzy match is applied, refused as ambiguous, or accepted as
 * dominant.
 *
 * WHY: on a large file that search blocked the event loop for up to two seconds per streamed edit
 * preview. It now skips a window once the lines scored so far, plus a length bound on the rest, show
 * the window can neither reach the threshold nor beat the second best; it builds each line's
 * normalized form once per search rather than once per window; and it answers a repeated search
 * from the last one. Each of those can change the three facts without changing the best window:
 * a skip that drops a window at the threshold (the ambiguity count), a skip that drops the true
 * second best (the dominance margin), a window depth computed against the whole file rather than
 * the window, and a repeated search answered for a different file.
 *
 * The sweep scores every window with a direct implementation of the documented rule (indent depth
 * relative to the window, then the normalized line, compared by `similarity`) and derives the
 * outcome `findMatch` must return, over files built from a few near-identical blocks so that many
 * windows sit near the threshold and near each other.
 *
 * NOT CAUGHT: `similarity` itself is trusted here; its edit distance is checked against the
 * cell-by-cell table in the utils suite. Exact matches never reach the window search, so the sweep
 * skips targets that occur verbatim.
 */
import { describe, expect, it } from "bun:test";
import {
	DEFAULT_FUZZY_THRESHOLD,
	type FuzzyMatch,
	findMatch,
	type MatchOutcome,
	similarity,
} from "@veyyon/coding-agent/edit/match";
import { countLeadingWhitespace, normalizeForFuzzy } from "@veyyon/coding-agent/edit/normalize";

const FALLBACK_THRESHOLD = 0.8;
const DOMINANT_FUZZY_MIN_CONFIDENCE = 0.97;
const DOMINANT_FUZZY_DELTA = 0.08;

function keys(lines: string[], includeDepth: boolean): string[] {
	const blank = lines.map(line => line.trim().length === 0);
	const indents = lines.map(countLeadingWhitespace);
	const filled = indents.filter((_, i) => !blank[i]);
	const min = filled.length > 0 ? Math.min(...filled) : 0;
	const steps = filled.map(indent => indent - min).filter(step => step > 0);
	const unit = steps.length > 0 ? Math.min(...steps) : 1;
	return lines.map((line, i) => {
		const prefix = includeDepth ? `${blank[i] ? 0 : Math.round((indents[i] - min) / unit)}|` : "|";
		return blank[i] ? prefix : `${prefix}${normalizeForFuzzy(line.trim())}`;
	});
}

interface Scan {
	best?: FuzzyMatch;
	above: number;
	second: number;
}

function scan(content: string, target: string, threshold: number, includeDepth: boolean): Scan {
	const lines = content.split("\n");
	const targetKeys = keys(target.split("\n"), includeDepth);
	const count = targetKeys.length;
	const result: Scan = { above: 0, second: -1 };
	let bestScore = -1;
	let offset = 0;
	for (let start = 0; start + count <= lines.length; start++) {
		const window = lines.slice(start, start + count);
		const windowKeys = keys(window, includeDepth);
		let score = 0;
		for (let i = 0; i < count; i++) score += similarity(targetKeys[i], windowKeys[i]);
		score /= count;
		if (score >= threshold) result.above++;
		if (score > bestScore) {
			result.second = bestScore;
			bestScore = score;
			result.best = { actualText: window.join("\n"), startIndex: offset, startLine: start + 1, confidence: score };
		} else if (score > result.second) {
			result.second = score;
		}
		offset += lines[start].length + 1;
	}
	return result;
}

function expectedOutcome(content: string, target: string, threshold: number): MatchOutcome {
	let result = scan(content, target, threshold, true);
	const first = result.best;
	if (first && first.confidence < threshold && first.confidence >= FALLBACK_THRESHOLD) {
		const flat = scan(content, target, threshold, false);
		if (flat.best && flat.best.confidence > first.confidence) result = flat;
	}
	const best = result.best;
	if (!best) return {};
	if (best.confidence >= threshold) {
		if (result.above === 1) return { match: best, closest: best };
		if (
			result.above > 1 &&
			best.confidence >= DOMINANT_FUZZY_MIN_CONFIDENCE &&
			best.confidence - result.second >= DOMINANT_FUZZY_DELTA
		) {
			return { match: best, closest: best, fuzzyMatches: result.above, dominantFuzzy: true };
		}
	}
	return { closest: best, fuzzyMatches: result.above };
}

describe("the replace-mode fuzzy search", () => {
	let seed = 0x2545f491;
	const next = (bound: number): number => {
		seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
		return (seed >>> 0) % bound;
	};
	const blocks = [
		[
			"function load(path) {",
			"  const text = read(path);",
			"  if (!text) {",
			"    return null;",
			"  }",
			"  return parse(text);",
			"}",
		],
		[
			"function save(path, value) {",
			"  const text = format(value);",
			"  if (!text) {",
			"    return false;",
			"  }",
			"  return write(path, text);",
			"}",
		],
		["  // section", "", "\tconst items = [];", "\tfor (const item of list) items.push(item);"],
	];
	const variant = (line: string): string => {
		switch (next(8)) {
			case 0:
				return line.replace(/text/, "body");
			case 1:
				return `  ${line}`;
			case 2:
				return line.replace(/;$/, "; // done");
			case 3:
				return line.trim();
			default:
				return line;
		}
	};
	const file = (): string => {
		const lines: string[] = [];
		for (let b = 0; b < 12; b++)
			lines.push(...blocks[next(blocks.length)].map(line => (next(3) === 0 ? variant(line) : line)));
		return lines.join("\n");
	};

	it("reports the best window, the windows at the threshold and the second best of a search that scores every window", () => {
		const mismatches: string[] = [];
		let searched = 0;
		const decided = new Set<string>();
		for (let f = 0; f < 20; f++) {
			const content = file();
			const lines = content.split("\n");
			for (let t = 0; t < 20; t++) {
				const length = 1 + next(7);
				const at = next(lines.length - length + 1);
				const target = lines
					.slice(at, at + length)
					.map(line => (next(2) === 0 ? variant(line) : line))
					.join("\n");
				if (target.length === 0 || content.includes(target)) continue;
				for (const threshold of [DEFAULT_FUZZY_THRESHOLD, 0.9, 0.85, 0.7]) {
					searched++;
					const expected = expectedOutcome(content, target, threshold);
					const actual = findMatch(content, target, { allowFuzzy: true, threshold });
					decided.add(
						expected.dominantFuzzy
							? "dominant"
							: expected.match
								? "single"
								: expected.fuzzyMatches
									? "ambiguous"
									: "closest",
					);
					if (JSON.stringify(actual) !== JSON.stringify(expected)) {
						mismatches.push(
							`file ${f} target ${t} at ${threshold}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
						);
					}
				}
			}
		}
		expect(searched).toBeGreaterThan(400);
		// The sweep reaches every decision the counts and the margin select between.
		expect([...decided].sort()).toEqual(["ambiguous", "closest", "dominant", "single"]);
		expect(mismatches).toEqual([]);
	});

	it("answers each search from the file, old text and threshold it is given, not from the last search", () => {
		const target = "function load(path) {\n  const body = read(path);";
		const first = "function load(path) {\n  const text = read(path);\n}";
		const second = "// header\nfunction load(path) {\n  const text = read(path);\n}";
		const below = findMatch(first, target, { allowFuzzy: true });
		expect(below.match).toBeUndefined();
		expect(below.closest?.startLine).toBe(1);
		// The same file and old text at a lower threshold is a different search.
		expect(findMatch(first, target, { allowFuzzy: true, threshold: 0.5 }).match?.startLine).toBe(1);
		// Another file with the same old text and threshold is a different search.
		expect(findMatch(second, target, { allowFuzzy: true, threshold: 0.5 }).match?.startLine).toBe(2);
		// Another old text in the same file at the same threshold is a different search.
		expect(findMatch(second, `${target}\n}`, { allowFuzzy: true, threshold: 0.5 }).closest?.actualText).toBe(
			second.split("\n").slice(1).join("\n"),
		);
		expect(findMatch(first, `${target}\n}`, { allowFuzzy: true }).closest?.actualText).toBe(first);
	});
});
