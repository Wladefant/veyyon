/**
 * The band suites compare colours read through `band-colors.ts`, mostly by ordering distances
 * against a grey ground, where a swapped or dropped channel changes no comparison. This pins each
 * channel so a helper that misreads one fails here rather than passing every band suite.
 */
import { describe, expect, it } from "bun:test";
import { bandRgb, hexRgb, rgbDistance } from "./band-colors";

describe("band colour helpers", () => {
	it("read every channel of the first truecolor background a row paints", () => {
		expect(bandRgb("\x1b[1;38;2;1;2;3;48;2;10;20;30mband\x1b[48;2;40;50;60mnext")).toEqual([10, 20, 30]);
	});

	it("read no band from a row that paints no truecolor background", () => {
		expect(bandRgb("\x1b[38;2;10;20;30mfg only\x1b[0m")).toBeNull();
	});

	it("read every channel of a hex colour", () => {
		expect(hexRgb("#0a141e")).toEqual([10, 20, 30]);
	});

	it("sum the per-channel distance in both directions", () => {
		expect(rgbDistance([10, 20, 30], [13, 16, 30])).toBe(7);
		expect(rgbDistance([13, 16, 30], [10, 20, 30])).toBe(7);
		expect(rgbDistance([0, 0, 5], [0, 0, 0])).toBe(5);
	});
});
