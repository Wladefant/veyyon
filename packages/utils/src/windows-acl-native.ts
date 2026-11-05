/** Read-only Win32 ACL verification. No shell startup, privilege changes, or cached ACL decisions. */
import { dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";

interface NativeSecurityApi {
	security: {
		GetNamedSecurityInfoW(
			target: Buffer,
			type: number,
			info: number,
			owner: BigUint64Array,
			group: null,
			dacl: BigUint64Array,
			sacl: null,
			descriptor: BigUint64Array,
		): number;
		GetTokenInformation(token: bigint, kind: number, buffer: Buffer, length: number, returned: Uint32Array): number;
		GetSecurityDescriptorControl(descriptor: Pointer, control: Uint16Array, revision: Uint32Array): number;
		GetAce(dacl: Pointer, index: number, ace: BigUint64Array): number;
		EqualSid(left: Pointer, right: Pointer): number;
		IsWellKnownSid(sid: Pointer, kind: number): number;
	};
	kernel: {
		GetFileAttributesW(target: Buffer): number;
		GetLastError(): number;
		LocalFree(pointer: Pointer): unknown;
	};
}

function loadSecurityApi(): NativeSecurityApi {
	const security = dlopen("advapi32.dll", {
		GetNamedSecurityInfoW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
			returns: FFIType.u32,
		},
		GetTokenInformation: {
			args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
			returns: FFIType.i32,
		},
		GetSecurityDescriptorControl: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetAce: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		EqualSid: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		IsWellKnownSid: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	});
	const kernel = dlopen("kernel32.dll", {
		GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
		GetLastError: { args: [], returns: FFIType.u32 },
		LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
	});
	return { security: security.symbols, kernel: kernel.symbols };
}

let api: NativeSecurityApi | undefined;

function pointerAt(buffer: BigUint64Array): Pointer {
	// Windows Bun targets are 64-bit. User-mode addresses fit exactly in a JS number.
	return Number(buffer[0]) as Pointer;
}

function failure(operation: string, code: number): Error {
	return new Error(`${operation} failed (Win32 error ${code}).`);
}

/** Same policy as the ACL writer: current user owner, protected DACL, exactly user + SYSTEM full control. */
export function verifyNativeOwnerOnlyWindowsAcl(filePath: string): void {
	api ??= loadSecurityApi();
	const { security, kernel } = api;
	const target = Buffer.from(`${filePath}\0`, "utf16le");
	const attributes = kernel.GetFileAttributesW(target);
	if (attributes === 0xffff_ffff) throw failure("GetFileAttributesW", kernel.GetLastError());
	if (attributes & 0x400) throw new Error("ACL target is a reparse point");

	// GetCurrentProcessToken() is the documented pseudo-handle (HANDLE)-4. It must not be closed.
	// TOKEN_USER is a SID_AND_ATTRIBUTES followed by its SID, whose maximum size is 68 bytes.
	const tokenUser = Buffer.alloc(256);
	const tokenLength = new Uint32Array(1);
	if (!security.GetTokenInformation(0xffff_ffff_ffff_fffcn, 1, tokenUser, tokenUser.length, tokenLength)) {
		throw failure("GetTokenInformation", kernel.GetLastError());
	}
	const user = Number(tokenUser.readBigUInt64LE()) as Pointer;
	const ownerPointer = new BigUint64Array(1);
	const daclPointer = new BigUint64Array(1);
	const descriptorPointer = new BigUint64Array(1);
	// SE_FILE_OBJECT; OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION. Never request the SACL.
	const result = security.GetNamedSecurityInfoW(
		target,
		1,
		5,
		ownerPointer,
		null,
		daclPointer,
		null,
		descriptorPointer,
	);
	if (result !== 0) throw failure("GetNamedSecurityInfoW", result);
	const descriptor = pointerAt(descriptorPointer);
	try {
		const owner = pointerAt(ownerPointer);
		const dacl = pointerAt(daclPointer);
		if (!owner || !security.EqualSid(owner, user)) throw new Error("ACL owner is not the current user");
		const control = new Uint16Array(1);
		const revision = new Uint32Array(1);
		if (!security.GetSecurityDescriptorControl(descriptor, control, revision)) {
			throw failure("GetSecurityDescriptorControl", kernel.GetLastError());
		}
		if (!(control[0] & 0x1000)) throw new Error("ACL inheritance is enabled"); // SE_DACL_PROTECTED
		if (!dacl || read.u16(dacl, 4) !== 2) throw new Error("ACL does not contain exactly two access rules");
		const expectedFlags = attributes & 0x10 ? 3 : 0; // directory: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
		let userRules = 0;
		let systemRules = 0;
		const acePointer = new BigUint64Array(1);
		for (let index = 0; index < 2; index++) {
			if (!security.GetAce(dacl, index, acePointer)) throw failure("GetAce", kernel.GetLastError());
			const ace = pointerAt(acePointer);
			// ACCESS_ALLOWED_ACE: 4-byte header, 4-byte mask, then the SID. Refuse every other ACE type.
			if (read.u8(ace, 0) !== 0) throw new Error("ACL principal rule is not an allow rule");
			if (read.u8(ace, 1) !== expectedFlags) throw new Error("ACL principal rule has unexpected inheritance flags");
			if (read.u32(ace, 4) !== 0x001f_01ff) throw new Error("ACL principal rule is not exactly full control");
			const sid = (ace + 8) as Pointer;
			if (security.EqualSid(sid, user)) userRules++;
			else if (security.IsWellKnownSid(sid, 22))
				systemRules++; // WinLocalSystemSid
			else throw new Error("ACL grants another identity access");
		}
		if (userRules !== 1 || systemRules !== 1) throw new Error("ACL is missing an expected principal rule");
		// Keep the token buffer live until all native SID comparisons have completed.
		ptr(tokenUser);
	} finally {
		if (descriptor) kernel.LocalFree(descriptor);
	}
}
