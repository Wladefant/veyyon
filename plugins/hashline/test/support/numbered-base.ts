/**
 * The numbered base the edit suites apply to, and whole-output checks against it.
 *
 * Every edit these suites make replaces one span of the base with new text, so
 * each check states that span and compares the result to `base[0, from) +
 * middle + base[to, end)` in place: a length check plus three anchored
 * comparisons, with no expected string and no line array built per anchor.
 * That keeps a whole-output check at O(n) memcmp on multi-million-line bases.
 */
import { expect } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/** `n` lines, line `i` reading `L<i>`. */
export function numberedLines(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `L${i + 1}`);
}

/** Offset of line `i` (1-based) in the numbered base: every earlier line `j` is `L`, the digits of `j`, `\n`. */
export function numberedLineStart(i: number): number {
	let offset = 2 * (i - 1);
	for (let width = 1, low = 1; low < i; width++, low *= 10) {
		offset += width * (Math.min(i - 1, low * 10 - 1) - low + 1);
	}
	return offset;
}

function numberedLineEnd(i: number): number {
	return numberedLineStart(i) + 1 + String(i).length;
}

/**
 * `text` equals `base` with `base[from, to)` replaced by `middle`. A mismatch
 * fails on the lines around the first differing character, not on two whole
 * bases.
 */
export function expectSplicedBase(text: string, base: string, from: number, to: number, middle: string): void {
	if (
		text.length === from + middle.length + (base.length - to) &&
		text.startsWith(base.slice(0, from)) &&
		text.startsWith(middle, from) &&
		text.endsWith(base.slice(to))
	) {
		return;
	}
	const expected = base.slice(0, from) + middle + base.slice(to);
	let at = 0;
	while (at < text.length && at < expected.length && text[at] === expected[at]) at++;
	const lineStart = expected.lastIndexOf("\n", at - 1) + 1;
	expect(text.slice(lineStart, at + 80)).toBe(expected.slice(lineStart, at + 80));
}

/** `patch` deletes line `i` of the `n`-line numbered `base`. */
export function expectLineDeleted(base: string, n: number, i: number, patch: string): void {
	const { text, firstChangedLine } = applyEdits(base, parsePatch(patch).edits);
	expect(firstChangedLine).toBe(i);
	if (i < n) expectSplicedBase(text, base, numberedLineStart(i), numberedLineStart(i + 1), "");
	else expectSplicedBase(text, base, Math.max(0, numberedLineStart(n) - 1), base.length, "");
}

/** `patch` replaces line `i` of the numbered `base` with `row`. */
export function expectLineReplaced(base: string, i: number, patch: string, row: string): void {
	const { text, firstChangedLine } = applyEdits(base, parsePatch(patch).edits);
	expect(firstChangedLine).toBe(i);
	expectSplicedBase(text, base, numberedLineStart(i), numberedLineEnd(i), row);
}

/** `INS.POST a` and `INS.PRE a` land `P` after and `R` before line `a` of the numbered `base`. */
export function expectInsertedBesideAnchor(base: string, a: number): void {
	const after = applyEdits(base, parsePatch(`INS.POST ${a}:\n+P`).edits);
	expect(after.firstChangedLine).toBe(a);
	expectSplicedBase(after.text, base, numberedLineEnd(a), numberedLineEnd(a), "\nP");

	const before = applyEdits(base, parsePatch(`INS.PRE ${a}:\n+R`).edits);
	expect(before.firstChangedLine).toBe(a);
	expectSplicedBase(before.text, base, numberedLineStart(a), numberedLineStart(a), "R\n");
}

/** `DEL 1.=k` keeps lines k+1..n and `DEL (n-k+1).=n` keeps lines 1..n-k of the numbered `base`. */
export function expectPrefixAndSuffixDeleted(base: string, n: number, k: number): void {
	const prefix = applyEdits(base, parsePatch(`DEL 1.=${k}`).edits).text;
	expectSplicedBase(prefix, base, 0, k < n ? numberedLineStart(k + 1) : base.length, "");

	const suffix = applyEdits(base, parsePatch(`DEL ${n - k + 1}.=${n}`).edits).text;
	expectSplicedBase(suffix, base, k < n ? numberedLineStart(n - k + 1) - 1 : 0, base.length, "");
}

/** `INS.HEAD` and `INS.TAIL` of `k` rows land before and after the one-line base `Z`. */
export function expectRowsAroundOneLineBase(k: number): void {
	const rows = (prefix: string) => Array.from({ length: k }, (_, i) => `${prefix}${i + 1}`).join("\n");
	const patchRows = (prefix: string) => Array.from({ length: k }, (_, i) => `+${prefix}${i + 1}`).join("\n");

	const head = applyEdits("Z", parsePatch(`INS.HEAD:\n${patchRows("H")}`).edits);
	expect(head.firstChangedLine).toBe(1);
	expectSplicedBase(head.text, "Z", 0, 0, `${rows("H")}\n`);

	const tail = applyEdits("Z", parsePatch(`INS.TAIL:\n${patchRows("T")}`).edits);
	expectSplicedBase(tail.text, "Z", 1, 1, `\n${rows("T")}`);
}
