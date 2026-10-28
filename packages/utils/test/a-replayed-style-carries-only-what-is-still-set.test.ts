/**
 * WHY: a renderer that cuts styled text replays the SGR state open at the cut (`sgrCarryAfter`). The carry
 * kept every sequence since the last full reset (`ESC [ 0 m`), but theme styling closes each span with the
 * attribute's own off code (`ESC [ 39 m`, `ESC [ 22 m`), so the carry grew with every span it crossed. A
 * streamed `Text` replays its carry into each new line's wrap, and the last row of an N-line block carried N
 * dead color pairs: streaming 2000 styled lines took 17 s.
 *
 * The class closed here: a carry holds each attribute still set and nothing else, for every attribute an SGR
 * sequence can set and every spelling of its off code, and it never drops an attribute that is still set.
 * Every pair of attributes in `ATTRIBUTES` is swept against each other, and every carry the sweep produces
 * reads back as itself.
 *
 * Not caught: an attribute missing from `ATTRIBUTES` (the table follows ECMA-48 and xterm, not a list in
 * source), and whether a terminal draws a replayed carry the way it drew the original sequences.
 */
import { describe, expect, it } from "bun:test";
import { sgrCarryAfter } from "@veyyon/utils/sgr";

const sgr = (params: string) => `\x1b[${params}m`;

interface Attribute {
	readonly name: string;
	/** A sequence that sets the attribute. */
	readonly set: string;
	/** The attribute's off code. */
	readonly clear: string;
	/** What the attribute is, as `clears` lists it. */
	readonly kind: string;
	/** Every kind of attribute `clear` turns off. */
	readonly clears: readonly string[];
}

function attribute(name: string, set: string, clear: string, kind: string, clears: string[] = [kind]): Attribute {
	return { name, set: sgr(set), clear: sgr(clear), kind, clears };
}

const ATTRIBUTES: Attribute[] = [
	attribute("bold", "1", "22", "bold", ["bold", "dim"]),
	attribute("dim", "2", "22", "dim", ["bold", "dim"]),
	attribute("italic", "3", "23", "italic", ["italic", "fraktur"]),
	attribute("fraktur", "20", "23", "fraktur", ["italic", "fraktur"]),
	attribute("underline", "4", "24", "underline"),
	attribute("curly underline, colon spelling", "4:3", "4:0", "underline"),
	attribute("double underline", "21", "24", "underline"),
	attribute("blink", "5", "25", "blink"),
	attribute("rapid blink", "6", "25", "blink"),
	attribute("inverse", "7", "27", "inverse"),
	attribute("hidden", "8", "28", "hidden"),
	attribute("strikethrough", "9", "29", "strike"),
	attribute("alternative font", "11", "10", "font"),
	attribute("proportional spacing", "26", "50", "proportional"),
	attribute("framed", "51", "54", "frame"),
	attribute("encircled", "52", "54", "frame"),
	attribute("overline", "53", "55", "overline"),
	attribute("ideogram underline", "60", "65", "ideogram"),
	attribute("superscript", "73", "75", "script"),
	attribute("foreground", "31", "39", "foreground"),
	attribute("bright foreground", "91", "39", "foreground"),
	// Index 1 and the channels 2, 1, 3 also read as bold, dim and italic when the color's parameters are not
	// consumed, so these rows fail if the parser reads them as codes.
	attribute("256-color foreground", "38;5;1", "39", "foreground"),
	attribute("truecolor foreground", "38;2;2;1;3", "39", "foreground"),
	attribute("truecolor foreground, colon spelling", "38:2::2:1:3", "39", "foreground"),
	attribute("background", "41", "49", "background"),
	attribute("bright background", "101", "49", "background"),
	attribute("256-color background", "48;5;4", "49", "background"),
	attribute("truecolor background", "48;2;4;5;7", "49", "background"),
	attribute("underline color", "58;5;9", "59", "underline color"),
	attribute("truecolor underline color, colon spelling", "58:2::1:2:3", "59", "underline color"),
];

/** Sequences no attribute holds: once set, only a full reset clears them. */
const UNKNOWN = [sgr("70"), sgr("38;9"), sgr("38;5"), sgr("48;2;1;2")];

const RESETS = [sgr("0"), sgr(""), sgr(";"), sgr("1;0")];

describe("a replayed style", () => {
	it.each(ATTRIBUTES)("carries $name while it is set and nothing once it is cleared", ({ set, clear }) => {
		expect(sgrCarryAfter("", `${set}span`)).toBe(set);
		expect(sgrCarryAfter("", `${set}span${clear}`)).toBe("");
		expect(sgrCarryAfter(sgrCarryAfter("", `${set}span`), `more${clear} tail`)).toBe("");
	});

	it("keeps an attribute that is still set when another one is set and cleared", () => {
		for (const outer of ATTRIBUTES) {
			for (const inner of ATTRIBUTES) {
				const carry = sgrCarryAfter("", `${outer.set}a${inner.set}b${inner.clear}c`);
				const cleared = inner.clears.includes(outer.kind);
				expect({ outer: outer.name, inner: inner.name, carry }).toEqual({
					outer: outer.name,
					inner: inner.name,
					carry: cleared ? "" : outer.set,
				});
				// A carry reads back as itself, so carrying it again never grows it.
				expect(sgrCarryAfter("", carry)).toBe(carry);
			}
		}
	});

	it("replays every attribute still set, the last value of each", () => {
		expect(sgrCarryAfter("", `${sgr("31")}a${sgr("1")}b`)).toBe(sgr("31;1"));
		expect(sgrCarryAfter("", `${sgr("31")}a${sgr("32")}b`)).toBe(sgr("32"));
		expect(sgrCarryAfter("", `${sgr("4:3")}a${sgr("4")}b`)).toBe(sgr("4"));
		expect(sgrCarryAfter("", `${sgr("1;31")}x${sgr("39")}`)).toBe(sgr("1"));
		expect(sgrCarryAfter("", `${sgr("1;31")}x${sgr("22;39")}`)).toBe("");
		expect(sgrCarryAfter(sgr("1"), "plain text")).toBe(sgr("1"));
	});

	it("clears every attribute at a full reset, in each spelling", () => {
		const everything = ATTRIBUTES.map(({ set }) => set).join("") + UNKNOWN.join("");
		for (const reset of RESETS) {
			expect(sgrCarryAfter("", `${everything}text${reset}`)).toBe("");
			expect(sgrCarryAfter("", `${everything}text${reset}${sgr("31")}red`)).toBe(sgr("31"));
		}
	});

	it("keeps a sequence no attribute holds, as written, until a full reset", () => {
		const clearAll = ATTRIBUTES.map(({ clear }) => clear).join("");
		for (const unknown of UNKNOWN) {
			expect(sgrCarryAfter("", `${unknown}x${clearAll}`)).toBe(unknown);
			expect(sgrCarryAfter("", `${unknown}x${unknown}y${unknown}`)).toBe(unknown);
			expect(sgrCarryAfter("", `${unknown}x${sgr("0")}`)).toBe("");
		}
	});

	it("stays the size of what is set across any number of spans", () => {
		let carry = "";
		for (let line = 0; line < 10_000; line++) {
			carry = sgrCarryAfter(carry, `${sgr("38;2;139;144;153")}line ${line}${sgr("39")}`);
			expect(carry).toBe("");
		}
		carry = sgrCarryAfter(carry, `${sgr("1")}open`);
		for (let line = 0; line < 10_000; line++) {
			carry = sgrCarryAfter(carry, `${sgr("31")}line ${line}${sgr("39")}`);
			expect(carry).toBe(sgr("1"));
		}
	});
});
