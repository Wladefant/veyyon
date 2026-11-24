/**
 * Stage Windows writes in the destination directory with the destination security descriptor
 * supplied to NtCreateFile itself. The exclusive creating handle owns writing, publication and
 * cleanup. A creation never clobbers a target that appears after reservation.
 *
 * A replacement uses one parent-handle-relative NTFS POSIX rename. It never moves the old file
 * aside or copies across a volume. A reader that shares delete access can keep reading the old
 * file; new opens see the replacement. Interruption before publication leaves the old file in place.
 *
 * The last check verifies the leaf's FileId, security and supported metadata. Windows does not
 * accept an expected destination FileId or a must-exist flag at rename time. A peer that can change
 * the same leaf after the check is outside this contract (issue #1157).
 */
import { dlopen, FFIType as ffi, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { lazy } from "./abortable";

const FILE_OBJECT = 1;
const OWNER_GROUP_DACL_LABEL = 0x17;
/** SE_DACL_PRESENT, SE_DACL_AUTO_INHERITED and SE_DACL_PROTECTED. */
const DACL_CONTROL = 0x1404;
const DACL_SECURITY = 4;
const DACL_AUTO_INHERITED = 0x400;
const DACL_AUTO_INHERIT_REQ = 0x100;
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn;

const DELETE = 0x1_0000;
const READ_CONTROL = 0x2_0000;
const WRITE_DAC = 0x4_0000;
const SYNCHRONIZE = 0x10_0000;
const FILE_WRITE_DATA = 0x2;
const FILE_TRAVERSE = 0x20;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_WRITE_ATTRIBUTES = 0x100;
const SHARE_READ_WRITE = 3;
const SHARE_ALL = 7;

const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
const FILE_NON_DIRECTORY_FILE = 0x40;
const FILE_OPEN_REPARSE_POINT = 0x20_0000;
const OBJ_CASE_INSENSITIVE = 0x40;

const ATTRIBUTE_READONLY = 0x1;
const ATTRIBUTE_DIRECTORY = 0x10;
const ATTRIBUTE_ARCHIVE = 0x20;
const ATTRIBUTE_NORMAL = 0x80;
const ATTRIBUTE_REPARSE_POINT = 0x400;
const ATTRIBUTE_ENCRYPTED = 0x4000;
/** Hidden, system, read-only and not-content-indexed travel with the replacement. */
const CARRIED_ATTRIBUTES = 0x2007;

const FILE_BASIC_INFO = 0;
const FILE_STREAM_INFO = 7;
const FILE_ATTRIBUTE_TAG_INFO = 9;
const FILE_ID_INFO = 18;
const FILE_RENAME_INFORMATION = 10;
const FILE_RENAME_INFORMATION_EX = 65;
const FILE_RENAME_REPLACE_IF_EXISTS = 0x1;
const FILE_RENAME_POSIX_SEMANTICS = 0x2;
const FILE_DISPOSITION_INFORMATION_EX = 64;
const DISPOSITION_DELETE_IGNORING_READONLY = 0x11;

const STATUS_OBJECT_NAME_NOT_FOUND = 0xc000_0034;

function load() {
	const { ptr, u32, u64, i32 } = ffi;
	return {
		kernel: dlopen("kernel32.dll", {
			CreateFileW: { args: [ptr, u32, u32, ptr, u32, u32, u64], returns: u64 },
			CloseHandle: { args: [u64], returns: i32 },
			GetLastError: { args: [], returns: u32 },
			LocalFree: { args: [ptr], returns: ptr },
			WriteFile: { args: [u64, ptr, u32, ptr, ptr], returns: i32 },
			FlushFileBuffers: { args: [u64], returns: i32 },
			GetFileInformationByHandleEx: { args: [u64, u32, ptr, u32], returns: i32 },
			GetVolumeInformationByHandleW: { args: [u64, ptr, u32, ptr, ptr, ptr, ptr, u32], returns: i32 },
			SetFileInformationByHandle: { args: [u64, u32, ptr, u32], returns: i32 },
		}).symbols,
		nt: dlopen("ntdll.dll", {
			NtCreateFile: { args: [ptr, u32, ptr, ptr, ptr, u32, u32, u32, u32, ptr, u32], returns: u32 },
			NtSetInformationFile: { args: [u64, ptr, ptr, u32, u32], returns: u32 },
			NtSetSecurityObject: { args: [u64, u32, ptr], returns: u32 },
			RtlNtStatusToDosError: { args: [u32], returns: u32 },
		}).symbols,
		security: dlopen("advapi32.dll", {
			GetSecurityInfo: { args: [u64, u32, u32, ptr, ptr, ptr, ptr, ptr], returns: u32 },
			SetSecurityDescriptorControl: { args: [ptr, u32, u32], returns: i32 },
			GetSecurityDescriptorControl: { args: [ptr, ptr, ptr], returns: i32 },
			GetLengthSid: { args: [ptr], returns: u32 },
		}).symbols,
	};
}

const api = lazy(load);

function failure(operation: string, code: number, target: string): Error {
	return new Error(`${operation} failed for ${target} (Win32 error ${code}).`);
}

function ntFailure(operation: string, status: number, target: string): Error {
	return failure(operation, api.value.nt.RtlNtStatusToDosError(status), target);
}

function pointer(out: BigUint64Array): Pointer {
	return Number(out[0]) as Pointer;
}

/** Open or create `leaf` inside the directory `root`. Returns the NTSTATUS and, on success, the handle. */
function openRelative(
	root: bigint,
	leaf: string,
	access: number,
	share: number,
	disposition: number,
	options: number,
	descriptor: Pointer | null = null,
): { status: number; handle: bigint } {
	// Keep both nested pointers in the allocation passed directly to the synchronous FFI call.
	const unicodeOffset = 48; // After OBJECT_ATTRIBUTES, on an 8-byte boundary.
	const nameOffset = unicodeOffset + 16; // After UNICODE_STRING.
	const nameLength = Buffer.byteLength(leaf, "utf16le");
	const attributes = Buffer.alloc(nameOffset + nameLength);
	const base = BigInt(ptr(attributes));
	attributes.write(leaf, nameOffset, nameLength, "utf16le");
	attributes.writeUInt16LE(nameLength, unicodeOffset);
	attributes.writeUInt16LE(nameLength, unicodeOffset + 2);
	attributes.writeBigUInt64LE(base + BigInt(nameOffset), unicodeOffset + 8);
	attributes.writeUInt32LE(unicodeOffset, 0);
	attributes.writeBigUInt64LE(root, 8);
	attributes.writeBigUInt64LE(base + BigInt(unicodeOffset), 16);
	attributes.writeUInt32LE(OBJ_CASE_INSENSITIVE, 24);
	// withSecurity owns this native allocation and frees it only after this call returns.
	attributes.writeBigUInt64LE(descriptor ? BigInt(descriptor) : 0n, 32);
	const handle = new BigUint64Array(1);
	const status =
		api.value.nt.NtCreateFile(
			handle,
			access | SYNCHRONIZE,
			attributes,
			Buffer.alloc(16),
			null,
			ATTRIBUTE_NORMAL,
			share,
			disposition,
			options | FILE_SYNCHRONOUS_IO_NONALERT,
			null,
			0,
		) >>> 0;
	return { status, handle: status === 0 ? handle[0] : 0n };
}

/** Publish through the stage handle. The caller never changes the selected intent on failure. */
function renameRelative(handle: bigint, root: bigint, leaf: string, replace: boolean): number {
	const name = Buffer.from(leaf, "utf16le");
	const info = Buffer.alloc(24 + name.length); // FILE_RENAME_INFORMATION(_EX)
	if (replace) info.writeUInt32LE(FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS, 0);
	info.writeBigUInt64LE(root, 8);
	info.writeUInt32LE(name.length, 16);
	name.copy(info, 20);
	return (
		api.value.nt.NtSetInformationFile(
			handle,
			Buffer.alloc(16),
			info,
			info.length,
			replace ? FILE_RENAME_INFORMATION_EX : FILE_RENAME_INFORMATION,
		) >>> 0
	);
}

function attributesOf(handle: bigint, target: string): number {
	const info = new Uint32Array(2); // FILE_ATTRIBUTE_TAG_INFO
	if (!api.value.kernel.GetFileInformationByHandleEx(handle, FILE_ATTRIBUTE_TAG_INFO, info, info.byteLength)) {
		throw failure("GetFileInformationByHandleEx", api.value.kernel.GetLastError(), target);
	}
	return info[0];
}

function fileIdOf(handle: bigint, target: string): Buffer {
	const { kernel } = api.value;
	const info = Buffer.alloc(24); // FILE_ID_INFO: volume serial number and 128-bit FileId
	if (!kernel.GetFileInformationByHandleEx(handle, FILE_ID_INFO, info, info.length)) {
		throw failure("GetFileInformationByHandleEx(FileIdInfo)", kernel.GetLastError(), target);
	}
	return info;
}

function assertNtfsVolume(parent: bigint, target: string): void {
	const { kernel } = api.value;
	const fsName = Buffer.alloc(64);
	if (!kernel.GetVolumeInformationByHandleW(parent, null, 0, null, null, null, fsName, fsName.length / 2)) {
		throw failure("GetVolumeInformationByHandleW", kernel.GetLastError(), target);
	}
	if (fsName.toString("utf16le", 0, 10) !== "NTFS\0") {
		throw new Error(`Refusing to replace ${target}: Windows security-preserving replacement requires NTFS.`);
	}
}

function openDestination(root: bigint, leaf: string): { status: number; handle: bigint } {
	return openRelative(
		root,
		leaf,
		READ_CONTROL | FILE_READ_ATTRIBUTES | DELETE,
		SHARE_ALL,
		FILE_OPEN,
		FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
	);
}

/** Refuse a destination whose alternate data streams a rename would drop. */
function assertOnlyUnnamedStream(handle: bigint, target: string): void {
	const { kernel } = api.value;
	const info = Buffer.alloc(64 * 1024);
	if (!kernel.GetFileInformationByHandleEx(handle, FILE_STREAM_INFO, info, info.length)) {
		throw failure("GetFileInformationByHandleEx(FileStreamInfo)", kernel.GetLastError(), target);
	}
	let offset = 0;
	for (;;) {
		const next = info.readUInt32LE(offset);
		const nameLength = info.readUInt32LE(offset + 4);
		if (info.toString("utf16le", offset + 24, offset + 24 + nameLength) !== "::$DATA") {
			throw new Error(`Refusing to replace ${target}: it has alternate data streams that a replacement would drop.`);
		}
		if (next === 0) return;
		offset += next;
	}
}

function replaceableAttributes(handle: bigint, target: string): number {
	const attributes = attributesOf(handle, target);
	if (attributes & (ATTRIBUTE_REPARSE_POINT | ATTRIBUTE_ENCRYPTED)) {
		throw new Error(`Refusing to replace ${target}: a replacement cannot keep its reparse point or encryption.`);
	}
	assertOnlyUnnamedStream(handle, target);
	return attributes & CARRIED_ATTRIBUTES;
}

interface Security {
	owner: Pointer;
	group: Pointer;
	acl: Pointer;
	label: Pointer;
	control: number;
	descriptor: Pointer;
}

/** Run synchronously while Win32 owns the buffer containing the descriptor and its pointers. */
function withSecurity<T>(handle: bigint, target: string, get: (info: Security) => T): T {
	const { kernel, security } = api.value;
	const owner = new BigUint64Array(1);
	const group = new BigUint64Array(1);
	const acl = new BigUint64Array(1);
	const label = new BigUint64Array(1);
	const descriptor = new BigUint64Array(1);
	const code = security.GetSecurityInfo(
		handle,
		FILE_OBJECT,
		OWNER_GROUP_DACL_LABEL,
		owner,
		group,
		acl,
		label,
		descriptor,
	);
	if (code !== 0) throw failure("GetSecurityInfo", code, target);
	const sd = pointer(descriptor);
	try {
		const control = new Uint16Array(1);
		if (!security.GetSecurityDescriptorControl(sd, control, new Uint32Array(1))) {
			throw failure("GetSecurityDescriptorControl", kernel.GetLastError(), target);
		}
		return get({
			owner: pointer(owner),
			group: pointer(group),
			acl: pointer(acl),
			label: pointer(label),
			control: control[0],
			descriptor: sd,
		});
	} finally {
		kernel.LocalFree(sd);
	}
}

function sameBytes(a: Pointer, b: Pointer, size: (v: Pointer) => number): boolean {
	if (!a || !b) return a === b;
	const len = size(a);
	return len === size(b) && Buffer.from(toArrayBuffer(a, 0, len)).equals(Buffer.from(toArrayBuffer(b, 0, len)));
}

function aclSize(acl: Pointer): number {
	return read.u16(acl, 2);
}

function sameSecurity(a: Security, b: Security): boolean {
	const { GetLengthSid } = api.value.security;
	return (
		((a.control ^ b.control) & DACL_CONTROL) === 0 &&
		sameBytes(a.acl, b.acl, aclSize) &&
		sameBytes(a.owner, b.owner, GetLengthSid) &&
		sameBytes(a.group, b.group, GetLengthSid) &&
		sameBytes(a.label, b.label, aclSize)
	);
}

function assertSameSecurity(expected: bigint, actual: bigint, target: string, what: string): void {
	const same = withSecurity(expected, target, a => withSecurity(actual, target, b => sameSecurity(a, b)));
	if (!same) throw new Error(`Refusing to replace ${target}: ${what}.`);
}

export interface WindowsWriteStage {
	readonly target: string;
	/** The target's directory, opened once; every later name is resolved inside it. */
	readonly parent: bigint;
	/** The exclusively opened stage that receives the bytes. */
	readonly stage: bigint;
	readonly stageName: string;
	/**
	 * The destination checked at reservation. Undefined means a no-clobber creation.
	 * An open handle identifies the object, but does not bind the leaf name to it.
	 */
	readonly original: bigint | undefined;
	/** File attributes the published file carries. */
	readonly attributes: number;
	published: boolean;
}

/**
 * Reserve a stage beside `target`. An existing target fixes the write as a replacement and lends
 * the stage its security descriptor at creation; a missing one fixes it as a creation under the
 * directory's normal inheritance. `readOnly` applies only to a created file.
 */
export function reserveWindowsWriteStage(target: string, options: { readOnly?: boolean } = {}): WindowsWriteStage {
	const { kernel } = api.value;
	const leaf = path.basename(target);
	if (!leaf || leaf === "." || leaf === ".." || leaf.includes(":")) {
		throw new Error(`Refusing to write ${target}: it does not name a file in a directory.`);
	}
	// FILE_FLAG_BACKUP_SEMANTICS opens the directory. Without delete sharing it cannot be renamed
	// or removed until the write ends.
	const parent = kernel.CreateFileW(
		Buffer.from(`${path.toNamespacedPath(path.dirname(target))}\0`, "utf16le"),
		FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
		SHARE_READ_WRITE,
		null,
		3,
		0x0200_0000,
		0n,
	);
	if (parent === INVALID_HANDLE) throw failure("CreateFileW", kernel.GetLastError(), path.dirname(target));
	let original: bigint | undefined;
	try {
		if (!(attributesOf(parent, target) & ATTRIBUTE_DIRECTORY)) {
			throw new Error(`Refusing to write ${target}: its parent is not a directory.`);
		}
		const opened = openDestination(parent, leaf);
		if (opened.status !== 0 && opened.status !== STATUS_OBJECT_NAME_NOT_FOUND) {
			throw ntFailure("NtCreateFile", opened.status, target);
		}
		original = opened.status === 0 ? opened.handle : undefined;
		let attributes = options.readOnly ? ATTRIBUTE_READONLY : 0;
		if (original !== undefined) {
			assertNtfsVolume(parent, target);
			attributes = replaceableAttributes(original, target);
		}
		const stageName = `.veyyon-write-${randomUUID()}.tmp`;
		const create = (descriptor: Pointer | null) => {
			const created = openRelative(
				parent,
				stageName,
				FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | READ_CONTROL | WRITE_DAC | DELETE,
				0,
				FILE_CREATE,
				FILE_NON_DIRECTORY_FILE,
				descriptor,
			);
			if (created.status !== 0) throw ntFailure("NtCreateFile", created.status, target);
			return created.handle;
		};
		const stage =
			original === undefined
				? create(null)
				: withSecurity(original, target, info => {
						if (!info.acl) throw new Error(`Refusing to replace ${target}: it has no Windows DACL to preserve.`);
						// OBJECT_ATTRIBUTES carries the creation-time descriptor, the native equivalent
						// of SECURITY_ATTRIBUTES. Never create a stage with the parent's DACL first.
						const created = create(info.descriptor);
						if (!(info.control & DACL_AUTO_INHERITED)) return created;
						// Creation copies every entry but drops SE_DACL_AUTO_INHERITED. Restating the DACL with
						// SE_DACL_AUTO_INHERIT_REQ keeps the explicit entries, keeps the inherited entries the
						// stage was created with, and sets the flag. Nothing else can open the stage yet.
						const { security, nt } = api.value;
						const restated =
							security.SetSecurityDescriptorControl(
								info.descriptor,
								DACL_AUTO_INHERIT_REQ,
								DACL_AUTO_INHERIT_REQ,
							) && nt.NtSetSecurityObject(created, DACL_SECURITY, info.descriptor) === 0;
						if (!restated) {
							deleteByHandle(created);
							kernel.CloseHandle(created);
							throw new Error(`Refusing to replace ${target}: Windows cannot restate its DACL on the stage.`);
						}
						return created;
					});
		if (original !== undefined) {
			try {
				assertSameSecurity(
					original,
					stage,
					target,
					"Windows cannot give the staged file the destination's security",
				);
			} catch (error) {
				deleteByHandle(stage);
				kernel.CloseHandle(stage);
				throw error;
			}
		}
		return { target, parent, stage, stageName, original, attributes, published: false };
	} catch (error) {
		if (original !== undefined) kernel.CloseHandle(original);
		kernel.CloseHandle(parent);
		throw error;
	}
}

/** Write the payload through the creating handle and flush it when asked. */
export function writeWindowsWriteStage(write: WindowsWriteStage, data: Uint8Array, flush: boolean): void {
	const { kernel } = api.value;
	const written = new Uint32Array(1);
	for (let offset = 0; offset < data.length; offset += written[0]) {
		const chunk = data.subarray(offset, offset + 0x4000_0000);
		if (!kernel.WriteFile(write.stage, chunk, chunk.length, written, null) || written[0] === 0) {
			throw failure("WriteFile", kernel.GetLastError(), write.target);
		}
	}
	if (write.attributes) {
		const basic = Buffer.alloc(40); // FILE_BASIC_INFO; zero times are left unchanged
		basic.writeUInt32LE(write.attributes | ATTRIBUTE_ARCHIVE, 32);
		if (!kernel.SetFileInformationByHandle(write.stage, FILE_BASIC_INFO, basic, basic.length)) {
			throw failure("SetFileInformationByHandle(FileBasicInfo)", kernel.GetLastError(), write.target);
		}
	}
	if (flush && !kernel.FlushFileBuffers(write.stage)) {
		throw failure("FlushFileBuffers", kernel.GetLastError(), write.target);
	}
}

/** Publish the stage with the intent fixed when it was reserved. */
export function publishWindowsWriteStage(write: WindowsWriteStage): void {
	const { target, parent, stage, original } = write;
	const leaf = path.basename(target);
	if (original === undefined) {
		const status = renameRelative(stage, parent, leaf, false);
		if (status !== 0) throw ntFailure("Creating the file (no replacement)", status, target);
	} else {
		const current = openDestination(parent, leaf);
		if (current.status !== 0) throw ntFailure("Reopening the replacement target", current.status, target);
		try {
			if (!fileIdOf(original, target).equals(fileIdOf(current.handle, target))) {
				throw new Error(`Refusing to replace ${target}: the destination changed while the write was staged.`);
			}
			if (replaceableAttributes(current.handle, target) !== write.attributes) {
				throw new Error(
					`Refusing to replace ${target}: its Windows attributes changed while the write was staged.`,
				);
			}
			assertSameSecurity(current.handle, stage, target, "its Windows security changed while the write was staged");
			// The final rename is by leaf name, not expected FileId. See #1157.
			const status = renameRelative(stage, parent, leaf, true);
			if (status !== 0) throw ntFailure("Publishing the replacement", status, target);
		} finally {
			api.value.kernel.CloseHandle(current.handle);
		}
	}
	write.published = true;
}

function deleteByHandle(handle: bigint): void {
	const info = Buffer.alloc(4); // FILE_DISPOSITION_INFORMATION_EX
	info.writeUInt32LE(DISPOSITION_DELETE_IGNORING_READONLY, 0);
	api.value.nt.NtSetInformationFile(handle, Buffer.alloc(16), info, info.length, FILE_DISPOSITION_INFORMATION_EX);
}

/** Release handles. Remove an unpublished stage through the handle that created it. */
export function closeWindowsWriteStage(write: WindowsWriteStage): void {
	const { kernel } = api.value;
	if (!write.published) deleteByHandle(write.stage);
	kernel.CloseHandle(write.stage);
	if (write.original !== undefined) kernel.CloseHandle(write.original);
	kernel.CloseHandle(write.parent);
}
