/**
 * WHY: every renderer that shows a tool result's prose, an error note or an
 * artifact notice reads it through `resultTextOf`. A reader that keeps only the
 * first text block hides the tail of a multi-block result, and one that joins
 * blocks without a newline runs the last line of one block into the first line
 * of the next.
 *
 * It does not catch a renderer that bypasses `resultTextOf` and reads
 * `result.content` itself.
 */

import { describe, expect, it } from "bun:test";
import type { ToolResultLike } from "../src/types";
import { resultTextOf } from "../src/util";

describe("a result shows every text block on its own line", () => {
	it("joins text blocks with a newline and drops image blocks", () => {
		const result: ToolResultLike = {
			content: [
				{ type: "text", text: "first" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "" },
				{ type: "text", text: "last" },
			],
		};
		expect(resultTextOf(result)).toBe("first\n\nlast");
	});

	it("reads nothing from an absent result or from content that is not a block list", () => {
		expect(resultTextOf(undefined)).toBe("");
		expect(resultTextOf({ content: "plain" } as never)).toBe("");
	});

	it("skips a block that is not a text block with string text", () => {
		const result = { content: [null, { type: "text" }, { type: "text", text: 7 }, { type: "text", text: "kept" }] };
		expect(resultTextOf(result as never)).toBe("kept");
	});
});
