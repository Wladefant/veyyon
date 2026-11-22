import { dlopen, FFIType } from "bun:ffi";
import { resolve, toNamespacedPath } from "node:path";

interface KernelRenameApi {
	MoveFileExW(source: Buffer, target: Buffer, flags: number): number;
	GetLastError(): number;
}

let kernel: { symbols: KernelRenameApi } | undefined;

function loadKernel() {
	return dlopen("kernel32.dll", {
		MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	});
}

const MOVEFILE_REPLACE_EXISTING = 0x1;
const MOVEFILE_WRITE_THROUGH = 0x8;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;

function widePath(path: string): Buffer {
	if (path.includes("\0")) throw new TypeError("A journal path cannot contain a NUL character");
	return Buffer.from(`${toNamespacedPath(resolve(path))}\0`, "utf16le");
}

/** Replace the entry on disk before returning. Never fall back to a cross-volume copy. */
export function windowsWriteThroughRenameSync(source: string, target: string): void {
	const from = widePath(source);
	const to = widePath(target);
	const { MoveFileExW, GetLastError } = (kernel ??= loadKernel()).symbols;
	if (MoveFileExW(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return;

	const win32 = GetLastError();
	const error = new Error(`MoveFileExW write-through rename failed (Win32 error ${win32}): '${source}' -> '${target}'`);
	// Preserve the two error distinctions the journal's move-aside fallback uses.
	if (win32 === ERROR_ACCESS_DENIED) throw Object.assign(error, { code: "EPERM" });
	if (win32 === ERROR_FILE_NOT_FOUND || win32 === ERROR_PATH_NOT_FOUND) {
		throw Object.assign(error, { code: "ENOENT" });
	}
	throw error;
}
