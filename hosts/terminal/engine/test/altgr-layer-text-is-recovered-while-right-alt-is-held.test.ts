import { dlopen, FFIType, ptr } from "bun:ffi";
import { describe, expect, it } from "bun:test";
import {
	type AltGrHost,
	createRightAltLatch,
	type KeyboardLayoutHandle,
	RIGHT_ALT_LATCH_MS,
	readAltGrLayer,
	translateWindowsAltGrSequence,
} from "../src/windows-altgr";

const HUNGARIAN = new Map(Object.entries({ "102:0": "[", "103:0": "]", "98:0": "{", "110:0": "}", "113:0": "\\" }));
const host = (layer: ReadonlyMap<string, string>, down: boolean): AltGrHost => ({
	activeLayer: () => layer,
	isRightAltDown: () => down,
});

describe("translateWindowsAltGrSequence", () => {
	it("recovers AltGr text and preserves shortcut keys when AltGr is not held", () => {
		const altGr = host(HUNGARIAN, true);
		const cases: Record<string, string> = {
			"\x1b[102;3u": "[",
			"\x1b[103;7u": "]",
			"\x1b[98;3u": "{",
			"\x1b[110;3u": "}",
			"\x1b[102;131u": "[",
			"\x1b[70;3u": "[",
		};
		for (const seq in cases) expect(translateWindowsAltGrSequence(seq, altGr)).toBe(cases[seq]);
		expect(translateWindowsAltGrSequence("\x1b[102;3u", host(HUNGARIAN, false))).toBeUndefined();
		expect(translateWindowsAltGrSequence("\x1b[102;3u", host(new Map(), true))).toBeUndefined();
		for (const seq of ["\x1b[104;3u", "\x1b[102;5u", "\x1b[102;11u", "\x1b[102;3:3u", "\x1b[102;4u", "\x1b[1;3A"]) {
			expect(translateWindowsAltGrSequence(seq, altGr)).toBeUndefined();
		}
	});
});

describe("createRightAltLatch", () => {
	it("latches Right Alt observation across dispatch batches", () => {
		let down = true,
			now = 1000;
		const isRightAltDown = createRightAltLatch(
			() => down,
			() => now,
		);
		expect(isRightAltDown()).toBe(true);
		down = false;
		now += 1;
		expect(isRightAltDown()).toBe(true);
		now += RIGHT_ALT_LATCH_MS;
		expect(isRightAltDown()).toBe(false);
		const neverDown = createRightAltLatch(
			() => false,
			() => 0,
		);
		expect(neverDown()).toBe(false);
	});
});

describe.skipIf(process.platform !== "win32")("readAltGrLayer (Windows)", () => {
	const user32 =
		process.platform === "win32"
			? dlopen("user32.dll", { LoadKeyboardLayoutW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr } })
			: undefined;
	const load = (klid: string): KeyboardLayoutHandle => {
		const name = new Uint16Array([...klid].map(c => c.charCodeAt(0)).concat(0));
		const hkl = user32!.symbols.LoadKeyboardLayoutW(ptr(name), 0x80);
		if (!hkl) throw new Error(`keyboard layout ${klid} unavailable`);
		return hkl;
	};

	it("maps AltGr layers by base key", () => {
		const layer = readAltGrLayer(load("0000040E"));
		const expected: Record<string, string> = { "102:0": "[", "103:0": "]", "98:0": "{", "110:0": "}" };
		for (const key in expected) expect(layer.get(key)).toBe(expected[key]);
		expect(readAltGrLayer(load("00000409")).size).toBe(0);
	});
});
