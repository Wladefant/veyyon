import { afterEach, describe, expect, it } from "bun:test";
import {
	__resetWindowsConsoleProbeCache,
	consoleAttachedViaTTY,
	hostHasInheritableConsole,
	shouldDetachKernel,
	shouldHideKernelWindow,
} from "../py/spawn-options";

describe("shouldDetachKernel", () => {
	it("starts POSIX kernels in a new session", () => {
		expect(shouldDetachKernel("darwin")).toBe(true);
		expect(shouldDetachKernel("linux")).toBe(true);
	});

	it("leaves Windows console inheritance to windowsHide", () => {
		expect(shouldDetachKernel("win32")).toBe(false);
	});
});

/** Windows kernels never allocate visible console windows. */
describe("shouldHideKernelWindow", () => {
	it("hides on Windows even when the host has a console", () => {
		expect(shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: true })).toBe(true);
	});

	it("hides on Windows when the host has no console", () => {
		// CREATE_NO_WINDOW here suppresses the console window Windows would
		// otherwise auto-allocate for the console-app Python kernel.
		expect(shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: false })).toBe(true);
	});

	it("never sets windowsHide off-Windows (the option is a Win32-only flag)", () => {
		// On POSIX `windowsHide` is a no-op; the predicate must return false
		// everywhere off-Windows so the spawn site matches pre-fix behavior.
		expect(shouldHideKernelWindow({ platform: "linux", hostHasInheritableConsole: true })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "linux", hostHasInheritableConsole: false })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "darwin", hostHasInheritableConsole: true })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "darwin", hostHasInheritableConsole: false })).toBe(false);
	});
});

describe("consoleAttachedViaTTY (FFI fallback heuristic)", () => {
	// The OR of three TTY signals correctly classifies the realistic shell
	// redirection scenarios that motivated widening the check beyond stdout
	// in the first review pass (PR #1961). The all-three-redirected case
	// (false here) is the gap that the Win32 FFI probe in
	// `hostHasInheritableConsole` is meant to close — this fallback is best-
	// effort.

	it("treats a fully interactive launch as console-attached", () => {
		expect(consoleAttachedViaTTY({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true })).toBe(true);
	});

	it("treats `veyyon -p '...' > out.txt` (stdout-only redirect) as console-attached", () => {
		// The reviewer's first-pass repro: stdout off the terminal, stdin
		// and stderr still attached. OR keeps the console.
		expect(consoleAttachedViaTTY({ stdinIsTTY: true, stdoutIsTTY: false, stderrIsTTY: true })).toBe(true);
	});

	it("treats stdin-only redirects (`< in.txt`) as console-attached", () => {
		expect(consoleAttachedViaTTY({ stdinIsTTY: false, stdoutIsTTY: true, stderrIsTTY: true })).toBe(true);
	});

	it("treats stderr-only redirects (`2> err.log`) as console-attached", () => {
		expect(consoleAttachedViaTTY({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: false })).toBe(true);
	});

	it("returns false only when none of stdin/stdout/stderr is a TTY", () => {
		// This is the gap: a real Windows Terminal session with all three
		// streams redirected (`veyyon ... < in > out 2> err`) lands here.
		// `hostHasInheritableConsole` uses the Win32 FFI probe to recover
		// the right answer in that scenario; this helper is the fallback.
		expect(consoleAttachedViaTTY({ stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false })).toBe(false);
	});
});

describe("hostHasInheritableConsole", () => {
	afterEach(() => {
		__resetWindowsConsoleProbeCache();
	});

	if (process.platform !== "win32") {
		it("matches the TTY-OR fallback off-Windows", () => {
			// Off-Windows, `windowsHide` is a no-op anyway, but we still
			// expose `hostHasInheritableConsole` symmetrically. Confirm it
			// degrades to the same OR the call site would compute by hand.
			const tty = consoleAttachedViaTTY({
				stdinIsTTY: !!process.stdin.isTTY,
				stdoutIsTTY: !!process.stdout.isTTY,
				stderrIsTTY: !!process.stderr.isTTY,
			});
			expect(hostHasInheritableConsole()).toBe(tty);
		});
	}
});
