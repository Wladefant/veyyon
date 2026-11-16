import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "./fs-error";

type FileApi = {
	ReplaceFileW(target: Buffer, replacement: Buffer, backup: Buffer, flags: number, exclude: null, reserved: null): number;
	MoveFileExW(source: Buffer, target: Buffer, flags: number): number;
	GetLastError(): number;
};

let api: FileApi | undefined;

function loadApi(): FileApi {
	return dlopen("kernel32.dll", {
		ReplaceFileW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	}).symbols;
}

function wide(filePath: string): Buffer {
	if (filePath.includes("\0")) throw new Error("A Windows replacement path contains a NUL byte");
	return Buffer.from(`${path.toNamespacedPath(path.resolve(filePath))}\0`, "utf16le");
}

function nativeError(operation: string, code: number, target: string): NodeJS.ErrnoException {
	const error = new Error(`${operation} failed for ${target} (Win32 error ${code}).`) as NodeJS.ErrnoException;
	error.errno = code;
	error.code = code === 2 || code === 3 ? "ENOENT" : code === 5 ? "EACCES" : code === 80 || code === 183 ? "EEXIST" : code === 32 || code === 33 ? "EBUSY" : `WIN32_${code}`;
	return error;
}

/** ReplaceFileW carries the destination DACL and attributes forward; rename-over-existing does not. */
export function publishWindowsFile(source: string, target: string, backup: string): void {
	api ??= loadApi();
	const dest = wide(target);
	const from = wide(source);
	const previous = wide(backup);
	// The sibling belongs to this staged write. Never overwrite debris from a prior process.
	let backupExists = true;
	try {
		fs.lstatSync(backup);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		backupExists = false;
	}
	if (backupExists) throw nativeError("Reserve replacement backup", 183, backup);
	const replace = (): void => {
		// Neither IGNORE_ACL_ERRORS nor IGNORE_MERGE_ERRORS may weaken this commit.
		if (api!.ReplaceFileW(dest, from, previous, 0, null, null)) {
			fs.unlinkSync(backup);
			return;
		}
		const code = api!.GetLastError();
		const error = nativeError("ReplaceFileW", code, target);
		if (code === 1177) {
			// Windows moved the original to backup but could not publish the replacement.
			// An unexpected new target belongs to another writer: preserve both, never clobber it.
			if (!api!.MoveFileExW(previous, dest, 0)) {
				throw new AggregateError(
					[error, nativeError("Restore replacement backup", api!.GetLastError(), target)],
					`Failed to replace ${target}; its previous contents remain at ${backup}`,
				);
			}
		}
		throw error;
	};
	try {
		replace();
		return;
	} catch (error) {
		if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Missing destinations use a non-clobbering move. A raced-in file must take the
	// ACL-preserving replacement path, not a rename with REPLACE_EXISTING.
	if (api.MoveFileExW(from, dest, 0)) return;
	const code = api.GetLastError();
	if (code === 80 || code === 183) {
		replace();
		return;
	}
	throw nativeError("MoveFileExW", code, target);
}
