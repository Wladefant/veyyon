/**
 * Recover AltGr text that Windows console hosts drop under the kitty keyboard protocol.
 * Windows Terminal / OpenConsole reports AltGr+key as Alt chord without produced text.
 */
import { dlopen, FFIType, type Library, type Pointer, ptr } from "bun:ffi";
import { parseKittySequence } from "@veyyon/utils/keys";

const [KITTY_MOD_SHIFT, KITTY_MOD_ALT, KITTY_MOD_CTRL, KITTY_LOCK_MASK] = [1, 2, 4, 192];
const [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LSHIFT, VK_LCONTROL, VK_RMENU] = [0x10, 0x11, 0x12, 0xa0, 0xa2, 0xa5];
const MAPVK_VK_TO_VSC = 0,
	TOUNICODE_NO_STATE_CHANGE = 0x4;
const [U32, PTR, I32] = ["u32", "ptr", "i32"] as const;

const USER32_SYMBOLS = {
	GetForegroundWindow: { args: [], returns: PTR },
	GetWindowThreadProcessId: { args: [PTR, PTR], returns: U32 },
	GetKeyboardLayout: { args: [U32], returns: PTR },
	GetAsyncKeyState: { args: [I32], returns: FFIType.i16 },
	MapVirtualKeyExW: { args: [U32, U32, PTR], returns: U32 },
	ToUnicodeEx: { args: [U32, U32, PTR, PTR, I32, U32, PTR], returns: I32 },
} as const;

type User32 = Library<typeof USER32_SYMBOLS>;
type AltGrTable = Map<string, string>;
export type KeyboardLayoutHandle = Pointer | bigint;

let user32: User32 | null | undefined;
let cachedLayout: { hkl: KeyboardLayoutHandle | null; table: AltGrTable } | undefined;

function getUser32(): User32 | null {
	if (user32 !== undefined) return user32;
	try {
		user32 = dlopen("user32.dll", USER32_SYMBOLS);
	} catch {
		user32 = null;
	}
	return user32;
}

function isPrintableText(text: string): boolean {
	return (
		text.length > 0 &&
		![...text].some(ch => {
			const cp = ch.codePointAt(0)!;
			return cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
		})
	);
}

function buildAltGrTable(lib: User32, hkl: KeyboardLayoutHandle): AltGrTable {
	const table: AltGrTable = new Map();
	const keyState = new Uint8Array(256),
		buffer = new Uint16Array(8);

	const translate = (vk: number, scan: number, modifiers: readonly number[]): string | undefined => {
		keyState.fill(0);
		for (const modifier of modifiers) keyState[modifier] = 0x80;
		const count = lib.symbols.ToUnicodeEx(
			vk,
			scan,
			ptr(keyState),
			ptr(buffer),
			buffer.length,
			TOUNICODE_NO_STATE_CHANGE,
			hkl,
		);
		if (count <= 0) return undefined;
		const text = String.fromCharCode(...buffer.subarray(0, count));
		return isPrintableText(text) ? text : undefined;
	};

	const altGr = [VK_CONTROL, VK_LCONTROL, VK_MENU, VK_RMENU],
		altGrShift = [...altGr, VK_SHIFT, VK_LSHIFT];
	for (let vk = 0x20; vk <= 0xfe; vk++) {
		if ((vk >= 0x5b && vk <= 0x5f) || (vk >= VK_LSHIFT && vk <= VK_RMENU)) continue;
		const scan = lib.symbols.MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, hkl);
		if (scan === 0) continue;
		const base = translate(vk, scan, []);
		if (base === undefined) continue;
		const baseCodepoint = base.toLowerCase().codePointAt(0)!;
		for (const shift of [false, true]) {
			const key = `${baseCodepoint}:${shift ? 1 : 0}`;
			if (table.has(key)) continue;
			const produced = translate(vk, scan, shift ? altGrShift : altGr);
			if (produced !== undefined) table.set(key, produced);
		}
	}
	return table;
}

function activeLayoutTable(lib: User32): AltGrTable {
	const hwnd = lib.symbols.GetForegroundWindow();
	const thread = hwnd ? lib.symbols.GetWindowThreadProcessId(hwnd, null) : 0;
	const hkl = lib.symbols.GetKeyboardLayout(thread);
	if (cachedLayout && cachedLayout.hkl === hkl) return cachedLayout.table;
	const table = hkl ? buildAltGrTable(lib, hkl) : new Map<string, string>();
	cachedLayout = { hkl, table };
	return table;
}

export function readAltGrLayer(hkl: KeyboardLayoutHandle): ReadonlyMap<string, string> {
	const lib = getUser32();
	return lib && hkl ? buildAltGrTable(lib, hkl) : new Map();
}

export interface AltGrHost {
	activeLayer(): ReadonlyMap<string, string>;
	isRightAltDown(): boolean;
}

const EMPTY_LAYER: ReadonlyMap<string, string> = new Map();
export const RIGHT_ALT_LATCH_MS = 30;

export function createRightAltLatch(isDownNow: () => boolean, now: () => number): () => boolean {
	let lastSeenDown = Number.NEGATIVE_INFINITY;
	return () => {
		const isDown = isDownNow(),
			at = now();
		if (isDown) lastSeenDown = at;
		return isDown || at - lastSeenDown <= RIGHT_ALT_LATCH_MS;
	};
}

const win32Host: AltGrHost = {
	activeLayer() {
		const lib = getUser32();
		return lib ? activeLayoutTable(lib) : EMPTY_LAYER;
	},
	isRightAltDown: createRightAltLatch(() => {
		const lib = getUser32();
		return lib !== null && (lib.symbols.GetAsyncKeyState(VK_RMENU) & 0x8000) !== 0;
	}, performance.now.bind(performance)),
};

export function translateWindowsAltGrSequence(data: string, host: AltGrHost = win32Host): string | undefined {
	if (!data.endsWith("u")) return undefined;
	const parsed = parseKittySequence(data);
	if (!parsed || parsed.eventType === 3) return undefined;
	const modifier = parsed.modifier & ~KITTY_LOCK_MASK;
	if (
		(modifier & KITTY_MOD_ALT) === 0 ||
		(modifier & ~(KITTY_MOD_ALT | KITTY_MOD_CTRL | KITTY_MOD_SHIFT)) !== 0 ||
		parsed.codepoint < 0x20 ||
		(parsed.codepoint >= 0xe000 && parsed.codepoint <= 0xf8ff)
	) {
		return undefined;
	}

	try {
		const layer = host.activeLayer();
		if (layer.size === 0) return undefined;
		const base = String.fromCodePoint(parsed.codepoint).toLowerCase().codePointAt(0)!;
		const text = layer.get(`${base}:${(modifier & KITTY_MOD_SHIFT) !== 0 ? 1 : 0}`);
		return text !== undefined && host.isRightAltDown() ? text : undefined;
	} catch {
		return undefined;
	}
}
