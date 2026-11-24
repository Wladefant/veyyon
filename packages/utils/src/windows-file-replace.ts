import { dlopen, FFIType as ffi, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { lazy } from "./abortable";

const FILE_OBJECT = 1;
const OWNER_GROUP_DACL_LABEL = 0x17;
const DACL_PROTECTED = 0x1000;
const OWNER = 1;
const DACL = 4;
const PROTECTED_DACL = 0x8000_0000;
const UNPROTECTED_DACL = 0x2000_0000;
const FILE_NOT_FOUND = 2;
const PATH_NOT_FOUND = 3;
const FILE_EXISTS = 80;
const ALREADY_EXISTS = 183;
const UNABLE_TO_MOVE_REPLACEMENT_2 = 1177;

export class WindowsReplaceRecoveryError extends Error {}

function load() {
	const { ptr, u32, i32 } = ffi;
	return {
		kernel: dlopen("kernel32.dll", {
			GetFileAttributesW: { args: [ptr], returns: u32 },
			GetLastError: { args: [], returns: u32 },
			LocalFree: { args: [ptr], returns: ptr },
			ReplaceFileW: { args: [ptr, ptr, ptr, u32, ptr, ptr], returns: i32 },
			MoveFileExW: { args: [ptr, ptr, u32], returns: i32 },
			CreateDirectoryW: { args: [ptr, ptr], returns: i32 },
			CreateFileW: { args: [ptr, u32, u32, ptr, u32, u32, ffi.u64], returns: ffi.u64 },
			CloseHandle: { args: [ffi.u64], returns: i32 },
			GetFileInformationByHandleEx: { args: [ffi.u64, u32, ptr, u32], returns: i32 },
		}).symbols,
		security: dlopen("advapi32.dll", {
			GetNamedSecurityInfoW: { args: [ptr, u32, u32, ptr, ptr, ptr, ptr, ptr], returns: u32 },
			GetSecurityInfo: { args: [ffi.u64, u32, u32, ptr, ptr, ptr, ptr, ptr], returns: u32 },
			GetSecurityDescriptorDacl: { args: [ptr, ptr, ptr, ptr], returns: i32 },
			GetSecurityDescriptorOwner: { args: [ptr, ptr, ptr], returns: i32 },
			SetNamedSecurityInfoW: { args: [ptr, u32, u32, ptr, ptr, ptr, ptr], returns: u32 },
			GetSecurityDescriptorControl: { args: [ptr, ptr, ptr], returns: i32 },
			GetLengthSid: { args: [ptr], returns: u32 },
			GetTokenInformation: { args: [ffi.u64, u32, ptr, u32, ptr], returns: i32 },
			ConvertSidToStringSidW: { args: [ptr, ptr], returns: i32 },
			ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [ptr, u32, ptr, ptr], returns: i32 },
		}).symbols,
	};
}

const api = lazy(load);

function wide(value: string): Buffer {
	return Buffer.from(`${value}\0`, "utf16le");
}

function filename(value: string): Buffer {
	return wide(path.toNamespacedPath(value));
}

function pointer(out: BigUint64Array): Pointer {
	return Number(out[0]) as Pointer;
}

function failure(operation: string, code: number, target: string): Error {
	return new Error(`${operation} failed for ${target} (Win32 error ${code}).`);
}

/** Run synchronously while Win32 owns the buffer containing the descriptor and its ACL pointers. */
function withSecurity<T>(file: string, get: (info: Security) => T): T | undefined {
	const { kernel, security } = api.value;
	const name = filename(file);
	const attrs = kernel.GetFileAttributesW(name);
	if (attrs === 0xffff_ffff) {
		const code = kernel.GetLastError();
		if (code === FILE_NOT_FOUND || code === PATH_NOT_FOUND) return undefined;
		throw failure("GetFileAttributesW", code, file);
	}
	if (attrs & 0x410) throw new Error(`Refusing to replace a directory or reparse point: ${file}`);
	const owner = new BigUint64Array(1);
	const group = new BigUint64Array(1);
	const acl = new BigUint64Array(1);
	const label = new BigUint64Array(1);
	const descriptor = new BigUint64Array(1);
	const code = security.GetNamedSecurityInfoW(
		name,
		FILE_OBJECT,
		OWNER_GROUP_DACL_LABEL,
		owner,
		group,
		acl,
		label,
		descriptor,
	);
	if (code !== 0) throw failure("GetNamedSecurityInfoW", code, file);
	const sd = pointer(descriptor);
	try {
		const control = new Uint16Array(1);
		if (!security.GetSecurityDescriptorControl(sd, control, new Uint32Array(1))) {
			throw failure("GetSecurityDescriptorControl", kernel.GetLastError(), file);
		}
		return get({
			owner: pointer(owner),
			group: pointer(group),
			acl: pointer(acl),
			label: pointer(label),
			control: control[0],
		});
	} finally {
		kernel.LocalFree(sd);
	}
}

interface Security {
	owner: Pointer;
	group: Pointer;
	acl: Pointer;
	label: Pointer;
	control: number;
}

function sameBytes(a: Pointer, b: Pointer, size: (v: Pointer) => number): boolean {
	if (!a || !b) return a === b;
	const len = size(a);
	return len === size(b) && Buffer.from(toArrayBuffer(a, 0, len)).equals(Buffer.from(toArrayBuffer(b, 0, len)));
}

function aclSize(acl: Pointer): number {
	return read.u16(acl, 2);
}

function sameIdentityAndLabel(a: Security, b: Security): boolean {
	const { GetLengthSid } = api.value.security;
	return (
		sameBytes(a.owner, b.owner, GetLengthSid) &&
		sameBytes(a.group, b.group, GetLengthSid) &&
		sameBytes(a.label, b.label, aclSize)
	);
}

/** Check the staged object's own security, not just the permissions of its parent. */
function assertMatchingSecurity(a: Security, b: Security, target: string): void {
	if ((a.control ^ b.control) & 0x1004 || !sameBytes(a.acl, b.acl, aclSize) || !sameIdentityAndLabel(a, b)) {
		throw new Error(
			`Refusing to replace ${target}: the staged file does not have the destination's Windows security.`,
		);
	}
}

/** Put the destination DACL on the empty sibling before the writer can put bytes there. */
export function protectWindowsWriteStage(target: string, stage: string, privateStage: boolean): void {
	const checked = withSecurity(target, original => {
		if (!original.acl) throw new Error(`Cannot preserve a missing or null Windows DACL on ${target}.`);
		if (!privateStage && original.control & DACL_PROTECTED) {
			throw new Error(`Refusing to stage a Windows write after the destination became protected: ${target}.`);
		}
		const info = (DACL | (original.control & 0x1000 ? PROTECTED_DACL : UNPROTECTED_DACL)) >>> 0;
		const code = api.value.security.SetNamedSecurityInfoW(
			filename(stage),
			FILE_OBJECT,
			info,
			null,
			null,
			original.acl,
			null,
		);
		if (code !== 0) throw failure("SetNamedSecurityInfoW", code, stage);
		if (
			!withSecurity(stage, staged => {
				assertMatchingSecurity(original, staged, target);
				return true;
			})
		) {
			throw new Error(`Windows write stage disappeared for ${target}.`);
		}
		return true;
	});
	if (privateStage && !checked) throw new Error(`Protected Windows write target no longer exists: ${target}.`);
}

function tokenSid(kind: number, target: string): string | undefined {
	const { kernel, security } = api.value;
	const info = Buffer.alloc(256);
	if (!security.GetTokenInformation(0xffff_ffff_ffff_fffcn, kind, info, info.length, new Uint32Array(1))) {
		throw failure("GetTokenInformation", kernel.GetLastError(), target);
	}
	const sid = Number(info.readBigUInt64LE()) as Pointer;
	if (!sid) return undefined;
	const out = new BigUint64Array(1);
	if (!security.ConvertSidToStringSidW(sid, out))
		throw failure("ConvertSidToStringSidW", kernel.GetLastError(), target);
	ptr(info); // The SID points into the token buffer.
	const text = pointer(out);
	try {
		let sidString = "";
		for (let offset = 0; read.u16(text, offset); offset += 2)
			sidString += String.fromCharCode(read.u16(text, offset));
		return sidString;
	} finally {
		kernel.LocalFree(text);
	}
}

export interface WindowsStageDirectory {
	path: string;
	pin: bigint;
}

/** Secure staging for protected targets. Ordinary creation keeps the parent-derived DACL. */
export function reserveProtectedWindowsStage(target: string): WindowsStageDirectory | undefined {
	if (withSecurity(target, info => Boolean(info.control & DACL_PROTECTED))) return reservePrivateDirectory(target);
	return undefined;
}

/** Deny other identities access and pin the directory against renames and deletion. */
function reservePrivateDirectory(target: string): WindowsStageDirectory {
	const { kernel, security } = api.value;
	const user = tokenSid(1, target);
	if (!user) throw new Error(`Cannot identify the Windows user replacing ${target}.`);
	const appContainer = tokenSid(31, target);
	const descriptor = `O:${user}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})${appContainer ? `(A;OICI;FA;;;${appContainer})` : ""}`;
	const out = new BigUint64Array(1);
	if (!security.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(descriptor), 1, out, null)) {
		throw failure("ConvertStringSecurityDescriptorToSecurityDescriptorW", kernel.GetLastError(), target);
	}
	const sd = pointer(out);
	try {
		const attrs = Buffer.alloc(24); // 64-bit SECURITY_ATTRIBUTES (length, descriptor, inherit handle)
		attrs.writeUInt32LE(attrs.length);
		attrs.writeBigUInt64LE(BigInt(sd), 8);
		const dir = path.join(path.dirname(target), `.veyyon-replace-${randomUUID()}`);
		const name = filename(dir);
		if (!kernel.CreateDirectoryW(name, attrs)) throw failure("CreateDirectoryW", kernel.GetLastError(), target);
		// READ_CONTROL | FILE_READ_ATTRIBUTES; share read/write; OPEN_EXISTING;
		// FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
		const pin = kernel.CreateFileW(name, 0x2_0080, 3, null, 3, 0x0220_0000, 0n);
		if (pin === 0xffff_ffff_ffff_ffffn) throw failure("CreateFileW", kernel.GetLastError(), dir);
		try {
			verifyPrivateDirectory(dir, pin, sd);
			return { path: dir, pin };
		} catch (error) {
			kernel.CloseHandle(pin);
			throw error;
		}
	} finally {
		kernel.LocalFree(sd);
	}
}

function verifyPrivateDirectory(dir: string, pin: bigint, expected: Pointer): void {
	const { kernel, security } = api.value;
	const attrs = new Uint32Array(2);
	// FileAttributeTagInfo. Reject a non-directory or reparse point on the actual opened object.
	if (!kernel.GetFileInformationByHandleEx(pin, 9, attrs, attrs.byteLength)) {
		throw failure("GetFileInformationByHandleEx", kernel.GetLastError(), dir);
	}
	if ((attrs[0] & 0x410) !== 0x10) throw new Error(`Unsafe Windows staging directory: ${dir}.`);
	const owner = new BigUint64Array(1);
	const acl = new BigUint64Array(1);
	const descriptor = new BigUint64Array(1);
	const code = security.GetSecurityInfo(pin, FILE_OBJECT, OWNER | DACL, owner, null, acl, null, descriptor);
	if (code !== 0) throw failure("GetSecurityInfo", code, dir);
	const sd = pointer(descriptor);
	try {
		const control = new Uint16Array(1);
		const expectedAcl = new BigUint64Array(1);
		const expectedOwner = new BigUint64Array(1);
		if (
			!security.GetSecurityDescriptorControl(sd, control, new Uint32Array(1)) ||
			!security.GetSecurityDescriptorDacl(expected, new Uint32Array(1), expectedAcl, new Uint32Array(1)) ||
			!security.GetSecurityDescriptorOwner(expected, expectedOwner, new Uint32Array(1)) ||
			!sameBytes(pointer(owner), pointer(expectedOwner), security.GetLengthSid) ||
			!(control[0] & DACL_PROTECTED) ||
			!sameBytes(pointer(acl), pointer(expectedAcl), aclSize)
		) {
			throw new Error(`Windows staging directory owner or DACL changed: ${dir}.`);
		}
	} finally {
		kernel.LocalFree(sd);
	}
}

export function closeWindowsStageDirectory(dir: WindowsStageDirectory): void {
	api.value.kernel.CloseHandle(dir.pin);
	try {
		fs.rmdirSync(dir.path); // Never recursively delete a recovery directory.
	} catch (error) {
		warnRetainedDirectory(dir.path, error);
	}
}

function warnRetainedDirectory(dir: string, error: unknown): void {
	// The logger itself uses the atomic writer to rotate logs.
	void import("./logger")
		.then(({ warn }) => {
			warn("Windows file replacement retained its recovery directory", { dir, error });
		})
		.catch(() => {});
}

function isOriginal(backup: string, original: fs.BigIntStats): boolean {
	const saved = fs.lstatSync(backup, { bigint: true, throwIfNoEntry: false });
	return saved?.isFile() === true && original.ino !== 0n && saved.ino === original.ino && saved.dev === original.dev;
}

/** Never fall back to an ordinary clobber rename when Windows cannot preserve the destination. */
export function publishWindowsWriteStage(target: string, stage: string, directory?: WindowsStageDirectory): void {
	const { kernel } = api.value;
	const targetName = filename(target);
	const stageName = filename(stage);
	// A creation must not clobber a destination created since the first observation.
	if (!fs.existsSync(target)) {
		if (directory) throw new Error(`Protected Windows write target no longer exists: ${target}.`);
		if (kernel.MoveFileExW(stageName, targetName, 0)) return;
		const code = kernel.GetLastError();
		if (code !== FILE_EXISTS && code !== ALREADY_EXISTS) throw failure("MoveFileExW", code, target);
	}
	const original = fs.lstatSync(target, { bigint: true });
	const recoveryDir = directory ?? reservePrivateDirectory(target);
	const dir = recoveryDir.path;
	const backup = path.join(dir, "original");
	let published = false;
	try {
		const checked = withSecurity(target, current =>
			withSecurity(stage, staged => {
				assertMatchingSecurity(current, staged, target);
				return true;
			}),
		);
		if (!checked || !isOriginal(target, original))
			throw new Error(`Windows write target or stage changed for ${target}.`);
		published = kernel.ReplaceFileW(targetName, stageName, filename(backup), 0, null, null) !== 0;
		if (!published) {
			const code = kernel.GetLastError();
			try {
				// Windows can displace the original without publishing the replacement.
				// Restore only the original, and never clobber another file on recovery.
				if (code === UNABLE_TO_MOVE_REPLACEMENT_2 && isOriginal(backup, original)) {
					kernel.MoveFileExW(filename(backup), targetName, 0);
				}
				if (!isOriginal(target, original)) throw new Error("The original is not at the target path.");
			} catch (cause) {
				throw new WindowsReplaceRecoveryError(
					`ReplaceFileW failed for ${target} (Win32 error ${code}); retained recovery paths ${dir} and ${stage}.`,
					{ cause },
				);
			}
			throw failure("ReplaceFileW", code, target);
		}
	} finally {
		try {
			if (published && isOriginal(backup, original)) fs.unlinkSync(backup);
		} catch (error) {
			warnRetainedDirectory(dir, error);
		} finally {
			if (!directory) closeWindowsStageDirectory(recoveryDir);
		}
	}
}
