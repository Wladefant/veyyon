import { describe, expect, it } from "bun:test";
import { countLines, parseReadArgs, parseReadDetails, parseWriteArgs, parseWriteDetails } from "../src/fs-tool-args";

describe("a read or write call parses to a path and a range", () => {
	describe("countLines", () => {
		it("counts lines without allocating arrays", () => {
			expect(countLines(null)).toBe(0);
			expect(countLines(undefined)).toBe(0);
			expect(countLines("")).toBe(0);
			expect(countLines("one line")).toBe(1);
			expect(countLines("line1\nline2")).toBe(2);
			expect(countLines("line1\nline2\nline3\n")).toBe(4);
			expect(countLines("line1\r\nline2\r\n")).toBe(3);
		});
	});

	describe("parseReadArgs", () => {
		it("parses empty or non-record input without throwing", () => {
			expect(parseReadArgs(null)).toEqual({
				rawPath: "",
				path: "",
				sel: null,
				from: null,
				to: null,
				rangeSuffix: "",
			});
			expect(parseReadArgs(undefined)).toEqual({
				rawPath: "",
				path: "",
				sel: null,
				from: null,
				to: null,
				rangeSuffix: "",
			});
			expect(parseReadArgs("not-a-record")).toEqual({
				rawPath: "",
				path: "",
				sel: null,
				from: null,
				to: null,
				rangeSuffix: "",
			});
			expect(parseReadArgs(123)).toEqual({
				rawPath: "",
				path: "",
				sel: null,
				from: null,
				to: null,
				rangeSuffix: "",
			});
		});

		it("prefers path over file_path when both are present", () => {
			expect(parseReadArgs({ path: "primary.ts", file_path: "fallback.ts" })).toEqual({
				rawPath: "primary.ts",
				path: "primary.ts",
				sel: null,
				from: null,
				to: null,
				rangeSuffix: "",
			});
			expect(parseReadArgs({ file_path: "fallback.ts" })).toEqual({
				rawPath: "fallback.ts",
				path: "fallback.ts",
				sel: null,
				from: null,
				to: null,
				rangeSuffix: "",
			});
		});

		it("extracts inline selector and compound selectors", () => {
			const parsed = parseReadArgs({ path: "src/foo.ts:10-50:raw" });
			expect(parsed.rawPath).toBe("src/foo.ts:10-50:raw");
			expect(parsed.path).toBe("src/foo.ts");
			expect(parsed.sel).toBe("10-50:raw");
		});

		it("parses numeric offset and limit into from, to, and rangeSuffix", () => {
			expect(parseReadArgs({ path: "a.ts", offset: 10, limit: 20 })).toEqual({
				rawPath: "a.ts",
				path: "a.ts",
				sel: null,
				from: 10,
				to: 29,
				rangeSuffix: ":10-29",
			});
			expect(parseReadArgs({ path: "a.ts", offset: 5 })).toEqual({
				rawPath: "a.ts",
				path: "a.ts",
				sel: null,
				from: 5,
				to: null,
				rangeSuffix: ":5",
			});
			expect(parseReadArgs({ path: "a.ts", limit: 15 })).toEqual({
				rawPath: "a.ts",
				path: "a.ts",
				sel: null,
				from: 1,
				to: 15,
				rangeSuffix: ":1-15",
			});
		});

		it("rejects non-number offset and limit", () => {
			const parsed = parseReadArgs({ path: "a.ts", offset: "10", limit: "invalid" });
			expect(parsed.from).toBeNull();
			expect(parsed.to).toBeNull();
		});
	});

	describe("parseReadDetails", () => {
		it("parses non-record input gracefully", () => {
			expect(parseReadDetails(null)).toEqual({
				resolvedPath: null,
				suffixTo: null,
				suffixFrom: null,
				elidedSpans: null,
				conflictCount: null,
				truncated: false,
				totalLines: null,
			});
			expect(parseReadDetails("not-an-object")).toEqual({
				resolvedPath: null,
				suffixTo: null,
				suffixFrom: null,
				elidedSpans: null,
				conflictCount: null,
				truncated: false,
				totalLines: null,
			});
		});

		it("parses resolvedPath, suffixResolution, summary, and truncation", () => {
			const details = {
				resolvedPath: "/abs/path/file.ts",
				suffixResolution: { from: "file.js", to: "/abs/path/file.ts" },
				summary: { elidedSpans: 4 },
				conflictCount: 2,
				truncation: { totalLines: 1000 },
			};
			expect(parseReadDetails(details)).toEqual({
				resolvedPath: "/abs/path/file.ts",
				suffixTo: "/abs/path/file.ts",
				suffixFrom: "file.js",
				elidedSpans: 4,
				conflictCount: 2,
				truncated: true,
				totalLines: 1000,
			});
		});
	});

	describe("parseWriteArgs", () => {
		it("prefers path over file_path when both are present", () => {
			expect(parseWriteArgs({ path: "a.ts", file_path: "b.ts", content: "hi" })).toEqual({
				path: "a.ts",
				content: "hi",
				isValidContent: true,
			});
			expect(parseWriteArgs({ file_path: "b.ts", content: "hi" })).toEqual({
				path: "b.ts",
				content: "hi",
				isValidContent: true,
			});
		});

		it("parses valid string content without coercion", () => {
			expect(parseWriteArgs({ path: "src/a.ts", content: "data" })).toEqual({
				path: "src/a.ts",
				content: "data",
				isValidContent: true,
			});
			expect(parseWriteArgs({ path: "src/b.ts", content: "" })).toEqual({
				path: "src/b.ts",
				content: "",
				isValidContent: true,
			});
		});

		it("distinguishes non-string content as invalid without coercion", () => {
			expect(parseWriteArgs({ path: "src/a.ts", content: 12345 })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts", content: { obj: true } })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts", content: [1, 2, 3] })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts", content: true })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts", content: null })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts" })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs("invalid")).toEqual({
				path: null,
				content: null,
				isValidContent: false,
			});
		});
	});

	describe("parseWriteDetails", () => {
		it("parses non-record input gracefully", () => {
			expect(parseWriteDetails(null)).toEqual({
				madeExecutable: false,
				diagnostics: null,
			});
			expect(parseWriteDetails(123)).toEqual({
				madeExecutable: false,
				diagnostics: null,
			});
		});

		it("parses madeExecutable and diagnostics structure", () => {
			const details = {
				madeExecutable: true,
				diagnostics: {
					server: "rust-analyzer",
					messages: ["warning: unused variable", "error: type mismatch"],
					summary: "1 error, 1 warning",
					errored: true,
				},
			};
			expect(parseWriteDetails(details)).toEqual({
				madeExecutable: true,
				diagnostics: {
					server: "rust-analyzer",
					messages: ["warning: unused variable", "error: type mismatch"],
					summary: "1 error, 1 warning",
					errored: true,
				},
			});
		});
	});
});
