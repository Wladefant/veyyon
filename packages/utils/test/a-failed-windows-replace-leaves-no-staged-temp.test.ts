import { describe, expect, it } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import * as atomicWrite from "../src/atomic-write";
import { applyOwnerOnlyWindowsAcl, verifyOwnerOnlyWindowsAcl } from "../src/windows-acl";
import { TempDir } from "../src/temp";

const ORIGINAL = "ORIGINAL-BYTES";
const NEW = "NEW-BYTES";

const DRIVERS: Record<string, (target: string) => Promise<void> | void> = {
	atomicWriteFile: target => atomicWrite.atomicWriteFile(target, NEW),
	atomicWriteFilePreservingMode: target => atomicWrite.atomicWriteFilePreservingMode(target, NEW),
	atomicWriteJson: target => atomicWrite.atomicWriteJson(target, NEW),
	atomicWriteFileWith: target => atomicWrite.atomicWriteFileWith(target, tempPath => fs.promises.writeFile(tempPath, NEW)),
	atomicWriteFileSync: target => atomicWrite.atomicWriteFileSync(target, NEW),
};

type WindowsFileApi = {
	CreateFileW(path: Buffer, desiredAccess: number, shareMode: number, securityAttributes: null, creationDisposition: number, flags: number, template: null): bigint;
	CloseHandle(handle: bigint): number;
	GetLastError(): number;
};

let fileApi: WindowsFileApi | undefined;

function loadWindowsFileApi(): WindowsFileApi {
	fileApi ??= dlopen("kernel32.dll", {
		CreateFileW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
			returns: FFIType.u64,
		},
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	}).symbols as WindowsFileApi;
	return fileApi;
}

function openWithoutDeleteShare(filePath: string): { api: WindowsFileApi; handle: bigint } {
	const api = loadWindowsFileApi();
	const encoded = Buffer.from(`${path.resolve(filePath)}\0`, "utf16le");
	const handle = api.CreateFileW(encoded, 0x80000000, 0x1 | 0x2, null, 3, 0x80, null);
	if (handle === 0xffffffffffffffffn) throw new Error(`CreateFileW failed with Win32 error ${api.GetLastError()}`);
	return { api, handle };
}

describe.skipIf(process.platform !== "win32")("a failed Windows replacement", () => {
	for (const [name, write] of Object.entries(DRIVERS)) {
		it(`${name} leaves a protected destination intact when replacement is denied`, async () => {
			const dir = await TempDir.create("@veyyon-windows-replace-");
			try {
				const target = path.join(dir.path(), "settings-δ.json");
				await fs.promises.writeFile(target, ORIGINAL);
				await applyOwnerOnlyWindowsAcl(target);
				await verifyOwnerOnlyWindowsAcl(target);

				const { api, handle } = openWithoutDeleteShare(target);
				try {
					await expect(Promise.resolve().then(() => write(target))).rejects.toThrow();
				} finally {
					if (!api.CloseHandle(handle)) throw new Error("CloseHandle failed");
				}

				expect(fs.readFileSync(target, "utf8")).toBe(ORIGINAL);
				expect(fs.readdirSync(dir.path()).filter(file => file.startsWith(".settings-δ.json.") && file.endsWith(".tmp"))).toEqual([]);
				await verifyOwnerOnlyWindowsAcl(target);
			} finally {
				await dir.remove();
			}
		});
	}
});
