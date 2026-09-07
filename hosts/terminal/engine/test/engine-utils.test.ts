import { describe, expect, it } from "bun:test";
import { formatBorderRule, frameBorderLines } from "../src/utils/border";
import { HoverController } from "../src/utils/hover-controller";
import { computeThumbRange, handleStandardScrollKey } from "../src/utils/scroll-layout";
import { formatSearchStatus, handleSearchKeyInput } from "../src/utils/search-filter";
import { applyLineBackground, dropLastCodePoint, firstGrapheme, lastGrapheme } from "../src/utils/text-layout";

describe("engine-utils", () => {
	describe("border", () => {
		it("formats horizontal border rule with exact widths", () => {
			const rule = formatBorderRule("┌", "─", 8, "┐");
			expect(rule).toBe("┌────────┐");
		});

		it("formats border rule with colorizer", () => {
			const color = (s: string) => `\x1b[31m${s}\x1b[0m`;
			const rule = formatBorderRule("┌", "─", 3, "┐", color);
			expect(rule).toBe("\x1b[31m┌───┐\x1b[0m");
		});

		it("frames interior lines with vertical borders", () => {
			const framed = frameBorderLines(["hello", "world"], "│");
			expect(framed).toEqual(["│hello│", "│world│"]);
		});
	});

	describe("hover-controller", () => {
		it("tracks hover target and provides strength", () => {
			const controller = new HoverController<string>();
			expect(controller.key).toBeNull();
			expect(controller.strength("item-1")).toBe(0);

			controller.set("item-1");
			expect(controller.key).toBe("item-1");
			expect(controller.strength("item-1")).toBe(1);
			expect(controller.strength("item-2")).toBe(0);

			controller.set(null);
			expect(controller.key).toBeNull();
			expect(controller.strength("item-1")).toBe(0);
			controller.dispose();
		});
	});

	describe("scroll-layout", () => {
		it("computes thumb range correctly across viewports and bounds", () => {
			expect(computeThumbRange(0, 100, 0)).toEqual({ start: 0, end: 0 });
			expect(computeThumbRange(10, 5, 0)).toEqual({ start: 0, end: 10 });
			const range = computeThumbRange(10, 20, 5);
			expect(range.start).toBeGreaterThanOrEqual(0);
			expect(range.end).toBeLessThanOrEqual(10);
			expect(range.end).toBeGreaterThan(range.start);
		});

		it("handles standard scroll keys with callback routing", () => {
			let scrolled = 0;
			let paged = 0;
			let toTop = false;
			let toBottom = false;

			const scroll = (d: number) => {
				scrolled += d;
			};
			const page = (d: number) => {
				paged += d;
			};
			const scrollToTop = () => {
				toTop = true;
			};
			const scrollToBottom = () => {
				toBottom = true;
			};

			expect(handleStandardScrollKey("\x1b[A", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(scrolled).toBe(-1);

			expect(handleStandardScrollKey("\x1b[B", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(scrolled).toBe(0);

			expect(handleStandardScrollKey("\x1b[5~", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(paged).toBe(-1);

			expect(handleStandardScrollKey("\x1b[6~", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(paged).toBe(0);

			expect(handleStandardScrollKey("\x1b[H", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(toTop).toBe(true);

			expect(handleStandardScrollKey("\x1b[F", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(toBottom).toBe(true);

			expect(handleStandardScrollKey("other-key", scroll, page, scrollToTop, scrollToBottom)).toBe(false);
		});
	});

	describe("search-filter", () => {
		it("formats search status accurately", () => {
			const hint = (s: string) => `[${s}]`;
			expect(formatSearchStatus("", 30, hint)).toBe("[  Type to search]");
			expect(formatSearchStatus("abc", 30, hint)).toBe("[  Search: abc]");
		});

		it("handles backspace and deletes one code point including unicode", () => {
			expect(handleSearchKeyInput("\x7f", "abc", true, true)).toBe("ab");
			expect(handleSearchKeyInput("\x7f", "a😊", true, true)).toBe("a");
			expect(handleSearchKeyInput("\x7f", "", true, true)).toBe("");
			expect(handleSearchKeyInput("x", "abc", true, true)).toBe("abcx");
			expect(handleSearchKeyInput("\x1b", "abc", true, true)).toBeNull();
		});
	});

	describe("text-layout", () => {
		it("extracts first and last graphemes", () => {
			expect(firstGrapheme("hello")).toBe("h");
			expect(firstGrapheme("")).toBe("");
			expect(lastGrapheme("hello")).toBe("o");
			expect(lastGrapheme("")).toBe("");
		});

		it("drops last code point handling surrogate pairs", () => {
			expect(dropLastCodePoint("hello")).toBe("hell");
			expect(dropLastCodePoint("test😊")).toBe("test");
			expect(dropLastCodePoint("")).toBe("");
		});

		it("applies line background color preserving SGR", () => {
			const res = applyLineBackground("hello", 10, s => `\x1b[44m${s}\x1b[0m`);
			expect(res).toContain("\x1b[44m");
			expect(res).toContain("hello");
		});
	});
});
