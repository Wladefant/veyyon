import { describe, expect, it } from "bun:test";
import { formatArtifactErrorNotice } from "@veyyon/coding-agent/tools/core/output-meta";
import { jobToolView } from "@veyyon/coding-agent/tools/shell/job-view";

// WHY: the job card dedups the capture warning against what it DISPLAYS. It once searched the whole
// result text, so a warning sitting in a footer the preview cuts off counted as shown and no
// warning appeared anywhere. The class closed here: for every preview depth (collapsed, expanded) and
// every position of the warning in the text, the card shows the warning exactly once. Gap: only the
// "write" variant is rendered; the notice text is built by one formatter shared by all variants.

const NOTICE = formatArtifactErrorNotice("write");

function warningRows(text: string, expanded: boolean): number {
	const view = jobToolView.renderResult(
		{
			content: [{ type: "text", text: "## Completed (1)\n" }],
			details: {
				jobs: [
					{
						id: "j-1",
						type: "bash",
						status: "completed",
						label: "capture",
						durationMs: 1000,
						resultText: text,
						meta: { artifactError: "write" },
					},
				],
			},
		},
		{ expanded },
	);
	if (view.kind !== "headedBlock") throw new Error(`unexpected view kind ${view.kind}`);
	return view.lines.filter(row => row.some(span => span.text.includes(NOTICE))).length;
}

function body(lineCount: number): string[] {
	return Array.from({ length: lineCount }, (_, i) => `output line ${i + 1}`);
}

describe("the capture warning on a completed job card", () => {
	for (const expanded of [false, true]) {
		const view = expanded ? "expanded" : "collapsed";

		it(`is shown when it sits in a footer the ${view} preview hides (40 lines, then the warning)`, () => {
			expect(warningRows([...body(40), `[${NOTICE}]`].join("\n"), expanded)).toBe(1);
		});

		it(`is shown once when it is the first line of the ${view} preview`, () => {
			expect(warningRows([`[${NOTICE}]`, ...body(40)].join("\n"), expanded)).toBe(1);
		});
	}

	it("is shown once in the expanded view when it falls inside the lines that view displays but past the collapsed one", () => {
		const text = [...body(1), `[${NOTICE}]`, ...body(38)].join("\n");
		expect(warningRows(text, false)).toBe(1);
		expect(warningRows(text, true)).toBe(1);
	});
});
