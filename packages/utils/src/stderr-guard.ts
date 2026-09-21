/**
 * Terminal stderr guard: keeps unmanaged fd-2 writes off the terminal while a
 * TUI owns the viewport.
 *
 * On macOS, runtime diagnostics are written by the platform directly to file
 * descriptor 2 at arbitrary times — e.g. libmalloc's "MallocStackLogging:
 * can't turn off malloc stack logging because it was not enabled" when the OS
 * broadcasts a memory-diagnostic event to long-lived processes. Those bytes
 * bypass the renderer and paint straight into the viewport. Stripping the
 * MallocStackLogging* env vars (cli.ts) only protects child processes; it
 * cannot stop libmalloc inside THIS process from logging.
 *
 * Fix (mirrors openai/codex#24459): while the TUI owns the terminal, dup fd 2
 * aside and dup2 a redirect target over it; restore the saved fd whenever
 * terminal ownership is released (external editor, Ctrl+Z suspend, shutdown,
 * crash restore). Unlike codex we redirect to the veyyon log file — not
 * /dev/null — so the diagnostics stay greppable and Bun native-crash reports
 * (which abort before any JS cleanup can restore fd 2) are preserved.
 *
 * WINDOWS TAKES THE OTHER HALF OF THAT SENTENCE. There is no libmalloc noise to
 * suppress, but the crash-report half matters more here than anywhere: a Bun
 * panic prints and the console window closes with it, so the report is gone and
 * the log holds nothing (issue #73). fd 2 cannot carry the fix — `ucrtbase`
 * exports `_dup`/`_dup2`, but Bun's fds are not that CRT's fds, and dup2'ing
 * over fd 2 killed the process on the next write with no output at all
 * (measured). What the panic printer actually resolves through is the process
 * standard-handle table, so the win32 branch re-points STD_ERROR_HANDLE at the
 * log and leaves fd 2 alone: JS writes keep reaching the terminal, and the
 * native abort trace lands in the day's log. Spawned children are unaffected —
 * Bun's `inherit` stdio carries its own captured handle, not this one
 * (measured).
 *
 * Only dup/dup2 and the four standard-handle calls go through bun:ffi; there is
 * no portable equivalent for either. `node:fs` has no dup/dup2, and it hands out
 * file descriptors with no way to obtain the Win32 HANDLE behind one or to write
 * the process standard-handle table. fcntl is deliberately avoided: it is
 * variadic, and the arm64-darwin ABI passes variadic arguments on the stack,
 * so a fixed-arity FFI signature would read garbage for the third argument.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogPath } from "./dirs";

const STDOUT_FILENO = 1;
const STDERR_FILENO = 2;

interface LibcFdOps {
	dup(fd: number): number;
	dup2(oldFd: number, newFd: number): number;
}

let libcFdOpsCache: LibcFdOps | null | undefined;

function libcFdOps(): LibcFdOps | null {
	if (libcFdOpsCache !== undefined) return libcFdOpsCache;
	libcFdOpsCache = null;
	if (process.platform === "win32") return null;
	// Darwin: dyld resolves libSystem from the shared cache. Linux: glibc
	// first, then the generic soname for musl-style layouts.
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		try {
			const libc = dlopen(candidate, {
				dup: { args: [FFIType.i32], returns: FFIType.i32 },
				dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			});
			libcFdOpsCache = libc.symbols;
			return libcFdOpsCache;
		} catch {
			// Try the next candidate; the guard stays inert if none load.
		}
	}
	return libcFdOpsCache;
}

/**
 * True when fd 2 writes would land on the same terminal the TUI paints to:
 * both stdout and stderr are ttys backed by the same device file. A stderr
 * the user already redirected (`2>file`, `2>/dev/null`, a different tty) must
 * keep flowing untouched.
 */
function stderrSharesStdoutTerminal(): boolean {
	if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
	// Windows answers the device question with `isTTY` alone. The two standard
	// handles of ONE console are distinct HANDLE values, and `fstat` reports the
	// raw handle as `ino` (measured), so the identity check below would refuse
	// every real console. There is also nothing for it to catch: a `2>file`
	// stderr is not a character device and has already failed `isTTY`, and a
	// second console to redirect the first into is not a thing Windows has.
	if (process.platform === "win32") return true;
	try {
		const stdoutStat = fs.fstatSync(STDOUT_FILENO);
		const stderrStat = fs.fstatSync(STDERR_FILENO);
		return stdoutStat.dev === stderrStat.dev && stdoutStat.ino === stderrStat.ino;
	} catch {
		// Cannot prove the two fds share a terminal, so assume they do not and LEAVE STDERR ALONE. False is
		// the conservative answer: redirecting a stderr that was not ours to redirect would swallow output
		// the user is watching, which is worse than a few stray writes over the TUI.
		return false;
	}
}

/** `(DWORD)-12`: the standard-error slot of the process handle table. */
const STD_ERROR_HANDLE = 0xfffffff4;
/** `INVALID_HANDLE_VALUE`, which `CreateFileW` returns on failure. */
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const FILE_APPEND_DATA = 0x0004;
const FILE_SHARE_READ_WRITE = 0x0003;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x0080;

/**
 * The four kernel32 calls the win32 branch needs. HANDLE is 64 bits on the only
 * Windows target Bun builds for, so it crosses the boundary as `u64` and arrives
 * as a bigint — which is also how `INVALID_HANDLE_VALUE` stays comparable
 * instead of collapsing into an imprecise double.
 */
interface Win32StdHandleOps {
	GetStdHandle(slot: number): bigint;
	SetStdHandle(slot: number, handle: bigint): number;
	CreateFileW(
		name: Uint8Array,
		access: number,
		share: number,
		security: bigint,
		disposition: number,
		flags: number,
		template: bigint,
	): bigint;
	CloseHandle(handle: bigint): number;
}

let win32StdHandleOpsCache: Win32StdHandleOps | null | undefined;

function win32StdHandleOps(): Win32StdHandleOps | null {
	if (win32StdHandleOpsCache !== undefined) return win32StdHandleOpsCache;
	win32StdHandleOpsCache = null;
	if (process.platform !== "win32") return null;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },
			SetStdHandle: { args: [FFIType.u32, FFIType.u64], returns: FFIType.i32 },
			CreateFileW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u64],
				returns: FFIType.u64,
			},
			CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
		});
		win32StdHandleOpsCache = kernel32.symbols;
		return win32StdHandleOpsCache;
	} catch {
		// bun:ffi unavailable; the guard stays inert.
		return win32StdHandleOpsCache;
	}
}

/** The standard-error handle displaced by the win32 capture, else null. */
let win32Capture: { ops: Win32StdHandleOps; original: bigint; redirect: bigint } | null = null;

/**
 * Point the process standard-error handle at `redirectPath`, so a native abort
 * that prints through it lands in the log instead of in a console window that is
 * about to close. fd 2 is untouched, so every JS write still reaches the
 * terminal. Returns false when the handle table cannot be reached or the target
 * cannot be opened.
 */
function captureWin32StandardError(redirectPath: string): boolean {
	const ops = win32StdHandleOps();
	if (!ops) return false;
	try {
		// getLogsDir() only computes the path; the logger creates it lazily, so
		// on a fresh profile the logs directory may not exist yet.
		fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
	} catch {
		// A target directory that cannot be created is a target that cannot be
		// opened; CreateFileW below reports it and the guard stays out.
	}
	// UTF-16LE with the terminating NUL, which is what the W entry point reads.
	const widePath = Buffer.from(`${redirectPath}\0`, "utf16le");
	const redirect = ops.CreateFileW(
		widePath,
		FILE_APPEND_DATA,
		FILE_SHARE_READ_WRITE,
		0n,
		OPEN_ALWAYS,
		FILE_ATTRIBUTE_NORMAL,
		0n,
	);
	if (redirect === INVALID_HANDLE_VALUE) return false;
	const original = ops.GetStdHandle(STD_ERROR_HANDLE);
	if (ops.SetStdHandle(STD_ERROR_HANDLE, redirect) === 0) {
		ops.CloseHandle(redirect);
		return false;
	}
	win32Capture = { ops, original, redirect };
	return true;
}

/** Undo {@link captureWin32StandardError}. True when a capture was active. */
function releaseWin32StandardError(): boolean {
	if (win32Capture === null) return false;
	const { ops, original, redirect } = win32Capture;
	win32Capture = null;
	ops.SetStdHandle(STD_ERROR_HANDLE, original);
	ops.CloseHandle(redirect);
	return true;
}

/** Saved dup of the real stderr while suppression is active, else null. */
let savedStderrFd: number | null = null;

export interface SuppressTerminalStderrOptions {
	/** Redirect target path; defaults to today's veyyon log file, then /dev/null. */
	redirectPath?: string;
	/** Bypass the platform + same-terminal gate. Tests only. */
	force?: boolean;
}

/**
 * Point the process's crash-time stderr at the veyyon log while the TUI owns
 * the viewport, so a diagnostic written below the renderer is greppable
 * afterwards instead of painted over the frame or lost with the window.
 *
 * WHICH STDERR MOVES DEPENDS ON THE PLATFORM, and the module header says why.
 * macOS redirects fd 2, so stray libmalloc writes stop reaching the viewport.
 * Windows redirects the standard-error handle the Bun panic printer resolves
 * through and leaves fd 2 alone, so JS writes keep reaching the terminal.
 *
 * Returns true when the guard is (already) installed. No-op — returning false —
 * on Linux, when stderr does not target the stdout terminal, or when the
 * platform calls it needs are unavailable.
 */
export function suppressTerminalStderr(options?: SuppressTerminalStderrOptions): boolean {
	if (savedStderrFd !== null || win32Capture !== null) return true;
	const platformWantsGuard = process.platform === "darwin" || process.platform === "win32";
	if (!options?.force && (!platformWantsGuard || !stderrSharesStdoutTerminal())) {
		return false;
	}
	if (process.platform === "win32") {
		return captureWin32StandardError(options?.redirectPath ?? getLogPath());
	}
	const libc = libcFdOps();
	if (!libc) return false;
	let redirectFd: number;
	try {
		const redirectPath = options?.redirectPath ?? getLogPath();
		// getLogsDir() only computes the path; the logger creates it lazily, so
		// on a fresh profile ~/.veyyon/profiles/<name>/logs may not exist yet. Create it here so
		// diagnostics land in the log instead of falling through to /dev/null.
		fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
		redirectFd = fs.openSync(redirectPath, "a");
	} catch {
		try {
			redirectFd = fs.openSync("/dev/null", "w");
		} catch {
			// Neither the log file nor /dev/null could be opened, so there is nowhere to send fd 2 and the
			// guard is not installed. False is the caller's signal to carry on without it, which it reports;
			// installing a guard that pointed at a broken fd would lose the diagnostics entirely.
			return false;
		}
	}

	const saved = libc.dup(STDERR_FILENO);
	if (saved === -1) {
		fs.closeSync(redirectFd);
		return false;
	}
	if (libc.dup2(redirectFd, STDERR_FILENO) === -1) {
		fs.closeSync(redirectFd);
		fs.closeSync(saved);
		return false;
	}
	fs.closeSync(redirectFd);
	savedStderrFd = saved;
	return true;
}

/**
 * Re-point the process's stderr at the terminal it came from. Safe to call
 * unconditionally: no-op when the guard is not installed. Called at every
 * terminal-ownership release and by the postmortem fatal handlers before they
 * print, so crash reports reach the real terminal.
 */
export function restoreTerminalStderr(): void {
	if (releaseWin32StandardError()) return;
	if (savedStderrFd === null) return;
	const saved = savedStderrFd;
	savedStderrFd = null;
	libcFdOps()?.dup2(saved, STDERR_FILENO);
	try {
		fs.closeSync(saved);
	} catch {
		// The dup'ed fd is process-owned; a close failure leaves nothing to recover.
	}
}

/**
 * Whether the guard currently holds the process's stderr pointed at the
 * redirect target. On win32 that is the standard-error handle rather than fd 2,
 * so JS writes still reach the terminal while this reads true.
 */
export function isTerminalStderrSuppressed(): boolean {
	return savedStderrFd !== null || win32Capture !== null;
}
