import { describe, expect, it } from "bun:test";
import {
	consoleAttachedViaTTY,
	shouldDetachKernel,
	shouldHideKernelWindow,
} from "@veyyon/coding-agent/eval/py/spawn-options";

/**
 * spawn-options.ts factors the Python-kernel spawn decisions into pure helpers
 * precisely so they can be unit-tested away from the Win32 FFI probe. They were
 * still untested. Each encodes a real hazard from issue #1960 and the POSIX
 * controlling-terminal problem, so a flipped branch reintroduces a deadlock or a
 * SIGTTIN stop:
 *
 *  - shouldHideKernelWindow must hide every Windows kernel window, including when
 *    the host has an inheritable console.
 *  - shouldDetachKernel must detach (setsid) on every non-Windows platform so a
 *    shell in user code cannot steal Veyyon's controlling terminal.
 *  - consoleAttachedViaTTY is the OR-of-three-streams fallback.
 *
 * These assert the full truth tables.
 */

describe("shouldHideKernelWindow", () => {
	it("hides on Windows when the host has no inheritable console", () => {
		expect(shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: false })).toBe(true);
	});

	it("hides on Windows when a console is inheritable", () => {
		expect(shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: true })).toBe(true);
	});

	it("never hides off Windows regardless of console state", () => {
		expect(shouldHideKernelWindow({ platform: "linux", hostHasInheritableConsole: false })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "darwin", hostHasInheritableConsole: true })).toBe(false);
	});
});

describe("shouldDetachKernel", () => {
	it("detaches on every non-Windows platform and never on Windows", () => {
		expect(shouldDetachKernel("linux")).toBe(true);
		expect(shouldDetachKernel("darwin")).toBe(true);
		expect(shouldDetachKernel("win32")).toBe(false);
	});
});

describe("consoleAttachedViaTTY", () => {
	it("is true when any stream is a TTY and false only when none are", () => {
		expect(consoleAttachedViaTTY({ stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false })).toBe(false);
		expect(consoleAttachedViaTTY({ stdinIsTTY: true, stdoutIsTTY: false, stderrIsTTY: false })).toBe(true);
		expect(consoleAttachedViaTTY({ stdinIsTTY: false, stdoutIsTTY: true, stderrIsTTY: false })).toBe(true);
		expect(consoleAttachedViaTTY({ stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: true })).toBe(true);
		expect(consoleAttachedViaTTY({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true })).toBe(true);
	});
});
