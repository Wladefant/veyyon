import { afterEach, describe, expect, it } from "bun:test";
import type { Component } from "@veyyon/tui";
import { matchesKey } from "@veyyon/utils/keys";
import { Win32InputModeDecoder } from "../src/windows-input-mode";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

// Records as the Windows console host emits them: CSI Vk;Sc;Uc;Kd;Cs;Rc _
const SHIFT_ENTER = "\x1b[13;28;13;1;16;1_";
const CTRL_ENTER = "\x1b[13;28;10;1;8;1_";
const ENTER = "\x1b[13;28;13;1;0;1_";
const ENTER_UP = "\x1b[13;28;13;0;0;1_";

function decodeOne(data: string): string {
	const keys = new Win32InputModeDecoder().decode(data);
	expect(keys).toHaveLength(1);
	return keys![0]!;
}

describe("Win32InputModeDecoder", () => {
	it("keeps Shift+Enter and Ctrl+Enter distinct from Enter", () => {
		expect(decodeOne(ENTER)).toBe("\r");
		expect(matchesKey(decodeOne(SHIFT_ENTER), "shift+enter")).toBe(true);
		expect(matchesKey(decodeOne(CTRL_ENTER), "ctrl+enter")).toBe(true);
		expect(matchesKey(decodeOne(CTRL_ENTER), "enter")).toBe(false);
	});

	it("drops key releases and bare modifier presses", () => {
		const decoder = new Win32InputModeDecoder();
		expect(decoder.decode(ENTER_UP)).toEqual([]);
		expect(decoder.decode("\x1b[16;42;0;1;16;1_")).toEqual([]);
		expect(decoder.decode("\x1b[17;29;0;1;8;1_")).toEqual([]);
	});

	it("passes non-record sequences through untouched", () => {
		const decoder = new Win32InputModeDecoder();
		expect(decoder.decode("\x1b[A")).toBeUndefined();
		expect(decoder.decode("\x1b[200~")).toBeUndefined();
		expect(decoder.decode("a")).toBeUndefined();
	});

	it("decodes text, control and Alt chords to the legacy bytes key matching expects", () => {
		expect(decodeOne("\x1b[65;30;97;1;0;1_")).toBe("a");
		expect(decodeOne("\x1b[65;30;65;1;16;1_")).toBe("A");
		expect(matchesKey(decodeOne("\x1b[67;46;3;1;8;1_"), "ctrl+c")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[66;48;98;1;2;1_"), "alt+b")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[9;15;9;1;16;1_"), "shift+tab")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[8;14;8;1;2;1_"), "alt+backspace")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[27;1;27;1;0;1_"), "escape")).toBe(true);
	});

	it("keeps Ctrl+Shift+letter distinct from Ctrl+letter", () => {
		const ctrlShiftP = decodeOne("\x1b[80;25;16;1;24;1_");
		expect(matchesKey(ctrlShiftP, "ctrl+shift+p")).toBe(true);
		expect(matchesKey(ctrlShiftP, "ctrl+p")).toBe(false);
	});

	it("encodes navigation keys with their modifiers", () => {
		expect(matchesKey(decodeOne("\x1b[38;72;0;1;256;1_"), "up")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[38;72;0;1;264;1_"), "ctrl+up")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[46;83;0;1;256;1_"), "delete")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[116;63;0;1;0;1_"), "f5")).toBe(true);
	});

	it("emits AltGr-composed text instead of a Ctrl+Alt chord", () => {
		// German layout: AltGr+Q → "@" reported as Right Alt + Left Ctrl.
		expect(decodeOne("\x1b[81;16;64;1;9;1_")).toBe("@");
	});

	it("joins surrogate halves delivered as separate records", () => {
		const decoder = new Win32InputModeDecoder();
		expect(decoder.decode("\x1b[231;0;55357;1;0;1_")).toEqual([]);
		expect(decoder.decode("\x1b[231;0;56832;1;0;1_")).toEqual(["😀"]);
	});

	it("delivers Alt+Numpad composition on the Alt release", () => {
		expect(new Win32InputModeDecoder().decode("\x1b[18;56;233;0;32;1_")).toEqual(["é"]);
	});

	it("repeats auto-repeated keys", () => {
		expect(new Win32InputModeDecoder().decode("\x1b[65;30;97;1;0;3_")).toEqual(["a", "a", "a"]);
	});

	it("rejects malformed, out-of-range, and overflow record fields without allocation", () => {
		const decoder = new Win32InputModeDecoder();
		// Unbounded / huge repeat count must not throw RangeError or allocate
		expect(decoder.decode("\x1b[13;28;13;1;0;999999999999999999_")).toBeUndefined();
		// Overflow ushort repeat count (> 65535)
		expect(decoder.decode("\x1b[13;28;13;1;0;65536_")).toBeUndefined();
		// Zero repeat count
		expect(decoder.decode("\x1b[13;28;13;1;0;0_")).toBeUndefined();
		// Negative or non-numeric repeat count
		expect(decoder.decode("\x1b[13;28;13;1;0;-1_")).toBeUndefined();
		// Overflow Uc (> 65535)
		expect(decoder.decode("\x1b[13;28;65536;1;0;1_")).toBeUndefined();
		// Overflow Cs flags (> 4294967295)
		expect(decoder.decode("\x1b[13;28;13;1;4294967296;1_")).toBeUndefined();
		// Overflow Vk (> 65535)
		expect(decoder.decode("\x1b[65536;28;13;1;0;1_")).toBeUndefined();
	});

	it("accepts valid boundary values for ushort and uint32 fields", () => {
		const decoder = new Win32InputModeDecoder();
		// Valid max ushort repeat count (65535)
		const maxRepeat = decoder.decode("\x1b[65;30;97;1;0;65535_");
		expect(maxRepeat).toBeDefined();
		expect(maxRepeat).toHaveLength(65535);
		expect(maxRepeat![0]).toBe("a");
		// Valid max uint32 Cs flags (4294967295)
		expect(decoder.decode("\x1b[65;30;97;1;4294967295;1_")).toBeDefined();
		// Valid max ushort Uc (65535)
		expect(decoder.decode("\x1b[0;0;65535;1;0;1_")).toEqual([String.fromCharCode(65535)]);
	});
});

class InputRecorder implements Component {
	received: string[] = [];
	invalidate(): void {}
	render(): string[] {
		return [""];
	}
	handleInput(data: string): void {
		this.received.push(data);
	}
}

describe("ProcessTerminal win32-input-mode fallback", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("enables win32-input-mode on a native console without kitty and decodes key records", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		const recorder = new InputRecorder();
		harness.tui.addChild(recorder);
		harness.tui.setFocus(recorder);
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c");
		const out = harness.writes.join("");
		expect(out).toContain("\x1b[?9001h");
		expect(out).not.toContain("\x1b[>4;2m");

		await harness.feed(SHIFT_ENTER, ENTER_UP, CTRL_ENTER);
		expect(recorder.received).toHaveLength(2);
		expect(matchesKey(recorder.received[0]!, "shift+enter")).toBe(true);
		expect(matchesKey(recorder.received[1]!, "ctrl+enter")).toBe(true);

		harness.writes.length = 0;
		harness.tui.stop();
		expect(harness.writes.join("")).toContain("\x1b[?9001l");
	});

	it("prefers a late kitty reply and turns win32-input-mode back off", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?1;2c", "\x1b[?0u");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		expect(out.indexOf("\x1b[?9001l")).toBeGreaterThan(out.indexOf("\x1b[?9001h"));
		expect(out).toContain("\x1b[>1u");
	});
});
