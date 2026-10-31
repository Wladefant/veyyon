/**
 * WHY: the `lsp` diagnostics action and the diagnostics a write reports both merge what several
 * servers say about one file. Each kept its own copy of the merge: drop a report whose range and
 * message repeat an earlier one, then sort. Both go through `uniqueSortedDiagnostics` now, and this
 * suite pins what the merge keeps and in which order.
 *
 * Not caught: a third caller that merges server reports without going through this function.
 */
import { describe, expect, it } from "bun:test";
import type { Diagnostic } from "@veyyon/coding-agent/lsp/types";
import { uniqueSortedDiagnostics } from "@veyyon/coding-agent/lsp/utils";

function at(line: number, character: number, message: string, severity?: 1 | 2 | 3 | 4, source?: string): Diagnostic {
	return {
		range: { start: { line, character }, end: { line, character: character + 4 } },
		message,
		...(severity === undefined ? {} : { severity }),
		...(source === undefined ? {} : { source }),
	};
}

describe("merging the diagnostics several servers report", () => {
	it("keeps the first report of a problem two servers both report", () => {
		const first = at(3, 2, "unused variable", 2, "tsserver");
		const repeat = at(3, 2, "unused variable", 2, "biome");

		expect(uniqueSortedDiagnostics([first, repeat])).toEqual([first]);
	});

	it("keeps reports that share a range but not a message, or a message but not a range", () => {
		const unused = at(3, 2, "unused variable", 2);
		const shadowed = at(3, 2, "shadowed variable", 2);
		const elsewhere = at(3, 9, "unused variable", 2);
		const longer = { ...unused, range: { start: unused.range.start, end: { line: 4, character: 0 } } };

		expect(uniqueSortedDiagnostics([unused, shadowed, elsewhere, longer])).toHaveLength(4);
	});

	it("orders by severity, then line, column and message, reading a missing severity as an error", () => {
		const hint = at(1, 0, "hint", 4);
		const warning = at(0, 0, "warning", 2);
		const errorLater = at(5, 0, "later", 1);
		const errorUnmarked = at(2, 7, "unmarked");
		const errorB = at(2, 3, "b", 1);
		const errorA = at(2, 3, "a", 1);

		expect(uniqueSortedDiagnostics([hint, warning, errorLater, errorUnmarked, errorB, errorA])).toEqual([
			errorA,
			errorB,
			errorUnmarked,
			errorLater,
			warning,
			hint,
		]);
	});

	it("leaves the caller's list as it was", () => {
		const reports = [at(4, 0, "second", 1), at(1, 0, "first", 1), at(1, 0, "first", 1)];
		const before = structuredClone(reports);

		uniqueSortedDiagnostics(reports);

		expect(reports).toEqual(before);
	});
});
