/**
 * WHY. `sliceTailBytes` keeps the tail of a string under a byte budget by walking characters off its
 * front, where `truncateTailBytes` encodes the window and decodes the cut. The class this closes: a
 * walk that counts a character at the wrong width, splits a surrogate pair, or stops one character
 * early or late, so the kept tail or its byte count differs from the encoder's cut. The first and last
 * code point of every UTF-8 width is swept, against the encoder as the oracle, under every budget from
 * below zero to past the text.
 *
 * Not caught: that the tail shares the input's storage, which no returned value states.
 */
import { describe, expect, it } from "bun:test";
import { sliceTailBytes, truncateTailBytes } from "../src/byte-truncate";

/**
 * The first and last code point of each UTF-8 width, one to four bytes, with the two either side of
 * the surrogate range; a four-byte character is a surrogate pair.
 */
const BOUNDARIES = [
	"\u0000",
	"\u007F",
	"\u0080",
	"\u07FF",
	"\u0800",
	"\uD7FF",
	"\uE000",
	"\uFFFF",
	"\u{10000}",
	"\u{10FFFF}",
];

describe("sliceTailBytes", () => {
	it("keeps the tail and the byte count the encoder keeps, for every character width and budget", () => {
		// Every character follows every other, so each budget cuts at each boundary between two widths.
		const text = BOUNDARIES.flatMap(first => BOUNDARIES.map(second => first + second)).join("");
		const total = Buffer.byteLength(text, "utf-8");
		for (let max = -1; max <= total + 1; max++) {
			expect({ max, ...sliceTailBytes(text, max) }).toEqual({ max, ...truncateTailBytes(text, max) });
		}
	});

	it("keeps a lone surrogate as it is, counting the three bytes of the U+FFFD it encodes to", () => {
		for (const lone of ["\uD800", "\uDC00"]) {
			expect({ lone, kept: sliceTailBytes(`ab${lone}c`, 4) }).toEqual({ lone, kept: { text: `${lone}c`, bytes: 4 } });
			expect({ lone, kept: sliceTailBytes(`ab${lone}c`, 3) }).toEqual({ lone, kept: { text: "c", bytes: 1 } });
		}
		// Two low surrogates are two characters, and so is the last character below the surrogates
		// followed by one.
		for (const first of ["\uDC00", "\uD7FF"]) {
			expect({ first, kept: sliceTailBytes(`${first}\uDC00c`, 4) }).toEqual({
				first,
				kept: { text: "\uDC00c", bytes: 4 },
			});
		}
	});
});
