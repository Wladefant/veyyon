import { describe, expect, it } from "bun:test";
import { assistantText, assistantTextBlocks, messageContentText } from "../src/utils/message-text";

const content = [
	{ type: "thinking" as const, thinking: "hmm", thinkingSignature: "" },
	{ type: "text" as const, text: "first" },
	{ type: "toolCall" as const, id: "t1", name: "read", arguments: {} },
	{ type: "text" as const, text: "second" },
];

describe("assistantTextBlocks / assistantText", () => {
	it("extracts only text blocks, in order", () => {
		expect(assistantTextBlocks({ content })).toEqual(["first", "second"]);
	});

	it("joins with newline by default and honors a custom separator", () => {
		expect(assistantText({ content })).toBe("first\nsecond");
		expect(assistantText({ content }, "")).toBe("firstsecond");
	});

	it("returns empty for a message with no text blocks", () => {
		expect(assistantText({ content: [] })).toBe("");
		expect(assistantTextBlocks({ content: [content[0]] })).toEqual([]);
	});
});
describe("messageContentText", () => {
	it("keeps text and image placeholders while dropping video content", () => {
		expect(
			messageContentText([
				{ type: "text", text: "hello" },
				{ type: "video", data: "clip", mimeType: "video/mp4" },
				{ type: "image", mimeType: "image/png", data: "encoded" },
			]),
		).toBe("hello\n\n[image/png image]");
	});
});
